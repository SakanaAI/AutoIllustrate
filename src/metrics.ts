// Cost + runtime accounting for a pipeline run.
//
// Gathered from artifacts the phases already persist — no phase signature
// changes, and parallel/retry work is captured because we read what landed on
// disk rather than what a single call returned:
//   - Headless agent logs (logs/*.log): native result records when available,
//     plus the normalized usage footer emitted by Headless 0.5+.
//   - an append-only API usage ledger (metrics/api_usage.jsonl): one raw-count
//     record per Python image/vision/CLI call. Prices are applied HERE (single
//     source of truth) — the Python side never computes dollars.
// The orchestrator supplies per-phase wall-clock.
//
// Everything here is best-effort: a missing or malformed artifact is skipped,
// never thrown — a metrics failure must never change the run's exit code.

import fs from "node:fs";
import path from "node:path";

import {
  collectHeadlessCostsByPhase,
  parseResultLine,
} from "./headless-metrics.js";
import { readJson } from "./reports.js";
import { formatDuration, formatTokens } from "./terminal.js";

export { parseResultLine };

export interface UsageTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningOutputTokens?: number;
}

export type CostBasis = "self-reported" | "api-list-price-estimate" | "tokens" | "image" | "subscription" | "unknown";

export interface CostEntry {
  source: string; // headless:<agent> | gemini-image | openai-image | openai-vision | gemini-vision | codex
  model?: string;
  costUsd?: number; // omitted when the model is unpriced (counted as uncosted)
  estimated: boolean; // true when derived from the price table (not self-reported)
  basis: CostBasis;
  provider?: string;
  pricingSource?: string;
  pricingStatus?: "native" | "priced" | "missing";
  usageStatus?: "reported" | "missing";
  usage?: UsageTokens;
  images?: number;
}

export interface PhaseTiming {
  phase: number;
  title: string;
  durationMs: number;
  status: "ok" | "skipped" | "failed";
}

export interface PhaseMetrics extends PhaseTiming {
  costs: CostEntry[];
  costUsd?: number; // sum of known (non-subscription) costs in this phase
  tokens?: number; // sum of reported output tokens (response length) in this phase
}

export type RunStatus = "complete" | "partial" | "failed";

export interface RunMetrics {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  totalDurationSecs: number;
  status: RunStatus;
  phases: PhaseMetrics[];
  totals: {
    costUsd: number;
    tokens: number;
    hasEstimates: boolean;
    uncostedCalls: number;
    apiListEstimateUsd: number;
    bySource: Record<string, number>;
  };
}

// ── Price table ────────────────────────────────────────────────────────────
// BEST-EFFORT defaults for this project's model ids. They WILL drift — verify
// against current provider pricing and override at runtime with a JSON file at
// AUTOILLUSTRATE_PRICE_FILE (deep-merged over these). Every cost derived from
// this table is flagged `estimated: true` and marked `*` in the summary.
//   tokens: USD per 1M tokens (image models bill image output as tokens too)
//   images: USD per image, keyed "<size>|<quality>"
interface TokenPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}
interface ImagePrice {
  // USD per megapixel of output, by quality tier. Image models bill ~by output
  // resolution, so cost is estimated from the recorded WxH rather than matched
  // to an exact size string — the composite can snap to many sizes, and an
  // exact-key table would silently leave the headline enhance cost uncosted.
  perMegapixelByQuality: Record<string, number>;
}
export interface PriceTable {
  tokens: Record<string, TokenPrice>;
  images: Record<string, ImagePrice>;
}

export const DEFAULT_PRICES: PriceTable = {
  tokens: {
    "gemini-3.1-flash-image": { inputPerMTok: 0.3, outputPerMTok: 30.0 },
    "gemini-3-pro-image": { inputPerMTok: 2.0, outputPerMTok: 120.0 },
    // gpt-5.5 standard tier, verified 2026-08 (OpenRouter/OpenAI). $1.25/$10 was
    // GPT-5, not 5.5. A reported Aug-22 cut to $4/$20 is unconfirmed on OpenAI's
    // own page; using the listed standard rate.
    "gpt-5.5": { inputPerMTok: 5.0, outputPerMTok: 30.0 },
    // gpt-6-astra standard tier, verified 2026-09 (OpenAI pricing page via
    // OpenRouter/pricepertoken). Batch/Flex halve it, Fast doubles it.
    "gpt-6-astra": { inputPerMTok: 10.0, outputPerMTok: 50.0 },
    // The vision audits resolve --audit-vlm gemini-3.1-pro to this API id, which
    // is the model string actually recorded; price both spellings.
    "gemini-3.1-pro": { inputPerMTok: 2.0, outputPerMTok: 12.0 },
    "gemini-3.1-pro-preview": { inputPerMTok: 2.0, outputPerMTok: 12.0 },
  },
  images: {
    // Per-MP rates anchored to OpenAI's published gpt-image-2 per-image prices
    // at 1024x1024 (~1.05 MP), verified 2026-08: low $0.006, medium $0.053,
    // high $0.211. Note billing is actually per fixed resolution tier, so a
    // large composite WxH still only approximates the true charge.
    "gpt-image-2": { perMegapixelByQuality: { low: 0.006, medium: 0.05, high: 0.2, auto: 0.2 } },
    // gpt-image-2.5 bills the same $30/M output tokens but re-tiered the
    // quality ladder (verified 2026-09, at 1024x1024): low $0.006, medium
    // $0.013, high $0.053, xhigh $0.094, max $0.211 — its high spends what
    // gpt-image-2 medium did, its max what gpt-image-2 high did. auto is
    // priced as high (the API's default).
    "gpt-image-2.5-sunburst": { perMegapixelByQuality: { low: 0.006, medium: 0.0125, high: 0.05, xhigh: 0.09, max: 0.2, auto: 0.05 } },
    "gpt-image-2.5-flare": { perMegapixelByQuality: { low: 0.006, medium: 0.0125, high: 0.05, xhigh: 0.09, max: 0.2, auto: 0.05 } },
  },
};

type PriceOverride = {
  tokens?: Record<string, Partial<TokenPrice>>;
  images?: Record<string, { perMegapixelByQuality?: Record<string, number> }>;
};

function mergeTokenPrices(override: PriceOverride): Record<string, TokenPrice> {
  const merged = { ...DEFAULT_PRICES.tokens };
  for (const [model, price] of Object.entries(override.tokens ?? {})) {
    merged[model] = { ...(merged[model] ?? {}), ...price } as TokenPrice;
  }
  return merged;
}

function mergeImagePrices(override: PriceOverride): Record<string, ImagePrice> {
  const merged = { ...DEFAULT_PRICES.images };
  for (const [model, price] of Object.entries(override.images ?? {})) {
    merged[model] = {
      perMegapixelByQuality: {
        ...(merged[model]?.perMegapixelByQuality ?? {}),
        ...(price.perMegapixelByQuality ?? {}),
      },
    };
  }
  return merged;
}

export function loadPrices(env: NodeJS.ProcessEnv = process.env): PriceTable {
  const file = env.AUTOILLUSTRATE_PRICE_FILE;
  if (!file) return DEFAULT_PRICES;
  const override = readJson(file);
  if (!override || typeof override !== "object") return DEFAULT_PRICES;
  const o = override as PriceOverride;
  return { tokens: mergeTokenPrices(o), images: mergeImagePrices(o) };
}

export function collectHeadlessByPhase(logsDir: string, runStartSecs: number, ranPhases: Set<number>, agent: string, prices: PriceTable = DEFAULT_PRICES): Map<number, CostEntry[]> {
  return collectHeadlessCostsByPhase(logsDir, runStartSecs, ranPhases, agent, prices);
}

const countOrUndef = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
const validCost = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000;

function megapixels(size: string | undefined): number | undefined {
  if (!size) return undefined;
  const match = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!match) return undefined;
  const pixels = Number(match[1]) * Number(match[2]);
  return pixels > 0 ? pixels / 1e6 : undefined;
}

// ── API usage ledger ─────────────────────────────────────────────────────────
interface LedgerRecord {
  ts?: number;
  phase?: number;
  source?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  images?: number;
  size?: string;
  quality?: string;
  basis?: string;
}

function priceLedgerRecord(rec: LedgerRecord, prices: PriceTable): CostEntry {
  const usage: UsageTokens = {
    inputTokens: countOrUndef(rec.input_tokens),
    outputTokens: countOrUndef(rec.output_tokens),
  };
  const base: CostEntry = {
    source: rec.source ?? "unknown",
    model: rec.model,
    estimated: true,
    basis: "unknown",
    usage,
    images: countOrUndef(rec.images),
  };
  // Subscription (codex): no metered API charge — known $0, not an estimate.
  if (rec.basis === "subscription") return { ...base, costUsd: 0, basis: "subscription", estimated: false };

  if (rec.basis === "tokens" && rec.model && prices.tokens[rec.model]) {
    if (
      (rec.input_tokens !== undefined && usage.inputTokens === undefined)
      || (rec.output_tokens !== undefined && usage.outputTokens === undefined)
    ) {
      return { ...base, basis: "tokens" };
    }
    const p = prices.tokens[rec.model];
    const inTok = usage.inputTokens ?? 0;
    const outTok = usage.outputTokens ?? 0;
    const cost = (inTok / 1e6) * p.inputPerMTok + (outTok / 1e6) * p.outputPerMTok;
    if (validCost(cost)) return { ...base, basis: "tokens", costUsd: round4(cost) };
  }
  if (rec.basis === "image" && rec.model && prices.images[rec.model]) {
    if (rec.images !== undefined && base.images === undefined) return { ...base, basis: "image" };
    const mp = megapixels(rec.size);
    const rate = prices.images[rec.model].perMegapixelByQuality[rec.quality ?? "high"] ?? prices.images[rec.model].perMegapixelByQuality.high;
    const cost = mp !== undefined && rate !== undefined ? mp * rate * (base.images ?? 1) : NaN;
    if (validCost(cost)) return { ...base, basis: "image", costUsd: round4(cost) };
  }
  // Known usage, unknown/unpriceable → carry the counts, leave cost unset.
  return { ...base, basis: rec.basis === "image" ? "image" : rec.basis === "tokens" ? "tokens" : "unknown" };
}

export function readApiLedger(workdir: string, runStartSecs: number, ranPhases: Set<number>, prices: PriceTable): Map<number, CostEntry[]> {
  const out = new Map<number, CostEntry[]>();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workdir, "metrics", "api_usage.jsonl"), "utf8");
  } catch {
    return out;
  }
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
    let rec: LedgerRecord;
    try {
      rec = JSON.parse(ln) as LedgerRecord;
    } catch {
      continue;
    }
    if (typeof rec.phase !== "number" || !ranPhases.has(rec.phase)) continue;
    // Drop records from a prior run that wrote into this reused workdir.
    if (typeof rec.ts === "number" && rec.ts < runStartSecs) continue;
    const arr = out.get(rec.phase) ?? [];
    arr.push(priceLedgerRecord(rec, prices));
    out.set(rec.phase, arr);
  }
  return out;
}

// ── Aggregation ──────────────────────────────────────────────────────────────
const sourceGroup = (source: string): string => (source.startsWith("headless") ? "headless" : source);

export interface BuildOptions {
  workdir: string;
  startedAt: string;
  finishedAt: string;
  runStartSecs: number;
  totalDurationMs: number;
  status: RunStatus;
  timings: PhaseTiming[];
  agent: string;
  env: NodeJS.ProcessEnv;
}

// Response length of a call: output tokens only, like Claude Code's own
// footer. Prompt input and cache reads are left out — they dwarf the output
// and say little about how much work the model produced.
export function usageTokenTotal(usage?: UsageTokens): number | undefined {
  const out = usage?.outputTokens;
  return typeof out === "number" && Number.isFinite(out) ? out : undefined;
}

export function buildRunMetrics(opts: BuildOptions): RunMetrics {
  const prices = loadPrices(opts.env);
  const ranPhases = new Set(opts.timings.filter((t) => t.status !== "skipped").map((t) => t.phase));
  const headless = collectHeadlessByPhase(path.join(opts.workdir, "logs"), opts.runStartSecs, ranPhases, opts.agent, prices);
  const ledger = readApiLedger(opts.workdir, opts.runStartSecs, ranPhases, prices);

  const phases: PhaseMetrics[] = opts.timings.map((t) => {
    const costs = [...(headless.get(t.phase) ?? []), ...(ledger.get(t.phase) ?? [])];
    const knownCosts = costs.filter((cost) => validCost(cost.costUsd));
    const sum = knownCosts.reduce((s, c) => s + (c.costUsd as number), 0);
    const tokenCounts = costs.map((cost) => usageTokenTotal(cost.usage)).filter((n): n is number => n !== undefined);
    return {
      ...t,
      costs,
      costUsd: knownCosts.length > 0 ? round4(sum) : undefined,
      tokens: tokenCounts.length > 0 ? tokenCounts.reduce((s, n) => s + n, 0) : undefined,
    };
  });

  let total = 0;
  let uncosted = 0;
  let hasEstimates = false;
  let apiListEstimate = 0;
  const bySource: Record<string, number> = {};
  for (const p of phases) {
    for (const c of p.costs) {
      if (validCost(c.costUsd)) {
        total += c.costUsd;
        if (c.basis === "api-list-price-estimate") apiListEstimate += c.costUsd;
        const key = sourceGroup(c.source);
        bySource[key] = round4((bySource[key] ?? 0) + c.costUsd);
      } else {
        uncosted++;
      }
      if (c.estimated) hasEstimates = true;
    }
  }

  return {
    schemaVersion: 1,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    totalDurationSecs: Math.round(opts.totalDurationMs / 1000),
    status: opts.status,
    phases,
    totals: {
      costUsd: round4(total),
      tokens: phases.reduce((sum, p) => sum + (p.tokens ?? 0), 0),
      hasEstimates,
      uncostedCalls: uncosted,
      apiListEstimateUsd: round4(apiListEstimate),
      bySource,
    },
  };
}

function serialize(m: RunMetrics): Record<string, unknown> {
  return {
    schema_version: m.schemaVersion,
    started_at: m.startedAt,
    finished_at: m.finishedAt,
    total_duration_secs: m.totalDurationSecs,
    status: m.status,
    phases: m.phases.map((p) => ({
      phase: p.phase,
      title: p.title,
      status: p.status,
      duration_secs: Math.round(p.durationMs / 1000),
      cost_usd: p.costUsd,
      tokens: p.tokens,
      costs: p.costs.map((c) => ({
        source: c.source,
        model: c.model,
        cost_usd: c.costUsd,
        estimated: c.estimated,
        basis: c.basis,
        provider: c.provider,
        pricing_source: c.pricingSource,
        pricing_status: c.pricingStatus,
        usage_status: c.usageStatus,
        usage: c.usage && {
          input_tokens: c.usage.inputTokens,
          output_tokens: c.usage.outputTokens,
          cache_read_tokens: c.usage.cacheReadTokens,
          cache_creation_tokens: c.usage.cacheCreationTokens,
          reasoning_output_tokens: c.usage.reasoningOutputTokens,
        },
        images: c.images,
      })),
    })),
    totals: {
      cost_usd: m.totals.costUsd,
      tokens: m.totals.tokens,
      has_estimates: m.totals.hasEstimates,
      uncosted_calls: m.totals.uncostedCalls,
      api_list_estimate_usd: m.totals.apiListEstimateUsd,
      by_source: m.totals.bySource,
    },
  };
}

export function writeRunMetrics(workdir: string, m: RunMetrics): void {
  const dir = path.join(workdir, "metrics");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run_metrics.json"), JSON.stringify(serialize(m), null, 2) + "\n");
}

// ── Console summary table ────────────────────────────────────────────────────
// Same h/m/s form as the phase lines ("4m 12s"), so the table reads like the run.
const fmtDur = formatDuration;

const shortTitle = (title: string): string => title.replace(/^Phase \d+(?:\.\d+)?\/\d+ — /, "").toLowerCase();

const unreportedCalls = (p: PhaseMetrics): number => p.costs.filter((c) => usageTokenTotal(c.usage) === undefined).length;

function tokenCell(p: PhaseMetrics): string {
  if (p.costs.length === 0) return "—";
  if (p.tokens === undefined) return "?";
  return `${formatTokens(p.tokens)}${unreportedCalls(p) > 0 ? " +?" : ""}`;
}

// Renders the rows + total + footnotes (the orchestrator prints a banner above).
export function formatSummary(m: RunMetrics): string {
  const rows = m.phases.map((p) => ({
    label: `${p.phase} ${shortTitle(p.title)}`,
    time: p.status === "skipped" ? "—" : fmtDur(p.durationMs),
    tokens: tokenCell(p),
  }));
  rows.push({ label: "total", time: fmtDur(m.totalDurationSecs * 1000), tokens: formatTokens(m.totals.tokens) });

  const labelW = Math.max("phase".length, ...rows.map((r) => r.label.length));
  const timeW = Math.max("time".length, ...rows.map((r) => r.time.length));
  const pad = (s: string, w: number): string => s.padEnd(w);

  const out: string[] = [];
  out.push(`${pad("phase", labelW)}  ${pad("time", timeW)}  tokens`);
  for (const r of rows.slice(0, -1)) out.push(`${pad(r.label, labelW)}  ${pad(r.time, timeW)}  ${r.tokens}`);
  const total = rows[rows.length - 1];
  out.push("─".repeat(labelW + timeW + 10));
  out.push(`${pad(total.label, labelW)}  ${pad(total.time, timeW)}  ${total.tokens}`);
  const unreported = m.phases.reduce((sum, p) => sum + unreportedCalls(p), 0);
  if (unreported > 0) out.push(`+? ${unreported} call(s) reported no token usage (image renders, subscription agents, --tmux)`);
  return out.join("\n");
}
