import fs from "node:fs";
import path from "node:path";

import {
  HEADLESS_STDOUT_TAIL_BYTES,
  headlessStdoutLogPath,
} from "./headless-log.js";
import type { CostBasis, CostEntry, PriceTable, UsageTokens } from "./metrics.js";

export interface HeadlessModelCost {
  model?: string;
  costUsd?: number;
  usage?: UsageTokens;
  estimated?: boolean;
  basis?: CostBasis;
  provider?: string;
  pricingSource?: string;
  pricingStatus?: "native" | "priced" | "missing";
  usageStatus?: "reported" | "missing";
  normalized?: boolean;
}

interface HeadlessResult {
  durationMs?: number;
  models: HeadlessModelCost[];
}

const nonnegativeOrUndef = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const tokenOrUndef = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
const MAX_COST_USD = 1_000_000;
const MAX_CANDIDATE_LINES = 10_000;
const MAX_JSON_LINE_CHARS = 1024 * 1024;
const costOrUndef = (value: unknown): number | undefined => {
  const cost = nonnegativeOrUndef(value);
  return cost !== undefined && cost <= MAX_COST_USD ? cost : undefined;
};

const hasTokens = (usage?: UsageTokens): boolean =>
  !!usage && (
    usage.inputTokens !== undefined
    || usage.outputTokens !== undefined
    || usage.cacheReadTokens !== undefined
    || usage.cacheCreationTokens !== undefined
    || usage.reasoningOutputTokens !== undefined
  );

function topLevelHeadlessResult(
  doc: Record<string, unknown>,
  durationMs?: number,
  model?: string,
): HeadlessResult {
  const usage = (doc.usage ?? {}) as Record<string, unknown>;
  return {
    durationMs,
    models: [{
      model,
      costUsd: costOrUndef(doc.total_cost_usd),
      usage: {
        inputTokens: tokenOrUndef(usage.input_tokens),
        outputTokens: tokenOrUndef(usage.output_tokens),
        cacheReadTokens: tokenOrUndef(usage.cache_read_input_tokens),
        cacheCreationTokens: tokenOrUndef(usage.cache_creation_input_tokens),
      },
    }],
  };
}

// Gemini's native result stores token counts under `stats`, not top-level
// `usage`/`modelUsage`. These slices are priced downstream from local tables.
function geminiStatsResult(doc: Record<string, unknown>, durationMs?: number): HeadlessResult | null {
  if (!doc.stats || typeof doc.stats !== "object") return null;
  const stats = doc.stats as Record<string, unknown>;
  const top: UsageTokens = {
    inputTokens: tokenOrUndef(stats.input_tokens),
    outputTokens: tokenOrUndef(stats.output_tokens),
    cacheReadTokens: tokenOrUndef(stats.cached),
  };
  const models = stats.models;
  if (models && typeof models === "object" && Object.keys(models as object).length > 0) {
    const entries = Object.entries(models as Record<string, Record<string, unknown>>);
    const single = entries.length === 1;
    return {
      durationMs,
      models: entries.map(([model, usage]) => ({
        model,
        usage: {
          inputTokens: tokenOrUndef(usage.input_tokens) ?? (single ? top.inputTokens : undefined),
          outputTokens: tokenOrUndef(usage.output_tokens) ?? (single ? top.outputTokens : undefined),
          cacheReadTokens: tokenOrUndef(usage.cached) ?? (single ? top.cacheReadTokens : undefined),
        },
      })),
    };
  }
  return hasTokens(top) ? { durationMs, models: [{ usage: top }] } : null;
}

function normalizedUsageResult(
  doc: Record<string, unknown>,
  expectedAgent?: string,
): HeadlessResult | null {
  if (!doc.usage || typeof doc.usage !== "object") return null;
  const usage = doc.usage as Record<string, unknown>;
  const agent = typeof usage.agent === "string" ? usage.agent : undefined;
  if (!agent || (expectedAgent && agent !== expectedAgent)) return null;
  if (usage.usageStatus !== "reported" && usage.usageStatus !== "missing") return null;

  const usageStatus = usage.usageStatus;
  const pricingStatus = usage.pricingStatus === "native"
    || usage.pricingStatus === "priced"
    || usage.pricingStatus === "missing"
    ? usage.pricingStatus
    : "missing";
  const cost = usage.cost && typeof usage.cost === "object"
    ? usage.cost as Record<string, unknown>
    : undefined;
  const costBasis = typeof usage.costBasis === "string" ? usage.costBasis : undefined;
  const basis: CostBasis = costBasis === "native-reported"
    ? "self-reported"
    : costBasis === "api-list-price-estimate"
      ? "api-list-price-estimate"
      : "tokens";
  const pricingSource = usage.pricingSource === "native" || usage.pricingSource === "models.dev"
    ? usage.pricingSource
    : undefined;
  const tokens: UsageTokens = {
    inputTokens: tokenOrUndef(usage.inputTokens),
    outputTokens: tokenOrUndef(usage.outputTokens),
    cacheReadTokens: tokenOrUndef(usage.cacheReadTokens),
    cacheCreationTokens: tokenOrUndef(usage.cacheWriteTokens),
    reasoningOutputTokens: tokenOrUndef(usage.reasoningOutputTokens),
  };
  const totalTokens = tokenOrUndef(usage.totalTokens);
  const completeUsage = Object.values(tokens).every((value) => value !== undefined)
    && totalTokens !== undefined;
  const baseTokenTotal = (tokens.inputTokens ?? 0)
    + (tokens.outputTokens ?? 0)
    + (tokens.cacheReadTokens ?? 0)
    + (tokens.cacheCreationTokens ?? 0);
  const consistentTokenTotal = totalTokens === baseTokenTotal
    || totalTokens === baseTokenTotal + (tokens.reasoningOutputTokens ?? 0);
  const costTotal = costOrUndef(cost?.total);
  const costParts = [
    costOrUndef(cost?.input),
    costOrUndef(cost?.cacheRead),
    costOrUndef(cost?.cacheWrite),
    costOrUndef(cost?.output),
  ];
  const pricedCostConsistent = costTotal !== undefined
    && costParts.every((part) => part !== undefined)
    && Math.abs(costParts.reduce((sum, part) => sum + (part ?? 0), 0) - costTotal) < 1e-6;
  const costContractValid = usageStatus === "reported"
    && completeUsage
    && consistentTokenTotal
    && (
    (pricingStatus === "native" && costBasis === "native-reported" && pricingSource === "native")
      || (
        pricingStatus === "priced"
        && costBasis === "api-list-price-estimate"
        && pricingSource === "models.dev"
        && pricedCostConsistent
      )
    );

  return {
    models: [{
      model: typeof usage.model === "string" ? usage.model : undefined,
      costUsd: costContractValid ? costTotal : undefined,
      usage: tokens,
      estimated: basis === "api-list-price-estimate",
      basis: usageStatus === "missing" ? "unknown" : basis,
      provider: typeof usage.provider === "string" ? usage.provider : undefined,
      pricingSource,
      pricingStatus,
      usageStatus,
      normalized: true,
    }],
  };
}

function readLogTail(logFile: string): string | null {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fs.openSync(logFile, "r");
    const size = fs.fstatSync(fileDescriptor).size;
    const length = Math.min(size, HEADLESS_STDOUT_TAIL_BYTES);
    const offset = size - length;
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(fileDescriptor, buffer, 0, length, offset);
    let raw = buffer.toString("utf8");
    if (offset > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }
    return raw;
  } catch {
    return null;
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
  }
}

// Claude/Gemini native result records take priority over the normalized usage
// footer because they retain Claude's richer per-model cost breakdown.
export function parseResultLine(
  logFile: string,
  expectedAgent?: string,
  runStartSecs?: number,
): HeadlessResult | null {
  const stdoutLog = headlessStdoutLogPath(logFile);
  let telemetryLog = logFile;
  try {
    const mainMtimeMs = fs.statSync(logFile).mtimeMs;
    const stdoutMtimeMs = fs.statSync(stdoutLog).mtimeMs;
    const runStartMs = (runStartSecs ?? 0) * 1000;
    if (stdoutMtimeMs >= mainMtimeMs && stdoutMtimeMs >= runStartMs) {
      telemetryLog = stdoutLog;
    }
  } catch {
    // Missing sidecar or main log: use the legacy merged log fallback.
  }
  const raw = readLogTail(telemetryLog);
  if (raw === null) return null;
  let normalized: HeadlessResult | null = null;
  let cursor = raw.length;
  let inspectedLines = 0;
  while (cursor > 0 && inspectedLines < MAX_CANDIDATE_LINES) {
    let lineEnd = cursor;
    if (raw.charCodeAt(lineEnd - 1) === 10) lineEnd--;
    const previousNewline = raw.lastIndexOf("\n", lineEnd - 1);
    const line = raw.slice(previousNewline + 1, lineEnd);
    cursor = previousNewline;
    inspectedLines++;
    if (!line || line.length > MAX_JSON_LINE_CHARS) continue;

    if (!normalized && line.includes('"usage"')) {
      try {
        normalized = normalizedUsageResult(JSON.parse(line) as Record<string, unknown>, expectedAgent);
      } catch {
        // Keep looking for a native result record.
      }
    }
    if (!line.includes('"type":"result"') && !line.includes('"type": "result"')) continue;

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (doc.type !== "result") continue;

    const durationMs = nonnegativeOrUndef(doc.duration_ms);
    const modelUsage = doc.modelUsage;
    if (modelUsage && typeof modelUsage === "object" && Object.keys(modelUsage as object).length > 0) {
      if (expectedAgent && expectedAgent !== "claude") continue;
      const entries = Object.entries(modelUsage as Record<string, Record<string, unknown>>);
      const models = entries.map(([model, usage]) => ({
        model,
        costUsd: costOrUndef(usage.costUSD),
        usage: {
          inputTokens: tokenOrUndef(usage.inputTokens),
          outputTokens: tokenOrUndef(usage.outputTokens),
          cacheReadTokens: tokenOrUndef(usage.cacheReadInputTokens),
          cacheCreationTokens: tokenOrUndef(usage.cacheCreationInputTokens),
        },
      }));
      if (!models.some((model) => model.costUsd !== undefined || hasTokens(model.usage))) {
        return topLevelHeadlessResult(doc, durationMs, entries[0]?.[0]);
      }
      return { durationMs, models };
    }
    if (doc.stats && (!expectedAgent || expectedAgent === "gemini")) {
      const geminiResult = geminiStatsResult(doc, durationMs);
      if (geminiResult) return geminiResult;
    }
    if (!expectedAgent || expectedAgent === "claude") {
      return topLevelHeadlessResult(doc, durationMs);
    }
  }
  return normalized;
}

const LOG_PHASE: Array<{ test: (file: string) => boolean; phase: number }> = [
  { test: (file) => file === "phase1.log", phase: 1 },
  { test: (file) => file === "phase1b.log", phase: 1.5 },
  { test: (file) => file.startsWith("panel_") && file.endsWith(".log"), phase: 2 },
  { test: (file) => file.startsWith("inspect_") && file.endsWith(".log"), phase: 3 },
  { test: (file) => file === "phase4_compose_agent.log", phase: 4 },
  { test: (file) => file === "phase6.log", phase: 6 },
];

function priceHeadlessSlice(agent: string, model: HeadlessModelCost, prices: PriceTable): CostEntry {
  const base: CostEntry = {
    source: `headless:${agent}`,
    model: model.model,
    estimated: true,
    basis: "tokens",
    usage: model.usage,
  };
  const price = model.model ? prices.tokens[model.model] : undefined;
  if (price && model.usage) {
    const inputTokens = model.usage.inputTokens ?? 0;
    const outputTokens = model.usage.outputTokens ?? 0;
    const cost = (inputTokens / 1e6) * price.inputPerMTok
      + (outputTokens / 1e6) * price.outputPerMTok;
    if (Number.isFinite(cost) && cost <= MAX_COST_USD) {
      return { ...base, costUsd: round4(cost) };
    }
  }
  return base;
}

export function collectHeadlessCostsByPhase(
  logsDir: string,
  runStartSecs: number,
  ranPhases: Set<number>,
  agent: string,
  prices: PriceTable,
): Map<number, CostEntry[]> {
  const costsByPhase = new Map<number, CostEntry[]>();
  let files: string[];
  try {
    files = fs.readdirSync(logsDir);
  } catch {
    return costsByPhase;
  }

  for (const file of files) {
    const match = LOG_PHASE.find((rule) => rule.test(file));
    if (!match || !ranPhases.has(match.phase)) continue;
    const logFile = path.join(logsDir, file);
    try {
      if (fs.statSync(logFile).mtimeMs / 1000 < runStartSecs) continue;
    } catch {
      continue;
    }
    const result = parseResultLine(logFile, agent, runStartSecs);
    if (!result) continue;
    const slices = result.models.filter((model) =>
      model.costUsd !== undefined
      || hasTokens(model.usage)
      || (model.normalized && model.usageStatus === "missing"));
    if (slices.length === 0) continue;

    const phaseCosts = costsByPhase.get(match.phase) ?? [];
    for (const model of slices) {
      if (model.costUsd !== undefined) {
        phaseCosts.push({
          source: `headless:${agent}`,
          model: model.model,
          costUsd: model.costUsd,
          estimated: model.estimated ?? false,
          basis: model.basis ?? "self-reported",
          provider: model.provider,
          pricingSource: model.pricingSource,
          pricingStatus: model.pricingStatus,
          usageStatus: model.usageStatus,
          usage: model.usage,
        });
      } else if (model.normalized) {
        phaseCosts.push({
          source: `headless:${agent}`,
          model: model.model,
          estimated: model.estimated ?? true,
          basis: model.basis ?? "tokens",
          provider: model.provider,
          pricingSource: model.pricingSource,
          pricingStatus: model.pricingStatus,
          usageStatus: model.usageStatus,
          usage: model.usage,
        });
      } else {
        phaseCosts.push(priceHeadlessSlice(agent, model, prices));
      }
    }
    costsByPhase.set(match.phase, phaseCosts);
  }
  return costsByPhase;
}
