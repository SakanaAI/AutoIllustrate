// Subprocess + tee helpers for the deterministic phases (4, 5) — the Node
// analogue of `exec > >(tee "$log") 2>&1` plus the python/drawio spawns.
//
// Children are spawned with an args array (no shell) and NOT detached: they
// are deterministic workers that must die with the orchestrator (in bash they
// shared run.sh's process group). cwd stays the invocation cwd — the Python
// scripts resolve `.env` relative to it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { logDone, logErr, logInfo, logTs, logWarn, mirrorsChildOutput, writeExternal } from "./log.js";
import { PhaseError } from "./errors.js";
import { registerChildPid, deregisterChildPid } from "./registry.js";

export class TeeLog {
  private stream: fs.WriteStream;
  private broken = false;
  readonly logPath: string;

  constructor(logPath: string) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.stream = fs.createWriteStream(logPath);
    this.logPath = logPath;
    // A log-file write error (ENOSPC, EACCES) must not crash the phase —
    // keep the console stream and warn once.
    this.stream.on("error", (err) => {
      if (!this.broken) logWarn("tee", `cannot write ${logPath}: ${err.message} — continuing with console output only`);
      this.broken = true;
    });
  }

  // Raw child output: always into the log file, mirrored to the terminal
  // only with --verbose (the failure surface tails the log otherwise).
  writeChunk(chunk: Buffer | string): void {
    this.stream.write(chunk);
    if (mirrorsChildOutput() || this.broken) writeExternal(chunk);
  }

  // The orchestrator's own annotations: timestamped in the log file (so the
  // transcript is greppable after the fact) and routed through the event
  // logger for the terminal — warnings/errors always show, info with --verbose.
  private fileLine(tag: string, marker: string, msg: string): void {
    this.stream.write(`${logTs()} ${tag.padEnd(10)} ${marker} ${msg}\n`);
  }

  info(tag: string, msg: string): void {
    this.fileLine(tag, "•", msg);
    logInfo(tag, msg);
  }

  warn(tag: string, msg: string): void {
    this.fileLine(tag, "⚠", msg);
    logWarn(tag, msg);
  }

  err(tag: string, msg: string): void {
    this.fileLine(tag, "✗", msg);
    logErr(tag, msg);
  }

  step(tag: string, n: number, total: number, msg: string): void {
    this.fileLine(tag, `[step ${n}/${total}]`, msg);
    logInfo(tag, `step ${n}/${total} · ${msg}`);
  }

  // A completed deliverable: ✓ in the log; on the terminal only with
  // --verbose (the phase_end line already reports the outcome).
  done(tag: string, msg: string): void {
    this.fileLine(tag, "✓", msg);
    logInfo(tag, msg);
  }

  // A ✓ line that must reach the terminal by default (stand-alone commands
  // such as `autoillustrate export`, which have no phase_end).
  announce(tag: string, msg: string): void {
    this.fileLine(tag, "✓", msg);
    logDone(tag, msg);
  }

  close(): Promise<void> {
    // 'close' fires after both finish and error-destroy; an already-errored
    // stream never reaches 'finish', so end(cb) alone could hang.
    return new Promise((resolve) => {
      if (this.stream.closed) return resolve();
      this.stream.once("close", () => resolve());
      this.stream.end();
    });
  }
}

export interface RunCommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutSecs?: number; // default: AUTOILLUSTRATE_CMD_TIMEOUT or 600
}

// Deterministic steps normally finish in seconds; the timeout only exists to
// turn a wedged child into a clean phase failure. Observed in the wild: the
// drawio Electron export dying on an unhandled UnknownVizError rejection and
// idling forever without exiting.
export function defaultCmdTimeoutSecs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AUTOILLUSTRATE_CMD_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? raw : 600;
}

// Run a deterministic child, teeing its merged output. Throws PhaseError on
// non-zero exit. Resolves with captured stdout (for parsing, e.g. PIL dims).
export async function runCommand(
  cmd: string,
  args: string[],
  tee: TeeLog,
  opts: RunCommandOptions = {},
): Promise<string> {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Registered so interrupt teardown can SIGTERM an in-flight worker even
  // when the signal arrived programmatically (no tty group delivery).
  if (child.pid !== undefined) registerChildPid(child.pid);
  const timeoutSecs = opts.timeoutSecs ?? defaultCmdTimeoutSecs(opts.env ?? process.env);
  let timedOut = false;
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    tee.writeChunk(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => tee.writeChunk(chunk));

  const code = await new Promise<number>((resolve, reject) => {
    let drainTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    // Watchdog: SIGTERM the wedged child, escalate to SIGKILL after 5s.
    const termTimer = setTimeout(() => {
      timedOut = true;
      tee.err("exec", `${path.basename(cmd)} TIMEOUT after ${timeoutSecs}s — killing wedged child`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutSecs * 1000);
    const clearTimers = () => {
      clearTimeout(drainTimer);
      clearTimeout(termTimer);
      clearTimeout(killTimer);
    };
    const settle = (c: number | null, signal: NodeJS.Signals | null) => {
      if (child.pid !== undefined) deregisterChildPid(child.pid);
      clearTimers();
      resolve(c ?? (signal ? 1 : 0));
    };
    child.on("error", (err) => {
      if (child.pid !== undefined) deregisterChildPid(child.pid);
      clearTimers();
      reject(err);
    });
    // 'close' (exit + stdio drained) is the normal resolution — 'exit' can
    // fire with tail output still buffered, truncating the captured stdout
    // (phase 4 parses PIL dimensions from it). The drain timer guards the
    // other direction: a grandchild inheriting the stdout pipe (Electron
    // helper) would delay 'close' until IT exits.
    child.on("exit", (c, signal) => {
      drainTimer = setTimeout(() => settle(c, signal), 2000);
    });
    child.on("close", settle);
  });
  if (timedOut) {
    throw new PhaseError(`${path.basename(cmd)} ${args[0] ?? ""} timed out after ${timeoutSecs}s (wedged child killed)`, 1, tee.logPath);
  }
  if (code !== 0) {
    throw new PhaseError(`${path.basename(cmd)} ${args[0] ?? ""} exited with code ${code}`, 1, tee.logPath);
  }
  return stdout;
}
