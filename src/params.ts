// Records the resolved hyperparameters for a run to params.json, alongside
// metrics/run_metrics.json. Captures the effective values *after* defaults are
// applied (e.g. enhanceModel, panelInspects, agent timeout) so a workdir is a
// self-contained record of how the figure was produced — the CLI flags are
// only echoed to stdout otherwise.

import fs from "node:fs";
import path from "node:path";

import type { RunContext } from "./context.js";

export interface RunParams {
  started_at: string;
  workdir: string;
  source?: string;
  instructions?: string;
  placement_requested: string; // half-width | full-width | infer
  mode: string | null; // light | medium | full — the speed preset (null = none/programmatic)
  agent: {
    agent: string;
    model: string | null; // null = agent's built-in default
    effort: string | null;
    timeout_secs: number;
    debug: boolean;
  };
  enhance_model: string;
  enhance_quality: string; // model-specific, e.g. low | medium | high | xhigh | max | auto
  panel_inspects: number; // 0 = Phase 3 inspect/refine skipped
  enhancement_attempts: number; // n verify attempts + (n-1) repair passes; 1 = Phase 6 skipped
  skip_enhance: boolean;
  interactive: boolean; // paused in the diagrams.net editor after Phase 4
  sequential: boolean;
  force: boolean;
  resume_from_phase: number | null; // null = full run from phase 1
}

export function buildRunParams(args: {
  ctx: RunContext;
  startedAt: string;
  placementRequested: string;
  skipEnhance: boolean;
  interactive?: boolean;
  resumePhase: number;
}): RunParams {
  const { ctx } = args;
  return {
    started_at: args.startedAt,
    workdir: ctx.workdir,
    source: ctx.source,
    instructions: ctx.instructions,
    placement_requested: args.placementRequested,
    mode: ctx.mode ?? null,
    agent: {
      agent: ctx.agent.agent,
      model: ctx.agent.model ?? null,
      effort: ctx.agent.effort ?? null,
      timeout_secs: ctx.agent.timeoutSecs,
      debug: ctx.agent.debug ?? false,
    },
    enhance_model: ctx.enhanceModel,
    enhance_quality: ctx.enhanceQuality,
    panel_inspects: ctx.panelInspects,
    enhancement_attempts: ctx.enhancementAttempts,
    skip_enhance: args.skipEnhance,
    interactive: args.interactive ?? false,
    sequential: ctx.sequential,
    force: ctx.force,
    resume_from_phase: args.resumePhase > 0 ? args.resumePhase : null,
  };
}

export function writeRunParams(workdir: string, p: RunParams): void {
  fs.writeFileSync(path.join(workdir, "params.json"), JSON.stringify(p, null, 2) + "\n");
}
