// Workdir helpers — port of scripts/cli/lib/workdir.sh.
//
// A workdir is a single self-contained run:
//
//   <workdir>/
//     figures/        Phase 4+5+6 headline + audit artifacts
//     panels/         Phase 2 per-panel PNG, Phase 3 inspect.json + attempts
//     logs/           per-phase stdout+stderr transcripts

import fs from "node:fs";
import path from "node:path";

export function runTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

// Fresh run dir under the out-dir parent (default: <cwd>/runs).
export function newRunWorkdir(outDir: string, now: Date = new Date()): string {
  return path.join(outDir, runTimestamp(now));
}

export function defaultWorkdir(cwd: string = process.cwd(), now: Date = new Date()): string {
  return newRunWorkdir(path.join(cwd, "runs"), now);
}

export function initWorkdir(workdir: string): void {
  for (const sub of ["", "figures", "panels", "logs"]) {
    fs.mkdirSync(path.join(workdir, sub), { recursive: true });
  }
}

export function resolveWorkdirArg(arg: string, cwd: string = process.cwd()): string {
  return path.isAbsolute(arg) ? arg : path.join(cwd, arg);
}
