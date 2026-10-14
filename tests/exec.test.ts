import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand, defaultCmdTimeoutSecs, TeeLog } from "../src/exec.js";
import { PhaseError } from "../src/errors.js";

function tee(): TeeLog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-exec-"));
  return new TeeLog(path.join(dir, "phase.log"));
}

test("runCommand captures the full stdout including the final chunk", async () => {
  const log = tee();
  const out = await runCommand("/bin/sh", ["-c", "awk 'BEGIN{for(i=0;i<100000;i++)printf \"a\"}'; printf ' END'"], log);
  await log.close();
  assert.ok(out.endsWith(" END"), "tail chunk must not be lost to the exit/close race");
  assert.equal(out.length, 100004);
});

test("runCommand throws PhaseError carrying the log path on non-zero exit", async () => {
  const log = tee();
  await assert.rejects(runCommand("/bin/sh", ["-c", "exit 3"], log), (err: unknown) => {
    assert.ok(err instanceof PhaseError);
    assert.equal(err.logPath, log.logPath);
    return true;
  });
  await log.close();
});

test("TeeLog survives an unwritable log path and close() still resolves", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-exec-"));
  // logPath IS a directory → async EISDIR on open; writes must not throw
  // and close() must not hang on the never-finishing stream.
  const log = new TeeLog(dir);
  log.info("x", "before error");
  await new Promise((r) => setTimeout(r, 50));
  log.warn("x", "after error");
  await log.close();
});

test("defaultCmdTimeoutSecs honors AUTOILLUSTRATE_CMD_TIMEOUT", () => {
  assert.equal(defaultCmdTimeoutSecs({}), 600);
  assert.equal(defaultCmdTimeoutSecs({ AUTOILLUSTRATE_CMD_TIMEOUT: "30" }), 30);
  assert.equal(defaultCmdTimeoutSecs({ AUTOILLUSTRATE_CMD_TIMEOUT: "bogus" }), 600);
});

test("runCommand kills a wedged child after the timeout and throws a timeout PhaseError", async () => {
  const log = tee();
  const dir = path.dirname(log.logPath);
  const pidFile = path.join(dir, "wedged.pid");
  const start = Date.now();
  // The drawio-wedge shape: child writes nothing useful and never exits.
  // Atomic pid write + 3s headroom — same anti-flake treatment as the agent
  // watchdog test (the write must land before SIGTERM, even on loaded CI).
  await assert.rejects(
    runCommand("/bin/sh", ["-c", `echo $$ > "${pidFile}.tmp" && mv "${pidFile}.tmp" "${pidFile}"; exec sleep 600`], log, {
      timeoutSecs: 3,
    }),
    (err: unknown) => {
      assert.ok(err instanceof PhaseError);
      assert.match(err.message, /timed out after 3s/);
      assert.equal(err.logPath, log.logPath);
      return true;
    },
  );
  await log.close();
  assert.ok(Date.now() - start < 15_000, "watchdog fired, did not wait for sleep 600");
  assert.match(fs.readFileSync(log.logPath, "utf8"), /TIMEOUT after 3s/);
  assert.ok(fs.existsSync(pidFile), "stub recorded its pid before the watchdog fired");
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 9_000; // SIGTERM at +3s, SIGKILL escalation at +8s
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(pid), "wedged child must be dead after the watchdog");
});

test("runCommand resolves shortly after exit when a grandchild holds the stdout pipe", async () => {
  const log = tee();
  const start = Date.now();
  // The backgrounded sleep inherits fd 1, so 'close' is delayed until it
  // dies — the post-exit drain grace must resolve us long before that.
  const out = await runCommand("/bin/sh", ["-c", "echo held; sleep 15 & exit 0"], log);
  const took = Date.now() - start;
  await log.close();
  assert.ok(took < 10_000, `resolved via drain grace, not grandchild exit (took ${took}ms)`);
  assert.match(out, /held/);
});
