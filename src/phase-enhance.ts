// Phase 5 — Enhance. Port of scripts/cli/phase5_enhance.sh. Calls
// enhance.py, which talks to OpenAI (gpt-image-2.5-sunburst) or Google (nanobanana)
// depending on ctx.enhanceModel.

import fs from "node:fs";
import path from "node:path";

import type { PhaseResult, RunContext } from "./context.js";
import { PhaseError } from "./errors.js";
import { TeeLog, runCommand } from "./exec.js";
import { timerStart, elapsed } from "./log.js";

export async function runPhase5(ctx: RunContext): Promise<PhaseResult | void> {
  const start = timerStart();
  const inputPng = path.join(ctx.workdir, "figures", "full_figure.png");
  const outPng = path.join(ctx.workdir, "figures", "full_figure_enhanced.png");
  const tee = new TeeLog(path.join(ctx.workdir, "logs", "phase5.log"));

  try {
    if (!fs.existsSync(inputPng)) {
      tee.err("phase5", `input ${inputPng} missing — run phase 4 first`);
      throw new PhaseError(`input ${inputPng} missing — run phase 4 first`, 1, tee.logPath);
    }
    if (fs.existsSync(outPng) && !ctx.force) {
      tee.info("phase5", `${outPng} exists, skipping (use --force to re-run)`);
      return { status: "skipped", outcome: "already enhanced · --force re-runs" };
    }

    tee.info("phase5", `input  = ${inputPng}`);
    tee.info("phase5", `output = ${outPng}`);
    tee.info("phase5", `running enhance.py (model=${ctx.enhanceModel}, quality=${ctx.enhanceQuality}, placement=${ctx.placement}) — this calls the image API, may take a while`);
    await runCommand(
      ctx.python,
      [
        path.join(ctx.toolkitDir, "scripts", "enhance.py"),
        "--workdir",
        `${ctx.workdir}/`,
        "--placement",
        ctx.placement,
        "--model",
        ctx.enhanceModel,
        "--quality",
        ctx.enhanceQuality,
        "--input",
        inputPng,
        "--out",
        outPng,
      ],
      tee,
      // Stamp the phase so enhance.py's usage records are billed to Phase 5.
      // (The Phase 6 repair loop re-runs enhance.py under AUTOILLUSTRATE_PHASE=6.)
      { env: { ...ctx.env, AUTOILLUSTRATE_PHASE: "5" } },
    );

    if (!fs.existsSync(outPng)) {
      tee.err("phase5", `enhance.py did not produce ${outPng}`);
      throw new PhaseError(`enhance.py did not produce ${outPng}`, 1, tee.logPath);
    }
    tee.done("phase5", `OK (${outPng}) ${elapsed(start)}`);
    tee.info("phase5", `quality used: ${ctx.enhanceQuality} — change it with --enhance-quality <q> (the model's own vocabulary, e.g. low|medium|high|xhigh|max|auto on gpt-image-2.5)`);
    return { status: "completed", outcome: `restyled with ${ctx.enhanceModel} at ${ctx.enhanceQuality} quality (--enhance-quality to change)` };
  } finally {
    await tee.close();
  }
}
