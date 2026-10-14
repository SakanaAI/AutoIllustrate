// Cached Python venv bootstrap.
//
// The Python phase scripts (compose/enhance/inspect/verify) need the deps in
// requirements.txt. Instead of requiring users to manage a venv, we keep one
// per requirements-hash under the user cache dir and (re)build it on demand:
//
//   ${XDG_CACHE_HOME:-~/.cache}/autoillustrate/venv-<sha256(requirements)[:10]>/
//
// The venv is built in a pid-suffixed tmp dir and atomically renamed into
// place once pip succeeds (`.ok` marker written before the rename), so
// concurrent runs never see — or wipe — a half-installed venv; rename losers
// adopt the winner's venv. Only bin/python is ever used (always invoked as
// `python -m ...`), so the rename can't break console-script shebangs.
// `VENV_PY` overrides everything (escape hatch, same as the bash pipeline).

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requirementsPath } from "./paths.js";
import { logInfo } from "./log.js";

const MIN_PYTHON = [3, 10] as const;

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "autoillustrate");
}

export function venvDir(requirementsFile: string = requirementsPath(), env: NodeJS.ProcessEnv = process.env): string {
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(requirementsFile))
    .digest("hex")
    .slice(0, 10);
  return path.join(cacheRoot(env), `venv-${hash}`);
}

export function venvPython(dir: string): string {
  return process.platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
}

// Return a copy of `env` with the venv interpreter's directory prepended to
// PATH. The phase scripts are always invoked with the absolute `ctx.python`,
// but the dispatched coding agents are not — left to their instincts they run
// bare `python`/`python3`/`pip`, which resolve to the system interpreter that
// lacks the toolkit deps (pillow, matplotlib, pypdf, ...). Prepending the
// venv's bin dir makes those bare invocations resolve to the right interpreter,
// so the agent's default behaviour just works instead of failing on
// ModuleNotFoundError. The prompts still carry the explicit `PYTHON:` path as
// the authoritative reference.
export function withVenvOnPath(env: NodeJS.ProcessEnv, python: string): NodeJS.ProcessEnv {
  const binDir = path.dirname(python);
  const current = env.PATH ?? "";
  // Idempotent: don't stack the same dir on resume/repeat invocations.
  if (current.split(path.delimiter).includes(binDir)) return env;
  return { ...env, PATH: current ? `${binDir}${path.delimiter}${current}` : binDir };
}

function pythonVersion(candidate: string): [number, number] | null {
  const probe = spawnSync(candidate, [
    "-c",
    "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')",
  ]);
  if (probe.status !== 0) return null;
  const [major, minor] = String(probe.stdout).trim().split(".").map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) ? [major, minor] : null;
}

// First interpreter on PATH satisfying MIN_PYTHON. Plain `python3` often
// resolves to an OS python that is too old, so versioned names are probed too.
export function findPython3(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = env.AUTOILLUSTRATE_PYTHON
    ? [env.AUTOILLUSTRATE_PYTHON]
    : ["python3", "python3.13", "python3.12", "python3.11", "python3.10", "python3.14"];
  let newestSeen: string | null = null;
  for (const candidate of candidates) {
    const version = pythonVersion(candidate);
    if (!version) continue;
    newestSeen = `${candidate} (${version.join(".")})`;
    if (version[0] > MIN_PYTHON[0] || (version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1])) {
      return candidate;
    }
  }
  const detail = newestSeen ? `found only ${newestSeen}` : "no interpreter found";
  throw new Error(`python3 not found with version >= ${MIN_PYTHON.join(".")} — ${detail}`);
}

export interface VenvOptions {
  requirementsFile?: string;
  env?: NodeJS.ProcessEnv;
  quiet?: boolean;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // EPERM: alive, other user
  }
}

// Remove venv-<hash>.tmp-<pid> leftovers from crashed bootstraps.
function sweepStaleTmpDirs(dir: string): void {
  const parent = path.dirname(dir);
  const prefix = `${path.basename(dir)}.tmp-`;
  let entries: string[];
  try {
    entries = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number(name.slice(prefix.length));
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) continue;
    fs.rmSync(path.join(parent, name), { recursive: true, force: true });
  }
}

// Returns the absolute path to the venv's python, bootstrapping on demand.
export function getVenvPython(opts: VenvOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.VENV_PY) return env.VENV_PY;

  const requirements = opts.requirementsFile ?? requirementsPath();
  const dir = venvDir(requirements, env);
  const python = venvPython(dir);
  const marker = path.join(dir, ".ok");
  if (fs.existsSync(marker) && fs.existsSync(python)) return python;

  if (fs.existsSync(dir)) {
    // Markerless dir — partial install from an interrupted pre-atomic-rename
    // build. New builds only ever appear complete, so this can't race pip.
    fs.rmSync(dir, { recursive: true, force: true });
  }
  sweepStaleTmpDirs(dir);

  const python3 = findPython3(env);
  if (!opts.quiet) logInfo("venv", `bootstrapping python venv at ${dir}`);
  const tmp = `${dir}.tmp-${process.pid}`;
  try {
    execFileSync(python3, ["-m", "venv", tmp], { stdio: opts.quiet ? "ignore" : "inherit" });
    // The venv's bundled pip is whatever ensurepip shipped with the system
    // python (pip 22.0.2 on Ubuntu 22.04's 3.10). Old pips reject the lock in
    // --require-hashes mode: google-genai's `google-auth[requests]` extra is
    // treated as a separate, unpinned requirement. Upgrade pip first.
    execFileSync(venvPython(tmp), ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], {
      stdio: opts.quiet ? "ignore" : "inherit",
    });
    // requirements.txt is a universal hashed lock (see requirements.in);
    // --require-hashes makes pip refuse anything unpinned or tampered with,
    // including a PIP_INDEX_URL pointed at a hostile mirror.
    execFileSync(venvPython(tmp), ["-m", "pip", "install", "--quiet", "--require-hashes", "-r", requirements], {
      stdio: opts.quiet ? "ignore" : "inherit",
    });
    fs.writeFileSync(path.join(tmp, ".ok"), "");
    fs.renameSync(tmp, dir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    // Rename refused because a concurrent bootstrap completed first — use it.
    if (fs.existsSync(marker) && fs.existsSync(python)) return python;
    throw new Error(`venv bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!opts.quiet) logInfo("venv", "venv ready");
  return python;
}
