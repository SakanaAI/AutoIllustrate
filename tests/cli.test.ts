import { test } from "node:test";

import { enhanceBackend } from "../src/context.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCli, UsageError } from "../src/cli.js";
import { shouldRunPhase } from "../src/pipeline.js";

function tmpSource(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-cli-"));
  const src = path.join(dir, "paper.pdf");
  fs.writeFileSync(src, "pdf");
  return src;
}

test("positional source + --prompt parses to a run", () => {
  const src = tmpSource();
  const parsed = parseCli([src, "--prompt", "two panels"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.pipeline?.source, src);
  assert.equal(parsed.pipeline?.instructions, "two panels");
  assert.equal(parsed.pipeline?.placement, "infer");
  assert.equal(parsed.pipeline?.agent, "claude");
  assert.equal(parsed.pipeline?.outDir, "runs");
});

test("--output is parsed into the pipeline options (default undefined)", () => {
  const src = tmpSource();
  assert.equal(parseCli([src, "--prompt", "x"]).pipeline?.output, undefined);
  const parsed = parseCli([src, "--prompt", "x", "--output", "/tmp/deliverable.png"]);
  assert.equal(parsed.pipeline?.output, "/tmp/deliverable.png");
});

test("legacy --source and --instructions aliases still work", () => {
  const src = tmpSource();
  const parsed = parseCli(["--source", src, "--instructions", "legacy text"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.pipeline?.source, src);
  assert.equal(parsed.pipeline?.instructions, "legacy text");
});

test("--prompt wins over --instructions when both given", () => {
  const src = tmpSource();
  const parsed = parseCli([src, "--prompt", "new", "--instructions", "old"]);
  assert.equal(parsed.pipeline?.instructions, "new");
});

test("source and prompt required only when phase 1 runs", () => {
  assert.throws(() => parseCli([]), UsageError);
  assert.throws(() => parseCli(["--prompt", "x"]), UsageError);
  const parsed = parseCli(["--workdir", "runs/old", "--resume-from", "compose"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.pipeline?.resumePhase, 4);
  // resume-from plan still needs source+prompt
  assert.throws(() => parseCli(["--workdir", "runs/old", "--resume-from", "plan"]), UsageError);
});

test("--resume-from accepts names and numbers, requires --workdir", () => {
  for (const [token, n] of [["2", 2], ["panels", 2], ["verify", 6], ["5", 5]] as const) {
    const parsed = parseCli(["--workdir", "runs/old", "--resume-from", token]);
    assert.equal(parsed.pipeline?.resumePhase, n);
  }
  assert.throws(() => parseCli(["--resume-from", "compose"]), /requires --workdir/);
  assert.throws(() => parseCli(["--workdir", "x", "--resume-from", "nonsense"]), /--resume-from must be one of/);
  // Object.prototype keys must not leak through the phase map.
  for (const inherited of ["constructor", "toString", "hasOwnProperty"]) {
    assert.throws(() => parseCli(["--workdir", "x", "--resume-from", inherited]), /--resume-from must be one of/);
  }
});

test("--agent is validated against the known-agent allowlist", () => {
  const src = tmpSource();
  // Path-traversal-shaped values must not reach which()/headless argv.
  assert.throws(() => parseCli([src, "-p", "x", "--agent", "../../../../bin/sh"]), /--agent must be one of/);
  assert.throws(() => parseCli(["doctor", "--agent", "bogus"]), /--agent must be one of/);
  assert.equal(parseCli([src, "-p", "x", "--agent", "gemini"]).pipeline?.agent, "gemini");
});

test("credentials and doctor positionals dispatch to their commands", () => {
  assert.equal(parseCli(["credentials"]).command, "credentials");
  assert.equal(parseCli(["doctor"]).command, "doctor");
});

test("enum validation: placement and effort", () => {
  const src = tmpSource();
  assert.throws(() => parseCli([src, "-p", "x", "--placement", "sideways"]), /--placement must be/);
  assert.throws(() => parseCli([src, "-p", "x", "--effort", "max"]), /--effort must be/);
  const parsed = parseCli([src, "-p", "x", "--placement", "full-width", "--effort", "xhigh"]);
  assert.equal(parsed.pipeline?.placement, "full-width");
  assert.equal(parsed.pipeline?.effort, "xhigh");
});

test("Gemini rejects unsupported reasoning effort", () => {
  const src = tmpSource();
  assert.throws(
    () => parseCli([src, "-p", "x", "--agent", "gemini", "--effort", "high"]),
    /--effort is not supported with --agent gemini/,
  );
});

test("Gemini light mode does not inherit Claude preset effort", () => {
  const src = tmpSource();
  const pipeline = parseCli([src, "-p", "x", "--mode", "light", "--agent", "gemini"]).pipeline;

  assert.equal(pipeline?.agent, "gemini");
  assert.equal(pipeline?.effort, undefined);
});

test("enhanceBackend maps aliases and raw ids to the credential each needs", () => {
  assert.equal(enhanceBackend("gpt-image-2.5-sunburst"), "openai");
  assert.equal(enhanceBackend("gpt-image-2"), "openai");
  assert.equal(enhanceBackend("gpt-image-1"), "openai");
  assert.equal(enhanceBackend("nanobanana"), "gemini");
  assert.equal(enhanceBackend("gemini-3.1-flash-image"), "gemini");
  assert.equal(enhanceBackend("codex"), "codex");
});

test("--enhance-model accepts the aliases and any raw model id, defaults to gpt-image-2.5-sunburst", () => {
  const src = tmpSource();
  assert.equal(parseCli([src, "-p", "x"]).pipeline?.enhanceModel, "gpt-image-2.5-sunburst");
  for (const model of ["gpt-image-2.5-sunburst", "gpt-image-2", "nanobanana", "nanobanana-pro", "codex", "gpt-image-1", "gemini-3.1-flash-image"]) {
    assert.equal(parseCli([src, "-p", "x", "--enhance-model", model]).pipeline?.enhanceModel, model);
  }
  assert.throws(() => parseCli([src, "-p", "x", "--enhance-model", " "]), /--enhance-model must not be empty/);
});

test("--enhance-quality defaults to high and passes any non-empty value through", () => {
  const src = tmpSource();
  assert.equal(parseCli([src, "-p", "x"]).pipeline?.enhanceQuality, "high");
  // The vocabulary is the image model's (xhigh/max on gpt-image-2.5, 4K on
  // nanobanana), so the CLI does not validate against a list.
  for (const q of ["low", "xhigh", "max", "auto", "4K"]) {
    assert.equal(parseCli([src, "-p", "x", "--enhance-quality", q]).pipeline?.enhanceQuality, q);
  }
  assert.throws(() => parseCli([src, "-p", "x", "--enhance-quality", " "]), /--enhance-quality must not be empty/);
});

test("model is derived from the resolved agent, overridable", () => {
  const src = tmpSource();
  assert.equal(parseCli([src, "-p", "x"]).pipeline?.model, "claude-opus-5-5", "claude default (medium mode)");
  assert.equal(
    parseCli([src, "-p", "x", "--model", "claude-sonnet-4-6"]).pipeline?.model,
    "claude-sonnet-4-6",
    "--model overrides the default",
  );
  // gemini has its own default model; agents without an override fall back to headless.
  assert.equal(parseCli([src, "-p", "x", "--agent", "gemini"]).pipeline?.model, "gemini-3.1-pro-preview");
  assert.equal(parseCli([src, "-p", "x", "--agent", "codex"]).pipeline?.model, undefined);
});

test("missing source path and unknown flags are usage errors", () => {
  assert.throws(() => parseCli(["/nope/missing.pdf", "-p", "x"]), /source path does not exist/);
  assert.throws(() => parseCli(["--bogus"]));
});

test("export subcommand parses paths and size flags", () => {
  const src = tmpSource(); // any existing file works as the drawio input
  const parsed = parseCli(["export", src, "/tmp/out.png", "--export-width", "2560"]);
  assert.equal(parsed.command, "export");
  assert.deepEqual(parsed.export, { drawioPath: src, pngOut: "/tmp/out.png", widthPx: 2560, scale: undefined });
  assert.equal(parseCli(["export", src, "/tmp/out.png"]).export?.scale, 2, "default scale 2");
  assert.equal(parseCli(["export", src, "/tmp/out.png", "--export-scale", "1.5"]).export?.scale, 1.5);
  assert.throws(() => parseCli(["export", src]), /export needs exactly/);
  assert.throws(() => parseCli(["export", "/nope.drawio", "/tmp/out.png"]), /export input does not exist/);
  assert.throws(() => parseCli(["export", src, "/tmp/out.png", "--export-width", "0"]), /--export-width must be/);
  assert.throws(
    () => parseCli(["export", src, "/tmp/out.png", "--export-width", "100", "--export-scale", "2"]),
    /mutually exclusive/,
  );
});

test("doctor / help / version subcommands", () => {
  assert.equal(parseCli(["doctor"]).command, "doctor");
  assert.equal(parseCli(["doctor", "--agent", "codex"]).agent, "codex");
  assert.equal(parseCli(["--help"]).command, "help");
  assert.equal(parseCli(["-V"]).command, "version");
});

test("skip/sequential/force/debug flags and out-dir/workdir", () => {
  const src = tmpSource();
  assert.equal(parseCli([src, "-p", "x"]).pipeline?.debug, false);
  assert.equal(parseCli([src, "-p", "x"]).pipeline?.tmux, false);
  const parsed = parseCli([src, "-p", "x", "--skip-enhance", "--sequential", "--force", "--debug", "--tmux", "-o", "out", "-w", "wd"]);
  assert.deepEqual(
    [parsed.pipeline?.skipEnhance, parsed.pipeline?.sequential, parsed.pipeline?.force, parsed.pipeline?.debug, parsed.pipeline?.tmux],
    [true, true, true, true, true],
  );
  assert.equal(parsed.pipeline?.outDir, "out");
  assert.equal(parsed.pipeline?.workdirArg, "wd");
});

test("-i/--interactive and --editor-port", () => {
  const src = tmpSource();
  const plain = parseCli([src, "-p", "x"]).pipeline;
  assert.equal(plain?.interactive, false);
  assert.equal(plain?.editorPort, undefined);
  assert.equal(parseCli([src, "-p", "x", "-i"]).pipeline?.interactive, true);
  const fixed = parseCli([src, "-p", "x", "--interactive", "--editor-port", "8123"]).pipeline;
  assert.equal(fixed?.interactive, true);
  assert.equal(fixed?.editorPort, 8123);
  // Resume runs can be interactive too (the gate follows Phase 5).
  assert.equal(parseCli(["-w", "wd", "--resume-from", "5", "-i"]).pipeline?.interactive, true);
  assert.throws(() => parseCli([src, "-p", "x", "--editor-port", "8123"]), UsageError);
  for (const bad of ["0", "65536", "abc", "12.5"]) {
    assert.throws(() => parseCli([src, "-p", "x", "-i", "--editor-port", bad]), UsageError);
  }
});

test("native agents reject unsupported tmux mode", () => {
  const src = tmpSource();
  for (const agent of ["cursor", "opencode", "gemini", "pi"]) {
    assert.throws(
      () => parseCli([src, "-p", "x", "--agent", agent, "--tmux"]),
      new RegExp(`--tmux is not supported with --agent ${agent}`),
    );
  }
});

test("--panel-inspects / --enhancement-attempts default from the mode and parse", () => {
  const src = tmpSource();
  const def = parseCli([src, "-p", "x"]);
  assert.equal(def.pipeline?.panelInspects, 0, "panel default (medium mode)");
  assert.equal(def.pipeline?.enhancementAttempts, 1, "enhancement default (medium mode)");
  const parsed = parseCli([src, "-p", "x", "--panel-inspects", "3", "--enhancement-attempts", "2"]);
  assert.equal(parsed.pipeline?.panelInspects, 3);
  assert.equal(parsed.pipeline?.enhancementAttempts, 2);
});

test("--mode presets set agent + budgets, default medium", () => {
  const src = tmpSource();
  const medium = parseCli([src, "-p", "x"]).pipeline; // no --mode → medium
  assert.deepEqual(
    [medium?.mode, medium?.agent, medium?.model, medium?.panelInspects, medium?.enhancementAttempts, medium?.effort],
    ["medium", "claude", "claude-opus-5-5", 0, 1, "high"],
  );

  const light = parseCli([src, "-p", "x", "--mode", "light"]).pipeline;
  assert.deepEqual(
    [light?.mode, light?.agent, light?.model, light?.panelInspects, light?.enhancementAttempts, light?.effort],
    ["light", "claude", "claude-opus-5-5", 0, 1, "low"],
  );

  const full = parseCli([src, "-p", "x", "--mode", "full"]).pipeline;
  assert.deepEqual([full?.agent, full?.panelInspects, full?.enhancementAttempts, full?.effort], ["claude", 3, 3, "high"]);

  assert.throws(() => parseCli([src, "-p", "x", "--mode", "bogus"]), /--mode must be one of/);
});

test("--mode presets are overridden by explicit flags", () => {
  const src = tmpSource();
  // explicit budget wins over the preset
  const p = parseCli([src, "-p", "x", "--mode", "light", "--panel-inspects", "2"]).pipeline;
  assert.equal(p?.panelInspects, 2);
  assert.equal(p?.enhancementAttempts, 1, "rest still from light");
  assert.equal(p?.agent, "claude");
  // explicit --effort wins over the preset effort
  assert.equal(parseCli([src, "-p", "x", "--mode", "light", "--effort", "high"]).pipeline?.effort, "high");
  // explicit --model wins over the agent-derived default
  assert.equal(parseCli([src, "-p", "x", "--mode", "light", "--model", "custom"]).pipeline?.model, "custom");
  // explicit --agent wins over the preset agent (and re-derives the model)
  const a = parseCli([src, "-p", "x", "--mode", "full", "--agent", "gemini"]).pipeline;
  assert.equal(a?.agent, "gemini");
  assert.equal(a?.model, "gemini-3.1-pro-preview");
});

test("--panel-inspects / --enhancement-attempts reject out-of-range and non-integer", () => {
  const src = tmpSource();
  for (const bad of ["21", "abc", "2.5"]) {
    assert.throws(() => parseCli([src, "-p", "x", "--panel-inspects", bad]), /--panel-inspects must be an integer between 0 and 20/);
    assert.throws(
      () => parseCli([src, "-p", "x", "--enhancement-attempts", bad]),
      /--enhancement-attempts must be an integer between 1 and 20/,
    );
  }
  // --panel-inspects 0 skips Phase 3; --enhancement-attempts floors at 1
  // (the always-on Phase 5 enhance is candidate 1), where 1 skips Phase 6.
  assert.equal(parseCli([src, "-p", "x", "--panel-inspects", "0"]).pipeline?.panelInspects, 0);
  assert.equal(parseCli([src, "-p", "x", "--enhancement-attempts", "1"]).pipeline?.enhancementAttempts, 1);
  assert.throws(
    () => parseCli([src, "-p", "x", "--enhancement-attempts", "0"]),
    /--enhancement-attempts must be an integer between 1 and 20/,
  );
  // A negative value passed via the `=` form is rejected by the bound check.
  assert.throws(() => parseCli([src, "-p", "x", "--panel-inspects=-1"]), /--panel-inspects must be an integer between 0 and 20/);
  assert.throws(() => parseCli([src, "-p", "x", "--enhancement-attempts=-1"]), /--enhancement-attempts must be an integer between 1 and 20/);
  // Boundaries are inclusive.
  assert.equal(parseCli([src, "-p", "x", "--panel-inspects", "20"]).pipeline?.panelInspects, 20);
  assert.equal(parseCli([src, "-p", "x", "--enhancement-attempts", "20"]).pipeline?.enhancementAttempts, 20);
});

test("shouldRunPhase resume matrix", () => {
  // no resume → everything runs, nothing forced
  assert.deepEqual(shouldRunPhase(1, 0), { run: true, forceThis: false });
  // resume-from 4: 1-3 skipped, 4 forced, 5-6 run unforced
  assert.deepEqual(shouldRunPhase(3, 4), { run: false, forceThis: false });
  assert.deepEqual(shouldRunPhase(4, 4), { run: true, forceThis: true });
  assert.deepEqual(shouldRunPhase(5, 4), { run: true, forceThis: false });
});
