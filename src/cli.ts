#!/usr/bin/env node
// autoillustrate CLI — arg parsing, validation, and dispatch (run | doctor).
// Port of run.sh's usage/arg surface with a friendlier shape:
// positional <source> and --prompt (alias of the old --instructions).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  AUDIT_VLMS,
  DEFAULT_ENHANCE_MODEL,
  DEFAULT_ENHANCE_QUALITY,
  UNIT_TEST_VLMS,
} from "./context.js";
import { DEFAULT_MODE, MODE_PRESETS, type Mode, resolveMode } from "./modes.js";
import { runCredentials, runDoctor } from "./doctor.js";
import { TeeLog } from "./exec.js";
import { exportDrawioPngRobust } from "./export-png.js";
import { PhaseError } from "./errors.js";
import { configureLogging, type LogFormat } from "./log.js";
import { toolkitDir } from "./paths.js";
import { runPipeline, type PipelineOptions } from "./pipeline.js";
import { installOutputGuards } from "./registry.js";

export const USAGE = `autoillustrate — publication-grade academic figures from a methodology brief

Usage:
  autoillustrate <source> --prompt "<text>" [options]
  autoillustrate --workdir <run-dir> --resume-from <phase> [options]
  autoillustrate doctor [--agent <name>]
  autoillustrate credentials
  autoillustrate export <in.drawio> <out.png> [--export-width <px> | --export-scale <f>]

Arguments:
  <source>                  PDF, .tex file, or directory the planner reads.
                            Optional when --resume-from >= 2.

Required (fresh run):
  -p, --prompt <text>       What the figure should depict.

Speed presets:
      --mode <m>            light | medium | full (default: medium). Trades
                            runtime for quality by setting the agent, effort,
                            and the two correction-loop budgets at once. All
                            tiers run the claude agent (Opus 5.5). Individual
                            flags (--agent, --model, --effort, --panel-inspects,
                            --enhancement-attempts) override the preset.
                              light  — claude, low effort,     0 panel inspects, 0 verify, 0 repair (~10 min)
                              medium — claude, high effort,     0 panel inspects, 0 verify, 0 repair (~15 min)
                              full   — claude, high effort,     3 panel inspects, 3 verify, 2 repair (~30 min)
                            (verify/repair counts are --enhancement-attempts n
                            and n-1; light and medium are n=1, full n=3.)
                            light and medium share the same loop budgets and
                            differ only in effort (low vs high); full adds the
                            inspect/verify/repair loops.

Figure options:
      --placement <p>       half-width | full-width | infer (default: infer — Phase 1 decides)
      --enhance-model <m>   gpt-image-2.5-sunburst | gpt-image-2 | nanobanana
                            | nanobanana-pro | codex | <model id>
                            (default: gpt-image-2.5-sunburst). Image
                            model for the Phase 5 restyle; nanobanana* are
                            Google's Gemini image models and need
                            GEMINI_API_KEY; codex runs the codex CLI's
                            $imagegen skill (gpt-image-2 on the ChatGPT
                            subscription — needs a logged-in codex CLI, no
                            API key). Any other id is passed through as-is:
                            gemini-* to the Gemini API, the rest to the
                            OpenAI Images API.
      --enhance-quality <q> Output quality of the Phase 5 restyle and of the
                            Phase 6 repair re-enhances (default: high).
                            Passed to the image model as-is, so the
                            accepted values are the model's own:
                            gpt-image-2.5-* take low | medium | high |
                            xhigh | max | auto, gpt-image-2 has no xhigh
                            or max, the nanobanana models take the same
                            ladder or a literal 1K | 2K | 4K (capped per
                            model), and codex ignores it.

Vision-audit options:
      --audit-vlm <m>       gpt-6-astra | gpt-5.5 | gemini-3.1-pro (default:
                            gpt-6-astra, at high reasoning effort).
                            Vision model for the content audits — Phase 3
                            panel inspect AND Phase 6 verify Stage A (one
                            shared knob). Sets $AUDIT_VLM for the sub-agents.
      --unit-test-vlm <b>   auto | openai | openai-single | gemini |
                            gemini-single | codex (default: openai-single).
                            Backend for Phase 6 Stage B unit-test probes,
                            independent of --audit-vlm. '*-single' answers all
                            questions in one call (cheapest); the others
                            fan out one call per question. Sets
                            $UNIT_TEST_VLM for the verify sub-agent.

Agent options:
      --agent <name>        claude | codex | cursor | gemini | opencode | pi
                            (default: from --mode; all presets use claude).
      --model <id>          Model override (default: claude-opus-5-5 for the
                            claude agent, gemini-3.1-pro-preview for gemini;
                            headless per-agent default otherwise).
      --effort <level>      low | medium | high | xhigh
                            (default: from --mode; light uses low, medium and
                            full use high). Not
                            supported with --agent gemini.
      --tmux                Run each sub-agent inside a tmux session (forwards
                            --tmux --wait --delete to headless; headless blocks
                            until the agent finishes, then deletes the session).
                            Not supported with --agent cursor, opencode, gemini, or pi.
                            headless forbids --json/--usage with --tmux, so
                            this mode omits agent usage; those rows show no
                            tokens in the run summary.

Run control:
  -o, --out-dir <dir>       Parent dir for new runs (default: ./runs). The run
                            itself lands in <out-dir>/<YYYY-MM-DD-HHMMSS>/.
  -w, --workdir <path>      Use this exact run dir (resume an earlier run).
      --output <path>       Copy the final figure (enhanced if produced, else
                            the deterministic export) to <path> when the run
                            finishes, and drop the run's figure.json plan
                            beside it as <stem>.prompts.json. Lets callers
                            promote the deliverable without locating the run
                            workdir. Without this flag the figures stay only
                            in <workdir>/figures/.
      --resume-from <ph>    1|plan, 2|panels, 3|inspect, 4|compose, 5|enhance,
                            6|verify. Requires --workdir.
  -i, --interactive         After Phase 4, open the composed figure in the
                            diagrams.net editor (your browser, served from
                            127.0.0.1 only) and pause. Edits autosave into
                            figures/full_figure.drawio. Press Enter to
                            re-export the PNG and continue to the enhance
                            phase, or Esc to leave with the deterministic
                            figure. Also offered by --resume-from 5.
      --editor-port <n>     Fixed 127.0.0.1 port for the --interactive editor
                            (default: a random free port). Pick one to reach
                            it from a remote machine: ssh -L <n>:127.0.0.1:<n>
      --skip-enhance        Stop after Phase 4 (deterministic PNG only).
      --panel-inspects <n>  Phase 3 per-panel inspect/refine budget: 1 initial
                            inspect + up to (n-1) repair passes (1-20; default
                            from --mode). 0 skips Phase 3 (panels ship as Phase 2
                            rendered them).
      --enhancement-attempts <n>
                            Enhanced candidates to judge (1-20; default from
                            --mode): the Phase 5 enhance plus (n-1) Phase 6
                            repair re-enhances, each judged by its own verify.
                            So n verify attempts and (n-1) repair passes. n=1
                            enhances once and skips Phase 6 entirely (verify
                            only exists to pick a winner and drive repairs).
      --sequential          Run Phase 2/3 per-panel sub-agents one at a time.
      --force               Re-run already-completed phases (ignore sentinels).

Output:
  The terminal shows the run header, one block per phase (what is running,
  then "completed · <outcome> · <elapsed> · <tokens>"), per-panel results, and
  the deliverable paths + token/runtime summary. Colours are semantic and only used on
  an interactive terminal (NO_COLOR disables, FORCE_COLOR=1 forces).
      --verbose             Also show diagnostics: sub-agent launches, log and
                            prompt paths, deterministic-step (python/drawio)
                            output. Implied by --debug.
      --debug               Stream raw sub-agent traces to the terminal too
                            (they always land in <workdir>/logs/ regardless).
      --log-format <f>      human | json (default: human). json writes one
                            JSON record per line to stdout and keeps child
                            output on stderr. Every run also journals all
                            events to <workdir>/events.jsonl.
      --heartbeat-seconds <n>
                            When stdout is not a terminal, print a
                            "still running" line this often during a long
                            phase (default: 60; 0 disables). Interactive
                            terminals refresh one spinner line in place.

Other:
      doctor                Check prerequisites (python3, venv, drawio,
                            headless, agent CLI, OPENAI_API_KEY) and exit.
      credentials           Report every credential the pipeline can use:
                            OPENAI_API_KEY / GEMINI_API_KEY presence (env or
                            ./.env), plus codex and Claude Code OAuth login
                            state. Always exits 0.
      export                Hardened drawio→PNG export: fast-fail direct
                            attempt, then SVG + headless-Chrome fallback.
                            Used by sub-agents instead of raw drawio -x.
      --export-width <px>   Output pixel width for export (default: scale).
      --export-scale <f>    Scale factor for export (default: 2).
  -h, --help                Show this help.
  -V, --version             Show version.

Environment:
  OPENAI_API_KEY            Required for Phases 3/6, and 5 unless a
                            nanobanana or codex --enhance-model is
                            selected (env or ./.env).
  GEMINI_API_KEY            Required for Phase 5 with --enhance-model
                            nanobanana | nanobanana-pro (env or ./.env).
  AUDIT_VLM                 Vision model for the content audits — Phase 3
                            panel inspect + Phase 6 verify Stage A (default
                            gpt-6-astra). Set by --audit-vlm.
  UNIT_TEST_VLM             Stage B unit-test backend for Phase 6 verify
                            (default openai-single). Set by --unit-test-vlm.
  AGENT_INVOKE_TIMEOUT      Per-sub-agent watchdog seconds (default: 7200).
  AUTOILLUSTRATE_CMD_TIMEOUT  Per-step watchdog seconds for deterministic
                            children like python/drawio (default: 600).
  AUTOILLUSTRATE_CHROME     Chrome/Chromium binary for the SVG export
                            fallback (default: auto-detected).
  VENV_PY                   Python interpreter override (skips the cached venv).
  AUTOILLUSTRATE_PRICE_FILE JSON override of the API list prices used for the
                            dollar estimates in metrics/run_metrics.json.
                            Those ignore subscriptions (Claude Code, ChatGPT)
                            and are never shown in the terminal.
  NO_COLOR / FORCE_COLOR    Disable / force ANSI colours in the terminal output.

Every run prints a per-phase + total runtime/token summary and writes
<workdir>/metrics/run_metrics.json. Token counts are response length only
(output tokens), not prompt input or cache reads. Image renders, subscription
agents (codex) and --tmux runs report no tokens and are flagged with +?.

Outputs land in <workdir>/figures/: full_figure.drawio, full_figure.png,
full_figure_enhanced.png. Per-phase logs in <workdir>/logs/.
`;

// Keep in sync with the usage text and docs/cli.md. --agent reaches a PATH lookup
// (doctor) and the headless argv, so it must not pass through unvalidated.
const KNOWN_AGENTS = ["claude", "codex", "cursor", "gemini", "opencode", "pi"];

// Agent-specific model overrides applied when the user passes no --model.
// Other agents keep headless's own defaults.
const DEFAULT_AGENT_MODEL_OVERRIDES: Partial<Record<string, string>> = {
  claude: "claude-opus-5-5",
  gemini: "gemini-3.1-pro-preview",
};

const RESUME_PHASES: Record<string, number> = {
  "1": 1, plan: 1,
  "2": 2, panels: 2,
  "3": 3, inspect: 3,
  "4": 4, compose: 4,
  "5": 5, enhance: 5,
  "6": 6, verify: 6,
};

export class UsageError extends Error {}

// parseArgs has no number type — parse + bound-check correction-loop budgets
// manually (mirrors the --export-width handling). Returns undefined when the
// flag is absent so the mode preset supplies the default; `min` = the floor
// (1 = initial pass only, no repairs; 0 = skip the loop entirely), 20 caps
// runaway loops.
function parseAttempts(raw: string | undefined, flag: string, min = 1): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > 20) {
    throw new UsageError(`${flag} must be an integer between ${min} and 20`);
  }
  return n;
}

export interface LoggingOptions {
  verbose: boolean;
  format: LogFormat;
  heartbeatSeconds: number;
}

export interface ParsedCli {
  command: "run" | "doctor" | "credentials" | "help" | "version" | "export";
  pipeline?: PipelineOptions;
  agent: string;
  logging: LoggingOptions;
  export?: { drawioPath: string; pngOut: string; widthPx?: number; scale?: number };
}

const LOG_FORMATS: LogFormat[] = ["human", "json"];
const DEFAULT_HEARTBEAT_SECONDS = 60;

function parseLogging(values: { verbose?: boolean; debug?: boolean; "log-format"?: string; "heartbeat-seconds"?: string }): LoggingOptions {
  const format = values["log-format"] ?? "human";
  if (!LOG_FORMATS.includes(format as LogFormat)) {
    throw new UsageError(`--log-format must be one of ${LOG_FORMATS.join(", ")}`);
  }
  let heartbeatSeconds = DEFAULT_HEARTBEAT_SECONDS;
  if (values["heartbeat-seconds"] !== undefined) {
    heartbeatSeconds = Number(values["heartbeat-seconds"]);
    if (!Number.isInteger(heartbeatSeconds) || heartbeatSeconds < 0) {
      throw new UsageError("--heartbeat-seconds must be a non-negative integer");
    }
  }
  return { verbose: Boolean(values.verbose || values.debug), format: format as LogFormat, heartbeatSeconds };
}

export function parseCli(argv: string[]): ParsedCli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      prompt: { type: "string", short: "p" },
      instructions: { type: "string" }, // legacy alias of --prompt
      source: { type: "string" }, // legacy alias of the positional
      placement: { type: "string" },
      "enhance-model": { type: "string" },
      "enhance-quality": { type: "string" },
      "audit-vlm": { type: "string" },
      "unit-test-vlm": { type: "string" },
      mode: { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "out-dir": { type: "string", short: "o" },
      workdir: { type: "string", short: "w" },
      output: { type: "string" },
      "resume-from": { type: "string" },
      "skip-enhance": { type: "boolean" },
      interactive: { type: "boolean", short: "i" },
      "editor-port": { type: "string" },
      "panel-inspects": { type: "string" },
      "enhancement-attempts": { type: "string" },
      sequential: { type: "boolean" },
      force: { type: "boolean" },
      debug: { type: "boolean" },
      verbose: { type: "boolean" },
      "log-format": { type: "string" },
      "heartbeat-seconds": { type: "string" },
      tmux: { type: "boolean" },
      "export-width": { type: "string" },
      "export-scale": { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
    },
  });

  const agent = values.agent ?? "claude";
  const logging = parseLogging(values);
  if (values.help) return { command: "help", agent, logging };
  if (values.version) return { command: "version", agent, logging };
  if (!KNOWN_AGENTS.includes(agent)) {
    throw new UsageError(`--agent must be one of ${KNOWN_AGENTS.join(", ")}`);
  }
  if (positionals[0] === "doctor") return { command: "doctor", agent, logging };
  if (positionals[0] === "credentials") return { command: "credentials", agent, logging };
  if (positionals[0] === "export") {
    const [, drawioPath, pngOut] = positionals;
    if (!drawioPath || !pngOut || positionals.length > 3) {
      throw new UsageError("export needs exactly: autoillustrate export <in.drawio> <out.png>");
    }
    if (!fs.existsSync(drawioPath)) throw new UsageError(`export input does not exist: ${drawioPath}`);
    const widthPx = values["export-width"] !== undefined ? Number(values["export-width"]) : undefined;
    const scale = values["export-scale"] !== undefined ? Number(values["export-scale"]) : undefined;
    if (widthPx !== undefined && (!Number.isFinite(widthPx) || widthPx <= 0)) {
      throw new UsageError("--export-width must be a positive number");
    }
    if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) {
      throw new UsageError("--export-scale must be a positive number");
    }
    if (widthPx !== undefined && scale !== undefined) {
      throw new UsageError("--export-width and --export-scale are mutually exclusive");
    }
    return { command: "export", agent, logging, export: { drawioPath, pngOut, widthPx, scale: widthPx === undefined ? (scale ?? 2) : undefined } };
  }
  if (positionals.length > 1) {
    throw new UsageError(`unexpected extra arguments: ${positionals.slice(1).join(" ")}`);
  }

  const source = positionals[0] ?? values.source;
  const instructions = values.prompt ?? values.instructions;

  let resumePhase = 0;
  if (values["resume-from"] !== undefined) {
    // Object.hasOwn: bare index lookup would accept Object.prototype keys
    // ("constructor", …) and bypass the source/prompt requirement below.
    const mapped = Object.hasOwn(RESUME_PHASES, values["resume-from"]) ? RESUME_PHASES[values["resume-from"]] : 0;
    if (!mapped) {
      throw new UsageError("--resume-from must be one of 1|plan, 2|panels, 3|inspect, 4|compose, 5|enhance, 6|verify");
    }
    resumePhase = mapped;
    if (!values.workdir) throw new UsageError("--resume-from requires --workdir <existing-run>");
  }

  if (resumePhase <= 1 && (!source || !instructions)) {
    throw new UsageError("<source> and --prompt are required (unless --resume-from >= 2)");
  }

  const placement = values.placement ?? "infer";
  if (!["half-width", "full-width", "infer"].includes(placement)) {
    throw new UsageError("--placement must be half-width, full-width, or infer");
  }
  if (values.effort !== undefined && !["low", "medium", "high", "xhigh"].includes(values.effort)) {
    throw new UsageError("--effort must be low, medium, high, or xhigh");
  }
  const mode = (values.mode ?? DEFAULT_MODE) as Mode;
  if (!(mode in MODE_PRESETS)) {
    throw new UsageError(`--mode must be one of ${Object.keys(MODE_PRESETS).join(", ")}`);
  }
  // The preset supplies agent + loop budgets; explicit flags override.
  // 0 skips the respective loop (Phase 3 / Phase 6).
  const resolved = resolveMode(mode, {
    agent: values.agent,
    panelInspects: parseAttempts(values["panel-inspects"], "--panel-inspects", 0),
    enhancementAttempts: parseAttempts(values["enhancement-attempts"], "--enhancement-attempts", 1),
    effort: values.effort,
  });
  const { panelInspects, enhancementAttempts } = resolved;
  if (
    values.tmux
    && ["cursor", "opencode", "gemini", "pi"].includes(resolved.agent)
  ) {
    throw new UsageError(`--tmux is not supported with --agent ${resolved.agent}`);
  }
  if (resolved.agent === "gemini" && resolved.effort !== undefined) {
    throw new UsageError("--effort is not supported with --agent gemini");
  }
  const enhanceModel = values["enhance-model"] ?? DEFAULT_ENHANCE_MODEL;
  if (enhanceModel.trim() === "") {
    throw new UsageError("--enhance-model must not be empty");
  }
  // Not validated against a list: the vocabulary is the image model's
  // (see DEFAULT_ENHANCE_QUALITY), and enhance.py / the API reject a bad one.
  const enhanceQuality = values["enhance-quality"] ?? DEFAULT_ENHANCE_QUALITY;
  if (enhanceQuality.trim() === "") {
    throw new UsageError("--enhance-quality must not be empty");
  }
  if (values["audit-vlm"] !== undefined && !AUDIT_VLMS.includes(values["audit-vlm"])) {
    throw new UsageError(`--audit-vlm must be one of ${AUDIT_VLMS.join(", ")}`);
  }
  if (values["unit-test-vlm"] !== undefined && !UNIT_TEST_VLMS.includes(values["unit-test-vlm"])) {
    throw new UsageError(`--unit-test-vlm must be one of ${UNIT_TEST_VLMS.join(", ")}`);
  }
  if (source && !fs.existsSync(source)) {
    throw new UsageError(`source path does not exist: ${source}`);
  }
  let editorPort: number | undefined;
  if (values["editor-port"] !== undefined) {
    if (!values.interactive) throw new UsageError("--editor-port requires --interactive");
    editorPort = Number(values["editor-port"]);
    if (!Number.isInteger(editorPort) || editorPort < 1 || editorPort > 65535) {
      throw new UsageError("--editor-port must be an integer between 1 and 65535");
    }
  }

  // --audit-vlm / --unit-test-vlm drive the vision audits. The orchestrator
  // never passes them on the scripts' command lines; instead it exports
  // $AUDIT_VLM / $UNIT_TEST_VLM, which the sub-agents inherit and
  // inspect_panel.py / verify.py read as their defaults. --audit-vlm is one
  // shared knob for both the Phase 3 panel inspect and the Phase 6 Stage A
  // audit. Only set when supplied, so an already-exported env var (or the
  // script's own default) is left intact.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (values["audit-vlm"] !== undefined) env.AUDIT_VLM = values["audit-vlm"];
  if (values["unit-test-vlm"] !== undefined) env.UNIT_TEST_VLM = values["unit-test-vlm"];

  return {
    command: "run",
    agent: resolved.agent,
    logging,
    pipeline: {
      source,
      instructions,
      placement,
      enhanceModel,
      enhanceQuality,
      mode,
      agent: resolved.agent,
      model: values.model ?? DEFAULT_AGENT_MODEL_OVERRIDES[resolved.agent],
      effort: resolved.effort,
      panelInspects,
      enhancementAttempts,
      outDir: values["out-dir"] ?? "runs",
      workdirArg: values.workdir,
      output: values.output,
      resumePhase,
      skipEnhance: values["skip-enhance"] ?? false,
      interactive: values.interactive ?? false,
      editorPort,
      sequential: values.sequential ?? false,
      force: values.force ?? false,
      debug: values.debug ?? false,
      tmux: values.tmux ?? false,
      env,
    },
  };
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(toolkitDir(), "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err)) {
      process.stderr.write(`autoillustrate: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  configureLogging(parsed.logging);

  switch (parsed.command) {
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "version":
      process.stdout.write(`${packageVersion()}\n`);
      return 0;
    case "doctor":
      return runDoctor(parsed.agent);
    case "credentials":
      return runCredentials();
    case "export":
      return runExport(parsed.export!);
    case "run":
      return runPipeline(parsed.pipeline!);
    default: {
      // Exhaustiveness: adding a command to the union without a case here
      // becomes a compile error rather than a silent undefined return.
      const unreachable: never = parsed.command;
      return unreachable;
    }
  }
}

// Single fast-fail direct attempt, then the SVG+Chrome fallback — bounded at
// roughly two minutes so sub-agent harnesses keep it in the foreground.
async function runExport(opts: NonNullable<ParsedCli["export"]>): Promise<number> {
  // A stand-alone command: its step-by-step progress IS the output.
  configureLogging({ verbose: true });
  const tee = new TeeLog(`${opts.pngOut}.export.log`);
  try {
    await exportDrawioPngRobust({
      drawioPath: opts.drawioPath,
      pngOut: opts.pngOut,
      widthPx: opts.widthPx,
      scale: opts.scale,
      tee,
      env: process.env,
      directAttempts: 1,
      directTimeoutSecs: 60,
    });
    tee.announce("export", `wrote ${opts.pngOut}`);
    return 0;
  } catch (err) {
    tee.err("export", err instanceof PhaseError ? err.message : String(err));
    return 1;
  } finally {
    await tee.close();
  }
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    // realpath both sides: the bin is invoked through an npm-link symlink.
    // fileURLToPath (not URL.pathname) — pathname keeps percent-encoding, so
    // installs under paths with spaces would silently fail the comparison.
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  installOutputGuards(); // `autoillustrate --help | head` must not crash on EPIPE
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`autoillustrate: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
