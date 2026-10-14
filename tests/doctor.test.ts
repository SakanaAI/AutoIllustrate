import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HEADLESS_VERSION } from "../src/agent.js";
import { configureLogging } from "../src/log.js";
import { scriptsDir } from "../src/paths.js";
import {
  which,
  checkOpenaiKey,
  checkVenv,
  checkDrawio,
  checkDrawioExport,
  checkHeadless,
  checkAgentCli,
  checkCodexAuth,
  checkClaudeAuth,
  effectiveClaudeCredential,
  runDoctor,
  runCredentials,
} from "../src/doctor.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-doctor-"));
}

function writeExecutable(dir: string, name: string, body = "exit 0"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

class CaptureStream {
  chunks: string[] = [];
  isTTY = false;
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

test("which finds executables on PATH and rejects non-executables", () => {
  const dir = tmpdir();
  const tool = writeExecutable(dir, "sometool");
  assert.equal(which("sometool", { PATH: dir }), tool);
  assert.equal(which("missing", { PATH: dir }), null);
  assert.equal(which("sometool", { PATH: "" }), null);
  // present but not executable → skipped
  fs.writeFileSync(path.join(dir, "plainfile"), "data");
  assert.equal(which("plainfile", { PATH: dir }), null);
});

test("checkOpenaiKey reads env and ./.env incl. export prefix", () => {
  const cwd = tmpdir();
  assert.equal(checkOpenaiKey({ OPENAI_API_KEY: "sk-x" }, cwd).ok, true);
  assert.equal(checkOpenaiKey({}, cwd).ok, false);

  fs.writeFileSync(path.join(cwd, ".env"), "OPENAI_API_KEY=sk-y\n");
  assert.equal(checkOpenaiKey({}, cwd).ok, true);
  assert.equal(checkOpenaiKey({}, cwd).detail, "found in ./.env");

  fs.writeFileSync(path.join(cwd, ".env"), "  export OPENAI_API_KEY=sk-z\n");
  assert.equal(checkOpenaiKey({}, cwd).ok, true);

  // a key that merely shares the prefix must not count
  fs.writeFileSync(path.join(cwd, ".env"), "OPENAI_API_KEY_BACKUP=sk-w\n");
  assert.equal(checkOpenaiKey({}, cwd).ok, false);
});

test("checkOpenaiKey reveals a masked tail for keys long enough to fingerprint", () => {
  const cwd = tmpdir();
  // from the environment
  assert.equal(checkOpenaiKey({ OPENAI_API_KEY: "sk-proj-abcd1234" }, cwd).detail, "set in environment (…1234)");
  // from ./.env, with surrounding quotes stripped like the run_bananabench loader
  fs.writeFileSync(path.join(cwd, ".env"), 'OPENAI_API_KEY="sk-proj-wxyz9876"\n');
  assert.equal(checkOpenaiKey({}, cwd).detail, "found in ./.env (…9876)");
  // too short to reveal safely (≤4 chars) → no tail
  assert.equal(checkOpenaiKey({ OPENAI_API_KEY: "sk-x" }, cwd).detail, "set in environment");
});

test("checkClaudeAuth appends a masked tail when an env-var key is the effective credential", () => {
  const dir = tmpdir();
  writeExecutable(dir, "claude", `echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'`);
  const detail = checkClaudeAuth({ PATH: dir, ANTHROPIC_API_KEY: "sk-ant-longenough7788" }).detail;
  assert.match(detail, /will use ANTHROPIC_API_KEY \(…7788\) \(API pay-as-you-go\)/);
});

test("checkVenv reports the VENV_PY override accurately", () => {
  const dir = tmpdir();
  const py = writeExecutable(dir, "python");
  assert.equal(checkVenv({ VENV_PY: py }).ok, true);
  const missing = checkVenv({ VENV_PY: path.join(dir, "nope") });
  assert.equal(missing.ok, false);
  assert.match(missing.hint ?? "", /missing interpreter/);
});

test("checkDrawio and checkAgentCli fail with hints when not on PATH", () => {
  const empty = tmpdir();
  const drawio = checkDrawio({ PATH: empty });
  assert.equal(drawio.ok, false);
  assert.match(drawio.hint ?? "", /draw\.io/);
  // The Homebrew cask already links `drawio` onto PATH — no symlink step in the primary macOS hint.
  const mac = checkDrawio({ PATH: empty }, "darwin").hint ?? "";
  assert.match(mac, /brew install --cask drawio \(puts `drawio` on PATH\)/);
  const linux = checkDrawio({ PATH: empty }, "linux").hint ?? "";
  assert.match(linux, /drawio-desktop\/releases/);
  assert.match(linux, /snap install drawio/);
  assert.doesNotMatch(linux, /brew/);
  // Linux always mentions the bundled headless installer, pointing at the shipped file.
  assert.match(linux, /no display is available/);
  // The recommended command must actually be runnable: invoke via bash with the
  // (possibly space-containing node_modules) path quoted, and ship the script
  // with its executable bit set so running it directly works too.
  assert.match(linux, /run bash "[^"]*install_drawio\.sh"/);
  const installer = path.join(scriptsDir(), "install_drawio.sh");
  assert.ok(fs.existsSync(installer));
  assert.ok(fs.statSync(installer).mode & 0o111, "install_drawio.sh must be executable");
  const win = checkDrawio({ PATH: empty }, "win32").hint ?? "";
  assert.doesNotMatch(win, /brew|snap|install_drawio/);
  const agent = checkAgentCli("codex", { PATH: empty });
  assert.equal(agent.ok, false);
  assert.match(agent.hint ?? "", /codex CLI/);
});

test("checkHeadless reports the bundled locked version without a global install", () => {
  const result = checkHeadless({ PATH: tmpdir() });
  assert.equal(result.ok, true);
  assert.equal(result.detail, `bundled @roberttlange/headless@${HEADLESS_VERSION}`);

  const invalidOverride = checkHeadless({
    PATH: tmpdir(),
    AUTOILLUSTRATE_HEADLESS_BIN: "/missing/headless",
  });
  assert.equal(invalidOverride.ok, false);
  assert.match(invalidOverride.hint ?? "", /unset AUTOILLUSTRATE_HEADLESS_BIN/);

  const overrideDir = tmpdir();
  writeExecutable(overrideDir, "headless-current", "echo 0.5.0");
  const currentOverride = checkHeadless({
    PATH: overrideDir,
    AUTOILLUSTRATE_HEADLESS_BIN: "headless-current",
  });
  assert.equal(currentOverride.ok, true);
  assert.match(currentOverride.detail, /0\.5\.0/);

  writeExecutable(overrideDir, "headless-old", "echo 0.3.2");
  const oldOverride = checkHeadless({
    PATH: overrideDir,
    AUTOILLUSTRATE_HEADLESS_BIN: "headless-old",
  });
  assert.equal(oldOverride.ok, false);
  assert.match(oldOverride.detail, />=0\.5\.0/);
});

test("checkAgentCli resolves cursor to its real `cursor-agent` binary", () => {
  const dir = tmpdir();
  // The headless `cursor` backend ships as `cursor-agent`; a literal `cursor`
  // on PATH must not satisfy the check, and `cursor-agent` must.
  writeExecutable(dir, "cursor");
  const wrong = checkAgentCli("cursor", { PATH: dir });
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /cursor-agent/);

  writeExecutable(dir, "cursor-agent");
  const right = checkAgentCli("cursor", { PATH: dir });
  assert.equal(right.ok, true);
});

test("checkDrawioExport runs a real export and catches a binary that can't export", () => {
  const dir = tmpdir();
  // On PATH but produces no SVG — the PATH-only checkDrawio would wrongly pass.
  writeExecutable(dir, "drawio");
  const broken = checkDrawioExport({ PATH: dir });
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /export/);
  assert.match(broken.hint ?? "", /xvfb/);

  writeExecutable(
    dir,
    "drawio",
    'while [ "$1" != "-o" ] && [ $# -gt 0 ]; do shift; done\n[ "$1" = "-o" ] && shift\n[ -n "$1" ] && printf \'<svg></svg>\' > "$1"\nexit 0',
  );
  const working = checkDrawioExport({ PATH: dir });
  assert.equal(working.ok, true, working.detail);

  writeExecutable(dir, "drawio");
  const skipped = checkDrawioExport({ PATH: dir, AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1" });
  assert.equal(skipped.ok, true);
  assert.match(skipped.detail, /skipped/);

  const missing = checkDrawioExport({ PATH: tmpdir() });
  assert.equal(missing.ok, false);
  assert.match(missing.hint ?? "", /draw\.io/);
});

test("checkCodexAuth verifies login via `codex login status`, not just PATH", () => {
  // not on PATH
  const missing = checkCodexAuth({ PATH: tmpdir() });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /not on PATH/);

  // logged in: exit 0, status line echoed to stdout
  const inDir = tmpdir();
  writeExecutable(inDir, "codex", 'echo "Logged in using ChatGPT"');
  const loggedIn = checkCodexAuth({ PATH: inDir });
  assert.equal(loggedIn.ok, true);
  assert.equal(loggedIn.detail, "Logged in using ChatGPT");

  // codex prints to stderr when non-interactive: both streams must be scanned
  const errDir = tmpdir();
  writeExecutable(errDir, "codex", 'echo "Logged in using ChatGPT" >&2');
  const viaStderr = checkCodexAuth({ PATH: errDir });
  assert.equal(viaStderr.ok, true);
  assert.equal(viaStderr.detail, "Logged in using ChatGPT");

  // free-text status line must not leak an account email
  const piiDir = tmpdir();
  writeExecutable(piiDir, "codex", 'echo "Logged in as leak@example.com"');
  const pii = checkCodexAuth({ PATH: piiDir });
  assert.equal(pii.ok, true);
  assert.doesNotMatch(pii.detail, /leak@example\.com/);
  assert.match(pii.detail, /\[redacted\]/);

  // installed but logged out: non-zero exit
  const outDir = tmpdir();
  writeExecutable(outDir, "codex", 'echo "Not logged in"; exit 1');
  const loggedOut = checkCodexAuth({ PATH: outDir });
  assert.equal(loggedOut.ok, false);
  assert.equal(loggedOut.detail, "installed but not logged in");
  assert.match(loggedOut.hint ?? "", /codex login/);

  // exit 0 while reporting logged-out must NOT be a false positive
  const zeroOutDir = tmpdir();
  writeExecutable(zeroOutDir, "codex", 'echo "Not logged in"; exit 0');
  assert.equal(checkCodexAuth({ PATH: zeroOutDir }).ok, false);

  // a wedged CLI is bounded by the timeout → undetermined, never a hang.
  // Block with a shell builtin (no `sleep` — it isn't on the restricted PATH
  // under dash, where it would exit 127 instead of hanging).
  const hangDir = tmpdir();
  writeExecutable(hangDir, "codex", "while :; do :; done");
  const timedOut = checkCodexAuth({ PATH: hangDir }, 200);
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.detail, /could not determine/);
});

test("checkClaudeAuth reports login state from JSON without leaking email/orgId", () => {
  // not on PATH
  assert.equal(checkClaudeAuth({ PATH: tmpdir() }).ok, false);

  // logged in: PII fields present in payload must NOT reach the detail line
  const inDir = tmpdir();
  writeExecutable(
    inDir,
    "claude",
    `echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"leak@example.com","orgId":"org-LEAK"}'`,
  );
  const loggedIn = checkClaudeAuth({ PATH: inDir });
  assert.equal(loggedIn.ok, true);
  assert.match(loggedIn.detail, /claude\.ai/);
  assert.match(loggedIn.detail, /max/);
  assert.doesNotMatch(loggedIn.detail, /leak@example\.com/);
  assert.doesNotMatch(loggedIn.detail, /org-LEAK/);

  // explicitly logged out: still names the credential Claude Code would fall
  // back to from the environment (here: a stored OAuth login → subscription)
  const outDir = tmpdir();
  writeExecutable(outDir, "claude", `echo '{"loggedIn":false}'`);
  const loggedOut = checkClaudeAuth({ PATH: outDir });
  assert.equal(loggedOut.ok, false);
  assert.match(loggedOut.detail, /not logged in/);
  assert.match(loggedOut.detail, /stored OAuth login \(Claude subscription\)/);
  assert.match(loggedOut.hint ?? "", /claude auth login/);

  // logged in with no method/plan fields → still ok, falls back gracefully
  const sparseDir = tmpdir();
  writeExecutable(sparseDir, "claude", `echo '{"loggedIn":true}'`);
  const sparse = checkClaudeAuth({ PATH: sparseDir });
  assert.equal(sparse.ok, true);
  assert.match(sparse.detail, /unknown method/);

  // unparseable output → undetermined, not a false positive
  const garbageDir = tmpdir();
  writeExecutable(garbageDir, "claude", `echo 'not json'`);
  const garbage = checkClaudeAuth({ PATH: garbageDir });
  assert.equal(garbage.ok, false);
  assert.match(garbage.detail, /could not determine/);

  // valid-but-non-object JSON (`null`) parses successfully — must NOT throw a
  // TypeError on the .loggedIn access; degrades to undetermined.
  const nullDir = tmpdir();
  writeExecutable(nullDir, "claude", `echo 'null'`);
  assert.doesNotThrow(() => checkClaudeAuth({ PATH: nullDir }));
  assert.equal(checkClaudeAuth({ PATH: nullDir }).ok, false);

  // a wedged CLI is bounded by the timeout → undetermined, never a hang.
  // Block with a shell builtin (see the codex test: `sleep` isn't on the
  // restricted PATH, so it would exit 127 instead of hanging).
  const hangDir = tmpdir();
  writeExecutable(hangDir, "claude", "while :; do :; done");
  const timedOut = checkClaudeAuth({ PATH: hangDir }, 200);
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.detail, /could not determine/);
});

test("effectiveClaudeCredential follows Claude Code's documented precedence", () => {
  // empty env → stored OAuth login (subscription)
  assert.deepEqual(effectiveClaudeCredential({}), { source: "stored OAuth login", billing: "Claude subscription" });

  // ANTHROPIC_API_KEY (pay-as-you-go) outranks the OAuth token (subscription)
  assert.deepEqual(effectiveClaudeCredential({ ANTHROPIC_API_KEY: "sk-x", CLAUDE_CODE_OAUTH_TOKEN: "tok" }), {
    source: "ANTHROPIC_API_KEY",
    billing: "API pay-as-you-go",
  });

  // OAuth token forces subscription billing when no API key is present
  assert.deepEqual(effectiveClaudeCredential({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }), {
    source: "CLAUDE_CODE_OAUTH_TOKEN",
    billing: "Claude subscription",
  });

  // ANTHROPIC_AUTH_TOKEN outranks the API key
  assert.equal(effectiveClaudeCredential({ ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "sk-x" }).source, "ANTHROPIC_AUTH_TOKEN");

  // a cloud provider redirect wins over everything
  assert.equal(effectiveClaudeCredential({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "sk-x" }).source, "AWS Bedrock");
});

test("checkClaudeAuth names the effective credential when an env var outranks the login", () => {
  // logged in via subscription, but an API key in the env is what actually bills
  const dir = tmpdir();
  writeExecutable(dir, "claude", `echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'`);
  const detail = checkClaudeAuth({ PATH: dir, ANTHROPIC_API_KEY: "sk-x" }).detail;
  assert.match(detail, /logged in via claude\.ai \(max\)/);
  assert.match(detail, /will use ANTHROPIC_API_KEY \(API pay-as-you-go\)/);
});

test("runCredentials prints all four rows and always exits 0", () => {
  const lines: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return realWrite(chunk);
  }) as typeof process.stdout.write;
  try {
    // empty PATH + no keys → every row ✗, but inventory still exits 0.
    // Pass an env with no API keys so the rows are ✗ regardless of the
    // developer's real ./.env (checkOpenaiKey reads cwd's .env).
    assert.equal(runCredentials({ PATH: tmpdir() }), 0);
    const out = lines.join("");
    assert.match(out, /Credential status/); // header
    assert.match(out, /OPENAI_API_KEY/);
    assert.match(out, /GEMINI_API_KEY/);
    assert.match(out, /codex CLI/);
    assert.match(out, /Claude Code/);
    // the CREDENTIAL_USAGE annotation renders (guards name↔key coupling)
    assert.match(out, /→ Phase 5 nanobanana/);
    // failed rows print a fix hint
    assert.match(out, /fix:/);
  } finally {
    process.stdout.write = realWrite;
  }
});

test("doctor and credentials honour --log-format json with one record per line", () => {
  const bin = tmpdir();
  const python = writeExecutable(bin, "python3", 'echo "3.12"');
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  configureLogging({ format: "json", stdout, stderr });
  try {
    const env = { PATH: tmpdir(), AUTOILLUSTRATE_PYTHON: python, VENV_PY: python, OPENAI_API_KEY: "sk-test" };
    assert.equal(runDoctor("claude", env), 1);
    assert.equal(runCredentials({ PATH: tmpdir() }), 0);
    assert.equal(stderr.text(), "");
    const records = stdout
      .text()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });
    assert.deepEqual(records[0], { ...records[0], event: "report_start", fields: { title: "Autoillustrate doctor · agent claude" } });
    const drawio = records.find((r) => r.event === "check" && r.fields.name === "drawio");
    assert.ok(drawio, "doctor emits a check record per row");
    assert.equal(drawio.fields.ok, false);
    assert.match(String(drawio.fields.hint), /install the draw\.io desktop app/);
    const end = records.find((r) => r.event === "report_end");
    assert.equal(end?.fields.status, "failed");
    assert.equal(typeof end?.fields.failed, "number");
    // codex is absent from the empty PATH regardless of the developer's ./.env
    // (which may supply real API keys and turn those rows ✓ with no hint).
    const codex = records.find((r) => r.event === "check" && r.fields.name === "codex CLI");
    assert.equal(codex?.fields.ok, false);
    assert.equal(codex?.fields.hint_label, "fix:");
    assert.match(String(codex?.fields.detail), /→ Phase 5 codex/);
  } finally {
    configureLogging({ format: "human", stdout: process.stdout, stderr: process.stderr });
  }
});

test("runDoctor returns 0 when all checks pass and 1 with remediation hints otherwise", () => {
  const bin = tmpdir();
  const python = writeExecutable(bin, "python3", 'echo "3.12"');
  writeExecutable(bin, "drawio");
  writeExecutable(bin, "claude");
  const okEnv = {
    PATH: bin,
    AUTOILLUSTRATE_PYTHON: python,
    VENV_PY: python,
    OPENAI_API_KEY: "sk-test",
    AUTOILLUSTRATE_SKIP_DRAWIO_SMOKE: "1",
  };

  const lines: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  // Capture AND forward — swallowing chunks can eat the async TAP reporter's
  // result lines for neighboring tests (see agent.test.ts).
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return realWrite(chunk);
  }) as typeof process.stdout.write;
  try {
    assert.equal(runDoctor("claude", okEnv), 0);
    const okOut = lines.join("");
    assert.match(okOut, /✓ OPENAI_API_KEY/);
    assert.doesNotMatch(okOut, /✗/);

    lines.length = 0;
    // empty PATH: drawio + agent CLI missing → exit 1 with hints
    assert.equal(runDoctor("claude", { PATH: tmpdir(), AUTOILLUSTRATE_PYTHON: python, VENV_PY: python, OPENAI_API_KEY: "sk-test" }), 1);
    const failOut = lines.join("");
    assert.match(failOut, /✗ drawio/);
    assert.match(failOut, /→ install the draw\.io desktop app/);
  } finally {
    process.stdout.write = realWrite;
  }
});
