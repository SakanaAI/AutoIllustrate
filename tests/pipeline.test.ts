import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runPipeline, promoteFinalFigure, type PipelineOptions } from "../src/pipeline.js";

// Stubbed end-to-end runs: a fake headless writes each phase's contracted
// deliverables (parsing the dispatched prompt to find phase + panel id), a
// fake python handles the compose/enhance chain, a fake drawio exports PNGs.

interface Stubbed {
  base: string;
  opts: PipelineOptions;
}

function setupStubs(): Stubbed {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-e2e-"));
  const stubDir = path.join(base, "bin");
  fs.mkdirSync(stubDir);

  const headless = path.join(stubDir, "headless-stub");
  fs.writeFileSync(
    headless,
    `#!/bin/sh
prompt=""; workdir=""; prev=""
for a in "$@"; do
  [ "$prev" = "--prompt-file" ] && prompt="$a"
  [ "$prev" = "--work-dir" ] && workdir="$a"
  prev="$a"
done
case "$prompt" in
  *.phase1_prompt.md)
    printf '{"placement":"half-width","panels":[{"id":"a"},{"id":"b"}]}' > "$workdir/figure.json"
    echo methods > "$workdir/methods.md"
    echo theme > "$workdir/theme.txt"
    printf '{"status":"ok","placement":"half-width","panel_ids":["a","b"]}' > "$workdir/phase1_report.json"
    ;;
  *.phase1b_prompt.md)
    echo '# style' > "$workdir/style.md"
    printf '{"status":"ok"}' > "$workdir/style_report.json"
    ;;
  *.phase2_prompt_*)
    pid=$(grep '^PANEL_ID:' "$prompt" | awk '{print $2}')
    mkdir -p "$workdir/panels"
    : > "$workdir/panels/$pid.png"
    printf 'def build_params(bypass_warnings=False):\\n    return {"page_w": 667, "page_h": 832}\\n' > "$workdir/generate_$pid.py"
    printf '{"panel_id":"%s","status":"ok","residual_issues":[]}' "$pid" > "$workdir/phase2_report_$pid.json"
    ;;
  *.phase3_prompt_*)
    pid=$(grep '^PANEL_ID:' "$prompt" | awk '{print $2}')
    printf '{"panel_id":"%s","status":"ok","attempts_used":1,"residual_issues":[]}' "$pid" > "$workdir/phase3_report_$pid.json"
    : > "$workdir/panels/$pid.inspect.json"
    : > "$workdir/unit_test_inspections_$pid.jsonl"
    ;;
  *.phase6_prompt.md)
    printf '{"winner_attempt":1,"shipped":"enhanced","residual_critical":[],"residual_minor":[],"summary":"all good"}' > "$workdir/phase6_report.json"
    ;;
esac
exit 0
`,
  );
  fs.chmodSync(headless, 0o755);

  const python = path.join(stubDir, "python");
  fs.writeFileSync(
    python,
    `#!/bin/sh
if [ "$1" = "-c" ]; then
  case "$2" in
    *version_info*) echo "3.12" ;;
    *) echo "2560 1440" ;;
  esac
  exit 0
fi
case "$1" in
  */generate_composite.py)
    dir=$(dirname "$1")
    mkdir -p "$dir/figures"
    : > "$dir/figures/full_figure.drawio"
    ;;
  */enhance.py)
    out=""; prev=""
    for a in "$@"; do
      [ "$prev" = "--out" ] && out="$a"
      prev="$a"
    done
    : > "$out"
    ;;
esac
exit 0
`,
  );
  fs.chmodSync(python, 0o755);

  for (const tool of ["drawio", "claude"]) {
    const stub = path.join(stubDir, tool);
    fs.writeFileSync(
      stub,
      `#!/bin/sh
prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && : > "$a"
  prev="$a"
done
exit 0
`,
    );
    fs.chmodSync(stub, 0o755);
  }

  const source = path.join(base, "paper.pdf");
  fs.writeFileSync(source, "pdf");

  const opts: PipelineOptions = {
    source,
    instructions: "two panels",
    placement: "infer",
    agent: "claude",
    outDir: path.join(base, "runs"),
    // Pin preflight's fallback .env lookup to the isolated temp dir so the
    // developer's real ./.env (which carries a live OPENAI_API_KEY) can't leak
    // in and mask the missing-key cases these tests exercise.
    cwd: base,
    resumePhase: 0,
    skipEnhance: false,
    sequential: false,
    force: false,
    env: {
      ...process.env,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AUTOILLUSTRATE_HEADLESS_BIN: headless,
      AUTOILLUSTRATE_PYTHON: python, // preflight must not depend on a real python3 on PATH
      VENV_PY: python,
      OPENAI_API_KEY: "sk-test",
      AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1",
    },
  };
  return { base, opts };
}

function onlyRunDir(outDir: string): string {
  const entries = fs.readdirSync(outDir);
  assert.equal(entries.length, 1);
  return path.join(outDir, entries[0]);
}

test("full stubbed pipeline runs phases 1-6 and reports the summary", async () => {
  const { opts } = setupStubs();
  const code = await runPipeline(opts);
  assert.equal(code, 0);
  const wd = onlyRunDir(opts.outDir);
  // artifact-name parity with the bash pipeline
  for (const f of [
    "figure.json",
    "methods.md",
    "theme.txt",
    "phase1_report.json",
    "style.md",
    "style_report.json",
    "phase2_report_a.json",
    "phase2_report_b.json",
    "phase3_report_a.json",
    "unit_test_inspections_b.jsonl",
    "panels/a.png",
    "panels/b.inspect.json",
    "figures/full_figure.drawio",
    "figures/full_figure.png",
    "figures/full_figure_enhanced.png",
    "phase6_report.json",
    "logs/phase1.log",
    "logs/phase1b.log",
    "logs/panel_a.log",
    "logs/inspect_b.log",
    "logs/phase4.log",
    "logs/phase5.log",
    "logs/phase6.log",
  ]) {
    assert.ok(fs.existsSync(path.join(wd, f)), `expected ${f}`);
  }
});

test("--skip-enhance stops after phase 4 with exit 0", async () => {
  const { opts } = setupStubs();
  const code = await runPipeline({ ...opts, skipEnhance: true });
  assert.equal(code, 0);
  const wd = onlyRunDir(opts.outDir);
  assert.ok(fs.existsSync(path.join(wd, "figures", "full_figure.png")));
  assert.ok(!fs.existsSync(path.join(wd, "figures", "full_figure_enhanced.png")));
  assert.ok(!fs.existsSync(path.join(wd, "phase6_report.json")));
});

// --interactive: the gate between Phase 4 and 5, driven through its hooks (no
// tty, no browser). The drawio stub writes any `-o` target, so a re-export
// after an edit shows up as a fresh full_figure.png.
const noBrowser = { openBrowser: () => false, autosaveGraceMs: 0 };

test("--interactive: Enter re-exports the edited drawio and continues to enhance", async () => {
  const { opts } = setupStubs();
  const opened: string[] = [];
  let pngBeforeEdit = 0;
  const code = await runPipeline({
    ...opts,
    interactive: true,
    interactiveHooks: {
      ...noBrowser,
      openBrowser: (url) => {
        opened.push(url);
        return true;
      },
      waitForKey: async () => {
        // Simulate the browser autosaving an edit while the run is paused.
        const wd = onlyRunDir(opts.outDir);
        pngBeforeEdit = fs.statSync(path.join(wd, "figures", "full_figure.png")).mtimeMs;
        await new Promise((r) => setTimeout(r, 10));
        fs.writeFileSync(path.join(wd, "figures", "full_figure.drawio"), "<mxfile>edited</mxfile>");
        return "continue";
      },
    },
  });
  assert.equal(code, 0);
  const wd = onlyRunDir(opts.outDir);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.ok(fs.statSync(path.join(wd, "figures", "full_figure.png")).mtimeMs > pngBeforeEdit, "PNG re-exported from the edited drawio");
  assert.ok(fs.existsSync(path.join(wd, "figures", "full_figure_enhanced.png")), "Phase 5 ran");
  assert.ok(fs.existsSync(path.join(wd, "phase6_report.json")), "Phase 6 ran");
  assert.ok(fs.existsSync(path.join(wd, "logs", "phase4b.log")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(wd, "params.json"), "utf8")).interactive, true);
  const rows = JSON.parse(fs.readFileSync(path.join(wd, "metrics", "run_metrics.json"), "utf8")).phases as { phase: number; status: string }[];
  assert.deepEqual(rows.find((r) => r.phase === 4.5)?.status, "ok");
});

test("--interactive: Esc leaves after Phase 4 with exit 0 and the deterministic figure", async () => {
  const { opts } = setupStubs();
  const code = await runPipeline({ ...opts, interactive: true, interactiveHooks: { ...noBrowser, waitForKey: async () => "leave" } });
  assert.equal(code, 0);
  const wd = onlyRunDir(opts.outDir);
  assert.ok(fs.existsSync(path.join(wd, "figures", "full_figure.png")));
  assert.ok(!fs.existsSync(path.join(wd, "figures", "full_figure_enhanced.png")), "Phase 5 skipped");
  assert.ok(!fs.existsSync(path.join(wd, "phase6_report.json")), "Phase 6 skipped");
});

test("--interactive: offered on --resume-from 5, not on --resume-from 6", async () => {
  const { opts } = setupStubs();
  assert.equal(await runPipeline(opts), 0);
  const wd = onlyRunDir(opts.outDir);
  let prompts = 0;
  const hooks = { ...noBrowser, waitForKey: async () => (prompts++, "continue" as const) };
  assert.equal(await runPipeline({ ...opts, workdirArg: wd, resumePhase: 6, interactive: true, interactiveHooks: hooks }), 0);
  assert.equal(prompts, 0, "resume from 6 never opens the editor");
  assert.equal(await runPipeline({ ...opts, workdirArg: wd, resumePhase: 5, interactive: true, interactiveHooks: hooks }), 0);
  assert.equal(prompts, 1, "resume from 5 pauses in the editor before re-enhancing");
});

test("implicit resume skips completed phases via sentinels", async () => {
  const { opts } = setupStubs();
  assert.equal(await runPipeline({ ...opts, skipEnhance: true }), 0);
  const wd = onlyRunDir(opts.outDir);

  // Break the agent stub: any new dispatch would now fail.
  fs.writeFileSync(opts.env!.AUTOILLUSTRATE_HEADLESS_BIN!, "#!/bin/sh\nexit 99\n");
  const code = await runPipeline({ ...opts, workdirArg: wd, skipEnhance: true });
  assert.equal(code, 0);
});

test("--resume-from 4 force-reruns compose only", async () => {
  const { opts } = setupStubs();
  assert.equal(await runPipeline({ ...opts, skipEnhance: true }), 0);
  const wd = onlyRunDir(opts.outDir);
  const png = path.join(wd, "figures", "full_figure.png");
  const before = fs.statSync(png).mtimeMs;
  fs.writeFileSync(opts.env!.AUTOILLUSTRATE_HEADLESS_BIN!, "#!/bin/sh\nexit 99\n"); // agents must not redispatch
  await new Promise((r) => setTimeout(r, 10));
  const code = await runPipeline({ ...opts, workdirArg: wd, resumePhase: 4, skipEnhance: true });
  assert.equal(code, 0);
  assert.ok(fs.statSync(png).mtimeMs > before, "phase 4 re-ran (sentinel ignored for resume target)");
});

test("pipeline fails with exit 1 when a panel reports failed", async () => {
  const { opts } = setupStubs();
  // Phase 2 stub reports failed for panel b.
  fs.writeFileSync(
    opts.env!.AUTOILLUSTRATE_HEADLESS_BIN!,
    `#!/bin/sh
prompt=""; workdir=""; prev=""
for a in "$@"; do
  [ "$prev" = "--prompt-file" ] && prompt="$a"
  [ "$prev" = "--work-dir" ] && workdir="$a"
  prev="$a"
done
case "$prompt" in
  *.phase1_prompt.md)
    printf '{"placement":"half-width","panels":[{"id":"a"},{"id":"b"}]}' > "$workdir/figure.json"
    echo m > "$workdir/methods.md"; echo t > "$workdir/theme.txt"
    printf '{"status":"ok","placement":"half-width","panel_ids":["a","b"]}' > "$workdir/phase1_report.json"
    ;;
  *.phase1b_prompt.md)
    echo '# style' > "$workdir/style.md"
    printf '{"status":"ok"}' > "$workdir/style_report.json"
    ;;
  *.phase2_prompt_*)
    pid=$(grep '^PANEL_ID:' "$prompt" | awk '{print $2}')
    if [ "$pid" = "a" ]; then
      mkdir -p "$workdir/panels"; : > "$workdir/panels/$pid.png"
      printf '{"panel_id":"a","status":"ok","residual_issues":[]}' > "$workdir/phase2_report_a.json"
    else
      printf '{"panel_id":"b","status":"failed","residual_issues":["export failed"]}' > "$workdir/phase2_report_b.json"
    fi
    ;;
esac
exit 0
`,
  );
  const code = await runPipeline(opts);
  assert.equal(code, 1);
});

test("--resume-from 4 --skip-enhance preflight needs neither agent CLI nor OPENAI_API_KEY", async () => {
  const { opts } = setupStubs();
  assert.equal(await runPipeline({ ...opts, skipEnhance: true }), 0);
  const wd = onlyRunDir(opts.outDir);
  // Resuming at compose with --skip-enhance runs only deterministic phases:
  // drop the key and the agent CLI stub, preflight must still pass.
  const env = { ...opts.env! };
  delete env.OPENAI_API_KEY;
  fs.rmSync(path.join(path.dirname(env.AUTOILLUSTRATE_HEADLESS_BIN!), "claude"));
  const code = await runPipeline({ ...opts, env, workdirArg: wd, resumePhase: 4, skipEnhance: true });
  assert.equal(code, 0);
});

test("nanobanana enhance-model swaps the phase-5 key requirement to GEMINI_API_KEY", async () => {
  const { opts } = setupStubs();
  assert.equal(await runPipeline({ ...opts, skipEnhance: true }), 0);
  const wd = onlyRunDir(opts.outDir);
  // Resuming at enhance with a gemini model: OPENAI_API_KEY must no longer
  // be required, GEMINI_API_KEY must be.
  const env = { ...opts.env! };
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  const resume = { ...opts, workdirArg: wd, resumePhase: 5, enhancementAttempts: 1, enhanceModel: "nanobanana" };
  assert.equal(await runPipeline({ ...resume, env }), 2);
  assert.equal(await runPipeline({ ...resume, env: { ...env, GEMINI_API_KEY: "test-key" } }), 0);
});

test("codex enhance-model needs the codex CLI instead of any API key", async () => {
  const { opts } = setupStubs();
  assert.equal(await runPipeline({ ...opts, skipEnhance: true }), 0);
  const wd = onlyRunDir(opts.outDir);
  // Pin PATH to the stub dir only (drawio stub lives there; python comes
  // from AUTOILLUSTRATE_PYTHON) so the host's real codex can't leak in.
  const stubDir = path.dirname(opts.env!.AUTOILLUSTRATE_HEADLESS_BIN!);
  const env = { ...opts.env!, PATH: stubDir };
  delete env.OPENAI_API_KEY;
  const resume = { ...opts, workdirArg: wd, resumePhase: 5, enhancementAttempts: 1, enhanceModel: "codex" };
  assert.equal(await runPipeline({ ...resume, env }), 2);
  fs.writeFileSync(path.join(stubDir, "codex"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(stubDir, "codex"), 0o755);
  assert.equal(await runPipeline({ ...resume, env }), 0);
});

test("gemini-3.1-pro --audit-vlm swaps the Phase 3 audit key to GEMINI_API_KEY", async () => {
  const { opts } = setupStubs();
  // Phase 3 panel inspect consumes the audit VLM (it runs even under
  // --skip-enhance). With a Gemini audit VLM, no OpenAI credential should be
  // demanded, but GEMINI_API_KEY must be.
  const env = { ...opts.env!, AUDIT_VLM: "gemini-3.1-pro" };
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  const gemini = { ...opts, env, skipEnhance: true };
  assert.equal(await runPipeline(gemini), 2); // GEMINI_API_KEY still missing
  assert.equal(await runPipeline({ ...gemini, env: { ...env, GEMINI_API_KEY: "g-key" } }), 0);
});

test("gemini audit must not start on OPENAI_API_KEY alone", async () => {
  const { opts } = setupStubs();
  // OpenAI present, Gemini absent: a Gemini-only audit would previously slip
  // through preflight (OpenAI satisfied the old unconditional check) and die
  // mid-phase. It must be rejected up front instead.
  const env = { ...opts.env!, AUDIT_VLM: "gemini-3.1-pro" };
  delete env.GEMINI_API_KEY;
  assert.equal(await runPipeline({ ...opts, env, skipEnhance: true }), 2);
});

test("gemini --audit-vlm with an openai --unit-test-vlm needs both keys", async () => {
  const { opts } = setupStubs();
  // Stage A audit is Gemini, Stage B unit tests are OpenAI: Phase 6 spans both
  // backends, so preflight must require both. A full run is needed for Phase 6
  // to count; nanobanana keeps Phase 5 off the OpenAI key, so the only OpenAI
  // need is the unit-test backend.
  const env = {
    ...opts.env!,
    AUDIT_VLM: "gemini-3.1-pro",
    UNIT_TEST_VLM: "openai-single",
    GEMINI_API_KEY: "g-key",
  };
  const both = { ...opts, env, enhanceModel: "nanobanana" };
  assert.equal(await runPipeline(both), 0); // both keys present
  const noOpenai = { ...env };
  delete noOpenai.OPENAI_API_KEY;
  assert.equal(await runPipeline({ ...both, env: noOpenai }), 2); // unit-test OpenAI key missing
});

test("codex --unit-test-vlm must NOT hard-require the codex CLI (verify.py falls back to the audit backend)", async () => {
  const { opts } = setupStubs();
  // Stage B codex unit tests have a graceful fallback: verify.py:1627 drops to
  // 'openai-single' (Stage A OpenAI) or the Stage A backend when codex is
  // absent. Preflight must therefore NOT demand the CLI — the fallback's
  // credential is the audit-backend key, already required. Resume at Phase 6
  // (verify only) with PATH pinned to the stub dir so the host's real codex
  // can't leak in; the OpenAI audit key (sk-test) covers the openai-single
  // fallback, so the run must succeed even with no codex on PATH.
  assert.equal(await runPipeline(opts), 0);
  const wd = onlyRunDir(opts.outDir);
  const stubDir = path.dirname(opts.env!.AUTOILLUSTRATE_HEADLESS_BIN!);
  const env = { ...opts.env!, PATH: stubDir, UNIT_TEST_VLM: "codex" };
  const resume = { ...opts, env, workdirArg: wd, resumePhase: 6 };
  assert.equal(await runPipeline(resume), 0); // codex absent, but OpenAI audit key covers the fallback
});

test("--output promotes the enhanced figure and the plan to the target path", async () => {
  const { base, opts } = setupStubs();
  const output = path.join(base, "deliverables", "concept.png");
  const code = await runPipeline({ ...opts, output });
  assert.equal(code, 0);
  const wd = onlyRunDir(opts.outDir);
  assert.ok(fs.existsSync(output), "deliverable copied to --output target");
  // Enhanced export is preferred over the deterministic one when both exist.
  assert.equal(
    fs.readFileSync(output).length,
    fs.readFileSync(path.join(wd, "figures", "full_figure_enhanced.png")).length,
  );
  // figure.json lands beside it as <stem>.prompts.json.
  assert.ok(fs.existsSync(path.join(base, "deliverables", "concept.prompts.json")));
});

test("--output falls back to the deterministic export under --skip-enhance", async () => {
  const { base, opts } = setupStubs();
  const output = path.join(base, "out", "fig.png");
  assert.equal(await runPipeline({ ...opts, skipEnhance: true, output }), 0);
  assert.ok(fs.existsSync(output));
});

test("promoteFinalFigure fails (false) when no figure exists in the workdir", () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-promote-"));
  fs.mkdirSync(path.join(wd, "figures"));
  assert.equal(promoteFinalFigure(wd, path.join(wd, "out.png")), false);
});

test("promoteFinalFigure ships the deterministic export when Phase 6 rejected the enhanced winner", () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-promote-"));
  fs.mkdirSync(path.join(wd, "figures"));
  // Both PNGs exist on disk (Step 5d promotes the winner attempt regardless),
  // but the report says verification fell back to deterministic.
  fs.writeFileSync(path.join(wd, "figures", "full_figure.png"), "DETERMINISTIC");
  fs.writeFileSync(path.join(wd, "figures", "full_figure_enhanced.png"), "ENHANCED-REJECTED");
  fs.writeFileSync(path.join(wd, "phase6_report.json"), JSON.stringify({ shipped: "deterministic" }));
  const output = path.join(wd, "out.png");
  assert.equal(promoteFinalFigure(wd, output), true);
  assert.equal(fs.readFileSync(output, "utf8"), "DETERMINISTIC");
});

test("promoteFinalFigure ships the enhanced winner when Phase 6 accepted it", () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-promote-"));
  fs.mkdirSync(path.join(wd, "figures"));
  fs.writeFileSync(path.join(wd, "figures", "full_figure.png"), "DETERMINISTIC");
  fs.writeFileSync(path.join(wd, "figures", "full_figure_enhanced.png"), "ENHANCED-WINNER");
  fs.writeFileSync(path.join(wd, "phase6_report.json"), JSON.stringify({ shipped: "enhanced" }));
  const output = path.join(wd, "out.png");
  assert.equal(promoteFinalFigure(wd, output), true);
  assert.equal(fs.readFileSync(output, "utf8"), "ENHANCED-WINNER");
});

test("preflight failure exits 2 before any phase runs", async () => {
  const { opts } = setupStubs();
  const env = { ...opts.env!, OPENAI_API_KEY: "" };
  delete env.OPENAI_API_KEY;
  const code = await runPipeline({ ...opts, env });
  assert.equal(code, 2);
  assert.equal(fs.readdirSync(opts.outDir).length, 1); // workdir created but empty of phase artifacts
  const wd = onlyRunDir(opts.outDir);
  assert.ok(!fs.existsSync(path.join(wd, "phase1_report.json")));
});

function runStartHeader(wd: string): string[] {
  const lines = fs.readFileSync(path.join(wd, "events.jsonl"), "utf8").split("\n").filter(Boolean);
  const start = lines.map((l) => JSON.parse(l)).find((r) => r.event === "run_start");
  return start.fields.header as string[];
}

test("run header shows audit/unit tests as disabled when no phase consumes them", async () => {
  const { opts } = setupStubs();
  // 0 inspects + 1 attempt: neither Phase 3 nor Phase 6 runs → no audit, no unit tests
  assert.equal(await runPipeline({ ...opts, panelInspects: 0, enhancementAttempts: 1 }), 0);
  const figureLine = runStartHeader(onlyRunDir(opts.outDir)).find((l) => l.startsWith("Figure:"));
  assert.match(figureLine!, /· audit disabled · unit tests disabled/);

  // inspects only: Phase 3 needs the audit VLM but Stage B unit tests are verify-only
  const inspectOnly = setupStubs();
  assert.equal(await runPipeline({ ...inspectOnly.opts, panelInspects: 1, enhancementAttempts: 1 }), 0);
  const inspectLine = runStartHeader(onlyRunDir(inspectOnly.opts.outDir)).find((l) => l.startsWith("Figure:"));
  assert.match(inspectLine!, /· audit gpt-6-astra · unit tests disabled/);

  // full loops: both shown
  const full = setupStubs();
  assert.equal(await runPipeline({ ...full.opts, panelInspects: 1, enhancementAttempts: 2 }), 0);
  const fullLine = runStartHeader(onlyRunDir(full.opts.outDir)).find((l) => l.startsWith("Figure:"));
  assert.match(fullLine!, /· audit gpt-6-astra · unit tests openai-single/);
});
