// Phase 1 — Plan. Port of scripts/cli/phase1_plan.sh.

import fs from "node:fs";
import path from "node:path";

import { agentInvoke } from "./agent.js";
import type { PhaseResult, RunContext } from "./context.js";
import { PhaseError } from "./errors.js";
import { logErr, logInfo, timerStart, elapsed } from "./log.js";
import { buildPhase1Prompt } from "./prompts.js";
import { fileExists, fileNonEmpty, readJson, readJsonString } from "./reports.js";

export async function runPhase1(ctx: RunContext): Promise<PhaseResult | void> {
  const report = path.join(ctx.workdir, "phase1_report.json");
  const log = path.join(ctx.workdir, "logs", "phase1.log");
  const start = timerStart();

  if (fileExists(report) && !ctx.force && readJsonString(report, "status") === "ok") {
    logInfo("phase1", `${report} exists (status=ok), skipping (use --force to re-run)`);
    return { status: "skipped", outcome: "already planned · --force re-runs" };
  }
  if (!ctx.source || !ctx.instructions) {
    throw new PhaseError("phase1 requires --source and --prompt", 2);
  }

  logInfo("phase1", `composing planner prompt (source=${ctx.source}, placement=${ctx.placement})`);
  const promptFile = path.join(ctx.workdir, ".phase1_prompt.md");
  fs.writeFileSync(
    promptFile,
    buildPhase1Prompt({
      workdir: ctx.workdir,
      source: ctx.source,
      placement: ctx.placement,
      toolkitDir: ctx.toolkitDir,
      python: ctx.python,
      instructions: ctx.instructions,
    }),
  );

  logInfo("phase1", `dispatching planner sub-agent (streaming log: ${log})`);
  const rc = await agentInvoke(log, promptFile, ctx.workdir, ctx.agent, ctx.env);
  if (rc !== 0) {
    throw new PhaseError(`phase1 sub-agent exited non-zero — see ${log}`, 1, log);
  }
  logInfo("phase1", `planner sub-agent returned ${elapsed(start)} — validating deliverables`);

  if (!fileExists(report)) {
    throw new PhaseError(`missing ${report} after sub-agent run`, 1, log);
  }
  const status = readJsonString(report, "status");
  if (status !== "ok") {
    const reason = readJsonString(report, "reason") || "(no reason given)";
    throw new PhaseError(`phase1 sub-agent reported status=${status} — ${reason}`, 1, log);
  }
  for (const f of ["figure.json", "methods.md", "theme.txt"]) {
    if (!fileNonEmpty(path.join(ctx.workdir, f))) {
      throw new PhaseError(`expected ${path.join(ctx.workdir, f)} to exist and be non-empty`, 1, log);
    }
    logInfo("phase1", `deliverable present: ${f}`);
  }

  const doc = readJson(report) as { panel_ids?: unknown[]; placement?: unknown } | null;
  const panelCount = Array.isArray(doc?.panel_ids) ? doc.panel_ids.length : 0;
  logInfo("phase1", `OK (${panelCount} panels) ${elapsed(start)}`);
  const placement = typeof doc?.placement === "string" ? ` · ${doc.placement}` : "";
  return { status: "completed", outcome: `${panelCount} panel${panelCount === 1 ? "" : "s"}${placement}` };
}

// Placement readback after Phase 1 (run.sh:249-258) — works whether phase 1
// just ran or was skipped via --resume-from.
export function readPlacement(workdir: string): string {
  const report = path.join(workdir, "phase1_report.json");
  if (!fileExists(report)) {
    logErr("run", `${report} missing — cannot resume without Phase 1 output`);
    throw new PhaseError(`${report} missing`, 1);
  }
  const placement = readJsonString(report, "placement");
  if (placement !== "half-width" && placement !== "full-width") {
    throw new PhaseError(`phase1 produced invalid placement: ${placement}`, 1);
  }
  return placement;
}
