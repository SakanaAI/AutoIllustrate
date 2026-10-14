import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunContext } from "../src/context.js";
import { runPhase1, readPlacement } from "../src/phase-plan.js";
import { runPhase1b } from "../src/phase-style.js";
import { runPanelPhase, PHASE2_SPEC, PHASE3_SPEC } from "../src/phase-panels.js";
import { runPhase4 } from "../src/phase-compose.js";
import { runPhase5 } from "../src/phase-enhance.js";
import { runPhase6 } from "../src/phase-verify.js";
import { toolkitDir } from "../src/paths.js";
import { initWorkdir } from "../src/workdir.js";

// Stub agents parse the dispatched prompt header for PANEL_ID / WORKDIR, so
// they exercise the real prompt-building path.
const STUB_PREAMBLE = `#!/bin/sh
prompt=""; workdir=""; prev=""
for a in "$@"; do
  [ "$prev" = "--prompt-file" ] && prompt="$a"
  [ "$prev" = "--work-dir" ] && workdir="$a"
  prev="$a"
done
pid=$(grep '^PANEL_ID:' "$prompt" 2>/dev/null | awk '{print $2}')
`;

function makeCtx(overrides: Partial<RunContext> = {}): RunContext & { stubDir: string } {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-phase-"));
  initWorkdir(workdir);
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-stub-"));
  return {
    workdir,
    toolkitDir: toolkitDir(),
    source: path.join(workdir, "src.pdf"),
    instructions: "two panels",
    placement: "half-width",
    enhanceModel: "gpt-image-2",
    enhanceQuality: "high",
    agent: { agent: "claude", timeoutSecs: 30 },
    panelInspects: 5,
    enhancementAttempts: 4,
    force: false,
    sequential: false,
    python: "/usr/bin/true",
    env: { ...process.env },
    stubDir,
    ...overrides,
  };
}

function installAgentStub(ctx: RunContext & { stubDir: string }, body: string): void {
  const stub = path.join(ctx.stubDir, "agent-stub");
  fs.writeFileSync(stub, STUB_PREAMBLE + body + "\n");
  fs.chmodSync(stub, 0o755);
  ctx.env.AUTOILLUSTRATE_HEADLESS_BIN = stub;
}

function writeFigureJson(workdir: string, ids: string[]): void {
  fs.writeFileSync(
    path.join(workdir, "figure.json"),
    JSON.stringify({ placement: "half-width", panels: ids.map((id) => ({ id })) }),
  );
}

// ── Phase 1 ────────────────────────────────────────────────────────────────

test("phase1 skips on ok sentinel without force", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.workdir, "phase1_report.json"), '{"status":"ok","placement":"half-width"}');
  installAgentStub(ctx, "exit 99"); // would fail if dispatched
  await runPhase1(ctx);
});

test("phase1 validates deliverables after agent run", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(ctx.source!, "pdf");
  installAgentStub(
    ctx,
    `cat > "$workdir/phase1_report.json" <<'EOF'
{"status":"ok","placement":"half-width","panel_ids":["a"]}
EOF
echo '{"panels":[{"id":"a"}]}' > "$workdir/figure.json"
echo m > "$workdir/methods.md"`,
  );
  // theme.txt missing → must throw
  await assert.rejects(runPhase1(ctx), /theme\.txt to exist and be non-empty/);
  fs.writeFileSync(path.join(ctx.workdir, "theme.txt"), "t");
  ctx.force = true;
  await runPhase1(ctx);
});

test("phase1 aborts on non-zero agent and on failed status", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(ctx.source!, "pdf");
  installAgentStub(ctx, "exit 3");
  await assert.rejects(runPhase1(ctx), /exited non-zero/);
  installAgentStub(ctx, `printf '{"status":"failed","reason":"no methods found"}' > "$workdir/phase1_report.json"`);
  await assert.rejects(runPhase1(ctx), /status=failed — no methods found/);
});

test("readPlacement validates the phase1 report", () => {
  const ctx = makeCtx();
  assert.throws(() => readPlacement(ctx.workdir), /phase1_report\.json missing/);
  fs.writeFileSync(path.join(ctx.workdir, "phase1_report.json"), '{"placement":"sideways"}');
  assert.throws(() => readPlacement(ctx.workdir), /invalid placement: sideways/);
  fs.writeFileSync(path.join(ctx.workdir, "phase1_report.json"), '{"placement":"full-width"}');
  assert.equal(readPlacement(ctx.workdir), "full-width");
});

// ── Phase 1.5 (style) ──────────────────────────────────────────────────────

test("phase1b skips on ok sentinel without force", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.workdir, "style_report.json"), '{"status":"ok"}');
  installAgentStub(ctx, "exit 99"); // would fail if dispatched
  await runPhase1b(ctx);
});

test("phase1b validates style.md after agent run", async () => {
  const ctx = makeCtx();
  installAgentStub(ctx, `printf '{"status":"ok"}' > "$workdir/style_report.json"`);
  // style.md missing → must throw
  await assert.rejects(runPhase1b(ctx), /style\.md to exist and be non-empty/);
  installAgentStub(
    ctx,
    `printf '{"status":"ok"}' > "$workdir/style_report.json"
echo s > "$workdir/style.md"`,
  );
  ctx.force = true; // report is now ok on disk — force past the skip sentinel
  await runPhase1b(ctx);
});

test("phase1b aborts on non-zero agent and on failed status", async () => {
  const ctx = makeCtx();
  installAgentStub(ctx, "exit 3");
  await assert.rejects(runPhase1b(ctx), /exited non-zero/);
  installAgentStub(ctx, `printf '{"status":"failed","reason":"no figure.json"}' > "$workdir/style_report.json"`);
  await assert.rejects(runPhase1b(ctx), /status=failed — no figure\.json/);
});

// ── Phases 2/3 (panel fan-out) ─────────────────────────────────────────────

const OK_PANEL_STUB = `mkdir -p "$workdir/panels"
: > "$workdir/panels/$pid.png"
printf 'def build_params(bypass_warnings=False):\\n    return {"page_w": 667, "page_h": 832}\\n' > "$workdir/generate_$pid.py"
printf '{"panel_id":"%s","status":"ok","residual_issues":[]}' "$pid" > "$workdir/phase2_report_$pid.json"`;

test("phase2 dispatches per panel and validates reports + PNGs", async () => {
  const ctx = makeCtx();
  writeFigureJson(ctx.workdir, ["a", "b"]);
  installAgentStub(ctx, OK_PANEL_STUB);
  await runPanelPhase(ctx, PHASE2_SPEC);
  assert.ok(fs.existsSync(path.join(ctx.workdir, ".phase2_prompt_a.md")));
  assert.ok(fs.existsSync(path.join(ctx.workdir, ".phase2_prompt_b.md")));
});

test("phase2 tolerates non-zero agent exit when report is ok (watchdog case)", async () => {
  const ctx = makeCtx({ sequential: true });
  writeFigureJson(ctx.workdir, ["a"]);
  installAgentStub(ctx, OK_PANEL_STUB + "\nexit 143");
  await runPanelPhase(ctx, PHASE2_SPEC);
});

test("prompt-write failure degrades to a warning in both modes; report check judges", async () => {
  for (const sequential of [true, false]) {
    const ctx = makeCtx({ sequential });
    writeFigureJson(ctx.workdir, ["a"]);
    installAgentStub(ctx, OK_PANEL_STUB); // must never be reached
    fs.chmodSync(ctx.workdir, 0o555); // .phase2_prompt_a.md write fails EACCES
    try {
      // The real dispatch error must not propagate raw — the phase fails via
      // the authoritative missing-report validation in either mode.
      await assert.rejects(runPanelPhase(ctx, PHASE2_SPEC), /1 panel\(s\) failed/);
    } finally {
      fs.chmodSync(ctx.workdir, 0o755);
    }
  }
});

test("phase2 aggregates failures across all panels before throwing", async () => {
  const ctx = makeCtx();
  writeFigureJson(ctx.workdir, ["good", "bad", "missing"]);
  installAgentStub(
    ctx,
    `if [ "$pid" = "good" ]; then
${OK_PANEL_STUB}
elif [ "$pid" = "bad" ]; then
  printf '{"panel_id":"%s","status":"failed","residual_issues":["lint failed"]}' "$pid" > "$workdir/phase2_report_$pid.json"
fi`,
  );
  await assert.rejects(runPanelPhase(ctx, PHASE2_SPEC), /2 panel\(s\) failed/);
});

test("phase2 fails when status ok but PNG missing", async () => {
  const ctx = makeCtx();
  writeFigureJson(ctx.workdir, ["a"]);
  installAgentStub(ctx, `printf '{"panel_id":"%s","status":"ok","residual_issues":[]}' "$pid" > "$workdir/phase2_report_$pid.json"`);
  await assert.rejects(runPanelPhase(ctx, PHASE2_SPEC), /1 panel\(s\) failed/);
});

test("phase2 page_w/page_h probe tolerates string dataclass field annotations", async () => {
  // The probe loads generate_<pid>.py via importlib; a @dataclass with a
  // string field annotation makes Python's dataclasses machinery resolve it
  // through sys.modules[cls.__module__], which crashes unless the probe
  // registers the module first. Regression for the false-positive panel fail.
  const ctx = makeCtx({ python: process.env.AUTOILLUSTRATE_PYTHON ?? "python3" });
  writeFigureJson(ctx.workdir, ["a"]);
  installAgentStub(
    ctx,
    OK_PANEL_STUB +
      `\ncat > "$workdir/generate_$pid.py" <<'PYEOF'
from dataclasses import dataclass


@dataclass
class EdgePath:
    points: "list[tuple]"


def build_params(bypass_warnings=False):
    return {"page_w": 667, "page_h": 832}
PYEOF`,
  );
  await runPanelPhase(ctx, PHASE2_SPEC);
});

test("phase2 warns (does not fail) when build_params() omits bypass_warnings", async () => {
  // Regression for test_102: a generator whose build_params() takes no args
  // renders a valid PNG but breaks Phase 4 compose, which calls it with
  // bypass_warnings=True. The contract gate is WARN-only — the run proceeds
  // and Phase 4's compose sub-agent repairs the generator, so one bad panel
  // no longer nukes the whole render phase.
  const ctx = makeCtx({ python: process.env.AUTOILLUSTRATE_PYTHON ?? "python3" });
  writeFigureJson(ctx.workdir, ["a"]);
  installAgentStub(
    ctx,
    `mkdir -p "$workdir/panels"
: > "$workdir/panels/$pid.png"
printf 'def build_params():\\n    return {"page_w": 667, "page_h": 832}\\n' > "$workdir/generate_$pid.py"
printf '{"panel_id":"%s","status":"ok","residual_issues":[]}' "$pid" > "$workdir/phase2_report_$pid.json"`,
  );
  const warnings: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    warnings.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    await runPanelPhase(ctx, PHASE2_SPEC); // resolves — must not throw
  } finally {
    process.stderr.write = realWrite;
  }
  const log = warnings.join("");
  assert.match(log, /⚠/);
  assert.match(log, /bypass_warnings/);
  assert.match(log, /deferring to Phase 4 compose/);
});

test("phase2 skips panels with ok sentinel + PNG", async () => {
  const ctx = makeCtx();
  writeFigureJson(ctx.workdir, ["a"]);
  fs.writeFileSync(path.join(ctx.workdir, "phase2_report_a.json"), '{"status":"degraded"}');
  fs.writeFileSync(path.join(ctx.workdir, "panels", "a.png"), "png");
  fs.writeFileSync(path.join(ctx.workdir, "generate_a.py"), 'def build_params(bypass_warnings=False):\n    return {"page_w": 1, "page_h": 1}\n');
  installAgentStub(ctx, "exit 99"); // would fail if dispatched
  await runPanelPhase(ctx, PHASE2_SPEC);
});

test("phase3 requires the Phase 2 PNG as precondition", async () => {
  const ctx = makeCtx();
  writeFigureJson(ctx.workdir, ["a"]);
  installAgentStub(ctx, "exit 0");
  await assert.rejects(runPanelPhase(ctx, PHASE3_SPEC), /1 panel\(s\) failed/);
});

test("phase3 validates inspect.json + unit tests deliverables", async () => {
  const ctx = makeCtx();
  writeFigureJson(ctx.workdir, ["a"]);
  fs.writeFileSync(path.join(ctx.workdir, "panels", "a.png"), "png");
  installAgentStub(
    ctx,
    `printf '{"panel_id":"%s","status":"ok","attempts_used":1,"residual_issues":[]}' "$pid" > "$workdir/phase3_report_$pid.json"
: > "$workdir/panels/$pid.inspect.json"
: > "$workdir/unit_test_inspections_$pid.jsonl"`,
  );
  await runPanelPhase(ctx, PHASE3_SPEC);
});

test("panel phase aborts when figure.json is missing or empty", async () => {
  const ctx = makeCtx();
  await assert.rejects(runPanelPhase(ctx, PHASE2_SPEC), /figure\.json missing/);
  fs.writeFileSync(path.join(ctx.workdir, "figure.json"), '{"panels":[]}');
  await assert.rejects(runPanelPhase(ctx, PHASE2_SPEC), /no panels/);
});

// ── Phase 4 (compose chain with stub python + drawio) ─────────────────────

function installPhase4Stubs(
  ctx: RunContext & { stubDir: string },
  opts: { dims?: string; producePng?: boolean; pngAfterAttempt?: number } = {},
): void {
  const python = path.join(ctx.stubDir, "python");
  fs.writeFileSync(
    python,
    `#!/bin/sh
if [ "$1" = "-c" ]; then echo "${opts.dims ?? "2560 1440"}"; exit 0; fi
case "$1" in
  */generate_composite.py) mkdir -p "${ctx.workdir}/figures"; : > "${ctx.workdir}/figures/full_figure.drawio" ;;
esac
exit 0
`,
  );
  fs.chmodSync(python, 0o755);
  ctx.python = python;

  // PNG mode: always | never | only after the Nth call (call count in a
  // file). SVG mode (the fallback path) always writes a minimal SVG.
  const producePng =
    opts.producePng === false
      ? "true"
      : opts.pngAfterAttempt
        ? `{ [ "$n" -gt ${opts.pngAfterAttempt} ] && : > "$a" || true; }`
        : ': > "$a"';
  const drawio = path.join(ctx.stubDir, "drawio");
  fs.writeFileSync(
    drawio,
    `#!/bin/sh
n=$(cat "${ctx.workdir}/.drawio_calls" 2>/dev/null || echo 0); n=$((n+1)); printf %s "$n" > "${ctx.workdir}/.drawio_calls"
fmt=png; prev=""
for a in "$@"; do
  [ "$prev" = "-f" ] && fmt="$a"
  prev="$a"
done
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then
    if [ "$fmt" = "svg" ]; then printf '<svg width="2061px" height="845px"></svg>' > "$a"; else ${producePng}; fi
  fi
  prev="$a"
done
exit 0
`,
  );
  fs.chmodSync(drawio, 0o755);
  ctx.env.PATH = `${ctx.stubDir}:${ctx.env.PATH ?? ""}`;
}

test("phase4 runs the compose chain and dimension check", async () => {
  const ctx = makeCtx();
  installPhase4Stubs(ctx);
  await runPhase4(ctx);
  const log = fs.readFileSync(path.join(ctx.workdir, "logs", "phase4.log"), "utf8");
  assert.match(log, /\[step 1\/4\] composing template/);
  assert.match(log, /exported 2560x1440px \(target 1440±10% \[1296\.\.1584\]\)/);
  assert.match(log, /✓ OK \(2560x1440, placement=half-width\)/);
});

test("phase4 warns (not aborts) on out-of-band dimensions", async () => {
  const ctx = makeCtx();
  installPhase4Stubs(ctx, { dims: "2559 900" });
  await runPhase4(ctx);
  const log = fs.readFileSync(path.join(ctx.workdir, "logs", "phase4.log"), "utf8");
  assert.match(log, /⚠ expected width 2560, got 2559/);
  assert.match(log, /⚠ height 900 outside placement target/);
});

test("phase4 warns loudly on unparsable dimensions instead of passing on NaN", async () => {
  const ctx = makeCtx();
  installPhase4Stubs(ctx, { dims: "PIL exploded" });
  await runPhase4(ctx);
  const log = fs.readFileSync(path.join(ctx.workdir, "logs", "phase4.log"), "utf8");
  assert.match(log, /⚠ could not parse export dimensions from "PIL exploded"/);
  assert.match(log, /✓ OK \(dimensions unverified, placement=half-width\)/);
  assert.doesNotMatch(log, /NaN/);
});

test("phase4 retries the drawio export until a PNG appears", async () => {
  const ctx = makeCtx();
  installPhase4Stubs(ctx, { pngAfterAttempt: 1 }); // attempt 1 produces nothing
  await runPhase4(ctx);
  const log = fs.readFileSync(path.join(ctx.workdir, "logs", "phase4.log"), "utf8");
  assert.match(log, /attempt 1\/2\)/);
  assert.doesNotMatch(log, /falling back to SVG/);
  assert.ok(fs.existsSync(path.join(ctx.workdir, "figures", "full_figure.png")));
});

test("phase4 falls back to SVG + Chrome when direct PNG export is exhausted", async () => {
  const ctx = makeCtx();
  installPhase4Stubs(ctx, { producePng: false }); // every direct PNG attempt fails
  const chrome = path.join(ctx.stubDir, "chrome-stub");
  fs.writeFileSync(
    chrome,
    `#!/bin/sh
for a in "$@"; do
  case "$a" in --screenshot=*) : > "\${a#--screenshot=}" ;; esac
done
exit 0
`,
  );
  fs.chmodSync(chrome, 0o755);
  ctx.env.AUTOILLUSTRATE_CHROME = chrome;
  await runPhase4(ctx);
  const log = fs.readFileSync(path.join(ctx.workdir, "logs", "phase4.log"), "utf8");
  assert.match(log, /falling back to SVG \+ headless-Chrome rasterization/);
  assert.match(log, /rasterizing SVG via headless Chrome \(2560x/);
  assert.ok(fs.existsSync(path.join(ctx.workdir, "figures", "full_figure.png")));
  assert.ok(!fs.existsSync(path.join(ctx.workdir, "figures", "full_figure.export.svg")), "svg intermediate cleaned up");
});

test("phase4 routes a drawio export exhaustion into the compose sub-agent, then fails only if the agent can't recover", async () => {
  const ctx = makeCtx();
  installPhase4Stubs(ctx, { producePng: false });
  // Pin the override to a missing path — otherwise findChrome would pick up
  // a real Chrome install on the host and enter the fallback.
  ctx.env.AUTOILLUSTRATE_CHROME = path.join(ctx.stubDir, "nonexistent-chrome");
  installAgentStub(ctx, "exit 0"); // agent can't recover either → terminal
  await assert.rejects(runPhase4(ctx), /compose sub-agent did not produce a figure/);
  const log = fs.readFileSync(path.join(ctx.workdir, "logs", "phase4.log"), "utf8");
  assert.match(log, /deterministic compose failed: .*drawio export did not produce .*SVG fallback/);
});

test("phase4 skips when full_figure.png exists", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.workdir, "figures", "full_figure.png"), "png");
  ctx.python = "/nonexistent"; // would fail if not skipped
  await runPhase4(ctx);
});

// An executable interpreter that fails at runtime, so the deterministic
// compose throws (PhaseError) and the agent fallback fires — distinct from a
// non-executable interpreter, which is a hard precondition that never falls back.
function installFailingPython(ctx: RunContext & { stubDir: string }): void {
  const python = path.join(ctx.stubDir, "python");
  fs.writeFileSync(python, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(python, 0o755);
  ctx.python = python;
}

test("phase4 dispatches a compose sub-agent when the deterministic compose fails", async () => {
  const ctx = makeCtx();
  installFailingPython(ctx);
  installAgentStub(
    ctx,
    `mkdir -p "$workdir/figures"
echo drawio > "$workdir/figures/full_figure.drawio"
echo png > "$workdir/figures/full_figure.png"`,
  );
  await runPhase4(ctx);
  const log = fs.readFileSync(path.join(ctx.workdir, "logs", "phase4.log"), "utf8");
  assert.match(log, /⚠ deterministic compose failed/);
  assert.match(log, /dispatching compose sub-agent/);
  assert.match(log, /✓ OK \(composed by sub-agent/);
  assert.ok(fs.existsSync(path.join(ctx.workdir, ".phase4_prompt.md")), "prompt written");
  assert.ok(fs.existsSync(path.join(ctx.workdir, "logs", "phase4_compose_agent.log")), "agent log written");
  assert.ok(fs.existsSync(path.join(ctx.workdir, "figures", "full_figure.png")));
});

test("phase4 fails when the compose sub-agent also produces no figure", async () => {
  const ctx = makeCtx();
  installFailingPython(ctx);
  installAgentStub(ctx, "exit 0"); // clean exit but writes no deliverables
  await assert.rejects(runPhase4(ctx), /compose sub-agent did not produce a figure/);
});

test("phase4 hard-fails (no fallback) when the interpreter is not executable", async () => {
  const ctx = makeCtx();
  ctx.python = "/nonexistent";
  installAgentStub(ctx, "exit 99"); // would fail if the fallback dispatched it
  await assert.rejects(runPhase4(ctx), /python interpreter not executable/);
});

// ── Phase 5 ────────────────────────────────────────────────────────────────

test("phase5 aborts without input and skips when output exists", async () => {
  const ctx = makeCtx();
  await assert.rejects(runPhase5(ctx), /missing — run phase 4 first/);
  fs.writeFileSync(path.join(ctx.workdir, "figures", "full_figure.png"), "png");
  fs.writeFileSync(path.join(ctx.workdir, "figures", "full_figure_enhanced.png"), "png");
  ctx.python = "/nonexistent"; // would fail if not skipped
  await runPhase5(ctx);
});

test("phase5 passes the configured enhance model and quality to enhance.py", async () => {
  const ctx = makeCtx({ enhanceModel: "nanobanana", enhanceQuality: "xhigh" });
  fs.writeFileSync(path.join(ctx.workdir, "figures", "full_figure.png"), "png");
  const argvLog = path.join(ctx.stubDir, "enhance-argv");
  const stub = path.join(ctx.stubDir, "python");
  fs.writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\n' "$@" > "${argvLog}"
prev=""
for a in "$@"; do
  [ "$prev" = "--out" ] && : > "$a"
  prev="$a"
done
exit 0
`,
  );
  fs.chmodSync(stub, 0o755);
  ctx.python = stub;
  await runPhase5(ctx);
  const argv = fs.readFileSync(argvLog, "utf8").trimEnd().split("\n");
  assert.equal(argv[argv.indexOf("--model") + 1], "nanobanana");
  assert.equal(argv[argv.indexOf("--quality") + 1], "xhigh");
});

// ── Phase 6 ────────────────────────────────────────────────────────────────

test("phase6 skips on existing report regardless of status", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.workdir, "phase6_report.json"), '{"anything":"goes"}');
  installAgentStub(ctx, "exit 99");
  await runPhase6(ctx);
});

test("phase6 validates the shipped field", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.workdir, "figures", "full_figure_enhanced.png"), "png");
  installAgentStub(
    ctx,
    `printf '{"winner_attempt":2,"shipped":"enhanced","summary":"looks good"}' > "$workdir/phase6_report.json"`,
  );
  await runPhase6(ctx);

  fs.rmSync(path.join(ctx.workdir, "phase6_report.json"));
  installAgentStub(ctx, `printf '{"shipped":"maybe"}' > "$workdir/phase6_report.json"`);
  await assert.rejects(runPhase6(ctx), /invalid 'shipped' value: maybe/);
});

test("phase6 aborts on non-zero agent exit (stricter than 2/3)", async () => {
  const ctx = makeCtx();
  fs.writeFileSync(path.join(ctx.workdir, "figures", "full_figure_enhanced.png"), "png");
  installAgentStub(ctx, "exit 5");
  await assert.rejects(runPhase6(ctx), /exited non-zero/);
});
