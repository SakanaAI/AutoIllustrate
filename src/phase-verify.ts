// Phase 6 — Verify + repair. Port of scripts/cli/phase6_verify.sh. A single
// sub-agent owns the verify → repair → re-enhance loop and winner selection.

import fs from "node:fs";
import path from "node:path";

import { agentInvoke } from "./agent.js";
import type { PhaseResult, RunContext } from "./context.js";
import { PhaseError } from "./errors.js";
import { logErr, logInfo, timerStart, elapsed } from "./log.js";
import { buildPhase6Prompt } from "./prompts.js";
import { fileExists, readJson, readJsonString } from "./reports.js";

export async function runPhase6(ctx: RunContext): Promise<PhaseResult | void> {
  const report = path.join(ctx.workdir, "phase6_report.json");
  const log = path.join(ctx.workdir, "logs", "phase6.log");
  const start = timerStart();

  // Unlike phase 1, the skip check has no status condition (phase6_verify.sh:22-25).
  if (fileExists(report) && !ctx.force) {
    logInfo("phase6", `${report} exists, skipping (use --force to re-run)`);
    return { status: "skipped", outcome: "already verified · --force re-runs" };
  }
  if (!fileExists(path.join(ctx.workdir, "figures", "full_figure_enhanced.png"))) {
    logErr("phase6", "enhanced PNG missing — phase 5 must run first");
    throw new PhaseError("enhanced PNG missing — phase 5 must run first", 1);
  }

  const promptFile = path.join(ctx.workdir, ".phase6_prompt.md");
  fs.writeFileSync(
    promptFile,
    buildPhase6Prompt({
      workdir: ctx.workdir,
      placement: ctx.placement,
      toolkitDir: ctx.toolkitDir,
      python: ctx.python,
      enhancementAttempts: ctx.enhancementAttempts,
      enhanceModel: ctx.enhanceModel,
      enhanceQuality: ctx.enhanceQuality,
    }),
  );

  logInfo("phase6", `dispatching verify-repair sub-agent (streaming log: ${log})`);
  // Stamp the phase so any re-enhance the repair loop runs (enhance.py, which
  // otherwise defaults to Phase 5) is billed to Phase 6, where it actually ran.
  const rc = await agentInvoke(log, promptFile, ctx.workdir, ctx.agent, { ...ctx.env, AUTOILLUSTRATE_PHASE: "6" });
  if (rc !== 0) {
    throw new PhaseError(`phase6 sub-agent exited non-zero — see ${log}`, 1, log);
  }
  logInfo("phase6", `verify-repair sub-agent returned ${elapsed(start)} — validating report`);

  if (!fileExists(report)) {
    throw new PhaseError(`missing ${report} after sub-agent run`, 1, log);
  }
  const shipped = readJsonString(report, "shipped");
  if (shipped !== "enhanced" && shipped !== "deterministic") {
    throw new PhaseError(`phase6 report has invalid 'shipped' value: ${shipped}`, 1, log);
  }

  const doc = readJson(report) as { winner_attempt?: unknown; summary?: unknown } | null;
  logInfo("phase6", `OK (winner=${doc?.winner_attempt ?? ""}, shipped=${shipped}) ${elapsed(start)}`);
  const winner = doc?.winner_attempt !== undefined && doc?.winner_attempt !== null && doc?.winner_attempt !== "" ? `winner attempt ${doc.winner_attempt} · ` : "";
  // Verification may reject every enhanced candidate and ship the
  // deterministic export: the phase completed, but the reader should notice.
  return { status: shipped === "enhanced" ? "completed" : "degraded", outcome: `${winner}shipped ${shipped}` };
}
