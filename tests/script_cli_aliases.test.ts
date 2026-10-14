import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const verifyPy = fs.readFileSync("scripts/verify.py", "utf8");
const inspectPanelPy = fs.readFileSync("scripts/inspect_panel.py", "utf8");

test("verify.py keeps hidden legacy aliases for renamed VLM flags", () => {
  assert.match(
    verifyPy,
    /add_argument\("--vlm", dest="vlm"[\s\S]*default=argparse\.SUPPRESS[\s\S]*help=argparse\.SUPPRESS\)/,
  );
  assert.match(
    verifyPy,
    /add_argument\("--unit-test-backend", dest="unit_test_backend"[\s\S]*default=argparse\.SUPPRESS[\s\S]*help=argparse\.SUPPRESS\)/,
  );
});

test("inspect_panel.py keeps a hidden legacy --vlm alias", () => {
  assert.match(
    inspectPanelPy,
    /add_argument\("--vlm", dest="vlm"[\s\S]*default=argparse\.SUPPRESS[\s\S]*help=argparse\.SUPPRESS\)/,
  );
});
