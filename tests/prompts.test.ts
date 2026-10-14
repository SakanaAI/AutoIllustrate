import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPhase1Prompt,
  buildPhase1bPrompt,
  buildPhase2Prompt,
  buildPhase3Prompt,
  describePanelShare,
  buildPhase4Prompt,
  buildPhase6Prompt,
} from "../src/prompts.js";

const VARS = {
  workdir: "/abs/run",
  placement: "half-width",
  toolkitDir: "/abs/toolkit",
  python: "/abs/venv/bin/python",
};

test("phase1 prompt = dispatch header + phase1.md body", () => {
  const p = buildPhase1Prompt({ ...VARS, source: "/abs/paper.pdf", instructions: "Two panels: loop + results." });
  assert.match(p, /^# Dispatch header \(injected by the orchestrator\)\n\nWORKDIR: {6}\/abs\/run\n/);
  assert.match(p, /SOURCE: {7}\/abs\/paper\.pdf\n/);
  assert.match(p, /PYTHON: {7}\/abs\/venv\/bin\/python\n/);
  assert.match(p, /INSTRUCTIONS \(verbatim, from --prompt\):\nTwo panels: loop \+ results\.\n\n---\n\n/);
  assert.ok(p.includes("Phase 1"), "phase1.md body appended");
});

test("phase1b prompt substitutes workdir + toolkit and points at the style guide", () => {
  const p = buildPhase1bPrompt({ ...VARS });
  assert.match(p, /WORKDIR: {6}\/abs\/run\n/);
  assert.ok(p.includes("`/abs/toolkit/references/style_guide.md`"));
  assert.ok(p.includes("$WORKDIR/style.md"));
  assert.ok(!p.includes("{{"), "no unsubstituted markers");
});

test("phase2 prompt substitutes all vars and keeps literal $WORKDIR text", () => {
  const p = buildPhase2Prompt({ ...VARS, panelId: "shinka_loop", panelShare: "panel 1 of 2, 50% of the figure area" });
  assert.match(p, /WORKDIR: {5}\/abs\/run\n/);
  assert.match(p, /PANEL_ID: {4}shinka_loop\n/);
  assert.match(p, /PANEL_SHARE: panel 1 of 2, 50% of the figure area\n/);
  assert.ok(p.includes("DETAIL BUDGET"));
  assert.match(p, /PYTHON: {6}\/abs\/venv\/bin\/python\n/);
  assert.ok(p.includes("`/abs/toolkit/references/panel_agent.md`"));
  assert.ok(p.includes("generate_shinka_loop.py"));
  assert.ok(p.includes('"panel_id": "shinka_loop"'));
  // Literal $WORKDIR text survives substitution (bash heredoc had \$WORKDIR).
  assert.ok(p.includes("$WORKDIR/figure.json"));
  assert.ok(p.includes("$WORKDIR/phase2_report_shinka_loop.json"));
  assert.ok(!p.includes("{{"), "no unsubstituted markers");
});

test("describePanelShare reports position, area share, and target size", () => {
  const figure = {
    panels: [
      { id: "a", proportion_w: 0.3333, proportion_h: 1.0 },
      { id: "b", proportion_w: 0.6667, proportion_h: 1.0 },
    ],
  };
  assert.equal(
    describePanelShare(figure, "a", "full-width"),
    "panel 1 of 2, 33% of the figure area (about 667 × 832 panel-space units)",
  );
  assert.equal(
    describePanelShare(figure, "b", "half-width"),
    "panel 2 of 2, 67% of the figure area (about 1333 × 1104 panel-space units)",
  );
  assert.equal(
    describePanelShare({ panels: [{ id: "solo", proportion_w: 1, proportion_h: 1 }] }, "solo", "full-width"),
    "the only panel of this figure, 100% of the figure area (about 2000 × 832 panel-space units)",
  );
  // Grid cell: area share is the product of the two proportions.
  assert.match(describePanelShare({ panels: [{ id: "g", proportion_w: 0.5, proportion_h: 0.5 }, {}, {}, {}] }, "g", "full-width"), /^panel 1 of 4, 25% /);
});

test("describePanelShare degrades when proportions or the file are missing", () => {
  assert.equal(
    describePanelShare({ panels: [{ id: "a" }, { id: "b" }, { id: "c" }] }, "b", "half-width"),
    "panel 2 of 3 (share unknown: figure.json carries no proportions)",
  );
  assert.equal(describePanelShare(null, "a", "infer"), "the only panel of this figure (share unknown: figure.json carries no proportions)");
  // Unknown placement: share still reported, target size omitted.
  assert.equal(
    describePanelShare({ panels: [{ id: "a", proportion_w: 0.5, proportion_h: 1 }, { id: "b" }] }, "a", "infer"),
    "panel 1 of 2, 50% of the figure area",
  );
});

test("phase3 prompt covers inspect deliverables and budget", () => {
  const p = buildPhase3Prompt({ ...VARS, panelId: "p1", panelInspects: 5 });
  assert.match(p, /BUDGET: {6}5 inspect attempts \(1 initial \+ up to 4 repair passes\)/);
  assert.ok(p.includes("panels/p1.inspect.json"));
  assert.ok(p.includes("unit_test_inspections_p1.jsonl"));
  assert.ok(p.includes("$WORKDIR/phase3_report_p1.json"));
  assert.ok(p.includes('"status": "ok" | "degraded" | "failed"'));
});

test("phase3 prompt substitutes a custom panel-inspects budget", () => {
  const p = buildPhase3Prompt({ ...VARS, panelId: "p1", panelInspects: 2 });
  assert.match(p, /BUDGET: {6}2 inspect attempts \(1 initial \+ up to 1 repair passes\)/);
  assert.ok(p.includes("<int between 1 and 2>"));
  assert.ok(p.includes("the 2-attempt budget was exhausted"));
  assert.ok(!p.includes("{{"), "no unsubstituted markers");
});

test("phase4 prompt points at the compose reference and states the deliverables", () => {
  const p = buildPhase4Prompt({ ...VARS });
  assert.match(p, /WORKDIR: {5}\/abs\/run\n/);
  assert.match(p, /PLACEMENT: {3}half-width\n/);
  assert.match(p, /PYTHON: {6}\/abs\/venv\/bin\/python\n/);
  assert.ok(p.includes("`/abs/toolkit/references/compose_agent.md`"));
  assert.ok(p.includes("$WORKDIR/figures/full_figure.drawio"));
  assert.ok(p.includes("$WORKDIR/figures/full_figure.png"));
  assert.ok(p.includes("$WORKDIR/logs/phase4.log"));
  assert.ok(!p.includes("{{"), "no unsubstituted markers");
});

test("phase6 prompt has no panel id and validates shipped contract", () => {
  const p = buildPhase6Prompt({ ...VARS, enhancementAttempts: 3, enhanceModel: "nanobanana", enhanceQuality: "xhigh" });
  assert.match(p, /BUDGET: {6}3 verify attempts, 2 repair passes/);
  // The repair loop's re-enhances must reuse Phase 5's model and quality.
  assert.match(p, /ENHANCE: {5}model nanobanana, quality xhigh/);
  assert.ok(p.includes("`--model nanobanana\n             --quality xhigh`"));
  assert.ok(p.includes("enhance_repair_agent.md"));
  assert.ok(p.includes('"shipped": "enhanced" | "deterministic"'));
  assert.ok(p.includes("$WORKDIR/figures/verify.attempt-<N>.json"));
});

test("phase6 prompt substitutes a custom enhancement-attempts budget", () => {
  // n verify attempts, n-1 repair passes.
  const p = buildPhase6Prompt({ ...VARS, enhancementAttempts: 2, enhanceModel: "gpt-image-2.5-sunburst", enhanceQuality: "high" });
  assert.match(p, /BUDGET: {6}2 verify attempts, 1 repair passes/);
  assert.ok(!p.includes("{{"), "no unsubstituted markers");
  // Without the enhance vars the template's ENHANCE line stays unsubstituted.
  assert.throws(() => buildPhase6Prompt({ ...VARS, enhancementAttempts: 2 }), /unsubstituted variable \{\{ENHANCE_MODEL\}\}/);
});

test("unsubstituted markers throw", () => {
  // Missing panelId for a panel template must fail loudly, not dispatch a
  // prompt containing {{PANEL_ID}}.
  assert.throws(
    () => buildPhase2Prompt({ ...VARS, panelId: undefined as unknown as string, panelShare: "x" }),
    /unsubstituted variable \{\{PANEL_ID\}\}/,
  );
  // A phase3/phase6 build without its attempt budget must also fail loudly.
  assert.throws(
    () => buildPhase3Prompt({ ...VARS, panelId: "p1" }),
    /unsubstituted variable \{\{PANEL_INSPECTS\}\}/,
  );
  assert.throws(
    () => buildPhase6Prompt({ ...VARS }),
    /unsubstituted variable \{\{ENHANCEMENT_ATTEMPTS\}\}/,
  );
});
