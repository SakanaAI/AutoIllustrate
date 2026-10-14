// Tolerant JSON sentinel/report readers — replaces jq usage across the bash
// dispatchers (lib/jq_helpers.sh and inline jq calls).
//
// Sentinels can be missing or half-written (an agent killed mid-write), so
// readers never throw: a missing/corrupt file reads as `null`/`""`, exactly
// like the bash `jq ... || echo ""` call sites.

import fs from "node:fs";

export function readJson(file: string): unknown | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readJsonString(file: string, key: string): string {
  const doc = readJson(file);
  if (doc === null || typeof doc !== "object") return "";
  const value = (doc as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

// Panel ids from figure.json (jq_panel_ids). Returns [] when the file is
// missing, corrupt, or has no panels — callers abort on empty.
export function panelIds(figureJsonPath: string): string[] {
  const doc = readJson(figureJsonPath);
  if (doc === null || typeof doc !== "object") return [];
  const panels = (doc as { panels?: unknown }).panels;
  if (!Array.isArray(panels)) return [];
  return panels
    .map((p) => (p && typeof p === "object" ? (p as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function fileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function fileNonEmpty(file: string): boolean {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}
