// Package-root resolution. The toolkit root is the directory containing
// scripts/, assets/, references/, prompts/, and requirements.txt — one level
// above this module's directory (dist/ when built, src/ under tsx).

import { fileURLToPath } from "node:url";
import path from "node:path";

export function toolkitDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function requirementsPath(): string {
  return path.join(toolkitDir(), "requirements.txt");
}

export function promptsDir(): string {
  return path.join(toolkitDir(), "prompts");
}

export function referencesDir(): string {
  return path.join(toolkitDir(), "references");
}

export function scriptsDir(): string {
  return path.join(toolkitDir(), "scripts");
}
