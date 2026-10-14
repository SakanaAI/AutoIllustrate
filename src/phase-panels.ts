// Phases 2 & 3 — per-panel sub-agent fan-out. Port of phase2_panels.sh and
// phase3_inspect.sh, which are structurally identical: read panel ids from
// figure.json, dispatch one sub-agent per panel (parallel by default, serial
// with --sequential), and validate each panel's on-disk report + deliverables
// as its sub-agent returns. Every panel is validated before the phase fails.
//
// A non-zero sub-agent exit is only a WARNING in either mode — it also fires
// when the watchdog kills an agent that already wrote its deliverables. The
// validated report is the sole judge of panel success.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { agentInvoke } from "./agent.js";
import type { PhaseResult, RunContext } from "./context.js";
import { PhaseError } from "./errors.js";
import { logErr, logInfo, logItem, logWarn, timerStart, trackProgress, elapsed } from "./log.js";
import { buildPhase2Prompt, buildPhase3Prompt, describePanelShare } from "./prompts.js";
import { fileExists, fileNonEmpty, panelIds, readJson, readJsonString } from "./reports.js";

interface PanelPhaseSpec {
  name: string; // "phase2" | "phase3"
  noun: string; // "panel" | "inspect"
  reportFile: (workdir: string, pid: string) => string;
  promptFile: (workdir: string, pid: string) => string;
  logFile: (workdir: string, pid: string) => string;
  buildPrompt: (ctx: RunContext, pid: string) => string;
  // Files (beyond an ok/degraded report) required to skip re-dispatch.
  skipDeliverables: (workdir: string, pid: string) => string[];
  // Files required for a panel to count as successful after the join.
  requiredDeliverables: (workdir: string, pid: string) => string[];
  // Hard precondition checked before skip/dispatch (phase3: Phase 2 PNG).
  precondition?: (workdir: string, pid: string) => string | null;
  // Extra post-join check beyond report status + deliverable existence.
  // Returns a message (logged as a WARNING, run continues) or null (passes).
  // phase2 uses it to flag a build_params() page_w/page_h contract violation;
  // Phase 4 compose catches and repairs the same failure via its sub-agent.
  extraCheck?: (ctx: RunContext, pid: string) => string | null;
}

const panelPng = (workdir: string, pid: string) => path.join(workdir, "panels", `${pid}.png`);

// Every generate_<panel>.py imports the shared geometry-validation library
// `panel_geometry.py`. It must live in the workdir next to the generators so
// the import resolves in all three load contexts (panel agent, compose,
// check_params_contract). The agent copies only the generator template, so the
// orchestrator stages the library here — overwriting any stale copy so a
// workdir carried across toolkit versions always mirrors the current checks.
// A copy failure is WARN-only, consistent with the rest of the phase: panels
// that need the library then fail via the authoritative report/deliverable
// validation rather than aborting the whole phase with a raw fs error.
function stagePanelGeometry(ctx: RunContext): void {
  const src = path.join(ctx.toolkitDir, "assets", "panel_geometry.py");
  const dst = path.join(ctx.workdir, "panel_geometry.py");
  try {
    fs.copyFileSync(src, dst);
  } catch (err) {
    logWarn("phase2", `could not stage panel_geometry.py into workdir: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const PHASE2_SPEC: PanelPhaseSpec = {
  name: "phase2",
  noun: "panel",
  reportFile: (w, pid) => path.join(w, `phase2_report_${pid}.json`),
  promptFile: (w, pid) => path.join(w, `.phase2_prompt_${pid}.md`),
  logFile: (w, pid) => path.join(w, "logs", `panel_${pid}.log`),
  buildPrompt: (ctx, pid) =>
    buildPhase2Prompt({
      workdir: ctx.workdir,
      panelId: pid,
      panelShare: describePanelShare(readJson(path.join(ctx.workdir, "figure.json")), pid, ctx.placement),
      placement: ctx.placement,
      toolkitDir: ctx.toolkitDir,
      python: ctx.python,
    }),
  skipDeliverables: panelPngOnly,
  requiredDeliverables: panelPngOnly,
  extraCheck: checkParamsContract,
};

export const PHASE3_SPEC: PanelPhaseSpec = {
  name: "phase3",
  noun: "inspect",
  reportFile: (w, pid) => path.join(w, `phase3_report_${pid}.json`),
  promptFile: (w, pid) => path.join(w, `.phase3_prompt_${pid}.md`),
  logFile: (w, pid) => path.join(w, "logs", `inspect_${pid}.log`),
  buildPrompt: (ctx, pid) =>
    buildPhase3Prompt({
      workdir: ctx.workdir,
      panelId: pid,
      placement: ctx.placement,
      toolkitDir: ctx.toolkitDir,
      python: ctx.python,
      panelInspects: ctx.panelInspects,
    }),
  skipDeliverables: phase3Deliverables,
  requiredDeliverables: phase3Deliverables,
  precondition: (w, pid) => (fileExists(panelPng(w, pid)) ? null : `missing Phase 2 PNG ${panelPng(w, pid)} — cannot inspect`),
};

function panelPngOnly(workdir: string, pid: string): string[] {
  return [panelPng(workdir, pid)];
}

// The Phase 4 composer requires every panel's build_params() to accept
// bypass_warnings=True and return page_w/page_h — it reads them as panel_sizes
// for layout and to size the page frame (generate_composite.py /
// scripts/compose.py). A panel can render a perfectly valid PNG without
// honouring either, so the omission stays invisible through Phase 2 and only
// surfaces at compose. scripts/check_params_contract.py is the single source
// of truth for this gate: the panel agent runs the very same script as a
// self-test before declaring success, so a clean self-test guarantees this
// passes. A failure here is WARN-only — the run proceeds and Phase 4's compose
// sub-agent repairs the generator (see runPanelPhase + phase-compose.ts).
function checkParamsContract(ctx: RunContext, pid: string): string | null {
  const generator = path.join(ctx.workdir, `generate_${pid}.py`);
  if (!fileExists(generator)) {
    return `missing ${generator} — cannot verify page_w/page_h contract`;
  }
  const checker = path.join(ctx.toolkitDir, "scripts", "check_params_contract.py");
  const res = spawnSync(ctx.python, [checker, generator], {
    cwd: ctx.workdir,
    env: ctx.env,
    encoding: "utf8",
  });
  if (res.status === 0) return null;
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const missing = output.match(/MISSING:([\w,]*)/);
  if (missing) {
    return `build_params() omits ${missing[1].split(",").join(" / ")} — Phase 4 compose requires page_w/page_h for layout`;
  }
  if (res.error) {
    return `could not verify page_w/page_h contract: ${res.error.message}`;
  }
  return `build_params() page_w/page_h check failed (rc=${res.status}): ${output.trim().slice(-300)}`;
}

function phase3Deliverables(workdir: string, pid: string): string[] {
  return [
    panelPng(workdir, pid),
    path.join(workdir, "panels", `${pid}.inspect.json`),
    path.join(workdir, `unit_test_inspections_${pid}.jsonl`),
  ];
}

interface DispatchOutcome {
  rc: number; // sub-agent rc (0 also for a sentinel-based skip)
  durationMs: number;
  skipped: boolean; // sentinel + deliverables already present
}

// Dispatch one panel. Mirrors dispatch_one(): returns the sub-agent rc
// (0 also for a sentinel-based skip); throws nothing.
async function dispatchOne(ctx: RunContext, spec: PanelPhaseSpec, pid: string): Promise<DispatchOutcome> {
  const tag = `${spec.name}[${pid}]`;
  const report = spec.reportFile(ctx.workdir, pid);
  const log = spec.logFile(ctx.workdir, pid);
  const start = timerStart();
  const outcome = (rc: number, skipped = false): DispatchOutcome => ({ rc, durationMs: Date.now() - start, skipped });

  const preconditionFailure = spec.precondition?.(ctx.workdir, pid) ?? null;
  if (preconditionFailure) {
    logErr(tag, preconditionFailure);
    return outcome(1);
  }

  if (fileExists(report) && !ctx.force) {
    const status = readJsonString(report, "status");
    if (
      (status === "ok" || status === "degraded") &&
      spec.skipDeliverables(ctx.workdir, pid).every(fileExists)
    ) {
      logInfo(tag, `${report} exists (status=${status}), skipping`);
      return outcome(0, true);
    }
  }

  logInfo(tag, `dispatching ${spec.noun} sub-agent (streaming log: ${log})`);

  // Prompt build/write inside the try: a dispatch failure (ENOSPC, EACCES,
  // spawn error) must degrade to a warning with its real reason in BOTH
  // parallel and sequential mode — the post-join report check is the judge.
  let rc = 0;
  try {
    const promptFile = spec.promptFile(ctx.workdir, pid);
    fs.writeFileSync(promptFile, spec.buildPrompt(ctx, pid));
    rc = await agentInvoke(log, promptFile, ctx.workdir, ctx.agent, ctx.env);
  } catch (err) {
    logErr(tag, `sub-agent dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    rc = 1;
  }
  logInfo(tag, `${spec.noun} sub-agent returned (rc=${rc}) ${elapsed(start)}`);
  return outcome(rc);
}

export async function runPanelPhase(ctx: RunContext, spec: PanelPhaseSpec): Promise<PhaseResult> {
  const start = timerStart();
  const figureJson = path.join(ctx.workdir, "figure.json");
  if (!fileNonEmpty(figureJson)) {
    throw new PhaseError(`${figureJson} missing — run phase 1 first`, 1);
  }
  const ids = panelIds(figureJson);
  if (ids.length === 0) {
    throw new PhaseError("figure.json has no panels", 1);
  }
  stagePanelGeometry(ctx);
  const phaseNo = spec.noun === "panel" ? 2 : 3;
  const verb = spec.noun === "panel" ? "Rendering" : "Inspecting";
  logInfo(spec.name, `${ids.length} panel(s) to ${spec.noun === "panel" ? "render" : "inspect"}: ${ids.join(" ")}`);

  let fail = 0;
  let degraded = 0;
  let reused = 0;

  // Authoritative validation, run the moment a panel's sub-agent returns. The
  // item line is the user-facing verdict (it replaces the panel's progress
  // row); the exact paths go to the journal / --verbose as diagnostics.
  const validate = (pid: string, dispatched: DispatchOutcome | undefined): void => {
    const tag = `${spec.name}[${pid}]`;
    const report = spec.reportFile(ctx.workdir, pid);
    const durationMs = dispatched && !dispatched.skipped ? dispatched.durationMs : undefined;
    const item = (status: "ok" | "degraded" | "failed", detail: string) => logItem(status, pid, { detail, durationMs, phase: phaseNo, track: pid });
    if (!fileExists(report)) {
      logInfo(tag, `missing ${report}`);
      item("failed", "no report written");
      fail++;
      return;
    }
    const status = readJsonString(report, "status");
    if (status === "ok" || status === "degraded") {
      const missing = spec.requiredDeliverables(ctx.workdir, pid).filter((f) => !fileExists(f));
      if (missing.length > 0) {
        logInfo(tag, `status=${status} but deliverables missing: ${missing.join(" ")}`);
        item("failed", `deliverables missing: ${missing.map((f) => path.basename(f)).join(", ")}`);
        fail++;
        return;
      }
      // The extra check (phase2's build_params contract) is WARN-only: a
      // violation no longer kills the run. Phase 4's deterministic compose
      // hits the same broken build_params, throws, and dispatches the compose
      // sub-agent that repairs the panel generator (phase-compose.ts). Failing
      // hard here would instead nuke every sibling panel for one bad generator.
      const extraError = spec.extraCheck?.(ctx, pid) ?? null;
      if (extraError) {
        logWarn(tag, `status=${status} but ${extraError} — deferring to Phase 4 compose (agent can repair)`);
      }
      logInfo(tag, `status=${status}, deliverables present`);
      const detailParts = [status === "ok" ? "ok" : "degraded"];
      if (dispatched?.skipped) {
        detailParts.push("reused from an earlier run");
        reused++;
      }
      if (extraError) detailParts.push("build_params contract violated");
      if (status === "degraded" || extraError) degraded++;
      item(status === "ok" && !extraError ? "ok" : "degraded", detailParts.join(" · "));
    } else {
      const doc = readJson(report) as { residual_issues?: unknown[] } | null;
      const reason = Array.isArray(doc?.residual_issues) ? doc.residual_issues.join("; ") : "";
      logInfo(tag, `status=${status}${reason ? ` — ${reason}` : ""}`);
      item("failed", `status ${status || "unknown"}${reason ? ` · ${reason}` : ""}`);
      fail++;
    }
  };

  const runOne = async (pid: string): Promise<void> => {
    trackProgress(pid, `${verb} panel: ${pid}`);
    let outcome: DispatchOutcome | undefined;
    try {
      outcome = await dispatchOne(ctx, spec, pid);
    } catch (err) {
      // dispatchOne catches its own errors; this is a last-resort surface.
      logErr(spec.name, `${spec.noun} ${pid} dispatch rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (outcome?.rc !== 0) {
      logWarn(spec.name, `${spec.noun} ${pid} sub-agent exited non-zero (watchdog timeout or error) — deferring to its report`);
    }
    validate(pid, outcome);
  };

  if (ctx.sequential) {
    logInfo(spec.name, `running ${ids.length} ${spec.noun} sub-agent(s) sequentially`);
    for (const pid of ids) await runOne(pid);
  } else {
    logInfo(spec.name, `forking ${ids.length} ${spec.noun} sub-agent(s) in parallel`);
    await Promise.all(ids.map(runOne));
  }

  logInfo(spec.name, `all ${spec.noun} sub-agents joined ${elapsed(start)}`);

  if (fail > 0) {
    throw new PhaseError(
      `${fail} panel(s) failed — see ${path.join(ctx.workdir, "logs", `${spec.noun === "panel" ? "panel" : "inspect"}_*.log`)}`,
      1,
    );
  }
  logInfo(spec.name, `OK (${ids.length} panels) ${elapsed(start)}`);
  const summary = [`${ids.length - degraded}/${ids.length} panels ok`];
  if (degraded > 0) summary.push(`${degraded} degraded`);
  if (reused === ids.length) summary.push("all reused from an earlier run");
  else if (reused > 0) summary.push(`${reused} reused`);
  return { status: degraded > 0 ? "degraded" : reused === ids.length ? "skipped" : "completed", outcome: summary.join(" · ") };
}
