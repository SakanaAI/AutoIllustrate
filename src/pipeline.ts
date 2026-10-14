// Pipeline orchestration — port of run.sh's phase sequencing, resume
// semantics, failure surface, and summary (run.sh:124-335).

import fs from "node:fs";
import path from "node:path";

import { defaultTimeoutSecs } from "./agent.js";
import {
  DEFAULT_AUDIT_VLM,
  DEFAULT_ENHANCE_MODEL,
  DEFAULT_ENHANCE_QUALITY,
  DEFAULT_ENHANCEMENT_ATTEMPTS,
  DEFAULT_PANEL_INSPECTS,
  DEFAULT_UNIT_TEST_VLM,
  enhanceBackend,
  type PhaseResult,
  type RunContext,
} from "./context.js";
import { PhaseError } from "./errors.js";
import {
  attachJournal,
  closeLogging,
  logDetail,
  logDone,
  logErr,
  logError,
  logInfo,
  logPhaseEnd,
  logPhaseStart,
  logPipelineEnd,
  logRaw,
  logRunStart,
  logRunSummary,
  logTs,
  logWarn,
  startProgress,
  stopProgress,
  timerStart,
} from "./log.js";
import { buildRunMetrics, formatSummary, writeRunMetrics, type PhaseTiming, type RunMetrics, type RunStatus } from "./metrics.js";
import { buildRunParams, writeRunParams } from "./params.js";
import { toolkitDir } from "./paths.js";
import { runPhase1, readPlacement } from "./phase-plan.js";
import { runPhase1b } from "./phase-style.js";
import { runPanelPhase, PHASE2_SPEC, PHASE3_SPEC } from "./phase-panels.js";
import { runPhase4 } from "./phase-compose.js";
import { runPhase5 } from "./phase-enhance.js";
import { runPhase6 } from "./phase-verify.js";
import { runInteractiveEdit, type EditDecision, type InteractiveHooks } from "./interactive.js";
import { preflight, withDotenvCredentials } from "./doctor.js";
import { panelIds, readJsonString } from "./reports.js";
import { installInterruptHandler, isTearingDown } from "./registry.js";
import { getVenvPython, withVenvOnPath } from "./venv.js";
import { initWorkdir, newRunWorkdir, resolveWorkdirArg } from "./workdir.js";

export interface PipelineOptions {
  source?: string;
  instructions?: string;
  placement: string; // half-width | full-width | infer
  enhanceModel?: string; // gpt-image-2.5-sunburst | gpt-image-2 | nanobanana | nanobanana-pro | codex | any image model id
  enhanceQuality?: string; // model-specific, e.g. low | medium | high | xhigh | max | auto (default high)
  mode?: string; // light | medium | full — the speed preset that set the defaults below
  agent: string;
  model?: string;
  effort?: string;
  panelInspects?: number;
  enhancementAttempts?: number;
  outDir: string;
  workdirArg?: string;
  output?: string; // promote the final figure to this path when the run finishes
  resumePhase: number; // 0 = not set
  skipEnhance: boolean;
  sequential: boolean;
  force: boolean;
  debug?: boolean;
  tmux?: boolean; // forward --tmux --wait --delete to headless
  interactive?: boolean; // pause after Phase 4 in the diagrams.net editor (Enter continues, Esc leaves)
  editorPort?: number; // fixed 127.0.0.1 port for that editor (default: any free port)
  interactiveHooks?: Partial<InteractiveHooks>; // test seam: key wait / browser opener
  env?: NodeJS.ProcessEnv;
  cwd?: string; // dir for preflight's fallback ./.env lookup; defaults to process.cwd()
}

interface PhaseGate {
  run: boolean;
  forceThis: boolean;
}

// run.sh:161-171 — phase n vs --resume-from.
export function shouldRunPhase(n: number, resumePhase: number): PhaseGate {
  if (resumePhase > 0 && n < resumePhase) return { run: false, forceThis: false };
  return { run: true, forceThis: resumePhase > 0 && n === resumePhase };
}

// Paths in the human view: relative to the invocation cwd when inside it,
// absolute otherwise — shorter lines, still copy-pasteable.
export function displayPath(target: string, cwd: string = process.cwd()): string {
  const rel = path.relative(cwd, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : target;
}

// Copy the best available final figure (enhanced when Phase 5 ran, else the
// deterministic export) from <workdir>/figures to `output`, and drop the run's
// figure.json plan beside it as <stem>.prompts.json — so callers can promote
// the deliverable without locating the run workdir. Returns false (a hard
// failure) when no figure exists or the copy fails. Mirrors run.sh's
// promote_output (the --output flag from the bash CLI).
export function promoteFinalFigure(workdir: string, output: string): boolean {
  const figs = path.join(workdir, "figures");
  const enhanced = path.join(figs, "full_figure_enhanced.png");
  const deterministic = path.join(figs, "full_figure.png");
  // Honor Phase 6's shipping decision: when verification rejected the enhanced
  // winner for structural residuals it records "shipped": "deterministic" but
  // leaves full_figure_enhanced.png on disk (the promoted attempt). Preferring
  // the enhanced PNG here would publish the image verification discarded, so
  // fall back to the deterministic export whenever Phase 6 said so.
  const shipped = readJsonString(path.join(workdir, "phase6_report.json"), "shipped");
  const preferEnhanced = shipped !== "deterministic" && fs.existsSync(enhanced);
  const src = preferEnhanced ? enhanced : deterministic;
  if (!fs.existsSync(src)) {
    logErr("run", `--output set but no figure found in ${figs}`);
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(src, output);
    logDone("run", `promoted ${path.basename(src)} → ${displayPath(output)}`);
    const plan = path.join(workdir, "figure.json");
    if (fs.existsSync(plan)) {
      const promptsOut = output.replace(/\.[^./]*$/, "") + ".prompts.json";
      fs.copyFileSync(plan, promptsOut);
      logInfo("run", `promoted figure.json -> ${promptsOut}`);
    }
    return true;
  } catch (err) {
    logErr("run", `--output promotion failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// The best figure to point the user at once the run stops (mirrors
// promoteFinalFigure's choice), plus the editable source.
function deliverables(workdir: string): { figure?: string; drawio?: string } {
  const figs = path.join(workdir, "figures");
  const enhanced = path.join(figs, "full_figure_enhanced.png");
  const deterministic = path.join(figs, "full_figure.png");
  const drawio = path.join(figs, "full_figure.drawio");
  const shipped = readJsonString(path.join(workdir, "phase6_report.json"), "shipped");
  const figure = shipped !== "deterministic" && fs.existsSync(enhanced) ? enhanced : fs.existsSync(deterministic) ? deterministic : undefined;
  return { figure, drawio: fs.existsSync(drawio) ? drawio : undefined };
}

interface PhaseSpec {
  n: number;
  label: string; // "1", "1.5", … as shown in "Phase 1.5/6"
  name: string; // "Plan", "Render panels", …
  title: string; // metrics row title (kept stable for run_metrics.json)
  log: string;
  progress: () => string; // the running label
  run: (force: boolean) => Promise<PhaseResult | void>;
  resumeAs?: number; // --resume-from gating follows this phase instead of `n`
}

export async function runPipeline(opts: PipelineOptions): Promise<number> {
  try {
    return await runPipelineInner(opts);
  } finally {
    closeLogging();
  }
}

async function runPipelineInner(opts: PipelineOptions): Promise<number> {
  const baseEnv = opts.env ?? process.env;
  const runStart = timerStart();
  const runStartSecs = runStart / 1000;
  const startedAt = logTs();
  const timings: PhaseTiming[] = [];

  const workdir = opts.workdirArg ? resolveWorkdirArg(opts.workdirArg) : newRunWorkdir(path.resolve(opts.outDir));
  initWorkdir(workdir);
  attachJournal(path.join(workdir, "events.jsonl"));
  const source = opts.source ? path.resolve(opts.source) : undefined;

  installInterruptHandler(runStart);

  // Scope preflight to the phases this invocation actually runs: 1-3 dispatch
  // agents, 5 needs an image-model credential, 6 needs both an audit VLM and
  // the agent — and --skip-enhance exits after phase 4, so it disables BOTH 5
  // and 6 (run.sh:299-303).
  // Phase 3 needs the audit VLM and no flag stops before it, so any invocation
  // that reaches phases 1-3 inevitably reaches 3. Requiring the credential up
  // front is deliberately stricter than bash's lazy failure model: refusing at
  // second 0 beats burning phase-1/2 agent runs and dying at 3.
  // --enhancement-attempts 1 is the skip-verify dial: verify only picks a
  // winner among candidates and drives repairs, so with the single Phase 5
  // candidate the run stops after Phase 5 and Phase 6 (and its audit/unit-test
  // credentials) is never needed. Verify runs only at 2+.
  // --panel-inspects 0 likewise skips Phase 3, so its audit VLM isn't needed.
  const panelInspects = opts.panelInspects ?? DEFAULT_PANEL_INSPECTS;
  const enhancementAttempts = opts.enhancementAttempts ?? DEFAULT_ENHANCEMENT_ATTEMPTS;
  const runsAgentPanels = opts.resumePhase <= 3; // phases 1-3 dispatch agents
  const runsInspect = runsAgentPanels && panelInspects > 0; // phase 3 only
  const runsEnhance = !opts.skipEnhance && opts.resumePhase <= 5;
  const runsVerify = !opts.skipEnhance && enhancementAttempts > 1;
  const enhanceModel = opts.enhanceModel ?? DEFAULT_ENHANCE_MODEL;
  const enhanceQuality = opts.enhanceQuality ?? DEFAULT_ENHANCE_QUALITY;
  const enhanceNeedsGemini = enhanceBackend(enhanceModel) === "gemini";
  const enhanceNeedsCodex = enhanceBackend(enhanceModel) === "codex";

  // The vision audits don't unconditionally need OpenAI: --audit-vlm (Phase 3
  // panel inspect + Phase 6 Stage A) and --unit-test-vlm (Phase 6 Stage B)
  // each pick an OpenAI/Gemini/codex backend, exported as $AUDIT_VLM /
  // $UNIT_TEST_VLM (cli.ts). Resolve the effective choices — falling back to
  // an already-exported env var, then the default — exactly as
  // inspect_panel.py / verify.py do, and derive the credential needs from the
  // backends so a Gemini-only audit run isn't rejected for a missing
  // OPENAI_API_KEY (and a Gemini audit can't start without GEMINI_API_KEY).
  // 'auto' unit-tests follow the audit backend (verify.py:799). Keep the
  // backend mapping in sync with VLM_REGISTRY / UT_BACKEND_CHOICES.
  const auditVlm = baseEnv.AUDIT_VLM ?? DEFAULT_AUDIT_VLM;
  const unitTestVlm = baseEnv.UNIT_TEST_VLM ?? DEFAULT_UNIT_TEST_VLM;
  const auditBackend = auditVlm === "gemini-3.1-pro" ? "gemini" : "openai";
  const unitTestBackend =
    unitTestVlm === "auto"
      ? auditBackend
      : unitTestVlm.startsWith("gemini")
        ? "gemini"
        : unitTestVlm === "codex"
          ? "codex"
          : "openai";
  // Phase 3 inspect + Phase 6 Stage A both consume the audit VLM; Phase 6
  // Stage B unit tests consume the unit-test VLM (verify only). --panel-inspects
  // 0 drops the Phase 3 consumer, so a 0-inspect, 0-verify run needs no audit key.
  const auditRuns = runsInspect || runsVerify;

  const needsOpenai =
    (auditRuns && auditBackend === "openai") ||
    (runsVerify && unitTestBackend === "openai") ||
    (runsEnhance && !enhanceNeedsGemini && !enhanceNeedsCodex);
  const needsGemini =
    (auditRuns && auditBackend === "gemini") ||
    (runsVerify && unitTestBackend === "gemini") ||
    (runsEnhance && enhanceNeedsGemini);
  // Only Phase 5 enhance hard-requires the codex CLI: enhance.py aborts if it
  // is absent (no fallback). The codex *unit-test* backend is deliberately NOT
  // required — verify.py falls back to the audit backend ('openai-single' when
  // Stage A is OpenAI, else the Stage A backend itself) when codex is missing
  // (verify.py:1627), and that fallback's credential is already mandated above
  // via auditRuns. Demanding the CLI here would wrongly reject a supported
  // `--unit-test-vlm codex` run that has a valid audit-backend key.
  const needsCodexCli = runsEnhance && enhanceNeedsCodex;

  if (
    !preflight(
      {
        agent: opts.agent,
        needsAgentPhases: runsAgentPanels || runsVerify,
        needsOpenai,
        needsGemini,
        needsCodexCli,
      },
      baseEnv,
      opts.cwd,
    )
  ) {
    return 2;
  }

  // Preflight (above) deliberately fails fast on missing keys before we pay for
  // a venv bootstrap. Only now resolve (bootstrapping if needed) the venv
  // interpreter and expose its bin dir on PATH for everything downstream — most
  // importantly the dispatched agents, which otherwise run bare `python3`/`pip`
  // against the system interpreter and fail to import the toolkit deps.
  const python = getVenvPython({ env: baseEnv });
  // Preflight above accepts a key found only in ./.env; carry it into the env
  // every phase and sub-agent inherits, since they run with cwd=$WORKDIR and
  // can no longer find that file themselves.
  const env = withVenvOnPath(withDotenvCredentials(baseEnv, opts.cwd), python);
  // enhance.py reads these as its --model / --quality defaults, so the Phase 6
  // repair loop's re-enhances follow the same --enhance-model / --enhance-quality
  // as Phase 5 without the sub-agent having to repeat the flags.
  env.ENHANCE_MODEL = enhanceModel;
  env.ENHANCE_QUALITY = enhanceQuality;

  const ctx: RunContext = {
    workdir,
    toolkitDir: toolkitDir(),
    source,
    instructions: opts.instructions,
    placement: opts.placement,
    enhanceModel,
    enhanceQuality,
    mode: opts.mode,
    agent: { agent: opts.agent, model: opts.model, effort: opts.effort, timeoutSecs: defaultTimeoutSecs(env), debug: opts.debug ?? false, tmux: opts.tmux ?? false },
    panelInspects,
    enhancementAttempts,
    force: opts.force,
    sequential: opts.sequential,
    python,
    env,
  };

  // ── Run header ──────────────────────────────────────────────────────────
  const subject = source ? path.basename(source) : opts.resumePhase > 0 ? `resume from phase ${opts.resumePhase}` : path.basename(workdir);
  const modeText = opts.mode ? `${opts.mode} mode` : "custom budgets";
  const header = [
    `Autoillustrate · ${subject} · ${modeText}`,
    `Agent: ${opts.agent} / ${opts.model || "default model"} / ${opts.effort ? `${opts.effort} effort` : "default effort"}${opts.tmux ? " / tmux" : ""}`,
    `Figure: placement ${ctx.placement} · enhance ${opts.skipEnhance ? "skipped" : `${enhanceModel} (${enhanceQuality} quality)`} · audit ${auditRuns ? auditVlm : "disabled"} · unit tests ${runsVerify ? unitTestVlm : "disabled"}${opts.interactive ? " · interactive edit" : ""}`,
    `Loops: ${panelInspects} panel inspect${panelInspects === 1 ? "" : "s"} · ${enhancementAttempts} enhancement attempt${enhancementAttempts === 1 ? "" : "s"} · ${opts.sequential ? "sequential" : "parallel"} panels`,
    `Run dir: ${displayPath(workdir)}`,
  ];
  if (opts.resumePhase > 0) header.push(`Resuming from phase ${opts.resumePhase} (earlier phases skipped, phase ${opts.resumePhase} forced)`);
  const details = [
    ...(source ? [`source: ${source}`] : []),
    `workdir: ${workdir}`,
    `logs: ${path.join(workdir, "logs")}`,
    `journal: ${path.join(workdir, "events.jsonl")}`,
    `agent timeout: ${ctx.agent.timeoutSecs}s · force: ${opts.force} · skip-enhance: ${opts.skipEnhance}`,
  ];
  logRunStart({
    header,
    details,
    workdir,
    source,
    mode: opts.mode ?? null,
    agent: opts.agent,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    placement: ctx.placement,
    enhance_model: enhanceModel,
    enhance_quality: enhanceQuality,
    audit_vlm: auditVlm,
    unit_test_vlm: unitTestVlm,
    panel_inspects: panelInspects,
    enhancement_attempts: enhancementAttempts,
    sequential: opts.sequential,
    skip_enhance: opts.skipEnhance,
    interactive: opts.interactive ?? false,
    resume_from: opts.resumePhase || null,
  });

  // Snapshot the resolved hyperparameters up front so a workdir is a
  // self-contained record even if the run later fails mid-phase. Best-effort:
  // a write failure must never abort the run.
  try {
    writeRunParams(
      workdir,
      buildRunParams({
        ctx,
        startedAt,
        placementRequested: opts.placement,
        skipEnhance: opts.skipEnhance,
        interactive: opts.interactive ?? false,
        resumePhase: opts.resumePhase,
      }),
    );
    logInfo("run", `params written to ${path.join(workdir, "params.json")}`);
  } catch (err) {
    logWarn("params", `could not write params.json: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Usage snapshot — best-effort and cheap (reads the logs already on disk), so
  // each phase's completion line can carry its token count and the running total.
  const metricsSnapshot = (status: RunStatus): RunMetrics | undefined => {
    try {
      return buildRunMetrics({
        workdir,
        startedAt,
        finishedAt: logTs(),
        runStartSecs,
        totalDurationMs: Date.now() - runStart,
        status,
        timings,
        agent: opts.agent,
        env,
      });
    } catch {
      return undefined;
    }
  };

  // Failure surface (run.sh:185-197): the error, then the failing log's tail.
  let currentLog = "";
  const failed = (err: unknown): number => {
    const exitCode = err instanceof PhaseError ? err.exitCode : 1;
    const message = err instanceof Error ? err.message : String(err);
    const tailTarget = err instanceof PhaseError && err.logPath ? err.logPath : currentLog;
    logError(message, tailTarget || undefined);
    if (tailTarget && fs.existsSync(tailTarget)) {
      try {
        const lines = fs.readFileSync(tailTarget, "utf8").split("\n");
        logRaw(`  ── last 50 lines of ${displayPath(tailTarget)} ──\n${lines.slice(-50).join("\n")}`, "stderr");
      } catch {
        // best-effort tail
      }
    }
    logPipelineEnd("failed", Date.now() - runStart, { exit_code: exitCode });
    return exitCode;
  };

  // Token + runtime summary on every terminal path. Best-effort: a metrics
  // failure logs a warning and is swallowed — it must never change the exit
  // code or mask the real outcome.
  const finalize = (status: RunStatus): void => {
    try {
      const metrics = buildRunMetrics({
        workdir,
        startedAt,
        finishedAt: logTs(),
        runStartSecs,
        totalDurationMs: Date.now() - runStart,
        status,
        timings,
        agent: opts.agent,
        env,
      });
      writeRunMetrics(workdir, metrics);
      logRunSummary(formatSummary(metrics), metrics);
      logInfo("run", `metrics written to ${path.join(workdir, "metrics", "run_metrics.json")}`);
    } catch (err) {
      logWarn("metrics", `could not build run summary: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Where the run stopped successfully: the finished line plus the paths a
  // user actually wants next, then the --output promotion and the summary.
  const succeed = (): number => {
    logPipelineEnd("completed", Date.now() - runStart);
    const out = deliverables(workdir);
    if (out.figure) logDetail(`Figure: ${displayPath(out.figure)}`);
    if (out.drawio) logDetail(`Editable: ${displayPath(out.drawio)}`);
    logDetail(`Run dir: ${displayPath(workdir)}`);
    const promoted = opts.output ? promoteFinalFigure(workdir, opts.output) : true;
    finalize("complete");
    return promoted ? 0 : 1;
  };

  const panelCount = (): number => panelIds(path.join(workdir, "figure.json")).length;
  const panelsLabel = (verb: string): string => {
    const n = panelCount();
    return n > 0 ? `${verb} ${n} panel${n === 1 ? "" : "s"}…` : `${verb} panels…`;
  };

  let editDecision = "continue" as EditDecision; // set by the --interactive gate (assigned inside its run closure)
  const phases: PhaseSpec[] = [
    {
      n: 1,
      label: "1",
      name: "Plan",
      title: "Phase 1/6 — Plan",
      log: path.join(workdir, "logs", "phase1.log"),
      progress: () => "Planning the figure…",
      run: (force) => runPhase1({ ...ctx, force }),
    },
    {
      n: 1.5,
      label: "1.5",
      name: "Style",
      title: "Phase 1.5/6 — Style",
      log: path.join(workdir, "logs", "phase1b.log"),
      progress: () => "Designing the visual style…",
      run: (force) => runPhase1b({ ...ctx, force }),
    },
    {
      n: 2,
      label: "2",
      name: "Render panels",
      title: "Phase 2/6 — Render panels",
      log: "", // per-panel logs (logs/panel_*.log) — no single file to tail
      progress: () => panelsLabel("Rendering"),
      run: (force) => runPanelPhase({ ...ctx, force }, PHASE2_SPEC),
    },
    {
      n: 3,
      label: "3",
      name: "Inspect + refine panels",
      title: "Phase 3/6 — Inspect + refine panels",
      log: "", // per-panel logs (logs/inspect_*.log)
      progress: () => panelsLabel("Inspecting and refining"),
      run: (force) => runPanelPhase({ ...ctx, force }, PHASE3_SPEC),
    },
    {
      n: 4,
      label: "4",
      name: "Compose",
      title: "Phase 4/6 — Compose",
      log: path.join(workdir, "logs", "phase4.log"),
      progress: () => "Composing the figure…",
      run: (force) => runPhase4({ ...ctx, force }),
    },
    // --interactive: pause in the diagrams.net editor before enhancing. Gated
    // like Phase 5 (it edits Phase 5's input), so `--resume-from 5` offers it
    // and `--resume-from 6` does not. No sentinel: it runs every time.
    ...(opts.interactive
      ? [
          {
            n: 4.5,
            label: "4.5",
            name: "Edit",
            title: "Phase 4.5/6 — Edit",
            log: path.join(workdir, "logs", "phase4b.log"),
            progress: () => "Waiting for edits in the browser…",
            resumeAs: 5,
            run: async () => {
              const result = await runInteractiveEdit(ctx, {
                port: opts.editorPort,
                nextStep: opts.skipEnhance ? "finish the run" : "continue to the enhance phase",
                hooks: opts.interactiveHooks,
              });
              editDecision = result.decision;
              return result;
            },
          } satisfies PhaseSpec,
        ]
      : []),
    {
      n: 5,
      label: "5",
      name: "Enhance",
      title: "Phase 5/6 — Enhance",
      log: path.join(workdir, "logs", "phase5.log"),
      progress: () => `Restyling with ${enhanceModel} at ${enhanceQuality} quality…`,
      run: (force) => runPhase5({ ...ctx, force }),
    },
    {
      n: 6,
      label: "6",
      name: "Verify + repair",
      title: "Phase 6/6 — Verify + repair",
      log: path.join(workdir, "logs", "phase6.log"),
      progress: () => "Verifying and repairing the enhanced figure…",
      run: (force) => runPhase6({ ...ctx, force }),
    },
  ];
  const TOTAL = 6;

  // A phase that will not run: shown as its own block so the reader sees
  // where the run stopped and why, and recorded as a skipped metrics row.
  const skipPhase = (phase: PhaseSpec, reason: string, record = true): void => {
    logPhaseStart(phase.n, phase.label, TOTAL, phase.name);
    if (record) timings.push({ phase: phase.n, title: phase.title, durationMs: 0, status: "skipped" });
    logPhaseEnd({ phase: phase.n, title: phase.name, status: "skipped", outcome: reason });
  };

  try {
    for (const [i, phase] of phases.entries()) {
      // Skip-flag early exits before phases 5 and 6 (run.sh:299-303, 316-320).
      // The stopped-before phases are announced (not recorded as metrics rows,
      // the run genuinely ends here) so the early stop is visible at a glance.
      // Esc in the --interactive editor ends the run the same way, with the
      // deterministic figure (already re-exported from the edited drawio).
      if (phase.n === 5 && editDecision === "leave") {
        logInfo("run", "left the interactive editor, stopping after Phase 4");
        for (const rest of phases.slice(i)) skipPhase(rest, "left the editor · deterministic figure only", false);
        return succeed();
      }
      if (phase.n === 5 && opts.skipEnhance) {
        logInfo("run", "--skip-enhance set, stopping after Phase 4");
        for (const rest of phases.slice(i)) skipPhase(rest, "--skip-enhance · deterministic figure only", false);
        return succeed();
      }
      if (phase.n === 6 && enhancementAttempts <= 1) {
        logInfo("run", "--enhancement-attempts 1, stopping after Phase 5");
        skipPhase(phase, "--enhancement-attempts 1 · a single candidate needs no verify", false);
        return succeed();
      }
      // --panel-inspects 0 skips Phase 3 mid-pipeline (panels ship as Phase 2
      // rendered them); the run continues to compose/enhance/verify.
      if (phase.n === 3 && panelInspects === 0) {
        skipPhase(phase, "--panel-inspects 0 · panels used as rendered");
        continue;
      }

      const gate = shouldRunPhase(phase.resumeAs ?? phase.n, opts.resumePhase);
      if (gate.run) {
        logPhaseStart(phase.n, phase.label, TOTAL, phase.name);
        const phaseStart = timerStart();
        currentLog = phase.log;
        startProgress(phase.progress(), { phase: phase.n, phaseLabel: `${phase.label}/${TOTAL}` });
        let result: PhaseResult | void;
        try {
          result = await phase.run(opts.force || gate.forceThis);
        } catch (err) {
          stopProgress();
          const durationMs = Date.now() - phaseStart;
          timings.push({ phase: phase.n, title: phase.title, durationMs, status: "failed" });
          logPhaseEnd({ phase: phase.n, title: phase.name, status: "failed", durationMs });
          throw err;
        }
        stopProgress();
        const durationMs = Date.now() - phaseStart;
        timings.push({ phase: phase.n, title: phase.title, durationMs, status: "ok" });
        const snapshot = metricsSnapshot("partial");
        const phaseTokens = snapshot?.phases.find((p) => p.phase === phase.n)?.tokens;
        logPhaseEnd({
          phase: phase.n,
          title: phase.name,
          status: result?.status ?? "completed",
          outcome: result?.outcome,
          durationMs,
          tokens: phaseTokens,
          runTokens: phaseTokens !== undefined ? snapshot?.totals.tokens : undefined,
        });
      } else {
        skipPhase(phase, `resume from phase ${opts.resumePhase}`);
      }

      // Placement readback after Phase 1, ran or skipped (run.sh:249-258).
      if (phase.n === 1) {
        ctx.placement = readPlacement(workdir);
        logInfo("run", `placement (post-phase1) = ${ctx.placement}`);
      }
    }
  } catch (err) {
    // Interrupt teardown owns the exit code: a phase failing because its
    // agent was just SIGTERMed must park here until onInterrupt exits 130.
    if (isTearingDown()) await new Promise<never>(() => {});
    const code = failed(err);
    finalize("failed");
    return code;
  }

  const verdict = readJsonString(path.join(workdir, "phase6_report.json"), "summary");
  if (verdict) logDetail(`Verdict: ${verdict}`, 6);
  return succeed();
}
