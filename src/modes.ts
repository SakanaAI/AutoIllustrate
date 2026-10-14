// Speed presets — three tiers (light | medium | full) that trade runtime for
// quality by setting the agent, the effort, and the two correction-loop budgets
// at once. panelInspects also gates Phase 6: the Phase 3 inspect agent is the
// only writer of unit_test_inspections_<panel>.jsonl, so at 0 the verifier's
// Stage B (the pre-declared arrow probes) silently self-skips and Step 5d loses
// its unit-test tier.
// A preset carries the agent, the counts, and an optional effort; the model is
// derived from the agent by DEFAULT_AGENT_MODEL_OVERRIDES in cli.ts (claude →
// claude-opus-5-5), so all three tiers run Opus 5.5 and differ only in how hard
// they work. light and medium share the same correction-loop budgets (0 inspect,
// 1 enhance → no Phase 3, no Phase 6) and differ only in effort: light dials it
// down to "low" for the cheapest Opus pass, medium and full pin "high" explicitly
// rather than trusting headless's per-agent default (an explicit --agent still
// drops the preset effort, see resolveMode). full
// adds the inspect+verify+repair loops on top. So the tiers separate the two
// levers — reasoning effort (light→medium) and correction loops (medium→full) —
// one at a time, keeping medium at ~15 min.
// enhancementAttempts n = the number of enhanced candidates Phase 5/6 produce:
// the always-on Phase 5 enhance plus (n-1) Phase 6 repair re-enhances, each one
// judged by its own verify pass. So n verify attempts, n-1 repair passes.
// n = 1 is the special case: verify exists only to pick a winner and drive
// repairs, so with a single candidate Phase 6 is skipped entirely. The floor is
// 1 since Phase 5 always runs. light and medium therefore ship the enhanced
// figure unverified, while full runs the Phase 6 loop.
export const MODE_PRESETS = {
  light: { agent: "claude", panelInspects: 0, enhancementAttempts: 1, effort: "low" },
  medium: { agent: "claude", panelInspects: 0, enhancementAttempts: 1, effort: "high" },
  full: { agent: "claude", panelInspects: 3, enhancementAttempts: 3, effort: "high" },
} as const;

export type Mode = keyof typeof MODE_PRESETS;
export const DEFAULT_MODE: Mode = "medium";

// Explicit CLI flags that, when present, win over the preset's values.
// undefined fields fall back to the preset.
export interface ModeOverrides {
  agent?: string;
  panelInspects?: number;
  enhancementAttempts?: number;
  effort?: string;
}

export interface ResolvedMode {
  agent: string;
  panelInspects: number;
  enhancementAttempts: number;
  effort?: string;
}

export function resolveMode(mode: Mode, ov: ModeOverrides): ResolvedMode {
  const preset = MODE_PRESETS[mode];
  const inheritsPresetAgent = ov.agent === undefined || ov.agent === preset.agent;
  return {
    agent: ov.agent ?? preset.agent,
    panelInspects: ov.panelInspects ?? preset.panelInspects,
    enhancementAttempts: ov.enhancementAttempts ?? preset.enhancementAttempts,
    effort:
      ov.effort
      ?? (inheritsPresetAgent && "effort" in preset ? preset.effort : undefined),
  };
}
