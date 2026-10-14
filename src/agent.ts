// Agent invocation — port of scripts/cli/lib/agent_invoke.sh.
//
// Dispatches a prompt to a coding agent, streaming merged
// stdout+stderr to a log file AND the orchestrator's stdout. The agent is
// launched detached (its own process-group leader, the setsid analogue of
// bash `set -m` + background job) so:
//   - the watchdog can hard-stop the whole subtree (agent plus any stray
//     background tasks it spawned) without touching the orchestrator;
//   - registry.ts can tear all groups down on Ctrl+C.
// On return, the group is signalled once more to reap leftover background
// tasks (these are why the agent process itself would otherwise never exit).
// Resolves with the agent's exit code (128+signal when signal-killed).

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  HEADLESS_STDOUT_TAIL_BYTES,
  headlessStdoutLogPath,
} from "./headless-log.js";
import { logInfo, logWarn, writeExternal } from "./log.js";
import { registerAgentPgid, deregisterAgentPgid } from "./registry.js";

export interface AgentConfig {
  agent: string; // claude | codex | cursor | gemini | opencode | pi
  model?: string; // Headless or the native backend supplies the default
  effort?: string; // low | medium | high | xhigh
  timeoutSecs: number;
  debug?: boolean; // also stream the raw agent trace to the terminal
  tmux?: boolean; // run the agent inside a tmux session (headless --tmux --wait --delete)
}

export function defaultTimeoutSecs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENT_INVOKE_TIMEOUT);
  return Number.isFinite(raw) && raw > 0 ? raw : 7200;
}

const require = createRequire(import.meta.url);
const HEADLESS_PACKAGE = "@roberttlange/headless";
// Bundled as a lockfile-pinned dependency rather than resolved at runtime, so
// no npx fallback can silently execute a newer (potentially hijacked) registry
// version — bump deliberately with releases.
export const HEADLESS_VERSION = "0.6.1";
let packagedHeadlessCli: string | undefined;

class BoundedTail {
  private chunks: Buffer[] = [];
  private size = 0;

  append(chunk: Buffer): void {
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    this.size += copy.length;
    while (this.size > HEADLESS_STDOUT_TAIL_BYTES && this.chunks.length > 0) {
      const excess = this.size - HEADLESS_STDOUT_TAIL_BYTES;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.size);
  }
}

function resolvePackagedHeadless(): string {
  if (packagedHeadlessCli) return packagedHeadlessCli;
  const packageJsonPath = require.resolve(`${HEADLESS_PACKAGE}/package.json`);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
    bin?: Record<string, string>;
  };
  if (packageJson.version !== HEADLESS_VERSION) {
    throw new Error(`autoillustrate requires ${HEADLESS_PACKAGE}@${HEADLESS_VERSION}; found ${packageJson.version ?? "unknown"}`);
  }
  const bin = packageJson.bin?.headless;
  if (!bin) throw new Error(`${HEADLESS_PACKAGE}@${HEADLESS_VERSION} does not declare the headless binary`);
  const cli = fs.realpathSync(path.resolve(path.dirname(packageJsonPath), bin));
  fs.accessSync(cli, fs.constants.R_OK);
  packagedHeadlessCli = cli;
  return cli;
}

// Use the lockfile-pinned runtime dependency. AUTOILLUSTRATE_HEADLESS_BIN is
// an explicit test/development escape hatch.
export function resolveHeadless(env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[] } {
  if (env.AUTOILLUSTRATE_HEADLESS_BIN) {
    const configured = env.AUTOILLUSTRATE_HEADLESS_BIN;
    let candidate: string | undefined;
    if (path.isAbsolute(configured) || configured.includes(path.sep)) {
      candidate = path.resolve(configured);
    } else {
      for (const directory of (env.PATH ?? "").split(path.delimiter)) {
        if (!directory) continue;
        const fromPath = path.join(directory, configured);
        try {
          fs.accessSync(fromPath, fs.constants.X_OK);
          candidate = fromPath;
          break;
        } catch {
          // Keep searching.
        }
      }
    }
    if (!candidate) throw new Error(`AUTOILLUSTRATE_HEADLESS_BIN is not executable: ${configured}`);
    const executable = fs.realpathSync(candidate);
    fs.accessSync(executable, fs.constants.X_OK);
    return { cmd: executable, args: [] };
  }
  return { cmd: process.execPath, args: [resolvePackagedHeadless()] };
}

function timestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}

function cursorModelForEffort(model: string | undefined, effort: string | undefined): string | undefined {
  if (!model) {
    if (!effort) return undefined;
    model = "gpt-5.5";
  }
  if (/-(low|medium|high|xhigh|extra-high)(-fast)?$/i.test(model)) return model;
  if (model === "gpt-5.5") {
    return { medium: "gpt-5.5-medium", high: "gpt-5.5-high", xhigh: "gpt-5.5-extra-high" }[effort ?? ""] ?? model;
  }
  if (
    ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"].includes(model)
    || model === "gpt-5.1"
    || model.endsWith("-codex")
    || model.endsWith("-codex-spark-preview")
  ) {
    const suffixes: Record<string, string> = { low: "low", high: "high", xhigh: "xhigh" };
    if (["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"].includes(model)) suffixes.medium = "medium";
    if (model === "gpt-5.1") delete suffixes.xhigh;
    return suffixes[effort ?? ""] ? `${model}-${suffixes[effort ?? ""]}` : model;
  }
  return model;
}

export async function agentInvoke(
  logPath: string,
  promptFile: string,
  workdir: string,
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (!fs.existsSync(promptFile)) {
    throw new Error(`agent_invoke: prompt file not found: ${promptFile}`);
  }
  const nativeAgent = ["cursor", "opencode", "gemini", "pi"].includes(config.agent);
  if (nativeAgent && config.tmux) {
    throw new Error(`agent_invoke: --tmux is not supported for native ${config.agent} invocation`);
  }
  if (config.agent === "gemini" && config.effort) {
    throw new Error("agent_invoke: effort is not supported for gemini");
  }
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath); // truncate, like `: > "$log_path"`
  const stdoutLogPath = headlessStdoutLogPath(logPath);
  const stdoutTail = new BoundedTail();
  // ENOSPC/EACCES on the log file must not crash the run (unhandled 'error'
  // would be an uncaught exception) — degrade to console-only streaming.
  let logBroken = false;
  logStream.on("error", (err) => {
    if (!logBroken) logWarn("agent", `cannot write ${logPath}: ${err.message} — continuing with console output only`);
    logBroken = true;
  });

  const headless = nativeAgent ? undefined : resolveHeadless(env);
  const command = config.agent === "cursor"
    ? env.CURSOR_CLI_BIN || "agent"
    : config.agent === "pi"
      ? env.PI_CODING_AGENT_BIN || "pi"
    : nativeAgent
      ? config.agent
      : headless!.cmd;
  const cursorModel = config.agent === "cursor"
    ? cursorModelForEffort(config.model, config.effort)
    : undefined;
  const args = nativeAgent
    ? config.agent === "cursor"
      ? [
          "-p",
          "--force",
          "--output-format",
          "stream-json",
          ...(cursorModel ? ["--model", cursorModel] : []),
        ]
      : config.agent === "opencode"
      ? [
          "run",
          "--format",
          "json",
          ...(config.model ? ["--model", config.model] : []),
          ...(config.effort ? ["--variant", config.effort] : []),
        ]
      : config.agent === "gemini"
      ? [
          "--prompt",
          "",
          "--output-format",
          "stream-json",
          "--yolo",
          ...(config.model ? ["--model", config.model] : []),
        ]
      : [
          "--no-session",
          "--mode",
          "json",
          ...(env.PI_CODING_AGENT_PROVIDER ? ["--provider", env.PI_CODING_AGENT_PROVIDER] : []),
          ...(config.model || env.PI_CODING_AGENT_MODEL
            ? ["--model", config.model || env.PI_CODING_AGENT_MODEL!]
            : []),
          ...(env.PI_CODING_AGENT_MODELS ? ["--models", env.PI_CODING_AGENT_MODELS] : []),
          ...(config.effort ? ["--thinking", config.effort] : []),
        ]
    : [
        ...headless!.args,
        config.agent,
        "--prompt-file",
        promptFile,
        "--work-dir",
        workdir,
        "--allow",
        "yolo",
        // tmux mode runs the agent in a detached session; --wait blocks headless
        // until it finishes and prints the final message, --delete tears the
        // session down afterward. headless forbids --json with --tmux, so in that
        // mode we drop both trace and usage output. Headless 0.5+ can combine
        // --json with --usage, appending normalized accounting after the trace.
        ...(config.tmux ? ["--tmux", "--wait", "--delete"] : ["--json", "--usage"]),
        "--timeout",
        String(config.timeoutSecs),
        ...(config.model ? ["--model", config.model] : []),
        ...(config.effort ? ["--effort", config.effort] : []),
      ];
  const invocationLabel = nativeAgent ? `native ${config.agent}` : `headless ${config.agent}`;

  logInfo(
    "agent",
    `launching ${invocationLabel} (model=${config.model || "default"}, effort=${config.effort || "default"}, timeout=${config.timeoutSecs}s${config.tmux ? ", tmux" : ""}) → ${logPath}`,
  );
  const invokeStart = Date.now();

  const promptFd = nativeAgent ? fs.openSync(promptFile, "r") : undefined;
  const child = spawn(command, args, {
    cwd: workdir,
    detached: true,
    stdio: [promptFd ?? "ignore", "pipe", "pipe"],
    // Pipeline agents must be driven by the repo's prompts and references
    // only, never by notes Claude Code accumulated in the user's auto-memory
    // (which is keyed on the git root, so run dirs would inherit it).
    env: { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  });
  if (promptFd !== undefined) fs.closeSync(promptFd);

  const pgid = child.pid;
  if (pgid) registerAgentPgid(pgid);

  const writeLog = async (chunk: Buffer): Promise<void> => {
    if (logBroken || logStream.destroyed) return;
    try {
      if (!logStream.write(chunk)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            logStream.off("drain", done);
            logStream.off("close", done);
            logStream.off("error", done);
            resolve();
          };
          logStream.once("drain", done);
          logStream.once("close", done);
          logStream.once("error", done);
        });
      }
    } catch {
      // The stream error handler reports the failure and enables console output.
    }
  };
  const writeTerminal = async (chunk: Buffer): Promise<void> => {
    // Through the event logger so a live spinner line is cleared first;
    // still honour back-pressure on whichever real stream it picked (stdout,
    // or stderr under --log-format json).
    const dest = writeExternal(chunk);
    if (dest.writableNeedDrain && dest.once) await new Promise<void>((resolve) => dest.once?.("drain", resolve));
  };
  const consumeOutput = async (
    stream: NodeJS.ReadableStream | null,
    captureStdout: boolean,
  ): Promise<void> => {
    if (!stream) return;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (captureStdout) stdoutTail.append(buffer);
      await writeLog(buffer);
      if (config.debug || logBroken) await writeTerminal(buffer);
    }
  };
  const outputDone = Promise.all([
    consumeOutput(child.stdout, true),
    consumeOutput(child.stderr, false),
  ]).catch((err) => {
    logWarn("agent", `output stream failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  const signalGroup = (signal: NodeJS.Signals) => {
    if (!pgid) return;
    try {
      process.kill(-pgid, signal);
    } catch {
      // ESRCH — already gone.
    }
  };

  // Watchdog: hard-stop the whole process group after the timeout.
  const termTimer = setTimeout(() => {
    logStream.write(`${timestamp()} agent_invoke: TIMEOUT after ${config.timeoutSecs}s — killing ${logPath} sub-agent\n`);
    signalGroup("SIGTERM");
    killTimer = setTimeout(() => signalGroup("SIGKILL"), 5000);
  }, config.timeoutSecs * 1000);
  let killTimer: NodeJS.Timeout | undefined;

  let rc: number;
  try {
    rc = await new Promise<number>((resolve, reject) => {
      child.on("error", (err) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        reject(err);
      });
      // 'close' (not 'exit') so all stdio has flushed into the log stream
      // before we end it — 'exit' can fire with tail output still buffered.
      child.on("close", (code, signal) => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve(code ?? 128 + (signal ? (signal === "SIGKILL" ? 9 : 15) : 0));
      });
    });
  } finally {
    // Reap background tasks the agent left running, then drop the group
    // from the interrupt registry. Await the log flush so callers (and
    // failure tails) never read a half-written log.
    signalGroup("SIGTERM");
    if (pgid) deregisterAgentPgid(pgid);
    await outputDone;
    const stdoutTempPath = `${stdoutLogPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(stdoutTempPath, stdoutTail.toBuffer());
      await fs.promises.rename(stdoutTempPath, stdoutLogPath);
    } catch (err) {
      logWarn("agent", `cannot write ${stdoutLogPath}: ${err instanceof Error ? err.message : String(err)}`);
      await fs.promises.rm(stdoutTempPath, { force: true }).catch(() => undefined);
    }
    // 'close' fires after both a normal finish and an error-destroy; checking
    // closed first avoids hanging when the stream already errored out.
    await new Promise<void>((resolve) => {
      if (logStream.closed) return resolve();
      logStream.once("close", resolve);
      logStream.end();
    });
  }

  logInfo("agent", `${invocationLabel} exited (rc=${rc}) after ${Math.round((Date.now() - invokeStart) / 1000)}s`);
  return rc;
}
