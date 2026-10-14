import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MODE, MODE_PRESETS, resolveMode } from "../src/modes.js";

test("each preset resolves to its table row with no overrides", () => {
  for (const mode of ["light", "medium", "full"] as const) {
    const preset = MODE_PRESETS[mode];
    assert.deepEqual(resolveMode(mode, {}), {
      agent: preset.agent,
      panelInspects: preset.panelInspects,
      enhancementAttempts: preset.enhancementAttempts,
      effort: "effort" in preset ? preset.effort : undefined,
    });
  }
});

test("default mode is medium", () => {
  assert.equal(DEFAULT_MODE, "medium");
  assert.deepEqual(resolveMode(DEFAULT_MODE, {}), {
    agent: "claude",
    panelInspects: 0,
    enhancementAttempts: 1,
    effort: "high",
  });
});

test("light runs claude at low effort", () => {
  const r = resolveMode("light", {});
  assert.equal(r.agent, "claude");
  assert.equal(r.effort, "low");
  assert.equal(r.panelInspects, 0);
  assert.equal(r.enhancementAttempts, 1);
});

test("medium shares light's loop budgets but runs at high effort", () => {
  const light = resolveMode("light", {});
  const medium = resolveMode("medium", {});
  assert.equal(medium.panelInspects, light.panelInspects);
  assert.equal(medium.enhancementAttempts, light.enhancementAttempts);
  assert.equal(light.effort, "low");
  assert.equal(medium.effort, "high", "medium pins high rather than the headless default");
  assert.equal(resolveMode("full", {}).effort, "high");
});

test("explicit budgets (including 0) override the preset", () => {
  const r = resolveMode("full", { panelInspects: 0, enhancementAttempts: 2 });
  assert.equal(r.panelInspects, 0);
  assert.equal(r.enhancementAttempts, 2);
  assert.equal(r.agent, "claude", "agent still from preset");
});

test("explicit effort overrides the preset effort", () => {
  assert.equal(resolveMode("light", { effort: "high" }).effort, "high");
  assert.equal(resolveMode("full", { effort: "xhigh" }).effort, "xhigh");
});

test("explicit agent overrides the preset agent", () => {
  assert.deepEqual(resolveMode("light", { agent: "gemini" }), {
    agent: "gemini",
    panelInspects: 0,
    enhancementAttempts: 1,
    effort: undefined,
  });
  assert.equal(resolveMode("medium", { agent: "codex" }).agent, "codex");
});
