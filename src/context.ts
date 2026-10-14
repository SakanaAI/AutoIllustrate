// Shared run context threaded through the phase modules — replaces the env
// var plumbing (WORKDIR, TOOLKIT_DIR, PLACEMENT, AGENT, ...) between run.sh
// and the phase scripts.

import type { AgentConfig } from "./agent.js";

// Keep in sync with MODEL_REGISTRY / resolve_model in scripts/enhance.py,
// the usage text, and docs/cli.md. Any model id is accepted: the aliases below
// map to their backends, a `gemini*` id goes to the Gemini API, and every
// other id is passed through to the OpenAI Images API.
export const DEFAULT_ENHANCE_MODEL = "gpt-image-2.5-sunburst";
// --enhance-quality: passed through to enhance.py --quality unvalidated —
// the accepted vocabulary is the image model's (gpt-image-2.5 takes
// low|medium|high|xhigh|max|auto, gpt-image-2 has no xhigh/max, the
// nanobanana models take the same ladder or a literal 1K|2K|4K, codex
// ignores it), so the backend is the one to reject a value.
export const DEFAULT_ENHANCE_QUALITY = "high";
export const GEMINI_ENHANCE_MODELS = ["nanobanana", "nanobanana-pro"];
export const CODEX_ENHANCE_MODEL = "codex";
export type EnhanceBackend = "openai" | "gemini" | "codex";

// Which credential the Phase 5 preflight gates on: OPENAI_API_KEY,
// GEMINI_API_KEY, or a ChatGPT-authenticated codex CLI.
export function enhanceBackend(model: string): EnhanceBackend {
  if (model === CODEX_ENHANCE_MODEL) return "codex";
  if (GEMINI_ENHANCE_MODELS.includes(model) || model.startsWith("gemini")) return "gemini";
  return "openai";
}

// Vision-audit VLM knobs, surfaced as --audit-vlm (the holistic content audit —
// Phase 3 panel inspect AND Phase 6 verify Stage A, one shared knob) and
// --unit-test-vlm (Phase 6 Stage B unit tests) on the orchestrator. The flags
// set $AUDIT_VLM / $UNIT_TEST_VLM, which the sub-agents inherit and
// inspect_panel.py / verify.py read as their defaults. Keep in sync with
// VLM_REGISTRY / UT_BACKEND_CHOICES in scripts/verify.py + inspect_panel.py.
export const AUDIT_VLMS = ["gpt-6-astra", "gpt-5.5", "gemini-3.1-pro"];
export const DEFAULT_AUDIT_VLM = "gpt-6-astra";
export const UNIT_TEST_VLMS = ["auto", "openai", "openai-single", "gemini", "gemini-single", "codex"];
export const DEFAULT_UNIT_TEST_VLM = "openai-single";

// Agent-orchestrated correction-loop budgets, substituted into the Phase 3 /
// Phase 6 dispatch prompts (authoritative over the reference docs the sub-agents
// read). Overridable via --panel-inspects / --enhancement-attempts.
// --panel-inspects: 1 inspect + (n-1) repairs; 0 skips Phase 3.
// --enhancement-attempts: n verify attempts + (n-1) repair passes over the
// Phase 5 enhance and its re-enhances; floor 1, where 1 skips Phase 6.
export const DEFAULT_PANEL_INSPECTS = 5; // Phase 3 per-panel inspect/refine
export const DEFAULT_ENHANCEMENT_ATTEMPTS = 3; // 3 verify attempts + 2 repair passes

// What a phase reports back to the orchestrator for its completion line:
// "completed · 4 panels · full-width · 2m 10s". A void return means completed
// with nothing to add; a sentinel skip returns status "skipped".
export interface PhaseResult {
  status: "completed" | "degraded" | "skipped";
  outcome?: string;
}

export interface RunContext {
  workdir: string;
  toolkitDir: string;
  source?: string; // absolute; required when phase 1 runs
  instructions?: string;
  placement: string; // half-width | full-width | infer (pre-phase-1 only)
  enhanceModel: string; // gpt-image-2.5-sunburst | gpt-image-2 | nanobanana | nanobanana-pro | codex | any image model id
  enhanceQuality: string; // model-specific vocabulary, e.g. low | medium | high | xhigh | max | auto
  mode?: string; // light | medium | full — the speed preset that set the budgets below
  agent: AgentConfig;
  panelInspects: number; // Phase 3 inspect/refine budget (default 5; 0 skips Phase 3)
  enhancementAttempts: number; // n verify attempts + (n-1) repair passes (default 3; 1 skips Phase 6)
  force: boolean;
  sequential: boolean;
  python: string; // venv interpreter, absolute
  env: NodeJS.ProcessEnv;
}
