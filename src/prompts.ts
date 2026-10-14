// Sub-agent prompt builders — ports of the dispatch heredocs in
// phase{1,2,3,6}_*.sh. Templates live in prompts/*.md with {{VAR}} markers;
// literal `$WORKDIR/...` text in them is intentional (the sub-agent reads it
// alongside the absolute WORKDIR value in its dispatch header).

import fs from "node:fs";
import path from "node:path";

import { promptsDir } from "./paths.js";

export interface PromptVars {
  workdir: string;
  placement: string;
  toolkitDir: string;
  python: string;
  panelId?: string;
  panelShare?: string; // Phase 2: the panel's share of the figure (see describePanelShare)
  panelInspects?: number; // Phase 3 inspect/refine budget
  enhancementAttempts?: number; // n verify attempts, n-1 repair passes (1 = Phase 6 skipped)
  enhanceModel?: string; // Phase 6: what the repair loop's re-enhances must pass to enhance.py
  enhanceQuality?: string;
}

function renderTemplate(templateName: string, vars: PromptVars): string {
  let text = fs.readFileSync(path.join(promptsDir(), templateName), "utf8");
  // "repairs" = attempts - 1 (the initial pass is not a repair). Both are
  // derived from the same budget so the prompt's two phrasings stay consistent.
  const pairs: Array<[string, string | undefined]> = [
    ["WORKDIR", vars.workdir],
    ["PLACEMENT", vars.placement],
    ["TOOLKIT_DIR", vars.toolkitDir],
    ["PYTHON", vars.python],
    ["PANEL_ID", vars.panelId],
    ["PANEL_SHARE", vars.panelShare],
    ["PANEL_INSPECTS", vars.panelInspects !== undefined ? String(vars.panelInspects) : undefined],
    ["PANEL_REPAIRS", vars.panelInspects !== undefined ? String(vars.panelInspects - 1) : undefined],
    // enhancementAttempts n = n verify attempts, n-1 repair passes: verify
    // attempt 1 judges the Phase 5 enhance, attempts 2..n each follow a repair.
    ["ENHANCEMENT_ATTEMPTS", vars.enhancementAttempts !== undefined ? String(vars.enhancementAttempts) : undefined],
    ["ENHANCEMENT_REPAIRS", vars.enhancementAttempts !== undefined ? String(vars.enhancementAttempts - 1) : undefined],
    ["ENHANCE_MODEL", vars.enhanceModel],
    ["ENHANCE_QUALITY", vars.enhanceQuality],
  ];
  for (const [key, value] of pairs) {
    if (value !== undefined) text = text.replaceAll(`{{${key}}}`, value);
  }
  const leftover = text.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`${templateName}: unsubstituted variable ${leftover[0]}`);
  return text;
}

// Phase 1: generated header + prompts/phase1.md verbatim (phase1_plan.sh:34-44).
export function buildPhase1Prompt(vars: PromptVars & { source: string; instructions: string }): string {
  const header =
    "# Dispatch header (injected by the orchestrator)\n\n" +
    `WORKDIR:      ${vars.workdir}\n` +
    `SOURCE:       ${vars.source}\n` +
    `PLACEMENT:    ${vars.placement}\n` +
    `TOOLKIT_DIR:  ${vars.toolkitDir}\n` +
    `PYTHON:       ${vars.python}\n\n` +
    "INSTRUCTIONS (verbatim, from --prompt):\n" +
    `${vars.instructions}\n\n` +
    "---\n\n";
  return header + fs.readFileSync(path.join(promptsDir(), "phase1.md"), "utf8");
}

// Phase 1.5 style: figure-wide style spec (style.md), between plan and panels.
export function buildPhase1bPrompt(vars: PromptVars): string {
  return renderTemplate("phase1b-style.md", vars);
}

// Mirrors CANONICAL_INNER in scripts/schema.py: the composite's inner
// panel-space size per placement, so the share note can quote the panel's
// own target size alongside its fraction of the figure.
const CANONICAL_INNER: Record<string, [number, number]> = {
  "full-width": [2000, 832],
  "half-width": [2000, 1104],
};

// One-line summary of how much of the figure a panel owns, for the Phase 2
// dispatch header — the panel agent scales its detail to this. Proportions
// come from figure.json (back-filled by scripts/schema.py in Phase 1); when
// they are absent the note still states the panel count.
export function describePanelShare(figure: unknown, panelId: string, placement: string): string {
  const panels = (figure as { panels?: unknown } | null)?.panels;
  const list = Array.isArray(panels) ? (panels as Array<Record<string, unknown>>) : [];
  const idx = list.findIndex((p) => p && p.id === panelId);
  const n = list.length;
  const count = n <= 1 ? "the only panel of this figure" : `panel ${idx + 1} of ${n}`;
  const me = idx >= 0 ? list[idx] : undefined;
  const pw = typeof me?.proportion_w === "number" ? me.proportion_w : undefined;
  const ph = typeof me?.proportion_h === "number" ? me.proportion_h : undefined;
  if (pw === undefined || ph === undefined) return `${count} (share unknown: figure.json carries no proportions)`;
  const pct = Math.round(pw * ph * 100);
  const inner = CANONICAL_INNER[placement];
  const dims = inner ? ` (about ${Math.round(pw * inner[0])} × ${Math.round(ph * inner[1])} panel-space units)` : "";
  return `${count}, ${pct}% of the figure area${dims}`;
}

export function buildPhase2Prompt(vars: PromptVars & { panelId: string; panelShare: string }): string {
  return renderTemplate("phase2-panel.md", vars);
}

export function buildPhase3Prompt(vars: PromptVars & { panelId: string }): string {
  return renderTemplate("phase3-inspect.md", vars);
}

// Phase 4 compose fallback: dispatched only when the deterministic compose
// throws — the sub-agent re-runs the composition and repairs whatever broke.
export function buildPhase4Prompt(vars: PromptVars): string {
  return renderTemplate("phase4-compose.md", vars);
}

export function buildPhase6Prompt(vars: PromptVars): string {
  return renderTemplate("phase6-verify.md", vars);
}
