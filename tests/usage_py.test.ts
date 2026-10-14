import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runPython(source: string): string {
  const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";
  const result = spawnSync(python, ["-c", source], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("_usage.record_usage appends a well-formed single-line ledger record", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-usage-"));
  runPython(`
import sys
sys.path.insert(0, "scripts")
from _usage import record_usage
record_usage(${JSON.stringify(workdir)}, phase=5, source="gemini-image",
             model="gemini-3.1-flash-image", duration_secs=21.3, basis="tokens",
             input_tokens=12, output_tokens=1290)
record_usage(${JSON.stringify(workdir)}, phase=5, source="codex",
             model="gpt-image-2 (codex)", duration_secs=44.0, basis="subscription")
print("ok")
`);

  const ledger = path.join(workdir, "metrics", "api_usage.jsonl");
  const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]);
  assert.equal(first.phase, 5);
  assert.equal(first.source, "gemini-image");
  assert.equal(first.basis, "tokens");
  assert.equal(first.input_tokens, 12);
  assert.equal(first.output_tokens, 1290);
  assert.equal(typeof first.ts, "number");

  const second = JSON.parse(lines[1]);
  assert.equal(second.basis, "subscription");
  // subscription record carries no token fields
  assert.equal(second.input_tokens, undefined);
});

test("_usage.resolve_phase honors AUTOILLUSTRATE_PHASE, else the default", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-phase-"));
  const stdout = runPython(`
import os, sys
sys.path.insert(0, "scripts")
from _usage import resolve_phase, record_usage

assert resolve_phase(5) == 5, "no env → default"
os.environ["AUTOILLUSTRATE_PHASE"] = "6"
assert resolve_phase(5) == 6, "env overrides default (Phase 6 repair re-enhance)"
os.environ["AUTOILLUSTRATE_PHASE"] = "garbage"
assert resolve_phase(5) == 5, "non-int env falls back to default"

# integration: a re-enhance under Phase 6 bills to Phase 6
os.environ["AUTOILLUSTRATE_PHASE"] = "6"
record_usage(${JSON.stringify(workdir)}, phase=resolve_phase(5), source="openai-image",
             model="gpt-image-2", duration_secs=1.0, basis="image", images=1,
             size="2560x1077", quality="high")
print("ok")
`);
  assert.equal(stdout, "ok");
  const rec = JSON.parse(fs.readFileSync(path.join(workdir, "metrics", "api_usage.jsonl"), "utf8").trim());
  assert.equal(rec.phase, 6); // recorded under the invoking phase, not the default 5
});

test("_usage.record_usage never raises on an unwritable workdir", () => {
  // A path under a file (not a dir) can't mkdir — record_usage must swallow it.
  const stdout = runPython(`
import sys, tempfile, os
sys.path.insert(0, "scripts")
from _usage import record_usage
f = tempfile.NamedTemporaryFile(delete=False)
f.close()
record_usage(os.path.join(f.name, "nested"), phase=5, source="x", model="m",
             duration_secs=1.0, basis="tokens")
print("survived")
`);
  assert.equal(stdout, "survived");
});
