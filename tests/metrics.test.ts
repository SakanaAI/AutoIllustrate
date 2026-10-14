import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { headlessStdoutLogPath } from "../src/headless-log.js";
import {
  loadPrices,
  DEFAULT_PRICES,
  parseResultLine,
  collectHeadlessByPhase,
  readApiLedger,
  buildRunMetrics,
  writeRunMetrics,
  formatSummary,
  type PhaseTiming,
} from "../src/metrics.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-metrics-"));
}

// A compact headless result line (matches the real `--json` tail shape). The
// single modelUsage slice carries the same cost/tokens as the rolled-up total.
function resultLine(costUsd: number, model = "claude-opus-4-8"): string {
  return JSON.stringify({
    type: "result",
    total_cost_usd: costUsd,
    duration_ms: 120000,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 },
    modelUsage: {
      [model]: { costUSD: costUsd, inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 200 },
    },
  });
}

function resultLineWithEmptyModelUsage(costUsd: number, model = "claude-opus-4-8"): string {
  return JSON.stringify({
    type: "result",
    total_cost_usd: costUsd,
    duration_ms: 120000,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 },
    modelUsage: { [model]: {} },
  });
}

// A two-model result line — main work on `primary`, housekeeping on an aux
// model — mirroring how Claude Code bills a tiny haiku alongside the requested
// model. `auxCost` is small; primaryCost is the bulk of the spend.
function multiModelResultLine(primary: string, primaryCost: number, aux: string, auxCost: number): string {
  return JSON.stringify({
    type: "result",
    total_cost_usd: primaryCost + auxCost,
    duration_ms: 120000,
    usage: { input_tokens: 7000, output_tokens: 12000, cache_read_input_tokens: 400000 },
    modelUsage: {
      [aux]: { costUSD: auxCost, inputTokens: 3400, outputTokens: 17, cacheReadInputTokens: 0 },
      [primary]: { costUSD: primaryCost, inputTokens: 6900, outputTokens: 12000, cacheReadInputTokens: 400000 },
    },
  });
}

function normalizedUsageLine(options: {
  agent?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalCost?: number | null;
  costBasis?: "native-reported" | "api-list-price-estimate" | null;
  pricingSource?: "native" | "models.dev" | null;
  pricingStatus?: "native" | "priced" | "missing";
  usageStatus?: "reported" | "missing";
} = {}): string {
  const totalCost = options.totalCost === undefined ? 0.344943 : options.totalCost;
  const usageStatus = options.usageStatus ?? "reported";
  return JSON.stringify({
    usage: {
      agent: options.agent ?? "codex",
      provider: options.provider ?? (options.agent === "claude" ? "anthropic" : "openai"),
      model: options.model ?? "gpt-5.6-sol",
      inputTokens: options.inputTokens ?? 23_479,
      cacheReadTokens: options.cacheReadTokens ?? 214_016,
      cacheWriteTokens: options.cacheWriteTokens ?? 0,
      outputTokens: options.outputTokens ?? 4_018,
      reasoningOutputTokens: options.reasoningOutputTokens ?? 797,
      totalTokens: (options.inputTokens ?? 23_479)
        + (options.cacheReadTokens ?? 214_016)
        + (options.cacheWriteTokens ?? 0)
        + (options.outputTokens ?? 4_018),
      usageStatus,
      cost: totalCost === null ? null : {
        input: totalCost === 0 ? 0 : 0.117395,
        cacheRead: totalCost === 0 ? 0 : 0.107008,
        cacheWrite: 0,
        output: totalCost === 0 ? 0 : 0.12054,
        total: totalCost,
      },
      costBasis: options.costBasis === undefined
        ? (totalCost === null ? null : "api-list-price-estimate")
        : options.costBasis,
      pricingSource: options.pricingSource === undefined
        ? (totalCost === null ? null : "models.dev")
        : options.pricingSource,
      pricingStatus: options.pricingStatus ?? (totalCost === null ? "missing" : "priced"),
    },
  });
}

test("loadPrices returns defaults and deep-merges AUTOILLUSTRATE_PRICE_FILE", () => {
  assert.equal(loadPrices({}).tokens["gpt-5.5"].inputPerMTok, DEFAULT_PRICES.tokens["gpt-5.5"].inputPerMTok);

  const dir = tmpdir();
  const priceFile = path.join(dir, "prices.json");
  fs.writeFileSync(priceFile, JSON.stringify({ tokens: { "my-model": { inputPerMTok: 1, outputPerMTok: 2 } } }));
  const merged = loadPrices({ AUTOILLUSTRATE_PRICE_FILE: priceFile });
  assert.equal(merged.tokens["my-model"].outputPerMTok, 2); // override added
  assert.ok(merged.tokens["gpt-5.5"], "defaults retained"); // defaults kept

  fs.writeFileSync(priceFile, JSON.stringify({ images: { "gpt-image-2": { perMegapixelByQuality: { medium: 0.05 } } } }));
  const deepMerged = loadPrices({ AUTOILLUSTRATE_PRICE_FILE: priceFile });
  assert.equal(deepMerged.images["gpt-image-2"].perMegapixelByQuality.medium, 0.05);
  assert.equal(deepMerged.images["gpt-image-2"].perMegapixelByQuality.high, DEFAULT_PRICES.images["gpt-image-2"].perMegapixelByQuality.high);

  // a missing/garbage price file falls back to defaults, never throws
  assert.equal(loadPrices({ AUTOILLUSTRATE_PRICE_FILE: path.join(dir, "nope.json") }).tokens["gpt-5.5"].inputPerMTok, DEFAULT_PRICES.tokens["gpt-5.5"].inputPerMTok);
});

test("parseResultLine reads the last result line and tolerates junk", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, ['{"type":"assistant","text":"working"}', "not json at all", resultLine(0.25)].join("\n") + "\n");
  const res = parseResultLine(log, "claude");
  assert.equal(res?.durationMs, 120000);
  assert.equal(res?.models.length, 1);
  assert.equal(res?.models[0].costUsd, 0.25);
  assert.equal(res?.models[0].model, "claude-opus-4-8");
  assert.equal(res?.models[0].usage?.inputTokens, 100);
  assert.equal(res?.models[0].usage?.cacheReadTokens, 200);

  // last result wins
  fs.writeFileSync(log, [resultLine(1.0), resultLine(2.0)].join("\n") + "\n");
  assert.equal(parseResultLine(log)?.models[0].costUsd, 2.0);

  // no result line / missing file → null
  fs.writeFileSync(log, '{"type":"assistant"}\n');
  assert.equal(parseResultLine(log), null);
  assert.equal(parseResultLine(path.join(dir, "absent.log")), null);
});

test("parseResultLine surfaces one slice per model in modelUsage", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  // Opus does the work ($1.07); a tiny aux haiku rides along ($0.0035).
  fs.writeFileSync(log, multiModelResultLine("claude-opus-4-8", 1.0709, "claude-haiku-4-5-20251001", 0.0035) + "\n");
  const res = parseResultLine(log);
  assert.equal(res?.models.length, 2);
  const opus = res?.models.find((m) => m.model === "claude-opus-4-8");
  const haiku = res?.models.find((m) => m.model === "claude-haiku-4-5-20251001");
  assert.equal(opus?.costUsd, 1.0709);
  assert.equal(opus?.usage?.outputTokens, 12000);
  assert.equal(haiku?.costUsd, 0.0035);
  assert.equal(haiku?.usage?.outputTokens, 17);

  // collectHeadlessByPhase emits a cost entry per model, both labelled
  fs.writeFileSync(path.join(dir, "panel_a.log"), multiModelResultLine("claude-opus-4-8", 2.0, "claude-haiku-4-5-20251001", 0.01) + "\n");
  const costs = collectHeadlessByPhase(dir, 0, new Set([1, 2]), "claude");
  const phase2 = costs.get(2) ?? [];
  assert.equal(phase2.length, 2);
  assert.ok(phase2.find((c) => c.model === "claude-opus-4-8" && c.costUsd === 2.0));
  assert.ok(phase2.find((c) => c.model === "claude-haiku-4-5-20251001" && c.costUsd === 0.01));
});

test("parseResultLine reads Headless 0.5 normalized Codex usage", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, [
    '{"type":"turn.completed","usage":{"input_tokens":237495,"cached_input_tokens":214016,"output_tokens":4018}}',
    normalizedUsageLine(),
  ].join("\n") + "\n");

  const res = parseResultLine(log);
  assert.equal(res?.models.length, 1);
  assert.equal(res?.models[0].model, "gpt-5.6-sol");
  assert.equal(res?.models[0].costUsd, 0.344943);
  assert.equal(res?.models[0].estimated, true);
  assert.equal(res?.models[0].basis, "api-list-price-estimate");
  assert.equal(res?.models[0].provider, "openai");
  assert.equal(res?.models[0].pricingSource, "models.dev");
  assert.equal(res?.models[0].pricingStatus, "priced");
  assert.equal(res?.models[0].usage?.inputTokens, 23_479);
  assert.equal(res?.models[0].usage?.cacheReadTokens, 214_016);
  assert.equal(res?.models[0].usage?.reasoningOutputTokens, 797);

  const costs = collectHeadlessByPhase(dir, 0, new Set([1]), "codex");
  assert.deepEqual(costs.get(1), [{
    source: "headless:codex",
    model: "gpt-5.6-sol",
    costUsd: 0.344943,
    estimated: true,
    basis: "api-list-price-estimate",
    provider: "openai",
    pricingSource: "models.dev",
    pricingStatus: "priced",
    usageStatus: "reported",
    usage: {
      inputTokens: 23_479,
      outputTokens: 4_018,
      cacheReadTokens: 214_016,
      cacheCreationTokens: 0,
      reasoningOutputTokens: 797,
    },
  }]);
});

test("parseResultLine preserves Claude per-model native costs when normalized usage is appended", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, [
    multiModelResultLine("claude-opus-4-8", 1.0709, "claude-haiku-4-5-20251001", 0.0035),
    normalizedUsageLine({
      agent: "claude",
      model: "claude-opus-4-8",
      totalCost: 1.0744,
      costBasis: "native-reported",
      pricingSource: "native",
    }),
  ].join("\n") + "\n");

  const res = parseResultLine(log);
  assert.equal(res?.models.length, 2);
  assert.ok(res?.models.find((m) => m.model === "claude-opus-4-8" && m.costUsd === 1.0709));
  assert.ok(res?.models.find((m) => m.model === "claude-haiku-4-5-20251001" && m.costUsd === 0.0035));
});

test("parseResultLine retains missing normalized usage as an uncosted call", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, normalizedUsageLine({ usageStatus: "missing", totalCost: null }) + "\n");
  const res = parseResultLine(log, "codex");
  assert.equal(res?.models.length, 1);
  assert.equal(res?.models[0].costUsd, undefined);
  assert.equal(res?.models[0].usageStatus, "missing");
  const entry = collectHeadlessByPhase(dir, 0, new Set([1]), "codex").get(1)?.[0];
  assert.equal(entry?.costUsd, undefined);
  assert.equal(entry?.usageStatus, "missing");
});

test("parseResultLine rejects spoofed or invalid normalized usage", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, normalizedUsageLine({ agent: "claude" }) + "\n");
  assert.equal(parseResultLine(log, "codex"), null);

  fs.writeFileSync(log, normalizedUsageLine({ totalCost: -1 }) + "\n");
  const negative = parseResultLine(log, "codex");
  assert.equal(negative?.models[0].costUsd, undefined);
  assert.equal(negative?.models[0].usageStatus, "reported");
});

test("parseResultLine ignores native result schemas from the wrong agent", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, resultLine(999_999, "forged-claude-model") + "\n");
  fs.writeFileSync(headlessStdoutLogPath(log), normalizedUsageLine() + "\n");
  const result = parseResultLine(log, "codex");
  assert.equal(result?.models[0].model, "gpt-5.6-sol");
  assert.equal(result?.models[0].costUsd, 0.344943);
});

test("parseResultLine ignores a stdout sidecar older than the main log", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  const stdoutLog = headlessStdoutLogPath(log);
  fs.writeFileSync(stdoutLog, normalizedUsageLine({ model: "stale-model" }) + "\n");
  fs.writeFileSync(log, normalizedUsageLine({ model: "current-model" }) + "\n");
  const now = Date.now() / 1000;
  fs.utimesSync(stdoutLog, now - 60, now - 60);
  fs.utimesSync(log, now, now);
  assert.equal(parseResultLine(log, "codex")?.models[0].model, "current-model");
});

test("parseResultLine discards negative native costs and token counts", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, JSON.stringify({
    type: "result",
    total_cost_usd: -4,
    usage: { input_tokens: -100, output_tokens: 50 },
    modelUsage: {
      "claude-opus-4-8": { costUSD: -4, inputTokens: -100, outputTokens: 50 },
    },
  }) + "\n");
  const result = parseResultLine(log, "claude");
  assert.equal(result?.models[0].costUsd, undefined);
  assert.equal(result?.models[0].usage?.inputTokens, undefined);
  assert.equal(result?.models[0].usage?.outputTokens, 50);
});

test("parseResultLine leaves incomplete or implausible costs uncosted", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  const incomplete = JSON.parse(normalizedUsageLine()) as {
    usage: Record<string, unknown>;
  };
  delete incomplete.usage.outputTokens;
  fs.writeFileSync(log, JSON.stringify(incomplete) + "\n");
  assert.equal(parseResultLine(log, "codex")?.models[0].costUsd, undefined);

  fs.writeFileSync(log, resultLine(Number.MAX_VALUE) + "\n");
  assert.equal(parseResultLine(log, "claude")?.models[0].costUsd, undefined);
});

test("parseResultLine distinguishes reported zero usage from missing usage", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, normalizedUsageLine({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalCost: 0,
  }) + "\n");
  const entry = collectHeadlessByPhase(dir, 0, new Set([1]), "codex").get(1)?.[0];
  assert.equal(entry?.usageStatus, "reported");
  assert.equal(entry?.costUsd, 0);
});

test("parseResultLine bounds large trace parsing to the final log tail", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  const fd = fs.openSync(log, "w");
  try {
    const filler = Buffer.alloc(9 * 1024 * 1024, "x");
    fs.writeSync(fd, filler);
    fs.writeSync(fd, `\n${normalizedUsageLine()}\n`);
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(parseResultLine(log, "codex")?.models[0].model, "gpt-5.6-sol");

  const earlyOnly = path.join(dir, "panel_a.log");
  const earlyFd = fs.openSync(earlyOnly, "w");
  try {
    fs.writeSync(earlyFd, `${normalizedUsageLine()}\n`);
    fs.writeSync(earlyFd, Buffer.alloc(9 * 1024 * 1024, "x"));
  } finally {
    fs.closeSync(earlyFd);
  }
  assert.equal(parseResultLine(earlyOnly, "codex"), null);
});

test("parseResultLine + collectHeadlessByPhase price the Gemini stats schema", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  // The Gemini agent: no total_cost_usd; tokens nested under `stats`/`stats.models`.
  const gemini = JSON.stringify({
    type: "result",
    status: "success",
    stats: {
      total_tokens: 231344, input_tokens: 1_000_000, output_tokens: 500_000,
      cached: 178401, duration_ms: 63105,
      models: { "gemini-3.1-pro-preview": { input_tokens: 1_000_000, output_tokens: 500_000 } },
    },
  });
  fs.writeFileSync(log, ['{"type":"assistant","text":"hi"}', gemini].join("\n") + "\n");

  const res = parseResultLine(log);
  assert.equal(res?.models.length, 1);
  assert.equal(res?.models[0].model, "gemini-3.1-pro-preview");
  assert.equal(res?.models[0].costUsd, undefined); // no self-reported cost
  assert.equal(res?.models[0].usage?.inputTokens, 1_000_000);

  // Estimated from the table: 1M in @ $2/M + 0.5M out @ $12/M = $8.
  const costs = collectHeadlessByPhase(dir, 0, new Set([1]), "gemini");
  const entry = costs.get(1)?.[0];
  assert.equal(entry?.model, "gemini-3.1-pro-preview");
  assert.equal(entry?.costUsd, 8.0);
  assert.equal(entry?.estimated, true);
  assert.equal(entry?.basis, "tokens");
});

test("parseResultLine falls back to top-level totals when modelUsage is only labels", () => {
  const dir = tmpdir();
  const log = path.join(dir, "phase1.log");
  fs.writeFileSync(log, resultLineWithEmptyModelUsage(0.25) + "\n");

  const res = parseResultLine(log);
  assert.equal(res?.models.length, 1);
  assert.equal(res?.models[0].model, "claude-opus-4-8");
  assert.equal(res?.models[0].costUsd, 0.25);
  assert.equal(res?.models[0].usage?.inputTokens, 100);

  const costs = collectHeadlessByPhase(dir, 0, new Set([1]), "claude");
  assert.equal(costs.get(1)?.[0].costUsd, 0.25);
});

test("collectHeadlessByPhase buckets by filename and skips non-ran phases", () => {
  const logs = tmpdir();
  fs.writeFileSync(path.join(logs, "phase1.log"), resultLine(0.2) + "\n");
  fs.writeFileSync(path.join(logs, "panel_a.log"), resultLine(0.3) + "\n");
  fs.writeFileSync(path.join(logs, "panel_b.log"), resultLine(0.3) + "\n");
  fs.writeFileSync(path.join(logs, "inspect_a.log"), resultLine(0.4) + "\n");
  fs.writeFileSync(path.join(logs, "phase6.log"), resultLine(0.33) + "\n");
  fs.writeFileSync(path.join(logs, "phase4.log"), "deterministic, no result line\n");

  const all = collectHeadlessByPhase(logs, 0, new Set([1, 2, 3, 6]), "claude");
  assert.equal(all.get(1)?.length, 1);
  assert.equal(all.get(2)?.length, 2); // both panel logs
  assert.equal(all.get(3)?.[0].costUsd, 0.4);
  assert.equal(all.get(3)?.[0].source, "headless:claude");
  assert.equal(all.get(3)?.[0].estimated, false);
  assert.equal(all.has(4), false); // phase4.log has no result line

  // phase 3 not run → inspect log excluded
  const partial = collectHeadlessByPhase(logs, 0, new Set([1, 2]), "claude");
  assert.equal(partial.has(3), false);
});

test("collectHeadlessByPhase ignores stale logs from earlier runs", () => {
  const logs = tmpdir();
  const staleLog = path.join(logs, "phase1.log");
  const currentLog = path.join(logs, "phase6.log");
  fs.writeFileSync(staleLog, resultLine(0.2) + "\n");
  fs.writeFileSync(currentLog, resultLine(0.4) + "\n");

  const runStartSecs = Date.now() / 1000;
  fs.utimesSync(staleLog, runStartSecs - 20, runStartSecs - 20);
  fs.utimesSync(currentLog, runStartSecs + 20, runStartSecs + 20);

  const costs = collectHeadlessByPhase(logs, runStartSecs, new Set([1, 6]), "claude");
  assert.equal(costs.has(1), false);
  assert.equal(costs.get(6)?.[0].costUsd, 0.4);
});

test("readApiLedger prices records and filters by phase + run start", () => {
  const workdir = tmpdir();
  fs.mkdirSync(path.join(workdir, "metrics"));
  const lines = [
    JSON.stringify({ ts: 2000, phase: 6, source: "gemini-image", model: "gemini-3.1-flash-image", input_tokens: 1_000_000, output_tokens: 0, basis: "tokens" }),
    JSON.stringify({ ts: 2000, phase: 6, source: "openai-image", model: "gpt-image-2", images: 1, size: "1000x1000", quality: "high", basis: "image" }),
    JSON.stringify({ ts: 2000, phase: 6, source: "openai-image", model: "gpt-image-2.5-sunburst", images: 1, size: "1000x1000", quality: "max", basis: "image" }),
    JSON.stringify({ ts: 2000, phase: 6, source: "openai-image", model: "gpt-image-2.5-sunburst", images: 1, size: "1000x1000", quality: "xhigh", basis: "image" }),
    JSON.stringify({ ts: 2000, phase: 6, source: "openai-image", model: "gpt-image-2.5-sunburst", images: 1, size: "1000x1000", quality: "weird", basis: "image" }), // unknown tier → priced as high
    JSON.stringify({ ts: 2000, phase: 6, source: "codex", model: "codex", basis: "subscription" }),
    JSON.stringify({ ts: 2000, phase: 6, source: "gemini-image", model: "unknown-model", input_tokens: 10, basis: "tokens" }),
    JSON.stringify({ ts: 2000, phase: 6, source: "gemini-image", model: "gemini-3.1-flash-image", input_tokens: "oops", basis: "tokens" }), // non-numeric → must not NaN
    JSON.stringify({ ts: 2000, phase: 6, source: "gemini-image", model: "gemini-3.1-flash-image", input_tokens: Number.MAX_SAFE_INTEGER, basis: "tokens" }),
    JSON.stringify({ ts: 500, phase: 6, source: "gemini-image", model: "gemini-3.1-flash-image", basis: "tokens" }), // before run start
    JSON.stringify({ ts: 2000, phase: 5, source: "openai-vision", model: "gpt-5.5", input_tokens: 0, output_tokens: 0, basis: "tokens" }), // wrong phase
    "{ this is not json",
  ];
  fs.writeFileSync(path.join(workdir, "metrics", "api_usage.jsonl"), lines.join("\n") + "\n");

  const p5 = readApiLedger(workdir, 1000, new Set([6]), loadPrices({})).get(6) ?? [];
  assert.equal(p5.length, 9, "kept: 5 priced + subscription + unknown-model + 2 invalid costs; dropped: stale ts, phase 5, junk");
  const sunburst = p5.filter((c) => c.model === "gpt-image-2.5-sunburst").map((c) => c.costUsd);
  assert.deepEqual(sunburst, [0.2, 0.09, 0.05], "max = gpt-image-2 high rate, xhigh between, unknown tier falls back to high");
  const gemini = p5.find((c) => c.model === "gemini-3.1-flash-image" && c.usage?.inputTokens === 1_000_000);
  assert.equal(gemini?.costUsd, 0.3); // 1M input @ 0.30/M
  assert.equal(gemini?.estimated, true);
  const image = p5.find((c) => c.source === "openai-image");
  assert.equal(image?.costUsd, 0.2); // 1.0 MP @ 0.20/MP, any size now priced
  const sub = p5.find((c) => c.basis === "subscription");
  assert.equal(sub?.costUsd, 0);
  assert.equal(sub?.estimated, false);
  assert.equal(p5.find((c) => c.model === "unknown-model")?.costUsd, undefined); // unpriced → uncosted
  // A malformed count is retained as uncosted instead of silently becoming $0
  // or poisoning totals with NaN.
  const bad = p5.find((c) => c.usage?.inputTokens === undefined && c.model === "gemini-3.1-flash-image");
  assert.equal(bad?.costUsd, undefined);
  assert.equal(bad?.basis, "tokens");
  const implausible = p5.find((c) => c.usage?.inputTokens === Number.MAX_SAFE_INTEGER);
  assert.equal(implausible?.costUsd, undefined);
});

test("readApiLedger prices the resolved gemini-3.1-pro-preview vision id", () => {
  const workdir = tmpdir();
  fs.mkdirSync(path.join(workdir, "metrics"));
  fs.writeFileSync(
    path.join(workdir, "metrics", "api_usage.jsonl"),
    JSON.stringify({ ts: 2000, phase: 6, source: "gemini-vision", model: "gemini-3.1-pro-preview", input_tokens: 1_000_000, output_tokens: 0, basis: "tokens" }) + "\n",
  );
  const p6 = readApiLedger(workdir, 1000, new Set([6]), loadPrices({})).get(6) ?? [];
  assert.equal(p6[0]?.costUsd, 2.0); // 1M input @ 2.0/M — the resolved -preview id is priced
});

function fixtureRun(): string {
  const workdir = tmpdir();
  fs.mkdirSync(path.join(workdir, "logs"));
  fs.mkdirSync(path.join(workdir, "metrics"));
  fs.writeFileSync(path.join(workdir, "logs", "phase1.log"), resultLine(0.2) + "\n");
  fs.writeFileSync(
    path.join(workdir, "metrics", "api_usage.jsonl"),
    [
      JSON.stringify({ ts: 2000, phase: 5, source: "gemini-image", model: "gemini-3.1-flash-image", input_tokens: 1_000_000, output_tokens: 0, basis: "tokens" }),
      JSON.stringify({ ts: 2000, phase: 5, source: "gemini-image", model: "unknown-model", input_tokens: 10, basis: "tokens" }),
    ].join("\n") + "\n",
  );
  return workdir;
}

test("buildRunMetrics aggregates totals, estimates, and uncosted calls", () => {
  const workdir = fixtureRun();
  const timings: PhaseTiming[] = [
    { phase: 1, title: "Phase 1/6 — Plan", durationMs: 62000, status: "ok" },
    { phase: 4, title: "Phase 4/6 — Compose", durationMs: 8000, status: "ok" },
    { phase: 5, title: "Phase 5/6 — Enhance", durationMs: 22000, status: "ok" },
    { phase: 6, title: "Phase 6/6 — Verify + repair", durationMs: 0, status: "skipped" },
  ];
  const m = buildRunMetrics({
    workdir,
    startedAt: "2026-06-13T14:30:45",
    finishedAt: "2026-06-13T14:32:17",
    runStartSecs: 1000,
    totalDurationMs: 92000,
    status: "complete",
    timings,
    agent: "claude",
    env: {},
  });

  const p1 = m.phases.find((p) => p.phase === 1)!;
  assert.equal(p1.costUsd, 0.2); // headless self-reported
  assert.equal(p1.tokens, 50); // output tokens only — input and cache reads excluded
  const p4 = m.phases.find((p) => p.phase === 4)!;
  assert.equal(p4.tokens, undefined); // no calls → no token line
  const p5 = m.phases.find((p) => p.phase === 5)!;
  assert.equal(p5.costUsd, 0.3); // gemini priced; unknown-model excluded from sum
  assert.equal(p5.tokens, 0); // output_tokens: 0 counts; the input-only record is unreported
  assert.equal(m.totals.costUsd, 0.5);
  assert.equal(m.totals.tokens, 50);
  assert.equal(m.totals.hasEstimates, true); // gemini estimate present
  assert.equal(m.totals.uncostedCalls, 1); // unknown-model
  assert.equal(m.totals.bySource["headless"], 0.2);
  assert.equal(m.totals.bySource["gemini-image"], 0.3);

  // round-trips to a snake_case artifact
  writeRunMetrics(workdir, m);
  const written = JSON.parse(fs.readFileSync(path.join(workdir, "metrics", "run_metrics.json"), "utf8"));
  assert.equal(written.schema_version, 1);
  assert.equal(written.totals.cost_usd, 0.5);
  assert.equal(written.phases[0].duration_secs, 62);
});

test("buildRunMetrics preserves normalized pricing provenance and separates API-list estimates", () => {
  const workdir = tmpdir();
  fs.mkdirSync(path.join(workdir, "logs"));
  fs.mkdirSync(path.join(workdir, "metrics"));
  fs.writeFileSync(path.join(workdir, "logs", "phase1.log"), normalizedUsageLine() + "\n");
  const m = buildRunMetrics({
    workdir,
    startedAt: "x",
    finishedAt: "y",
    runStartSecs: 0,
    totalDurationMs: 1000,
    status: "complete",
    timings: [{ phase: 1, title: "Phase 1/6 — Plan", durationMs: 1000, status: "ok" }],
    agent: "codex",
    env: {},
  });
  assert.equal(m.totals.costUsd, 0.3449);
  assert.equal(m.totals.apiListEstimateUsd, 0.3449);

  writeRunMetrics(workdir, m);
  const written = JSON.parse(fs.readFileSync(path.join(workdir, "metrics", "run_metrics.json"), "utf8"));
  const entry = written.phases[0].costs[0];
  assert.equal(written.totals.api_list_estimate_usd, 0.3449);
  assert.equal(entry.provider, "openai");
  assert.equal(entry.pricing_source, "models.dev");
  assert.equal(entry.pricing_status, "priced");
  assert.equal(entry.usage_status, "reported");
  assert.equal(entry.usage.reasoning_output_tokens, 797);
});

test("formatSummary renders token rows, a total, and the unreported-usage footnote", () => {
  const workdir = fixtureRun();
  const m = buildRunMetrics({
    workdir,
    startedAt: "x",
    finishedAt: "y",
    runStartSecs: 1000,
    totalDurationMs: 92000,
    status: "complete",
    timings: [
      { phase: 1, title: "Phase 1/6 — Plan", durationMs: 62000, status: "ok" },
      { phase: 5, title: "Phase 5/6 — Enhance", durationMs: 22000, status: "ok" },
    ],
    agent: "claude",
    env: {},
  });
  const out = formatSummary(m);
  assert.match(out, /phase\s+time\s+tokens/);
  assert.match(out, /^1 plan\s+1m 2s\s+0\.1k$/m); // 50 output tokens
  assert.match(out, /^5 enhance\s+22s\s+0\.0k \+\?$/m); // one call reported no output tokens
  assert.match(out, /^total\s+1m 32s\s+0\.1k$/m);
  assert.doesNotMatch(out, /\$/); // no prices anywhere
  assert.match(out, /\+\? 1 call\(s\) reported no token usage/);
});

test("formatSummary marks calls with no token usage and footnotes them", () => {
  const workdir = tmpdir();
  fs.mkdirSync(path.join(workdir, "metrics"));
  fs.writeFileSync(
    path.join(workdir, "metrics", "api_usage.jsonl"),
    JSON.stringify({ ts: 2000, phase: 5, source: "codex", model: "codex", basis: "subscription" }) + "\n",
  );
  const m = buildRunMetrics({
    workdir,
    startedAt: "x",
    finishedAt: "y",
    runStartSecs: 1000,
    totalDurationMs: 44000,
    status: "complete",
    timings: [{ phase: 5, title: "Phase 5/6 — Enhance", durationMs: 44000, status: "ok" }],
    agent: "claude",
    env: {},
  });
  const out = formatSummary(m);
  assert.match(out, /^5 enhance\s+44s\s+\?$/m); // calls, but none reported tokens
  assert.match(out, /\+\? 1 call\(s\) reported no token usage/);
});
