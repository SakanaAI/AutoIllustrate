// Phase 4 — Compose. Port of scripts/cli/phase4_compose.sh. Deterministic:
// compose.py → lint_math.py → generate_composite.py → drawio PNG export →
// dimension check (warn-only; the deterministic outputs always ship). When the
// deterministic path throws, the composition is handed to a sub-agent
// (composeViaAgent) instead of failing the whole pipeline.

import fs from "node:fs";
import path from "node:path";

import { agentInvoke } from "./agent.js";
import type { PhaseResult, RunContext } from "./context.js";
import { PhaseError } from "./errors.js";
import { TeeLog, runCommand } from "./exec.js";
import { exportDrawioPngRobust } from "./export-png.js";
import { timerStart, elapsed } from "./log.js";
import { buildPhase4Prompt } from "./prompts.js";
import { fileNonEmpty } from "./reports.js";

export const TARGET_WIDTH = 2560;
const TARGET_HEIGHTS: Record<string, number> = { "half-width": 1440, "full-width": 1100 };

// drawio-desktop's headless export races MathJax typesetting: math-heavy
// composites intermittently die on an unhandled UnknownVizError rejection
// and idle forever (observed up to deterministic per-file, drawio 30.0.4).
// A healthy export takes seconds, so fail each attempt fast; after the
// direct attempts, fall back to SVG + headless-Chrome rasterization
// (export-png.ts), which dodges the wedge entirely.
export const DRAWIO_EXPORT_ATTEMPTS = 2;
export const DRAWIO_EXPORT_TIMEOUT_SECS = 120;

const PIL_DIMS_SNIPPET = "import sys\nfrom PIL import Image\nwith Image.open(sys.argv[1]) as im:\n    print(im.width, im.height)\n";

export async function runPhase4(ctx: RunContext): Promise<PhaseResult | void> {
  const start = timerStart();
  const pngOut = path.join(ctx.workdir, "figures", "full_figure.png");
  const tee = new TeeLog(path.join(ctx.workdir, "logs", "phase4.log"));

  try {
    if (fs.existsSync(pngOut) && !ctx.force) {
      tee.info("phase4", `${pngOut} exists, skipping (use --force to re-run)`);
      return { status: "skipped", outcome: "already composed · --force re-runs" };
    }

    // The interpreter is a hard precondition kept OUTSIDE the agent fallback:
    // the sub-agent runs the same $PYTHON, so a broken one is unrecoverable.
    try {
      fs.accessSync(ctx.python, fs.constants.X_OK);
    } catch {
      tee.err("phase4", `python interpreter not executable: ${ctx.python}`);
      throw new PhaseError(`python interpreter not executable: ${ctx.python}`, 1, tee.logPath);
    }

    try {
      return await runDeterministicCompose(ctx, tee, start);
    } catch (err) {
      // A deterministic compose failure no longer kills the run: hand the
      // composition to a sub-agent that diagnoses phase4.log and repairs
      // whatever broke (a panel generator, a lint error, a drawio export
      // wedge). Only if the agent ALSO fails to produce a figure does the
      // phase — and the pipeline — fail.
      const msg = err instanceof Error ? err.message : String(err);
      tee.warn("phase4", `deterministic compose failed: ${msg} — dispatching compose sub-agent`);
      return await composeViaAgent(ctx, tee, start);
    }
  } finally {
    await tee.close();
  }
}

// The deterministic composition (compose.py → lint → generate → export →
// warn-only dimension check). Throws PhaseError on any hard failure; the
// dimension check is warn-only and never throws, so it does not trigger the
// agent fallback.
async function runDeterministicCompose(ctx: RunContext, tee: TeeLog, start: number): Promise<PhaseResult> {
  const pngOut = path.join(ctx.workdir, "figures", "full_figure.png");
  const drawioOut = path.join(ctx.workdir, "figures", "full_figure.drawio");
  const scripts = path.join(ctx.toolkitDir, "scripts");

  tee.step("phase4", 1, 4, "composing template + generator (compose.py)");
  await runCommand(
    ctx.python,
    [path.join(scripts, "compose.py"), "--workdir", `${ctx.workdir}/`, "--out-dir", `${path.join(ctx.workdir, "figures")}/`],
    tee,
    { env: ctx.env },
  );

  tee.step("phase4", 2, 4, "linting composite template (lint_math.py)");
  await runCommand(
    ctx.python,
    [path.join(scripts, "lint_math.py"), path.join(ctx.workdir, "composite.drawio.template")],
    tee,
    { env: ctx.env },
  );

  tee.step("phase4", 3, 4, "running generate_composite.py");
  // Always bypass geometry WARNINGS at compose: blocking on warnings is
  // Phase 2's responsibility (each panel's generator already gated them at
  // render time). ERRORS still abort inside build_params regardless.
  await runCommand(ctx.python, [path.join(ctx.workdir, "generate_composite.py"), "--bypass-warnings"], tee, { env: ctx.env });

  if (!fs.existsSync(drawioOut)) {
    tee.err("phase4", `${drawioOut} not produced by generator`);
    throw new PhaseError(`${drawioOut} not produced by generator`, 1, tee.logPath);
  }
  tee.info("phase4", `composite drawio written: ${drawioOut}`);

  tee.step("phase4", 4, 4, `exporting PNG via drawio CLI (width=${TARGET_WIDTH})`);
  await exportDrawioPngRobust({
    drawioPath: drawioOut,
    pngOut,
    widthPx: TARGET_WIDTH,
    tee,
    env: ctx.env,
    directAttempts: DRAWIO_EXPORT_ATTEMPTS,
    directTimeoutSecs: DRAWIO_EXPORT_TIMEOUT_SECS,
  });

  tee.info("phase4", `verifying export dimensions against placement=${ctx.placement}`);
  const targetHeight = TARGET_HEIGHTS[ctx.placement];
  if (!targetHeight) {
    tee.err("phase4", `unknown placement ${ctx.placement}`);
    throw new PhaseError(`unknown placement ${ctx.placement}`, 1, tee.logPath);
  }
  const dims = await runCommand(ctx.python, ["-c", PIL_DIMS_SNIPPET, pngOut], tee, { env: ctx.env });
  const [gotW, gotH] = dims.trim().split(/\s+/).map(Number);
  // NaN slips through `gotH < low` (all NaN comparisons are false) — a
  // corrupt dims read must warn loudly, not silently pass the check.
  if (!Number.isFinite(gotW) || !Number.isFinite(gotH)) {
    tee.warn("phase4", `could not parse export dimensions from ${JSON.stringify(dims.trim())} — skipping the dimension check`);
    tee.done("phase4", `OK (dimensions unverified, placement=${ctx.placement}) ${elapsed(start)}`);
    return { status: "completed", outcome: `${ctx.placement} · dimensions unverified` };
  }

  const low = Math.floor((targetHeight * 90) / 100);
  const high = Math.floor((targetHeight * 110) / 100);
  tee.info("phase4", `exported ${gotW}x${gotH}px (target ${targetHeight}±10% [${low}..${high}])`);
  if (gotW !== TARGET_WIDTH) {
    tee.warn("phase4", `expected width ${TARGET_WIDTH}, got ${gotW} — continuing (Phase 5 re-snaps, Phase 6 audits)`);
  }
  if (gotH < low || gotH > high) {
    tee.warn("phase4", `height ${gotH} outside placement target ${targetHeight}±10% [${low}..${high}]`);
    tee.warn("phase4", "composite may be too tall/short — tighten per-panel PAGE_H in the panel generators so the composite matches the placement target; continuing anyway");
  }

  tee.done("phase4", `OK (${gotW}x${gotH}, placement=${ctx.placement}) ${elapsed(start)}`);
  const offTarget = gotW !== TARGET_WIDTH || gotH < low || gotH > high;
  return { status: offTarget ? "degraded" : "completed", outcome: `${gotW}×${gotH}px · ${ctx.placement}${offTarget ? " · off target" : ""}` };
}

// Fallback when the deterministic compose throws: dispatch one sub-agent to
// reproduce + repair the composition. The on-disk deliverables are the sole
// judge of success — a non-zero agent exit is only a warning (the watchdog
// also exits non-zero on a timeout that already wrote them), mirroring the
// panel-phase contract in phase-panels.ts rather than phase-verify.ts.
async function composeViaAgent(ctx: RunContext, tee: TeeLog, start: number): Promise<PhaseResult> {
  const figs = path.join(ctx.workdir, "figures");
  const drawioOut = path.join(figs, "full_figure.drawio");
  const pngOut = path.join(figs, "full_figure.png");
  const agentLog = path.join(ctx.workdir, "logs", "phase4_compose_agent.log");

  const promptFile = path.join(ctx.workdir, ".phase4_prompt.md");
  fs.writeFileSync(
    promptFile,
    buildPhase4Prompt({
      workdir: ctx.workdir,
      placement: ctx.placement,
      toolkitDir: ctx.toolkitDir,
      python: ctx.python,
    }),
  );

  tee.info("phase4", `dispatching compose sub-agent (streaming log: ${agentLog})`);
  // Stamp the phase so any toolkit script the agent runs is billed to Phase 4.
  const rc = await agentInvoke(agentLog, promptFile, ctx.workdir, ctx.agent, { ...ctx.env, AUTOILLUSTRATE_PHASE: "4" });
  tee.info("phase4", `compose sub-agent returned (rc=${rc}) ${elapsed(start)} — validating deliverables`);

  const missing = [drawioOut, pngOut].filter((f) => !fileNonEmpty(f));
  if (missing.length > 0) {
    tee.err("phase4", `compose sub-agent did not produce a figure (missing/empty: ${missing.join(" ")})`);
    throw new PhaseError(`compose sub-agent did not produce a figure — see ${agentLog}`, 1, agentLog);
  }
  tee.done("phase4", `OK (composed by sub-agent, rc=${rc}) ${elapsed(start)}`);
  return { status: "degraded", outcome: `composed by the repair sub-agent · ${ctx.placement}` };
}
