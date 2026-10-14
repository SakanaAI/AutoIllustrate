import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Smoke tests against the BUILT artifact: nothing else executes dist/cli.js,
// so shebang, ESM resolution, and the isDirectRun gate are only proven here.
// Requires a prior build (`npm run check` guarantees it).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCli = path.join(repoRoot, "dist", "cli.js");

function runDist(cli: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("dist/cli.js --help exits 0 and prints usage", () => {
  assert.ok(fs.existsSync(distCli), "dist/cli.js missing — run npm run build first");
  const res = runDist(distCli, ["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
});

test("dist/cli.js with no args exits 2 with a usage error", () => {
  const res = runDist(distCli, []);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--prompt/);
});

test("SIGINT mid-phase tears down agents and exits 130", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-sigint-"));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const write = (name: string, body: string): string => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };
  const headless = write("headless-stub", "sleep 600");
  const python = write("python", 'if [ "$1" = "-c" ]; then echo "3.12"; fi\nexit 0');
  write("claude", "exit 0");
  write("drawio", "exit 0");
  const source = path.join(base, "paper.pdf");
  fs.writeFileSync(source, "pdf");

  // --verbose: the "launching headless" diagnostic is the cue that the
  // phase-1 agent is live (the concise default view hides sub-agent launches).
  const child = spawn(process.execPath, [distCli, source, "-p", "x", "-o", path.join(base, "runs"), "--verbose"], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1",
      AUTOILLUSTRATE_HEADLESS_BIN: headless,
      AUTOILLUSTRATE_PYTHON: python,
      VENV_PY: python,
      OPENAI_API_KEY: "sk-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    // Interrupt once the phase-1 agent is live (idempotent handler — repeats are fine).
    if (out.includes("launching headless")) child.kill("SIGINT");
  });
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));

  assert.equal(code, 130, `interrupt must exit 130, not race a phase failure to 1\n--- output ---\n${out}`);
  assert.match(out, /interrupted — stopping all running agents/);
  assert.match(out, /Pipeline finished · interrupted/);
  fs.rmSync(base, { recursive: true, force: true });
});

test("downstream pipe closing mid-run tears down agents and exits 141", async () => {
  // `autoillustrate ... | head` — Node surfaces the closed pipe as EPIPE on
  // stdout. The output guard must kill live agent groups and exit 141
  // (128+SIGPIPE), not crash with an uncaught exception that orphans them.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-epipe-"));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const pidFile = path.join(base, "agent.pid");
  const write = (name: string, body: string): string => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };
  // Agent stub chatters forever so the orchestrator keeps writing to stdout
  // after the read end disappears.
  const headless = write(
    "headless-stub",
    `echo $$ > "${pidFile}.tmp" && mv "${pidFile}.tmp" "${pidFile}"
while true; do echo tick; sleep 0.1; done`,
  );
  const python = write("python", 'if [ "$1" = "-c" ]; then echo "3.12"; fi\nexit 0');
  write("claude", "exit 0");
  write("drawio", "exit 0");
  const source = path.join(base, "paper.pdf");
  fs.writeFileSync(source, "pdf");

  // --debug: agent chatter must reach the orchestrator's stdout so the
  // closed pipe actually provokes EPIPE (the quiet default would only write
  // sparse progress lines).
  const child = spawn(process.execPath, [distCli, source, "-p", "x", "-o", path.join(base, "runs"), "--debug"], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1",
      AUTOILLUSTRATE_HEADLESS_BIN: headless,
      AUTOILLUSTRATE_PYTHON: python,
      VENV_PY: python,
      OPENAI_API_KEY: "sk-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d: Buffer) => (err += d.toString()));
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    // Wait for the agent's teed chatter so the group is provably live, then
    // simulate `| head` exiting: close our read end of the child's stdout.
    if (out.includes("tick") && !child.stdout.destroyed) child.stdout.destroy();
  });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 141, `broken stdout pipe must exit 141 (128+SIGPIPE)\n--- stderr ---\n${err}`);

  const agentPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const killDeadline = Date.now() + 5_000;
  while (alive(agentPid) && Date.now() < killDeadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(agentPid), "agent group must be torn down on EPIPE, not orphaned");
  fs.rmSync(base, { recursive: true, force: true });
});

test("programmatic SIGTERM mid-phase-4 kills the python worker and exits 130", async () => {
  // A terminal Ctrl+C reaches deterministic workers via the tty group; a
  // bare `kill -TERM <orchestrator>` (supervisor, systemd) does not — the
  // registry must SIGTERM the in-flight runCommand child itself.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-sigterm-"));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const pidFile = path.join(base, "worker.pid");
  const write = (name: string, body: string): string => {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };
  const python = write(
    "python",
    `if [ "$1" = "-c" ]; then echo "3.12"; exit 0; fi
case "$1" in
  */compose.py) echo $$ > "${pidFile}.tmp" && mv "${pidFile}.tmp" "${pidFile}"; exec sleep 600 ;;
esac
exit 0`,
  );
  write("drawio", "exit 0");
  const workdir = path.join(base, "run");
  fs.mkdirSync(workdir);
  fs.writeFileSync(
    path.join(workdir, "phase1_report.json"),
    '{"status":"ok","placement":"half-width","panel_ids":["a"]}',
  );

  const child = spawn(
    process.execPath,
    [distCli, "--workdir", workdir, "--resume-from", "4", "--skip-enhance"],
    {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1",
        AUTOILLUSTRATE_PYTHON: python,
        VENV_PY: python,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));

  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(pidFile), `compose.py worker never started\n--- output ---\n${out}`);
  child.kill("SIGTERM");

  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 130, `SIGTERM must exit 130\n--- output ---\n${out}`);

  const workerPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const killDeadline = Date.now() + 5_000;
  while (alive(workerPid) && Date.now() < killDeadline) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(workerPid), "python worker must not be orphaned by a programmatic SIGTERM");
  fs.rmSync(base, { recursive: true, force: true });
});

test("dist/cli.js runs from an install path containing spaces", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate smoke "));
  fs.cpSync(path.join(repoRoot, "dist"), path.join(base, "dist"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(base, "package.json"));
  const res = runDist(path.join(base, "dist", "cli.js"), ["--version"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^\d+\.\d+\.\d+/, "CLI must execute (not silently no-op) from a percent-encodable path");
  fs.rmSync(base, { recursive: true, force: true });
});
