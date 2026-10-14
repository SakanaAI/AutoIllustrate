// Prerequisite checks: the `autoillustrate doctor` subcommand plus the
// automatic preflight that runs before a pipeline run (scoped to what the
// invocation actually needs).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HEADLESS_VERSION, resolveHeadless } from "./agent.js";
import { logCheck, logErr, logReportEnd, logReportStart } from "./log.js";
import { requirementsPath, scriptsDir } from "./paths.js";
import { findPython3, venvDir, venvPython } from "./venv.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

// The value assigned to `key` in ./.env, or undefined if absent. Trims, then
// strips one layer of surrounding quotes, so the tail we reveal matches what
// the child process would actually receive.
function dotenvValue(key: string, cwd: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      // trim BEFORE stripping `export` — an indented "  export KEY=…" line is
      // valid dotenv and must still count.
      const stripped = line.trimStart().replace(/^export\s+/, "");
      if (!stripped.startsWith(`${key}=`)) continue;
      let val = stripped.slice(key.length + 1).trim();
      if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
        val = val.slice(1, -1);
      }
      return val;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function hasDotenvKey(key: string, cwd: string): boolean {
  return dotenvValue(key, cwd) !== undefined;
}

// Preflight accepts a credential that lives only in ./.env, but sub-agents are
// spawned with cwd=$WORKDIR (agent.ts), where the Python fallback — which reads
// `.env` relative to its own cwd — can no longer see it. Materialize the file's
// values into the env every child inherits so the credential survives the cwd
// change. Already-exported values win.
export function withDotenvCredentials(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of ["OPENAI_API_KEY", "GEMINI_API_KEY"]) {
    if (out[key]) continue;
    const value = dotenvValue(key, cwd);
    if (value) out[key] = value;
  }
  return out;
}

// A masked fingerprint of a secret — its last 4 characters after an ellipsis,
// e.g. " (…AB12)" — so the report can confirm WHICH key is in use without
// printing it. Returns "" when there is nothing safe to show: absent, or short
// enough (≤4 chars) that the tail would expose the whole value. Callers append
// it unconditionally.
export function keyTail(value: string | undefined): string {
  if (!value || value.length <= 4) return "";
  return ` (…${value.slice(-4)})`;
}

export function checkNode(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node",
    ok: major >= 22,
    detail: `v${process.versions.node}`,
    hint: major >= 22 ? undefined : "install Node >= 22",
  };
}

export function checkPython(env: NodeJS.ProcessEnv = process.env): CheckResult {
  try {
    const py = findPython3(env);
    return { name: "python3", ok: true, detail: py };
  } catch (err) {
    return {
      name: "python3",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      hint: "install Python >= 3.10 (e.g. brew install python@3.12)",
    };
  }
}

export function checkVenv(env: NodeJS.ProcessEnv = process.env): CheckResult {
  if (env.VENV_PY) {
    const ok = fs.existsSync(env.VENV_PY);
    return { name: "venv", ok, detail: `VENV_PY override: ${env.VENV_PY}`, hint: ok ? undefined : "VENV_PY points at a missing interpreter" };
  }
  const dir = venvDir(requirementsPath(), env);
  const ready = fs.existsSync(path.join(dir, ".ok")) && fs.existsSync(venvPython(dir));
  return {
    name: "venv",
    ok: true, // fix-it check: bootstrapped automatically on first run
    detail: ready ? `ready at ${dir}` : `not bootstrapped yet (auto-creates at ${dir} on first run)`,
  };
}

// One-shot headless setup for Linux servers: installs a pinned drawio via Nix
// and writes an xvfb-run wrapper onto PATH. Shipped with the package so the
// hint can point at a real local path.
export function drawioHeadlessInstallHint(): string {
  return `if no display is available (e.g. on a remote server) you can simply run bash "${path.join(scriptsDir(), "install_drawio.sh")}", which installs drawio and an xvfb-run wrapper for you`;
}

// Per-platform install hint. The Homebrew cask and the Linux .deb/.rpm/snap
// packages all put a `drawio` command on PATH by themselves; only a manual
// .app / AppImage install needs a symlink.
export function drawioInstallHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return (
        "install the draw.io desktop app: brew install --cask drawio (puts `drawio` on PATH); " +
        "if you installed the .app manually instead, symlink its CLI: " +
        "ln -s '/Applications/draw.io.app/Contents/MacOS/draw.io' /usr/local/bin/drawio"
      );
    case "linux":
      return (
        "install the draw.io desktop app from https://github.com/jgraph/drawio-desktop/releases " +
        "(the .deb/.rpm packages and `snap install drawio` put `drawio` on PATH; " +
        "for the AppImage, symlink it onto PATH as `drawio`); " +
        drawioHeadlessInstallHint()
      );
    default:
      return (
        "install the draw.io desktop app from https://github.com/jgraph/drawio-desktop/releases " +
        "and put its bundled CLI on PATH as `drawio`"
      );
  }
}

export function checkDrawio(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CheckResult {
  const found = which("drawio", env);
  return {
    name: "drawio",
    ok: found !== null,
    detail: found ?? "not on PATH",
    hint: found ? undefined : drawioInstallHint(platform),
  };
}

// Minimal one-rectangle diagram for the smoke-test below. The crash we guard
// against happens at Electron platform init, before any cell renders, so content
// is irrelevant — keep it small and fast.
const DRAWIO_SMOKE_XML =
  '<mxfile><diagram id="d" name="P"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="ok" style="rounded=0;" vertex="1" parent="1">' +
  '<mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>' +
  "</root></mxGraphModel></diagram></mxfile>";

const DRAWIO_SMOKE_TIMEOUT_MS = 60_000;

// Real export smoke-test: checkDrawio only proves the binary is on PATH, not
// that it can export. drawio-desktop is Electron and SIGSEGVs at platform init
// on a headless host with no X server — a failure that otherwise first surfaces
// in Phase 5, after the agent phases have spent tokens, looking like a transient
// export hiccup. One tiny SVG export up front makes it a fast preflight failure.
// AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE=1 falls back to the PATH-only check.
export function checkDrawioExport(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const base = checkDrawio(env);
  if (!base.ok) return base;
  if (env.AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE) {
    return { ...base, detail: `${base.detail} (export smoke-test skipped)` };
  }

  const headlessHint =
    "drawio is on PATH but cannot export — on a headless/GPU-less host run it under a virtual display: " +
    'install xvfb and put a `drawio` wrapper earlier on PATH that runs `exec xvfb-run -a <real drawio> --no-sandbox --disable-gpu "$@"`' +
    (process.platform === "linux" ? `; ${drawioHeadlessInstallHint()}` : "");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-drawio-"));
  const inPath = path.join(dir, "smoke.drawio");
  const outPath = path.join(dir, "smoke.svg");
  try {
    fs.writeFileSync(inPath, DRAWIO_SMOKE_XML);
    const r = spawnSync("drawio", ["-x", "-f", "svg", "-e", "-b", "10", "-o", outPath, inPath], {
      env,
      timeout: DRAWIO_SMOKE_TIMEOUT_MS,
      stdio: "ignore",
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { name: "drawio", ok: false, detail: `export smoke-test timed out after ${DRAWIO_SMOKE_TIMEOUT_MS / 1000}s (${base.detail})`, hint: headlessHint };
    }
    if (r.signal) {
      // SIGSEGV here is the classic "Missing X server or $DISPLAY" headless crash.
      return { name: "drawio", ok: false, detail: `export crashed with ${r.signal} (${base.detail})`, hint: headlessHint };
    }
    const svg = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
    if (!svg.includes("<svg")) {
      return { name: "drawio", ok: false, detail: `export produced no SVG (exit ${r.status ?? "?"}) (${base.detail})`, hint: headlessHint };
    }
    return { name: "drawio", ok: true, detail: `${base.detail} (export ✓)` };
  } catch (err) {
    return { name: "drawio", ok: false, detail: err instanceof Error ? err.message : String(err), hint: base.hint };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function checkHeadless(env: NodeJS.ProcessEnv = process.env): CheckResult {
  try {
    const resolved = resolveHeadless(env);
    if (env.AUTOILLUSTRATE_HEADLESS_BIN) {
      const executable = resolved.cmd;
      const versionResult = spawnSync(executable, ["--version"], {
        encoding: "utf8",
        env,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
      const versionOutput = `${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`;
      const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(versionOutput);
      const compatible = versionResult.status === 0
        && !!match
        && (Number(match[1]) > 0 || Number(match[2]) >= 5);
      return {
        name: "headless",
        ok: compatible,
        detail: compatible
          ? `override: ${executable} (${match?.[1]}.${match?.[2]}.${match?.[3]})`
          : `override is not Headless >=0.5.0: ${executable}`,
        hint: compatible ? undefined : "upgrade, fix, or unset AUTOILLUSTRATE_HEADLESS_BIN",
      };
    }
    return {
      name: "headless",
      ok: true,
      detail: `bundled @roberttlange/headless@${HEADLESS_VERSION}`,
    };
  } catch (err) {
    return {
      name: "headless",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      hint: env.AUTOILLUSTRATE_HEADLESS_BIN
        ? "fix or unset AUTOILLUSTRATE_HEADLESS_BIN"
        : "reinstall AutoIllustrate dependencies with npm install",
    };
  }
}

// The headless backend key (--agent) is not always the name of the binary it
// launches: Cursor's headless CLI ships as `cursor-agent`, not `cursor`. Map
// the key to the real binary so preflight's PATH lookup checks the right name.
const AGENT_CLI_BINARIES: Record<string, string> = {
  cursor: "cursor-agent",
};

export function checkAgentCli(agent: string, env: NodeJS.ProcessEnv = process.env): CheckResult {
  const binary = AGENT_CLI_BINARIES[agent] ?? agent;
  const found = which(binary, env);
  return {
    name: `agent (${agent})`,
    ok: found !== null,
    detail: found ?? `not on PATH (looked for \`${binary}\`)`,
    hint: found ? undefined : `install the ${agent} CLI (the selected headless backend; binary \`${binary}\`)`,
  };
}

export function checkOpenaiKey(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): CheckResult {
  const inEnv = Boolean(env.OPENAI_API_KEY);
  const value = inEnv ? env.OPENAI_API_KEY : dotenvValue("OPENAI_API_KEY", cwd);
  const inDotenv = value !== undefined && !inEnv;
  return {
    name: "OPENAI_API_KEY",
    ok: inEnv || inDotenv,
    detail: (inEnv ? "set in environment" : inDotenv ? "found in ./.env" : "not set") + keyTail(value),
    hint: inEnv || inDotenv ? undefined : "export OPENAI_API_KEY or add it to ./.env (needed by the gpt-6-astra audit/unit-test VLM in Phases 3/6, and Phase 5 with the default gpt-image-2.5-sunburst enhance model)",
  };
}

// Preflight-only (not in allChecks): only required when codex is the selected
// --enhance-model or --unit-test-vlm backend, so it must not fail `doctor` for
// everyone.
export function checkCodexCli(env: NodeJS.ProcessEnv = process.env): CheckResult {
  const found = which("codex", env);
  return {
    name: "codex CLI",
    ok: found !== null,
    detail: found ?? "not on PATH",
    hint: found ? undefined : "install the OpenAI codex CLI and run `codex login` (needed by --enhance-model codex in Phase 5, or --unit-test-vlm codex in Phase 6)",
  };
}

// Preflight-only (not in allChecks): only required when Gemini is the selected
// backend for an enhance model (nanobanana*), the --audit-vlm, or the
// --unit-test-vlm, so it must not fail `doctor` for everyone.
export function checkGeminiKey(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): CheckResult {
  const inEnv = Boolean(env.GEMINI_API_KEY);
  const value = inEnv ? env.GEMINI_API_KEY : dotenvValue("GEMINI_API_KEY", cwd);
  const inDotenv = value !== undefined && !inEnv;
  return {
    name: "GEMINI_API_KEY",
    ok: inEnv || inDotenv,
    detail: (inEnv ? "set in environment" : inDotenv ? "found in ./.env" : "not set") + keyTail(value),
    hint: inEnv || inDotenv ? undefined : "export GEMINI_API_KEY or add it to ./.env (needed by the nanobanana --enhance-model in Phase 5, or a gemini-3.1-pro --audit-vlm / --unit-test-vlm in Phases 3/6)",
  };
}

// OAuth-backend check (credentials report, not preflight): verifies the codex
// CLI is actually logged in, not merely on PATH. `codex login status` is local
// and exit-code based (0 = authed). Bounded so a wedged CLI can't hang the
// report; a timeout/signal surfaces as "could not determine".
// Strip email-shaped tokens so a codex build that prints the account email in
// its status line can't leak PII into the report — the Claude JSON path is
// already allow-listed; this gives the free-text codex line the same posture.
function redactEmails(line: string): string {
  return line.replace(/\S+@\S+/g, "[redacted]");
}

export function checkCodexAuth(env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): CheckResult {
  const found = which("codex", env);
  if (!found) {
    return {
      name: "codex CLI",
      ok: false,
      detail: "not on PATH",
      hint: "install the OpenAI codex CLI and run `codex login` (needed by --enhance-model codex in Phase 5)",
    };
  }
  const res = spawnSync(found, ["login", "status"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", env });
  if (res.error || res.status === null) {
    return {
      name: "codex CLI",
      ok: false,
      detail: "could not determine login status",
      hint: "run `codex login status` to check, then `codex login` if needed",
    };
  }
  // codex prints the status line to stderr (stdout is empty) when run
  // non-interactively, so scan both streams for the first line.
  const firstLine = `${res.stdout ?? ""}\n${res.stderr ?? ""}`
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  // Trust the exit code, but defend against a build that exits 0 while
  // reporting a logged-out state.
  if (res.status === 0 && !(firstLine && /not logged in/i.test(firstLine))) {
    return { name: "codex CLI", ok: true, detail: firstLine ? redactEmails(firstLine) : "logged in" };
  }
  return { name: "codex CLI", ok: false, detail: "installed but not logged in", hint: "run `codex login`" };
}

interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
}

// Resolve which credential Claude Code will ACTUALLY use, following its
// documented precedence — `claude auth status` reports the stored OAuth login
// but does not reveal that an env-var credential outranks it, which is exactly
// the subscription-vs-API-key question. Names the source only (no secret value,
// no PII). apiKeyHelper (precedence #4, a settings.json script) isn't detectable
// from the environment and is omitted.
// https://code.claude.com/docs/en/authentication.md#authentication-precedence
export function effectiveClaudeCredential(env: NodeJS.ProcessEnv = process.env): { source: string; billing: string } {
  if (env.CLAUDE_CODE_USE_BEDROCK) return { source: "AWS Bedrock", billing: "cloud provider billing" };
  if (env.CLAUDE_CODE_USE_VERTEX) return { source: "Google Vertex", billing: "cloud provider billing" };
  if (env.ANTHROPIC_AUTH_TOKEN) return { source: "ANTHROPIC_AUTH_TOKEN", billing: "API / custom" };
  if (env.ANTHROPIC_API_KEY) return { source: "ANTHROPIC_API_KEY", billing: "API pay-as-you-go" };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { source: "CLAUDE_CODE_OAUTH_TOKEN", billing: "Claude subscription" };
  return { source: "stored OAuth login", billing: "Claude subscription" };
}

// OAuth-backend check (credentials report, not preflight): verifies Claude Code
// — the default --agent for phases 1/2/3/6 — is signed in. `claude auth status
// --json` is local and authoritative across credential stores (macOS Keychain,
// ~/.claude/.credentials.json, ANTHROPIC_API_KEY). Surfaces only auth method +
// plan; email/orgId are intentionally never read out (no-PII).
export function checkClaudeAuth(env: NodeJS.ProcessEnv = process.env, timeoutMs = 15_000): CheckResult {
  const found = which("claude", env);
  if (!found) {
    return {
      name: "Claude Code",
      ok: false,
      detail: "not on PATH",
      hint: "install Claude Code (the default --agent), or set ANTHROPIC_API_KEY",
    };
  }
  const res = spawnSync(found, ["auth", "status", "--json"], { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", env });
  const undetermined: CheckResult = {
    name: "Claude Code",
    ok: false,
    detail: "could not determine auth status",
    hint: "run `claude auth status` to check",
  };
  if (res.error || res.status === null) return undetermined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout ?? "");
  } catch {
    return undetermined;
  }
  // Guard the shape BEFORE property access: JSON.parse("null") / a bare number
  // parse successfully but aren't objects, and reading .loggedIn off null would
  // throw past the try/catch and break the always-exit-0 contract.
  if (typeof parsed !== "object" || parsed === null) return undetermined;
  const status = parsed as ClaudeAuthStatus;
  if (typeof status.loggedIn !== "boolean") return undetermined;
  const cred = effectiveClaudeCredential(env);
  // Only the env-var credential sources have a value we can fingerprint; a
  // stored OAuth login / Bedrock / Vertex has no key string in the environment.
  const KEY_SOURCES = new Set(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  const credSource = cred.source + (KEY_SOURCES.has(cred.source) ? keyTail(env[cred.source]) : "");
  if (status.loggedIn) {
    const method = status.authMethod ?? "unknown method";
    const plan = status.subscriptionType ? ` (${status.subscriptionType})` : "";
    return { name: "Claude Code", ok: true, detail: `logged in via ${method}${plan} — will use ${credSource} (${cred.billing})` };
  }
  return {
    name: "Claude Code",
    ok: false,
    detail: `not logged in — would use ${credSource} (${cred.billing})`,
    hint: "run `claude auth login` (or set ANTHROPIC_API_KEY)",
  };
}

export function allChecks(agent: string, env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  return [
    checkNode(),
    checkPython(env),
    checkVenv(env),
    checkDrawioExport(env),
    checkHeadless(env),
    checkAgentCli(agent, env),
    checkOpenaiKey(env),
  ];
}

// One report row: "  ✓ name   detail" coloured as a whole (success/failure),
// with the remediation hint dimmed underneath. Lines are styled whole so a
// plain-text reader (or a test) sees "✓ NAME" contiguous.
export function runDoctor(agent: string, env: NodeJS.ProcessEnv = process.env): number {
  const results = allChecks(agent, env);
  logReportStart(`Autoillustrate doctor · agent ${agent}`);
  for (const r of results) logCheck(r, "→");
  const failures = results.filter((r) => !r.ok).length;
  const counts = { passed: results.length - failures, failed: failures };
  if (failures === 0) logReportEnd("passed", `All ${results.length} checks passed`, counts);
  else logReportEnd("failed", `${failures} of ${results.length} checks failed · fix the items above and re-run \`autoillustrate doctor\``, counts);
  return failures === 0 ? 0 : 1;
}

// Which phase/model consumes each credential — annotated on the report so the
// user can map a missing key to what it would break. Keyed by CheckResult.name.
const CREDENTIAL_USAGE: Record<string, string> = {
  OPENAI_API_KEY: "Phases 3/6 gpt-6-astra audit/unit-test + Phase 5 gpt-image-2.5-sunburst",
  GEMINI_API_KEY: "Phase 5 nanobanana* + Phases 3/6 gemini-3.1-pro audit/unit-test",
  "codex CLI": "Phase 5 codex + Phase 6 codex unit-test (OAuth)",
  "Claude Code": "Phases 1/2/3/6 agent (default --agent claude)",
};

// Unconditional inventory of every credential the pipeline can consume — unlike
// preflight, which is scoped to a single invocation's needs. API keys are
// presence-checked (env/.env); the OAuth backends are login-verified.
export function credentialChecks(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): CheckResult[] {
  return [checkOpenaiKey(env, cwd), checkGeminiKey(env, cwd), checkCodexAuth(env), checkClaudeAuth(env)];
}

// `autoillustrate credentials` — pure inventory, always exits 0: a missing key
// for a backend you don't use is not an error.
export function runCredentials(env: NodeJS.ProcessEnv = process.env): number {
  logReportStart("Credential status", "API keys: presence · codex / Claude Code: OAuth login verified");
  for (const r of credentialChecks(env)) {
    const usage = CREDENTIAL_USAGE[r.name];
    logCheck({ ...r, detail: `${r.detail}${usage ? `  → ${usage}` : ""}` }, "fix:");
  }
  return 0;
}

export interface PreflightNeeds {
  agent: string;
  needsAgentPhases: boolean; // phases 1/2/3/6 will dispatch sub-agents
  needsOpenai: boolean; // an OpenAI-backed audit/unit-test VLM (Phases 3/6) or enhance model (Phase 5) will run
  needsGemini?: boolean; // a Gemini-backed audit/unit-test VLM (Phases 3/6) or nanobanana enhance model (Phase 5) will run
  needsCodexCli?: boolean; // the codex enhance model (Phase 5) will run — NOT the codex unit-test VLM, which falls back to the audit backend (verify.py:1627)
}

// Collect ALL failures, print remediations, return false if any (cli exits 2).
export function preflight(
  needs: PreflightNeeds,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): boolean {
  const checks: CheckResult[] = [checkPython(env), checkDrawioExport(env)];
  if (needs.needsAgentPhases) checks.push(checkAgentCli(needs.agent, env));
  if (needs.needsOpenai) checks.push(checkOpenaiKey(env, cwd));
  if (needs.needsGemini) checks.push(checkGeminiKey(env, cwd));
  if (needs.needsCodexCli) checks.push(checkCodexCli(env));
  const failures = checks.filter((c) => !c.ok);
  for (const f of failures) {
    logErr("preflight", `${f.name}: ${f.detail}${f.hint ? ` — ${f.hint}` : ""}`);
  }
  if (failures.length > 0) {
    logErr("preflight", "run `autoillustrate doctor` for the full prerequisite report");
  }
  return failures.length === 0;
}
