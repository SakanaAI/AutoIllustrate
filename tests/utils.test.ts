import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { countDrawioMathCells, svgMathComplete, findChrome, drawioPngExportArgs } from "../src/export-png.js";
import { logTs } from "../src/log.js";
import { toolkitDir, requirementsPath } from "../src/paths.js";
import { defaultWorkdir, initWorkdir, resolveWorkdirArg } from "../src/workdir.js";
import { readJson, readJsonString, panelIds, fileExists, fileNonEmpty } from "../src/reports.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-test-"));
}

test("logTs matches bash date +%Y-%m-%dT%H:%M:%S format", () => {
  const ts = logTs(new Date(2026, 5, 11, 9, 5, 3));
  assert.equal(ts, "2026-06-11T09:05:03");
});

test("toolkitDir points at the package root", () => {
  assert.ok(fs.existsSync(requirementsPath()), "requirements.txt under toolkit root");
  assert.ok(fs.existsSync(path.join(toolkitDir(), "package.json")));
});

test("defaultWorkdir uses runs/<YYYY-MM-DD-HHMMSS> under cwd", () => {
  const wd = defaultWorkdir("/some/cwd", new Date(2026, 0, 2, 3, 4, 5));
  assert.equal(wd, "/some/cwd/runs/2026-01-02-030405");
});

test("initWorkdir creates figures/, panels/, logs/ idempotently", () => {
  const wd = path.join(tmpdir(), "run");
  initWorkdir(wd);
  initWorkdir(wd);
  for (const sub of ["figures", "panels", "logs"]) {
    assert.ok(fs.statSync(path.join(wd, sub)).isDirectory());
  }
});

test("resolveWorkdirArg resolves relative paths against cwd", () => {
  assert.equal(resolveWorkdirArg("/abs/run", "/cwd"), "/abs/run");
  assert.equal(resolveWorkdirArg("runs/x", "/cwd"), "/cwd/runs/x");
});

test("readJson tolerates missing and corrupt files", () => {
  const dir = tmpdir();
  assert.equal(readJson(path.join(dir, "missing.json")), null);
  const corrupt = path.join(dir, "corrupt.json");
  fs.writeFileSync(corrupt, '{"status": "ok"');
  assert.equal(readJson(corrupt), null);
  const ok = path.join(dir, "ok.json");
  fs.writeFileSync(ok, '{"status": "ok"}');
  assert.deepEqual(readJson(ok), { status: "ok" });
});

test("readJsonString defaults to empty string", () => {
  const dir = tmpdir();
  const f = path.join(dir, "report.json");
  fs.writeFileSync(f, '{"status": "degraded", "n": 3}');
  assert.equal(readJsonString(f, "status"), "degraded");
  assert.equal(readJsonString(f, "reason"), "");
  assert.equal(readJsonString(f, "n"), "");
  assert.equal(readJsonString(path.join(dir, "missing.json"), "status"), "");
});

test("panelIds extracts ids and tolerates malformed figure.json", () => {
  const dir = tmpdir();
  const f = path.join(dir, "figure.json");
  fs.writeFileSync(f, JSON.stringify({ panels: [{ id: "a" }, { id: "b" }, { nope: 1 }] }));
  assert.deepEqual(panelIds(f), ["a", "b"]);
  assert.deepEqual(panelIds(path.join(dir, "missing.json")), []);
  fs.writeFileSync(f, '{"panels": "oops"}');
  assert.deepEqual(panelIds(f), []);
});

test("export-png helpers: math counting, SVG completeness, chrome override", () => {
  const drawio =
    '<mxCell id="a" value="$$p_i \\propto r_i$$"/>' +
    '<mxCell id="b" value="plain label"/>' +
    '<mxCell id="c" value="rate \\(r_i\\) here"/>' +
    '<mxCell id="d"/>';
  assert.equal(countDrawioMathCells(drawio), 2);

  const svgComplete = '<svg><g data-mml-node="math"/><g data-mml-node="math"/></svg>';
  assert.equal(svgMathComplete(svgComplete, 2), true);
  assert.equal(svgMathComplete(svgComplete, 3), false);
  assert.equal(svgMathComplete("<svg/>", 0), true, "mathless figures are trivially complete");

  const dir = tmpdir();
  const stub = path.join(dir, "chrome");
  fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(stub, 0o755);
  assert.equal(findChrome({ AUTOILLUSTRATE_CHROME: stub }), stub);
  // An explicit override never falls through to host Chrome installs.
  assert.equal(findChrome({ AUTOILLUSTRATE_CHROME: path.join(dir, "missing") }), null);
});

test("drawioPngExportArgs never passes -e (writePngWithText crashes drawio v30.0.2+)", () => {
  const args = drawioPngExportArgs(["--width", "2560"], "/out/full_figure.png", "/in/full_figure.drawio");
  assert.equal(args.includes("-e"), false, "-e re-adds the regressed PNG XML-embed crash");
  // Still a well-formed export: mode, format, border, size, output, input.
  assert.deepEqual(args, ["-x", "-f", "png", "-b", "10", "--width", "2560", "-o", "/out/full_figure.png", "/in/full_figure.drawio"]);
});

test("fileExists / fileNonEmpty", () => {
  const dir = tmpdir();
  const empty = path.join(dir, "empty");
  const full = path.join(dir, "full");
  fs.writeFileSync(empty, "");
  fs.writeFileSync(full, "x");
  assert.equal(fileExists(empty), true);
  assert.equal(fileNonEmpty(empty), false);
  assert.equal(fileNonEmpty(full), true);
  assert.equal(fileExists(path.join(dir, "nope")), false);
  assert.equal(fileExists(dir), false);
});
