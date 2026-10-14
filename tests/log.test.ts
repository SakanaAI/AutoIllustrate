import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  attachJournal,
  closeLogging,
  configureLogging,
  logDetail,
  logInfo,
  logItem,
  logPhaseEnd,
  logPhaseStart,
  logPipelineEnd,
  logRunStart,
  logWarn,
  pollProgress,
  startProgress,
  stopProgress,
  trackProgress,
  writeExternal,
} from "../src/log.js";
import { stripAnsi } from "../src/terminal.js";

const CLEAR = "\r\u001b[2K";
const UP = "\u001b[1A";

class FakeStream {
  chunks: string[] = [];
  isTTY: boolean;
  columns = 80;
  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

function setup(opts: { verbose?: boolean; format?: "human" | "json"; tty?: boolean; heartbeatSeconds?: number } = {}) {
  const stdout = new FakeStream(opts.tty ?? false);
  const stderr = new FakeStream(opts.tty ?? false);
  configureLogging({
    stdout,
    stderr,
    verbose: opts.verbose ?? false,
    format: opts.format ?? "human",
    heartbeatSeconds: opts.heartbeatSeconds ?? 60,
    env: { NO_COLOR: "1" },
  });
  return { stdout, stderr };
}

function restore() {
  closeLogging();
  configureLogging({ stdout: process.stdout, stderr: process.stderr, verbose: false, format: "human", heartbeatSeconds: 60, env: process.env });
}

test("human view: run header, phase block, item lines, and finish line", () => {
  const { stdout, stderr } = setup();
  try {
    logRunStart({ header: ["Autoillustrate · paper.pdf · medium mode", "Run dir: runs/x"], details: ["logs: /abs/logs"] });
    logPhaseStart(2, "2", 6, "Render panels");
    logDetail("Panels: a, b");
    logItem("ok", "a", { detail: "ok", durationMs: 182_000 });
    logItem("degraded", "b", { detail: "degraded", durationMs: 241_000 });
    logPhaseEnd({ phase: 2, title: "Render panels", status: "degraded", outcome: "1/2 panels ok · 1 degraded", durationMs: 241_000, tokens: 12_345, runTokens: 45_678 });
    logPhaseEnd({ phase: 3, title: "Inspect", status: "skipped", outcome: "--panel-inspects 0" });
    logPipelineEnd("completed", 3_725_000);
    const out = stdout.text();
    assert.match(out, /AutoIllustrate|█/); // wordmark
    assert.match(out, /^Autoillustrate · paper\.pdf · medium mode$/m);
    assert.doesNotMatch(out, /logs: \/abs\/logs/); // details are --verbose only
    assert.match(out, /^Phase 2\/6 · Render panels$/m);
    assert.match(out, /^  Panels: a, b$/m);
    assert.match(out, /^  ✓ a · ok · 3m 2s$/m);
    assert.match(out, /^  ⚠ b · degraded · 4m 1s$/m);
    assert.match(out, /^  ⚠ degraded · 1\/2 panels ok · 1 degraded · 4m 1s · 12\.3k tokens \(run 45\.7k\)$/m);
    assert.match(out, /^  – skipped · --panel-inspects 0$/m);
    assert.match(out, /^Pipeline finished · completed · 1h 2m$/m);
    assert.equal(stderr.text(), "");
  } finally {
    restore();
  }
});

test("info diagnostics are hidden by default and shown with --verbose; warnings always reach stderr", () => {
  const quiet = setup();
  try {
    logInfo("agent", "launching headless claude");
    logWarn("phase2", "sub-agent exited non-zero");
    assert.equal(quiet.stdout.text(), "");
    assert.match(quiet.stderr.text(), /^  ⚠ phase2 · sub-agent exited non-zero$/m);
  } finally {
    restore();
  }
  const verbose = setup({ verbose: true });
  try {
    logInfo("agent", "launching headless claude");
    logRunStart({ header: ["h"], details: ["logs: /abs/logs"] });
    assert.match(verbose.stdout.text(), /^  agent: launching headless claude$/m);
    assert.match(verbose.stdout.text(), /^  logs: \/abs\/logs$/m);
  } finally {
    restore();
  }
});

test("json format terminates a partial external chunk on stderr, never on stdout", () => {
  const { stdout, stderr } = setup({ format: "json" });
  try {
    const dest = writeExternal("half a line");
    assert.equal(dest, stderr);
    logDetail("next event");
    // stderr got the newline; stdout is still exactly one JSON record per line
    assert.equal(stderr.text(), "half a line\n");
    const lines = stdout.text().split("\n");
    assert.equal(lines.at(-1), "");
    assert.equal(lines.length, 2, stdout.text());
    assert.equal((JSON.parse(lines[0]) as { event: string }).event, "detail");
  } finally {
    restore();
  }
});

test("json format writes one record per line and routes external output to stderr", () => {
  const { stdout, stderr } = setup({ format: "json" });
  try {
    logPhaseStart(1, "1", 6, "Plan");
    logPhaseEnd({ phase: 1, title: "Plan", status: "completed", outcome: "4 panels", durationMs: 130_000 });
    writeExternal("raw agent chatter\n");
    const records = stdout
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; phase: number | null; fields: Record<string, unknown> });
    assert.deepEqual(
      records.map((r) => r.event),
      ["phase_start", "phase_end"],
    );
    assert.equal(records[1].phase, 1);
    assert.equal(records[1].fields.elapsed, "2m 10s");
    assert.equal(records[1].fields.elapsed_seconds, 130);
    assert.equal(stderr.text(), "raw agent chatter\n");
  } finally {
    restore();
  }
});

test("journal receives every record including hidden diagnostics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-journal-"));
  const journal = path.join(dir, "events.jsonl");
  setup();
  try {
    attachJournal(journal);
    logInfo("phase1", "hidden plumbing");
    logDetail("Placement: full-width");
    const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]) as { event: string; timestamp: string; fields: Record<string, unknown> };
    assert.equal(first.event, "message");
    assert.equal(first.fields.level, "info");
    assert.match(first.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("redirected output: the running label prints once and heartbeats follow the interval", () => {
  const { stdout } = setup({ heartbeatSeconds: 30 });
  try {
    const t0 = Date.now();
    startProgress("Rendering 4 panels…", { phase: 2, phaseLabel: "2/6" });
    assert.match(stdout.text(), /^  Rendering 4 panels…$/m);
    pollProgress(t0 + 10_000);
    assert.doesNotMatch(stdout.text(), /still running/);
    // t0 is taken before startProgress reads its own clock, so poll mid-second:
    // a millisecond of drift must not turn 31s into 30s.
    pollProgress(t0 + 31_500);
    assert.match(stdout.text(), /^  Phase 2\/6 · Rendering 4 panels… 31s · still running$/m);
    stopProgress();
    assert.doesNotMatch(stdout.text(), /\r/); // no cursor games off a TTY
  } finally {
    restore();
  }
});

test("interactive terminal: spinner redraws in place and is cleared before other lines", () => {
  const { stdout } = setup({ tty: true });
  try {
    startProgress("Planning the figure…", { phase: 1 });
    assert.ok(stdout.text().endsWith(`${CLEAR}  ⠋ Planning the figure… 0s`), stdout.text());
    pollProgress(Date.now() + 1000);
    assert.ok(stdout.text().endsWith("⠙ Planning the figure… 1s"));
    stdout.chunks.length = 0;
    logDetail("Placement: full-width");
    // clear-line first, then the real line
    assert.equal(stripAnsi(stdout.text()), `${CLEAR}  Placement: full-width\n`);
    stdout.chunks.length = 0;
    writeExternal("partial chunk without newline");
    pollProgress(Date.now() + 2000);
    // a dangling external chunk gets its own newline before the spinner returns
    assert.ok(stdout.text().startsWith(`partial chunk without newline\n${CLEAR}  ⠹ Planning`), stdout.text());
    stopProgress();
    assert.ok(stdout.text().endsWith(CLEAR));
  } finally {
    restore();
  }
});

test("interactive terminal: tracked items get one spinner row each and settle in place", () => {
  const { stdout } = setup({ tty: true });
  // the spinner frame counter is module-global, so compare frame-agnostically
  const shown = () => stdout.text().replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/gu, "⠋");
  try {
    startProgress("Rendering 2 panels…", { phase: 2, phaseLabel: "2/6" });
    trackProgress("a", "Rendering panel: a");
    stdout.chunks.length = 0;
    trackProgress("b", "Rendering panel: b");
    // the one-row block is erased, then redrawn one row per panel
    assert.equal(shown(), `${CLEAR}${CLEAR}  ⠋ Rendering panel: a 0s\n${CLEAR}  ⠋ Rendering panel: b 0s`);
    stdout.chunks.length = 0;
    logItem("ok", "a", { detail: "ok", durationMs: 2000, phase: 2, track: "a" });
    // a two-row block is erased bottom-up before the repaint
    assert.equal(shown(), `${CLEAR}${UP}${CLEAR}${CLEAR}  ✓ a · ok · 2s\n${CLEAR}  ⠋ Rendering panel: b 0s`);
    stdout.chunks.length = 0;
    logWarn("phase2", "panel b sub-agent exited non-zero");
    // another line clears the whole block first; the next tick repaints it
    assert.equal(shown(), `${CLEAR}${UP}${CLEAR}`);
    stdout.chunks.length = 0;
    pollProgress(Date.now() + 1000);
    assert.equal(shown(), `${CLEAR}  ✓ a · ok · 2s\n${CLEAR}  ⠋ Rendering panel: b 1s`);
    logItem("failed", "b", { detail: "no report written", phase: 2, track: "b" });
    stdout.chunks.length = 0;
    stopProgress();
    // settled rows become permanent lines, in panel order
    assert.equal(shown(), `${CLEAR}${UP}${CLEAR}  ✓ a · ok · 2s\n  ✗ b · no report written\n`);
  } finally {
    restore();
  }
});

test("redirected output: tracked items print their label once and heartbeats name the pending ones", () => {
  const { stdout } = setup({ heartbeatSeconds: 30 });
  try {
    const t0 = Date.now();
    startProgress("Rendering 2 panels…", { phase: 2, phaseLabel: "2/6" });
    trackProgress("a", "Rendering panel: a");
    trackProgress("b", "Rendering panel: b");
    logItem("ok", "a", { detail: "ok", phase: 2, track: "a" });
    pollProgress(t0 + 31_500);
    stopProgress();
    assert.equal(
      stdout.text(),
      "  Rendering 2 panels…\n  Rendering panel: a\n  Rendering panel: b\n  ✓ a · ok\n  Phase 2/6 · Rendering 2 panels… 31s · still running · waiting on b\n",
    );
  } finally {
    restore();
  }
});

test("json output: tracked items emit item_result records and heartbeats carry waiting_on", () => {
  const { stdout } = setup({ format: "json", heartbeatSeconds: 30 });
  try {
    const t0 = Date.now();
    startProgress("Rendering 2 panels…", { phase: 2, phaseLabel: "2/6" });
    trackProgress("a", "Rendering panel: a");
    trackProgress("b", "Rendering panel: b");
    logItem("ok", "a", { detail: "ok", phase: 2, track: "a" });
    pollProgress(t0 + 31_500);
    stopProgress();
    const records = stdout.text().trim().split("\n").map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });
    assert.deepEqual(records.map((r) => r.event), ["item_result", "heartbeat"]);
    assert.equal(records[0].fields.label, "a");
    assert.deepEqual(records[1].fields.waiting_on, ["b"]);
  } finally {
    restore();
  }
});
