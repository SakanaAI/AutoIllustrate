import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentInvoke, resolveHeadless, defaultTimeoutSecs, HEADLESS_VERSION } from "../src/agent.js";
import { headlessStdoutLogPath } from "../src/headless-log.js";
import { liveAgentCount, killAllAgents } from "../src/registry.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-agent-"));
}

function writeStub(dir: string, body: string): string {
  const stub = path.join(dir, "headless-stub");
  fs.writeFileSync(stub, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(stub, 0o755);
  return stub;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeWorkdir(): { workdir: string; promptFile: string; logPath: string } {
  const workdir = tmpdir();
  const promptFile = path.join(workdir, ".prompt.md");
  fs.writeFileSync(promptFile, "do the thing");
  return { workdir, promptFile, logPath: path.join(workdir, "logs", "agent.log") };
}

test("defaultTimeoutSecs honors AGENT_INVOKE_TIMEOUT", () => {
  assert.equal(defaultTimeoutSecs({}), 7200);
  assert.equal(defaultTimeoutSecs({ AGENT_INVOKE_TIMEOUT: "120" }), 120);
  assert.equal(defaultTimeoutSecs({ AGENT_INVOKE_TIMEOUT: "bogus" }), 7200);
});

test("resolveHeadless uses the locked package and honors the explicit override", () => {
  const resolved = resolveHeadless({ PATH: "/nonexistent" });
  assert.equal(resolved.cmd, process.execPath);
  assert.equal(resolved.args.length, 1);
  assert.match(resolved.args[0], /@roberttlange[/\\]headless[/\\]dist[/\\]cli\.js$/);
  assert.equal(HEADLESS_VERSION, "0.6.1");
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(packageJson.dependencies["@roberttlange/headless"], HEADLESS_VERSION);
  const overrideDir = tmpdir();
  const override = writeStub(overrideDir, "exit 0");
  assert.deepEqual(
    resolveHeadless({ AUTOILLUSTRATE_HEADLESS_BIN: override }),
    { cmd: fs.realpathSync(override), args: [] },
  );
});

test("agentInvoke streams output to log file and returns exit code", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  const stub = writeStub(workdir, 'echo "agent says: $1"; echo "oops" >&2; exit 7');
  const rc = await agentInvoke(logPath, promptFile, workdir, { agent: "claude", timeoutSecs: 30 }, {
    ...process.env,
    AUTOILLUSTRATE_HEADLESS_BIN: stub,
  });
  assert.equal(rc, 7);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /agent says: claude/);
  assert.match(log, /oops/);
  const stdoutLog = fs.readFileSync(headlessStdoutLogPath(logPath), "utf8");
  assert.match(stdoutLog, /agent says: claude/);
  assert.doesNotMatch(stdoutLog, /oops/);
  assert.equal(liveAgentCount(), 0);
});

test("agentInvoke passes headless flags incl. optional model/effort", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  const stub = writeStub(workdir, 'echo "$@"');
  const env = { ...process.env, AUTOILLUSTRATE_HEADLESS_BIN: stub };
  await agentInvoke(logPath, promptFile, workdir, { agent: "codex", model: "gpt-x", effort: "high", timeoutSecs: 42 }, env);
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /^codex --prompt-file .*\.prompt\.md --work-dir .* --allow yolo --json --usage --timeout 42 --model gpt-x --effort high$/m);

  await agentInvoke(logPath, promptFile, workdir, { agent: "claude", timeoutSecs: 5 }, env);
  const log2 = fs.readFileSync(logPath, "utf8");
  assert.doesNotMatch(log2, /--model|--effort/);
  assert.doesNotMatch(log2, /--tmux/);
});

test("agentInvoke disables Claude Code auto-memory for spawned agents", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  const stub = writeStub(workdir, 'echo "AUTOMEM=$CLAUDE_CODE_DISABLE_AUTO_MEMORY"');
  const env = { ...process.env, AUTOILLUSTRATE_HEADLESS_BIN: stub };
  delete env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  await agentInvoke(logPath, promptFile, workdir, { agent: "claude", timeoutSecs: 5 }, env);
  assert.match(fs.readFileSync(logPath, "utf8"), /^AUTOMEM=1$/m);
});

test("agentInvoke preserves native OpenCode and Gemini security contracts", async () => {
  for (const agent of ["opencode", "gemini"]) {
    const { workdir, promptFile, logPath } = makeWorkdir();
    const stub = path.join(workdir, agent);
    fs.writeFileSync(stub, '#!/bin/sh\nprintf \'ARGS:%s\\n\' "$*"\nprintf \'STDIN:\'; cat\n');
    fs.chmodSync(stub, 0o755);
    const env = { ...process.env, PATH: `${workdir}${path.delimiter}${process.env.PATH ?? ""}` };

    await agentInvoke(
      logPath,
      promptFile,
      workdir,
      { agent, model: "test-model", effort: agent === "opencode" ? "high" : undefined, timeoutSecs: 5 },
      env,
    );

    const log = fs.readFileSync(logPath, "utf8");
    assert.match(log, /STDIN:do the thing/);
    assert.doesNotMatch(log, /--dangerously-skip-permissions|--skip-trust/);
    if (agent === "opencode") {
      assert.match(log, /ARGS:run --format json --model test-model --variant high/);
    } else {
      assert.match(log, /ARGS:--prompt  --output-format stream-json --yolo --model test-model/);
    }
  }
});

test("agentInvoke rejects unsupported Gemini effort", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  await assert.rejects(
    agentInvoke(logPath, promptFile, workdir, { agent: "gemini", effort: "high", timeoutSecs: 5 }),
    /effort is not supported for gemini/,
  );
});

test("agentInvoke preserves native Cursor trust and model defaults", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  const stub = path.join(workdir, "cursor-agent");
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'ARGS:%s\\n\' "$*"\nprintf \'STDIN:\'; cat\n');
  fs.chmodSync(stub, 0o755);
  const env = { ...process.env, CURSOR_CLI_BIN: stub, CURSOR_API_KEY: "secret-sentinel" };

  await agentInvoke(logPath, promptFile, workdir, { agent: "cursor", timeoutSecs: 5 }, env);

  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /ARGS:-p --force --output-format stream-json/);
  assert.match(log, /STDIN:do the thing/);
  assert.doesNotMatch(log, /--trust|--model|secret-sentinel/);
});

test("agentInvoke preserves native Pi defaults and forwards explicit controls", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  const stub = path.join(workdir, "pi-stub");
  fs.writeFileSync(stub, '#!/bin/sh\nprintf \'ARGS:%s\\n\' "$*"\nprintf \'STDIN:\'; cat\n');
  fs.chmodSync(stub, 0o755);
  const baseEnv = { ...process.env, PI_CODING_AGENT_BIN: stub };
  delete baseEnv.PI_CODING_AGENT_PROVIDER;
  delete baseEnv.PI_CODING_AGENT_MODEL;
  delete baseEnv.PI_CODING_AGENT_MODELS;

  await agentInvoke(logPath, promptFile, workdir, { agent: "pi", timeoutSecs: 5 }, baseEnv);
  const defaultLog = fs.readFileSync(logPath, "utf8");
  assert.match(defaultLog, /ARGS:--no-session --mode json/);
  assert.match(defaultLog, /STDIN:do the thing/);
  assert.doesNotMatch(defaultLog, /--provider|--model|--models|--thinking/);

  await agentInvoke(
    logPath,
    promptFile,
    workdir,
    { agent: "pi", model: "explicit-model", effort: "high", timeoutSecs: 5 },
    {
      ...baseEnv,
      PI_CODING_AGENT_PROVIDER: "custom-provider",
      PI_CODING_AGENT_MODEL: "ambient-model",
      PI_CODING_AGENT_MODELS: "available-a,available-b",
    },
  );
  const explicitLog = fs.readFileSync(logPath, "utf8");
  assert.match(
    explicitLog,
    /ARGS:--no-session --mode json --provider custom-provider --model explicit-model --models available-a,available-b --thinking high/,
  );
  assert.match(explicitLog, /STDIN:do the thing/);
});

test("agentInvoke forwards --tmux --wait --delete when tmux is set", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  const stub = writeStub(workdir, 'echo "$@"');
  const env = { ...process.env, AUTOILLUSTRATE_HEADLESS_BIN: stub };
  await agentInvoke(logPath, promptFile, workdir, { agent: "codex", timeoutSecs: 42, tmux: true }, env);
  const log = fs.readFileSync(logPath, "utf8");
  // headless rejects --json alongside --tmux, so tmux mode drops it.
  assert.match(log, /--allow yolo --tmux --wait --delete --timeout 42$/m);
  assert.doesNotMatch(log, /--json/);
});

test("agent trace stays off the terminal by default, streams with debug, always lands in the log", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  const stub = writeStub(workdir, 'echo "TRACE_MARKER_XYZ"');
  const env = { ...process.env, AUTOILLUSTRATE_HEADLESS_BIN: stub };
  const captured: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // Capture AND forward: the node:test TAP reporter flushes asynchronously
  // through this same stream — swallowing chunks here eats other tests'
  // result lines and silently shrinks the suite count.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return realWrite(chunk);
  }) as typeof process.stdout.write;
  try {
    await agentInvoke(logPath, promptFile, workdir, { agent: "claude", timeoutSecs: 30 }, env);
    assert.ok(!captured.join("").includes("TRACE_MARKER_XYZ"), "trace must not reach the terminal without --debug");
    captured.length = 0;
    await agentInvoke(logPath, promptFile, workdir, { agent: "claude", timeoutSecs: 30, debug: true }, env);
    assert.ok(captured.join("").includes("TRACE_MARKER_XYZ"), "trace must stream to the terminal with --debug");
  } finally {
    process.stdout.write = realWrite;
  }
  assert.match(fs.readFileSync(logPath, "utf8"), /TRACE_MARKER_XYZ/);
});

test("agentInvoke rejects on missing prompt file", async () => {
  const { workdir, logPath } = makeWorkdir();
  await assert.rejects(
    agentInvoke(logPath, path.join(workdir, "nope.md"), workdir, { agent: "claude", timeoutSecs: 5 }),
    /prompt file not found/,
  );
});

test("agentInvoke degrades to console-only when the log path is unwritable", async () => {
  const { workdir, promptFile } = makeWorkdir();
  const stub = writeStub(workdir, "echo fine; exit 0");
  const logDir = path.join(workdir, "logs", "is-a-dir");
  fs.mkdirSync(logDir, { recursive: true });
  // logPath is a directory → stream 'error' (EISDIR); the run must still
  // resolve with the agent's rc and the log flush must not hang.
  const rc = await agentInvoke(logDir, promptFile, workdir, { agent: "claude", timeoutSecs: 30 }, {
    ...process.env,
    AUTOILLUSTRATE_HEADLESS_BIN: stub,
  });
  assert.equal(rc, 0);
  assert.equal(liveAgentCount(), 0);
});

test("watchdog TERMs the whole process group incl. grandchildren", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  // Stub records its pgid (it is the detached group leader), spawns a
  // grandchild in the same group, then sleeps past the timeout. The pgid
  // write is atomic (tmp+rename) and the 3s timeout leaves ample headroom
  // for it to land before SIGTERM, even on loaded CI runners.
  const stub = writeStub(workdir, 'echo $$ > pgid.tmp && mv pgid.tmp pgid\nsleep 600 &\nsleep 600');
  const start = Date.now();
  const rc = await agentInvoke(logPath, promptFile, workdir, { agent: "claude", timeoutSecs: 3 }, {
    ...process.env,
    AUTOILLUSTRATE_HEADLESS_BIN: stub,
  });
  assert.ok(Date.now() - start < 15_000, "watchdog fired, did not wait for sleep 600");
  assert.equal(rc, 143, "TERM-killed → 128+15");
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /TIMEOUT after 3s/);
  assert.equal(liveAgentCount(), 0);
  // The whole group must be dead well before the +5s SIGKILL escalation —
  // proving SIGTERM (not the KILL fallback) reached the grandchild.
  const pgidFile = path.join(workdir, "pgid");
  assert.ok(fs.existsSync(pgidFile), "stub recorded its pgid before the watchdog fired");
  const pgid = Number(fs.readFileSync(pgidFile, "utf8").trim());
  assert.ok(Number.isInteger(pgid) && pgid > 0);
  const deadline = start + 3000 + 4000; // TERM fires at +3s, KILL at +8s
  while (groupAlive(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!groupAlive(pgid), "process group dead via SIGTERM before KILL escalation");
});

test("killAllAgents tears down live agent groups (Ctrl+C path)", async () => {
  const { workdir, promptFile, logPath } = makeWorkdir();
  const stub = writeStub(workdir, "sleep 600 &\nsleep 600");
  const env = { ...process.env, AUTOILLUSTRATE_HEADLESS_BIN: stub };
  const running = agentInvoke(logPath, promptFile, workdir, { agent: "claude", timeoutSecs: 600 }, env);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(liveAgentCount(), 1);
  await killAllAgents();
  const rc = await running;
  assert.equal(rc, 143);
  assert.equal(liveAgentCount(), 0);
});
