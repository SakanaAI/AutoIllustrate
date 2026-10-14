// Live agent process-group registry + interrupt teardown.
//
// Port of run.sh's on_interrupt handler and the $WORKDIR/.agent_pgids file
// registry. Sub-agents run as their OWN process groups (see agent.ts) so the
// per-invocation watchdog can stop one wedged agent without touching the
// orchestrator — the flip side is that a terminal Ctrl+C reaches only the
// orchestrator's group, so on INT/TERM we must signal every live agent group
// ourselves. Everything runs in one Node process, so an in-memory Set
// replaces the bash file registry.

import { logPipelineEnd, logRaw, stopProgress } from "./log.js";
import { colorsEnabled, formatDuration, style } from "./terminal.js";

const livePgids = new Set<number>();
let tearingDown = false;
let runStart = Date.now();

export function registerAgentPgid(pgid: number): void {
  livePgids.add(pgid);
}

export function deregisterAgentPgid(pgid: number): void {
  livePgids.delete(pgid);
}

export function liveAgentCount(): number {
  return livePgids.size;
}

// Deterministic workers (phase 4/5 python/drawio) share the orchestrator's
// process group, so a terminal Ctrl+C reaches them via the tty — but a
// programmatic SIGTERM/SIGINT delivered to the orchestrator alone would
// orphan them mid-run. Track their pids so teardown can signal them too.
const liveChildPids = new Set<number>();

export function registerChildPid(pid: number): void {
  liveChildPids.add(pid);
}

export function deregisterChildPid(pid: number): void {
  liveChildPids.delete(pid);
}

function killLiveChildren(): void {
  for (const pid of liveChildPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH — already gone
    }
  }
  liveChildPids.clear();
}

// True from the first Ctrl+C until process.exit(130). Phases whose agents die
// from the teardown SIGTERM fail with rc≠0; the pipeline must not let those
// failures exit 1 before onInterrupt's exit 130 lands (bash deferred the INT
// trap until the phase returned, so on_interrupt always won).
export function isTearingDown(): boolean {
  return tearingDown;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH — group already gone.
  }
}

export async function killAllAgents(): Promise<void> {
  if (livePgids.size === 0) return; // nothing live — skip the TERM grace
  for (const pgid of livePgids) signalGroup(pgid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const pgid of livePgids) {
    signalGroup(pgid, "SIGKILL");
    livePgids.delete(pgid);
  }
}

// Idempotent: repeat Ctrl+C during teardown is ignored (bash: trap '' INT TERM).
async function onInterrupt(): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  stopProgress();
  logRaw(style("  ⚠ interrupted — stopping all running agents…", "warning", colorsEnabled(process.stderr)), "stderr");
  killLiveChildren();
  await killAllAgents();
  logPipelineEnd("interrupted", Date.now() - runStart, { message: `aborted after ${formatDuration(Date.now() - runStart)}` });
  process.exit(130);
}

// Node ignores SIGPIPE: a downstream consumer exiting (`autoillustrate | head`)
// surfaces as EPIPE write errors on stdout instead. Unhandled, that is an
// uncaught exception that kills the orchestrator WITHOUT tearing down live
// agent groups. Tear down and exit 141 (128+SIGPIPE, the shell convention).
async function onBrokenPipe(): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  killLiveChildren();
  await killAllAgents();
  process.exit(141);
}

let outputGuardsInstalled = false;

export function installOutputGuards(): void {
  if (outputGuardsInstalled) return;
  outputGuardsInstalled = true;
  for (const stream of [process.stdout, process.stderr]) {
    const other = stream === process.stdout ? process.stderr : process.stdout;
    const name = stream === process.stdout ? "stdout" : "stderr";
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        void onBrokenPipe();
        return;
      }
      try {
        other.write(`autoillustrate: ${name} write failed: ${err.message}\n`);
      } catch {
        // both streams broken — nowhere left to report
      }
    });
  }
}

let handlersInstalled = false;

export function installInterruptHandler(startedAt: number = Date.now()): void {
  runStart = startedAt;
  installOutputGuards();
  if (handlersInstalled) return; // repeat runs in one process must not stack listeners
  handlersInstalled = true;
  process.on("SIGINT", () => void onInterrupt());
  process.on("SIGTERM", () => void onInterrupt());
}
