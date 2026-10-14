// Phase 1.5 — Style. Between Phase 1 (plan) and Phase 2 (panels): a single
// text sub-agent designs one figure-wide visual style and writes style.md,
// which every panel agent then applies. Structurally a sibling of Phase 1.

import fs from "node:fs";
import path from "node:path";

import { agentInvoke } from "./agent.js";
import type { PhaseResult, RunContext } from "./context.js";
import { PhaseError } from "./errors.js";
import { logInfo, timerStart, elapsed } from "./log.js";
import { buildPhase1bPrompt } from "./prompts.js";
import { fileExists, fileNonEmpty, readJsonString } from "./reports.js";

export async function runPhase1b(ctx: RunContext): Promise<PhaseResult | void> {
  const report = path.join(ctx.workdir, "style_report.json");
  const log = path.join(ctx.workdir, "logs", "phase1b.log");
  const start = timerStart();

  if (fileExists(report) && !ctx.force && readJsonString(report, "status") === "ok") {
    logInfo("phase1b", `${report} exists (status=ok), skipping (use --force to re-run)`);
    return { status: "skipped", outcome: "already styled · --force re-runs" };
  }

  logInfo("phase1b", `composing style prompt`);
  const promptFile = path.join(ctx.workdir, ".phase1b_prompt.md");
  fs.writeFileSync(
    promptFile,
    buildPhase1bPrompt({
      workdir: ctx.workdir,
      placement: ctx.placement,
      toolkitDir: ctx.toolkitDir,
      python: ctx.python,
    }),
  );

  logInfo("phase1b", `dispatching style sub-agent (streaming log: ${log})`);
  const rc = await agentInvoke(log, promptFile, ctx.workdir, ctx.agent, ctx.env);
  if (rc !== 0) {
    throw new PhaseError(`phase1b sub-agent exited non-zero — see ${log}`, 1, log);
  }
  logInfo("phase1b", `style sub-agent returned ${elapsed(start)} — validating deliverables`);

  if (!fileExists(report)) {
    throw new PhaseError(`missing ${report} after sub-agent run`, 1, log);
  }
  const status = readJsonString(report, "status");
  if (status !== "ok") {
    const reason = readJsonString(report, "reason") || "(no reason given)";
    throw new PhaseError(`phase1b sub-agent reported status=${status} — ${reason}`, 1, log);
  }
  const style = path.join(ctx.workdir, "style.md");
  if (!fileNonEmpty(style)) {
    throw new PhaseError(`expected ${style} to exist and be non-empty`, 1, log);
  }
  logInfo("phase1b", `OK ${elapsed(start)}`);
  return { status: "completed", outcome: "style.md written" };
}
