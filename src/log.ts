// Structured run logging — every terminal line is an event.
//
// One emit() path fans each event out to (a) the terminal, rendered either
// for people (concise, domain-focused, semantically coloured) or as JSON
// Lines (--log-format json), and (b) a per-run journal (<workdir>/events.jsonl)
// carrying the complete record for post-run analysis. The human view stays
// terse by default: plumbing (log paths, prompt files, sub-agent launches) is
// only shown with --verbose, and while a long step runs an interactive
// terminal refreshes one spinner line in place whereas redirected output gets
// a heartbeat line every --heartbeat-seconds (default 60).
//
// Free-text helpers (logInfo/logWarn/logErr/logDone) remain for the phase
// modules; they map onto `message` events with a level.

import fs from "node:fs";

import {
  CLEAR_LINE,
  CURSOR_UP,
  SPINNER_FRAMES,
  colorsEnabled,
  formatDuration,
  formatTokens,
  style,
  terminalColumns,
  terminalText,
  terminalWidth,
  trueColorEnabled,
  truncateTerminalText,
  type Semantic,
} from "./terminal.js";
import { renderLogo, renderTagline } from "./logo.js";

export type LogFormat = "human" | "json";
export type ItemStatus = "ok" | "degraded" | "failed" | "skipped";
export type PhaseEndStatus = "completed" | "degraded" | "skipped" | "failed";

export interface OutStream {
  write(chunk: string | Uint8Array): boolean;
  isTTY?: boolean;
  columns?: number;
  // Back-pressure surface of a real Writable (absent on test fakes).
  writableNeedDrain?: boolean;
  once?(event: "drain", listener: () => void): unknown;
}

interface LogState {
  format: LogFormat;
  verbose: boolean;
  heartbeatSeconds: number;
  stdout: OutStream;
  stderr: OutStream;
  env: NodeJS.ProcessEnv;
}

const state: LogState = {
  format: "human",
  verbose: false,
  heartbeatSeconds: 60,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
};

let journalPath: string | undefined;
let journalBroken = false;

export interface LogOptions {
  format?: LogFormat;
  verbose?: boolean;
  heartbeatSeconds?: number;
  stdout?: OutStream;
  stderr?: OutStream;
  env?: NodeJS.ProcessEnv;
}

export function configureLogging(opts: LogOptions): void {
  if (opts.format !== undefined) state.format = opts.format;
  if (opts.verbose !== undefined) state.verbose = opts.verbose;
  if (opts.heartbeatSeconds !== undefined) state.heartbeatSeconds = Math.max(0, opts.heartbeatSeconds);
  if (opts.stdout !== undefined) state.stdout = opts.stdout;
  if (opts.stderr !== undefined) state.stderr = opts.stderr;
  if (opts.env !== undefined) state.env = opts.env;
}

export function loggingConfig(): Readonly<Pick<LogState, "format" | "verbose" | "heartbeatSeconds">> {
  return { format: state.format, verbose: state.verbose, heartbeatSeconds: state.heartbeatSeconds };
}

export function isVerbose(): boolean {
  return state.verbose;
}

// Append every subsequent event to this JSON Lines file (best-effort: a write
// failure warns once and terminal logging continues).
export function attachJournal(file: string): void {
  journalPath = file;
  journalBroken = false;
}

export function detachJournal(): void {
  journalPath = undefined;
}

function colors(stream: OutStream): boolean {
  return colorsEnabled(stream, state.env);
}

function styled(text: string, semantic: Semantic, stream: OutStream = state.stdout): string {
  return style(text, semantic, colors(stream));
}

// ── Timestamps / timers (kept for the file logs and the phase modules) ─────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Local ISO-8601 second stamp — the prefix of every line in <workdir>/logs/*.
export function logTs(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

export function timerStart(): number {
  return Date.now();
}

// "(4m 12s)" — appended to free-text diagnostics.
export function elapsed(start: number): string {
  return `(${formatDuration(Date.now() - start)})`;
}

// ── Terminal writing (transient-line aware) ────────────────────────────────

let transientShown = false; // a spinner block currently ends on the cursor row
let transientLines = 0; // rows the block occupies (one per tracked item, else one)
let dangling: OutStream | null = null; // external output left this stream mid-line

// Erase the spinner block bottom-up, leaving the cursor on its first row.
function transientClearSequence(): string {
  if (!transientShown) return "";
  let seq = CLEAR_LINE;
  for (let i = 1; i < transientLines; i++) seq += CURSOR_UP + CLEAR_LINE;
  transientShown = false;
  transientLines = 0;
  return seq;
}

function clearTransient(): void {
  const seq = transientClearSequence();
  if (seq) state.stdout.write(seq);
}

// Terminate a partial external line on the stream it was written to, so the
// JSON view never gets a stray newline on stdout for a chunk that went to
// stderr.
function endDangling(): void {
  if (!dangling) return;
  dangling.write("\n");
  dangling = null;
}

function writeLine(stream: OutStream, text: string): void {
  clearTransient();
  endDangling();
  stream.write(text + "\n");
}

// The stream child/agent output is mirrored to: stdout in the human view,
// stderr under --log-format json so stdout stays pure JSON Lines.
export function externalOutputStream(): OutStream {
  return state.format === "json" ? state.stderr : state.stdout;
}

// Pass-through for child/agent output: give it a clean line while a spinner
// is active and remember whether it left the cursor mid-line. Returns the
// stream written to so callers can honour its back-pressure.
export function writeExternal(chunk: Buffer | string): OutStream {
  const stream = externalOutputStream();
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  if (text.length === 0) return stream;
  clearTransient();
  stream.write(chunk);
  dangling = text.endsWith("\n") ? null : stream;
  return stream;
}

// Whether verbose child-process output should be mirrored to the terminal.
export function mirrorsChildOutput(): boolean {
  return state.verbose;
}

// ── Events ────────────────────────────────────────────────────────────────

export interface LogRecord {
  timestamp: string;
  event: string;
  phase: number | null;
  fields: Record<string, unknown>;
}

function journal(record: LogRecord): void {
  if (!journalPath || journalBroken) return;
  try {
    fs.appendFileSync(journalPath, JSON.stringify(record) + "\n");
  } catch (err) {
    journalBroken = true;
    const reason = err instanceof Error ? err.message : String(err);
    writeLine(state.stderr, styled(`  ⚠ run · event journal unavailable (${reason}); terminal logging continues`, "warning", state.stderr));
  }
}

function emit(event: string, fields: Record<string, unknown>, phase: number | null = null, track?: string): LogRecord {
  const record: LogRecord = { timestamp: new Date().toISOString(), event, phase, fields };
  journal(record);
  const captured = track !== undefined && settleTrack(track, fields);
  if (state.format === "json") {
    writeLine(state.stdout, JSON.stringify(record));
  } else if (!captured) {
    for (const line of humanLines(record)) writeLine(line.stream ?? state.stdout, line.text);
  }
  return record;
}

interface HumanLine {
  text: string;
  stream?: OutStream;
}

const ITEM_GLYPH: Record<ItemStatus, [string, Semantic]> = {
  ok: ["✓", "success"],
  degraded: ["⚠", "warning"],
  failed: ["✗", "failure"],
  skipped: ["–", "detail"],
};

const PHASE_GLYPH: Record<PhaseEndStatus, [string, Semantic]> = {
  completed: ["✓", "success"],
  degraded: ["⚠", "warning"],
  skipped: ["–", "detail"],
  failed: ["✗", "failure"],
};

// "  ✓ label · detail · 4m 12s" — shared by the event view and the in-place
// spinner-row replacement, which width-caps the plain text before styling.
function itemLine(f: Record<string, unknown>): [string, Semantic] {
  const [glyph, semantic] = ITEM_GLYPH[f.status as ItemStatus];
  const parts = [terminalText(f.label)];
  if (typeof f.detail === "string" && f.detail) parts.push(terminalText(f.detail));
  if (typeof f.elapsed === "string") parts.push(f.elapsed);
  return [`  ${glyph} ${parts.join(" · ")}`, semantic];
}

function humanLines(record: LogRecord): HumanLine[] {
  const f = record.fields;
  const out = state.stdout;
  const err = state.stderr;
  switch (record.event) {
    case "run_start": {
      const lines = renderLogo({ colors: colors(out), columns: terminalColumns(out), trueColor: trueColorEnabled(state.env) }).map((text) => ({ text }));
      lines.push({ text: renderTagline(colors(out)) }, { text: "" });
      for (const header of f.header as string[]) lines.push({ text: header });
      if (state.verbose) for (const extra of (f.details as string[] | undefined) ?? []) lines.push({ text: styled(`  ${extra}`, "detail") });
      return lines;
    }
    case "phase_start":
      return [{ text: "" }, { text: styled(`Phase ${f.label}/${f.total} · ${terminalText(f.title)}`, "phase") }];
    case "phase_end": {
      const status = f.status as PhaseEndStatus;
      const [glyph, semantic] = PHASE_GLYPH[status];
      const parts: string[] = [status];
      if (typeof f.outcome === "string" && f.outcome) parts.push(terminalText(f.outcome));
      if (status !== "skipped" && typeof f.elapsed === "string") parts.push(f.elapsed);
      if (typeof f.tokens === "number") {
        const phaseTokens = `${formatTokens(f.tokens)} tokens`;
        parts.push(typeof f.run_tokens === "number" && f.run_tokens > f.tokens ? `${phaseTokens} (run ${formatTokens(f.run_tokens)})` : phaseTokens);
      }
      return [{ text: styled(`  ${glyph} ${parts.join(" · ")}`, semantic) }];
    }
    case "item_result": {
      const [text, semantic] = itemLine(f);
      return [{ text: styled(text, semantic) }];
    }
    case "detail":
      return [{ text: `  ${terminalText(f.message, 400)}` }];
    case "heartbeat": {
      const position = typeof f.phase_label === "string" ? `Phase ${f.phase_label} · ` : "";
      const waiting = Array.isArray(f.waiting_on) && f.waiting_on.length > 0 ? ` · waiting on ${terminalText(f.waiting_on.join(", "))}` : "";
      return [{ text: styled(`  ${position}${terminalText(f.label)} ${f.elapsed} · still running${waiting}`, "running") }];
    }
    case "pipeline_end": {
      const status = f.status as string;
      const semantic: Semantic = status === "completed" ? "success" : status === "interrupted" ? "warning" : "failure";
      const parts = [`Pipeline finished · ${status}`];
      if (typeof f.elapsed === "string") parts.push(f.elapsed);
      return [{ text: "" }, { text: styled(parts.join(" · "), semantic) }];
    }
    case "run_summary":
      return [{ text: "" }, { text: styled("Run summary", "phase") }, ...String(f.text).split("\n").map((text) => ({ text }))];
    case "error": {
      const lines: HumanLine[] = [{ text: styled(`ERROR: ${terminalText(f.message, 600)}`, "failure", err), stream: err }];
      if (typeof f.log_path === "string") lines.push({ text: styled(`  log: ${terminalText(f.log_path, 512)}`, "detail", err), stream: err });
      return lines;
    }
    case "message": {
      const level = f.level as "info" | "warn" | "error" | "done";
      const tag = terminalText(f.tag, 64);
      const message = terminalText(f.message, 600);
      if (level === "info") {
        return state.verbose ? [{ text: styled(`  ${tag}: ${message}`, "detail") }] : [];
      }
      if (level === "done") return [{ text: styled(`  ✓ ${message}`, "success") }];
      if (level === "warn") return [{ text: styled(`  ⚠ ${tag} · ${message}`, "warning", err), stream: err }];
      return [{ text: styled(`  ✗ ${tag} · ${message}`, "failure", err), stream: err }];
    }
    case "raw":
      return String(f.text).split("\n").map((text) => ({ text, stream: f.stream === "stderr" ? err : out }));
    case "report_start": {
      const subtitle = typeof f.subtitle === "string" ? styled(` · ${terminalText(f.subtitle)}`, "detail") : "";
      return [{ text: styled(terminalText(f.title), "phase") + subtitle }];
    }
    case "check": {
      const ok = Boolean(f.ok);
      const row = styled(`  ${ok ? "✓" : "✗"} ${terminalText(f.name).padEnd(16)} ${terminalText(f.detail, 600)}`, ok ? "success" : "failure");
      const lines: HumanLine[] = [{ text: row }];
      if (typeof f.hint === "string" && f.hint) {
        lines.push({ text: styled(`    ${"".padEnd(16)} ${terminalText(f.hint_label)} ${terminalText(f.hint, 600)}`, "detail") });
      }
      return lines;
    }
    case "report_end":
      return [{ text: "" }, { text: styled(terminalText(f.message), f.status === "passed" ? "success" : "failure") }];
    default:
      if (!state.verbose) return [];
      return [{ text: styled(`  ${record.event}: ${Object.entries(f).map(([k, v]) => `${k}=${terminalText(v)}`).join(" ")}`, "detail") }];
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export interface RunStartFields {
  header: string[]; // always shown, one line each
  details?: string[]; // --verbose only
  [key: string]: unknown; // extra structured fields for the journal/JSON view
}

// Wordmark + run header (human) / run_start record (json).
export function logRunStart(fields: RunStartFields): void {
  emit("run_start", fields);
}

export function logPhaseStart(phase: number, label: string, total: number, title: string): void {
  emit("phase_start", { label, total, title }, phase);
}

export interface PhaseEndFields {
  phase: number;
  title: string;
  status: PhaseEndStatus;
  outcome?: string;
  durationMs?: number;
  tokens?: number;
  runTokens?: number;
}

export function logPhaseEnd(p: PhaseEndFields): void {
  const fields: Record<string, unknown> = { title: p.title, status: p.status };
  if (p.outcome) fields.outcome = p.outcome;
  if (p.durationMs !== undefined) {
    fields.elapsed = formatDuration(p.durationMs);
    fields.elapsed_seconds = Math.round(p.durationMs / 100) / 10;
  }
  if (p.tokens !== undefined) fields.tokens = p.tokens;
  if (p.runTokens !== undefined) fields.run_tokens = p.runTokens;
  emit("phase_end", fields, p.phase);
}

// One line per item of a fan-out (a panel rendered, a check performed). With
// `track` the line replaces that item's spinner row in place (see trackProgress).
export function logItem(status: ItemStatus, label: string, opts: { detail?: string; durationMs?: number; phase?: number; track?: string } = {}): void {
  const fields: Record<string, unknown> = { status, label };
  if (opts.detail) fields.detail = opts.detail;
  if (opts.durationMs !== undefined) fields.elapsed = formatDuration(opts.durationMs);
  emit("item_result", fields, opts.phase ?? null, opts.track);
}

// A domain fact worth showing by default ("Placement: full-width").
export function logDetail(message: string, phase?: number): void {
  emit("detail", { message }, phase ?? null);
}

// Diagnostic plumbing — journaled always, shown only with --verbose.
export function logInfo(tag: string, msg: string): void {
  emit("message", { level: "info", tag, message: msg });
}

export function logWarn(tag: string, msg: string): void {
  emit("message", { level: "warn", tag, message: msg });
}

export function logErr(tag: string, msg: string): void {
  emit("message", { level: "error", tag, message: msg });
}

export function logDone(tag: string, msg: string): void {
  emit("message", { level: "done", tag, message: msg });
}

export function logError(message: string, logPath?: string): void {
  emit("error", logPath ? { message, log_path: logPath } : { message });
}

export function logPipelineEnd(status: "completed" | "failed" | "interrupted", durationMs: number, extra: Record<string, unknown> = {}): void {
  emit("pipeline_end", { status, elapsed: formatDuration(durationMs), elapsed_seconds: Math.round(durationMs / 100) / 10, ...extra });
}

// The end-of-run cost/runtime table (human) — the metrics object rides along
// so the JSON view and the journal carry the structured form.
export function logRunSummary(text: string, metrics: unknown): void {
  emit("run_summary", { text, metrics });
}

// Pre-rendered text that is neither diagnostic nor an event of its own (usage
// text, doctor reports). Journaled as `raw`.
export function logRaw(text: string, stream: "stdout" | "stderr" = "stdout"): void {
  emit("raw", { text: text.replace(/\n$/, ""), stream });
}

// ── Diagnostic reports (doctor / credentials) ─────────────────────────────

export interface CheckRow {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export function logReportStart(title: string, subtitle?: string): void {
  emit("report_start", subtitle ? { title, subtitle } : { title });
}

// One environment check: "  ✓ name  detail" plus an indented remediation hint
// when it failed (`hintLabel` prefixes the hint: "→" for doctor, "fix:" for
// credentials).
export function logCheck(row: CheckRow, hintLabel: string): void {
  const fields: Record<string, unknown> = { name: row.name, ok: row.ok, detail: row.detail };
  if (row.hint) {
    fields.hint = row.hint;
    fields.hint_label = hintLabel;
  }
  emit("check", fields);
}

export function logReportEnd(status: "passed" | "failed", message: string, counts: { passed: number; failed: number }): void {
  emit("report_end", { status, message, ...counts });
}

// ── Progress: spinner (TTY) / heartbeat (redirected) ──────────────────────

interface ProgressTrack {
  id: string;
  label: string;
  startedAt: number;
  done: boolean;
  row?: string; // TTY only: the settled result line, still redrawn inside the block
}

interface ActiveProgress {
  label: string;
  phase: number | null;
  phaseLabel?: string;
  startedAt: number;
  lastHeartbeat: number;
  tracks: ProgressTrack[];
}

let active: ActiveProgress | null = null;
let ticker: NodeJS.Timeout | undefined;
let spinnerIndex = 0;
let exitHookInstalled = false;
const SPINNER_TICK_MS = 120;

function usesTransientProgress(): boolean {
  return state.format === "human" && Boolean(state.stdout.isTTY);
}

function spinnerLine(frame: string, label: string, elapsedMs: number, columns: number): string {
  const elapsedText = formatDuration(elapsedMs);
  const fixed = terminalWidth(`  ${frame}  ${elapsedText}`);
  const text = truncateTerminalText(label, Math.max(0, columns - fixed));
  return styled(truncateTerminalText(`  ${frame} ${text} ${elapsedText}`, columns), "running");
}

// Redraw the whole block in one write: erase the previous block, then one row
// per track (or the single step line). Every row is width-capped so it never
// wraps — the cursor-up arithmetic assumes one terminal row per line.
function drawSpinner(now: number): void {
  if (!active) return;
  endDangling();
  const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
  spinnerIndex++;
  const columns = terminalColumns(state.stdout) ?? 80;
  const lines =
    active.tracks.length === 0
      ? [spinnerLine(frame, active.label, now - active.startedAt, columns)]
      : active.tracks.map((t) => t.row ?? spinnerLine(frame, t.label, now - t.startedAt, columns));
  state.stdout.write(transientClearSequence() + lines.map((line) => CLEAR_LINE + line).join("\n"));
  transientShown = true;
  transientLines = lines.length;
}

function pendingTracks(): string[] {
  return active ? active.tracks.filter((t) => !t.done).map((t) => t.id) : [];
}

// Mark a tracked item finished. On a TTY its result line takes over its row
// in the spinner block (redrawn each tick, made permanent by stopProgress) and
// true says the caller must not print it; elsewhere the line prints normally.
function settleTrack(id: string, fields: Record<string, unknown>): boolean {
  const track = active?.tracks.find((t) => t.id === id);
  if (!track) return false;
  track.done = true;
  if (!usesTransientProgress()) return false;
  const [text, semantic] = itemLine(fields);
  track.row = styled(truncateTerminalText(text, terminalColumns(state.stdout) ?? 80), semantic);
  drawSpinner(Date.now());
  return true;
}

// Refresh the active step once: redraw the spinner on a TTY, and emit a
// heartbeat record when the interval has elapsed. Exported for tests.
export function pollProgress(now: number = Date.now()): void {
  if (!active) return;
  if (usesTransientProgress()) drawSpinner(now);
  if (state.heartbeatSeconds <= 0) return;
  if (now - active.lastHeartbeat < state.heartbeatSeconds * 1000) return;
  active.lastHeartbeat = now;
  const record: LogRecord = {
    timestamp: new Date(now).toISOString(),
    event: "heartbeat",
    phase: active.phase,
    fields: {
      label: active.label,
      phase_label: active.phaseLabel,
      elapsed: formatDuration(now - active.startedAt),
      elapsed_seconds: Math.round((now - active.startedAt) / 100) / 10,
      ...(active.tracks.length > 0 ? { waiting_on: pendingTracks() } : {}),
    },
  };
  journal(record);
  if (state.format === "json") writeLine(state.stdout, JSON.stringify(record));
  else if (!usesTransientProgress()) for (const line of humanLines(record)) writeLine(line.stream ?? state.stdout, line.text);
}

// Track a long-running step ("Rendering 4 panels…") until stopProgress().
// On a redirected stream the label is printed once up front so a log reader
// knows what is in flight before the first heartbeat.
export function startProgress(label: string, opts: { phase?: number; phaseLabel?: string } = {}): void {
  stopProgress();
  const now = Date.now();
  active = { label, phase: opts.phase ?? null, phaseLabel: opts.phaseLabel, startedAt: now, lastHeartbeat: now, tracks: [] };
  if (state.format === "human" && !usesTransientProgress()) {
    writeLine(state.stdout, styled(`  ${terminalText(label)}`, "running"));
  }
  const transient = usesTransientProgress();
  if (!transient && state.heartbeatSeconds <= 0) return;
  const interval = transient ? SPINNER_TICK_MS : state.heartbeatSeconds * 1000;
  ticker = setInterval(() => pollProgress(), interval);
  ticker.unref(); // never keep the process alive on its own
  if (transient) {
    drawSpinner(now);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once("exit", () => clearTransient());
    }
  }
}

// Split the active step into per-item rows ("Rendering panel: a"): each row
// spins until logItem(…, { track: id }) settles it in place. Off a TTY the
// label prints once, like the step label.
export function trackProgress(id: string, label: string): void {
  if (!active) return;
  active.tracks.push({ id, label, startedAt: Date.now(), done: false });
  if (state.format !== "human") return;
  if (usesTransientProgress()) drawSpinner(Date.now());
  else writeLine(state.stdout, styled(`  ${terminalText(label)}`, "running"));
}

export function stopProgress(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = undefined;
  }
  const settled = active?.tracks.flatMap((t) => (t.row === undefined ? [] : [t.row])) ?? [];
  clearTransient();
  active = null;
  for (const line of settled) writeLine(state.stdout, line);
}

export function progressActive(): boolean {
  return active !== null;
}

// Stop timers and forget the journal — call on every terminal path of a run.
export function closeLogging(): void {
  stopProgress();
  detachJournal();
}
