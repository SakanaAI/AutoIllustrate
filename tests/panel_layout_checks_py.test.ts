import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The page-fill / dead-zone geometry checks live in the shared geometry
// library (assets/panel_geometry.py), which every generate_<panel>.py imports
// and calls via enforce(). The library imports only the stdlib, so these run
// under a plain python3 with no venv. We import it via importlib and exercise
// the pure functions directly. Numeric cases print JSON and are asserted in TS
// for readable diffs; pass/fail cases assert in Python and print "ok".

const GEOMETRY = "assets/panel_geometry.py";

const BOILERPLATE = `
import importlib.util, json, math
from pathlib import Path
_spec = importlib.util.spec_from_file_location("panel_geometry", Path(${JSON.stringify(GEOMETRY)}))
m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m)
Rect, EdgePath = m.Rect, m.EdgePath
`;

function runPython(source: string): string {
  const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";
  const result = spawnSync(python, ["-c", source], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

/** Run a Python body with the scaffold imported as `m` (plus Rect/EdgePath). */
function scaffold(body: string): string {
  return runPython(`${BOILERPLATE}\n${body}`);
}

/** Run a body whose last statement prints JSON; return the parsed value. */
function scaffoldJSON(body: string): any {
  return JSON.parse(scaffold(body));
}

// ── _grid_dims ────────────────────────────────────────────────────────────

test("_grid_dims: even dims, ~square cells, short axis gets SHORT_AXIS_SUBDIV", () => {
  const out = scaffoldJSON(`
res = {}
for (w, h) in [(1000, 540), (800, 800), (2100, 540), (400, 1000)]:
    nx, ny = m._grid_dims(w, h)
    res[f"{w}x{h}"] = {
        "nx": nx, "ny": ny,
        "cw": w / nx, "ch": h / ny,
        "short_cells": ny if h <= w else nx,
    }
print(json.dumps(res))
`);
  for (const [key, r] of Object.entries<any>(out)) {
    assert.equal(r.nx % 2, 0, `${key}: nx must be even (clean quadrant split), got ${r.nx}`);
    assert.equal(r.ny % 2, 0, `${key}: ny must be even, got ${r.ny}`);
    // cells stay near-square so line/thin-label stamping is isotropic
    const ratio = Math.max(r.cw, r.ch) / Math.min(r.cw, r.ch);
    assert.ok(ratio < 1.15, `${key}: cells should be ~square, aspect ${ratio.toFixed(3)}`);
    // the constrained (short) axis always gets exactly SHORT_AXIS_SUBDIV cells
    assert.equal(r.short_cells, 8, `${key}: short axis should get SHORT_AXIS_SUBDIV=8 cells`);
  }
  // concrete expected resolutions
  assert.deepEqual([out["1000x540"].nx, out["1000x540"].ny], [14, 8]);
  assert.deepEqual([out["800x800"].nx, out["800x800"].ny], [8, 8]);
  assert.deepEqual([out["2100x540"].nx, out["2100x540"].ny], [32, 8]);
  assert.deepEqual([out["400x1000"].nx, out["400x1000"].ny], [8, 20]);
});

// ── _occupancy_grid ─────────────────────────────────────────────────────────

test("_occupancy_grid: empty input is all-empty; a full-page rect is all-full", () => {
  const out = scaffoldJSON(`
nx, ny = m._grid_dims(1000, 540)
empty = m._occupancy_grid([], [], 1000, 540, nx, ny)
full = m._occupancy_grid([Rect("bg", 0, 0, 1000, 540)], [], 1000, 540, nx, ny)
print(json.dumps({
    "cells": nx * ny,
    "empty_occ": sum(sum(r) for r in empty),
    "full_occ": sum(sum(r) for r in full),
}))
`);
  assert.equal(out.empty_occ, 0);
  assert.equal(out.full_occ, out.cells);
});

test("_occupancy_grid: a small box stamps only its cell; a top-edge arrow stamps its row", () => {
  const out = scaffoldJSON(`
nx, ny = m._grid_dims(1000, 540)   # 14 x 8, cells ~71.4 x 67.5
box = m._occupancy_grid([Rect("b", 0, 0, 71, 67)], [], 1000, 540, nx, ny)
arrow = m._occupancy_grid([], [EdgePath("e", "#000", [(0, 0), (999, 0)])], 1000, 540, nx, ny)
print(json.dumps({
    "box_total": sum(sum(r) for r in box),
    "box_00": box[0][0],
    "arrow_row0": sum(arrow[0]),
    "arrow_rest": sum(sum(r) for r in arrow[1:]),
    "nx": nx,
}))
`);
  assert.equal(out.box_total, 1, "a sub-cell box occupies exactly one cell");
  assert.equal(out.box_00, true);
  assert.equal(out.arrow_row0, out.nx, "a horizontal arrow along the top edge marks the whole top row");
  assert.equal(out.arrow_rest, 0, "…and nothing below it");
});

test("_occupancy_grid: overlapping boxes/labels do not double-count (boolean union)", () => {
  const out = scaffoldJSON(`
nx, ny = m._grid_dims(1000, 540)
one = m._occupancy_grid([Rect("a", 100, 100, 300, 200)], [], 1000, 540, nx, ny)
two = m._occupancy_grid(
    [Rect("a", 100, 100, 300, 200), Rect("b", 150, 120, 300, 200)],
    [], 1000, 540, nx, ny,
)
print(json.dumps({
    "one": sum(sum(r) for r in one),
    "two": sum(sum(r) for r in two),
}))
`);
  // union grows (b extends past a) but is still a boolean OR, never a sum
  assert.ok(out.two > out.one);
});

// ── check_page_fill ─────────────────────────────────────────────────────────

test("check_page_fill: full-page content passes; a tiny centered blob warns", () => {
  scaffold(`
ok = m.check_page_fill([Rect("bg", 20, 20, 960, 500)], [], 1000, 540)
assert ok == [], ok
warn = m.check_page_fill([Rect("b", 450, 245, 100, 50)], [], 1000, 540)
assert len(warn) == 1 and "bounding box" in warn[0], warn
assert m.check_page_fill([], [], 1000, 540) == []   # nothing to check
print("ok")
`);
});

test("check_page_fill: an arrow routed to the margin counts toward the content extent", () => {
  scaffold(`
# a tiny box alone would warn; a corner-to-corner arrow extends the bbox to
# the full page, so fill passes — arrows are real content extent.
box = [Rect("b", 480, 260, 40, 20)]
assert m.check_page_fill(box, [], 1000, 540) != []          # tiny box alone -> warn
edge = [EdgePath("e", "#000", [(0, 0), (1000, 540)])]
assert m.check_page_fill(box, edge, 1000, 540) == []        # arrow fills the bbox -> ok
print("ok")
`);
});

// ── _corner_empty_area (direct, hand-built grids) ───────────────────────────

test("_corner_empty_area: all-empty -> every corner is a full quadrant; all-full -> zero", () => {
  const out = scaffoldJSON(`
nx, ny = 8, 4                      # hx=4, hy=2 -> quadrant = 8 cells
empty = [[False] * nx for _ in range(ny)]
full = [[True] * nx for _ in range(ny)]
print(json.dumps({
    "empty": m._corner_empty_area(empty, nx, ny),
    "full": m._corner_empty_area(full, nx, ny),
    "quad": (nx // 2) * (ny // 2),
}))
`);
  assert.equal(out.quad, 8);
  for (const c of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    assert.equal(out.empty[c], 8, `${c} empty rect should fill its quadrant`);
    assert.equal(out.full[c], 0, `${c} should have no empty rect`);
  }
});

test("_corner_empty_area: an empty top-left quadrant is isolated to that corner", () => {
  const out = scaffoldJSON(`
nx, ny = 8, 4
g = [[True] * nx for _ in range(ny)]
for j in range(2):                 # blank the top-left quadrant (cols<4, rows<2)
    for i in range(4):
        g[j][i] = False
print(json.dumps(m._corner_empty_area(g, nx, ny)))
`);
  assert.equal(out["top-left"], 8);
  assert.equal(out["top-right"], 0);
  assert.equal(out["bottom-left"], 0);
  assert.equal(out["bottom-right"], 0);
});

test("_corner_empty_area: a nub on the corner column halves the grown rectangle", () => {
  // Everything empty except a single occupied cell at (row 1, col 0): the
  // corner rectangle can only span row 0 before the nub blocks column 0.
  const out = scaffoldJSON(`
nx, ny = 8, 4                      # hx=4, hy=2
g = [[False] * nx for _ in range(ny)]
g[1][0] = True
print(json.dumps({"tl": m._corner_empty_area(g, nx, ny)["top-left"]}))
`);
  // row 0 only, width capped at hx=4 -> area 4 (half of the 8-cell quadrant)
  assert.equal(out.tl, 4);
});

// ── check_corner_deadzones (integration via Rects/EdgePaths) ─────────────────

test("check_corner_deadzones: a full panel is clean", () => {
  scaffold(`
assert m.check_corner_deadzones([Rect("bg", 0, 0, 1000, 540)], [], 1000, 540) == []
print("ok")
`);
});

test("check_corner_deadzones: content in the right ~60% flags both left corners", () => {
  const warnings = scaffoldJSON(`
w = m.check_corner_deadzones([Rect("r", 430, 0, 570, 540)], [], 1000, 540)
print(json.dumps(w))
`);
  assert.equal(warnings.length, 2, `expected two left-corner warnings, got ${JSON.stringify(warnings)}`);
  const joined = warnings.join(" ");
  assert.ok(/top-left/.test(joined) && /bottom-left/.test(joined), joined);
  assert.ok(!/top-right/.test(joined) && !/bottom-right/.test(joined), joined);
});

test("check_corner_deadzones: each warning explains the rectangular-layout rationale + carve-out so the agent adjudicates", () => {
  const warnings = scaffoldJSON(`
print(json.dumps(m.check_corner_deadzones([Rect("r", 430, 0, 570, 540)], [], 1000, 540)))
`);
  for (const w of warnings) {
    // the layout rationale — a non-rectangular silhouette wastes column space
    assert.ok(/non-rectangular|L-shaped/i.test(w), `missing layout rationale: ${w}`);
    // the intentional-whitespace carve-out — why this can't be auto-blocked
    assert.ok(/intentional white space/i.test(w), `missing whitespace carve-out: ${w}`);
    // and an explicit out, so a deliberate-whitespace panel isn't wedged
    assert.ok(/bypass/i.test(w), `warning should tell the agent it may bypass: ${w}`);
  }
});

test("check_corner_deadzones: a uniformly sparse panel defers to check_page_fill (no warning)", () => {
  scaffold(`
# single tiny box -> overall fill below MIN_OVERALL_FILL -> corner check abstains
assert m.check_corner_deadzones([Rect("b", 450, 245, 100, 50)], [], 1000, 540) == []
print("ok")
`);
});

test("check_corner_deadzones: an arrow occupying the empty strip clears the dead-zone flag", () => {
  scaffold(`
block = [Rect("r", 430, 0, 570, 540)]
assert len(m.check_corner_deadzones(block, [], 1000, 540)) == 2      # left corners flagged
# route a vertical arrow down the far-left edge: it stamps column 0, so the
# corner rectangles anchored there are no longer empty -> flags cleared.
edge = [EdgePath("e", "#000", [(10, 10), (10, 530)])]
assert m.check_corner_deadzones(block, edge, 1000, 540) == []
print("ok")
`);
});

test("check_corner_deadzones: known limitation — a central void (two opposite corner blobs) is not caught", () => {
  // Documents scope: check_page_fill sees a full bbox, check_corner_deadzones
  // sees an overall-sparse panel, so a central void slips both. Catching it
  // would need a max-empty-rectangle-anywhere pass (out of scope for now).
  scaffold(`
blobs = [Rect("a", 0, 0, 120, 80), Rect("b", 880, 460, 120, 80)]
assert m.check_page_fill(blobs, [], 1000, 540) == []        # bbox spans the page
assert m.check_corner_deadzones(blobs, [], 1000, 540) == [] # overall too sparse to fire
print("ok")
`);
});

// ── check_endpoint_grazes_element ───────────────────────────────────────────
// Box "b" at (400,200,100,100): right edge x=500 (y in 200..300), top-right
// corner at (500,200). A clean connection meets a side head-on (perpendicular);
// a terminal segment parallel to the touched side "grazes" and is flagged.

test("check_endpoint_grazes_element: perpendicular into the middle of an edge is clean", () => {
  scaffold(`
box = [Rect("b", 400, 200, 100, 100)]
# target endpoint on the mid right edge, terminal segment horizontal -> head-on
edge = [EdgePath("e", "#000", [(560, 250), (500, 250)])]
assert m.check_endpoint_grazes_element(edge, box, 2) == []
print("ok")
`);
});

test("check_endpoint_grazes_element: a vertical segment along a vertical edge grazes", () => {
  const warnings = scaffoldJSON(`
box = [Rect("b", 400, 200, 100, 100)]
# target endpoint on the mid right edge, terminal segment vertical -> parallel
edge = [EdgePath("e", "#000", [(500, 180), (500, 250)])]
print(json.dumps(m.check_endpoint_grazes_element(edge, box, 2)))
`);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.ok(/parallel to its left\/right edge/.test(warnings[0]), warnings[0]);
  assert.ok(/perpendicular/.test(warnings[0]), warnings[0]);
});

test("check_endpoint_grazes_element: a corner hit warns for either axis-aligned direction", () => {
  scaffold(`
box = [Rect("b", 400, 200, 100, 100)]
# endpoint at the top-right corner (500,200)
horiz = [EdgePath("h", "#000", [(560, 200), (500, 200)])]
vert = [EdgePath("v", "#000", [(500, 140), (500, 200)])]
assert len(m.check_endpoint_grazes_element(horiz, box, 2)) == 1, m.check_endpoint_grazes_element(horiz, box, 2)
assert len(m.check_endpoint_grazes_element(vert, box, 2)) == 1, m.check_endpoint_grazes_element(vert, box, 2)
print("ok")
`);
});

test("check_endpoint_grazes_element: a diagonal terminal segment is not flagged here", () => {
  scaffold(`
box = [Rect("b", 400, 200, 100, 100)]
# diagonal into the corner: parallel to neither axis -> left to the ortho check
edge = [EdgePath("e", "#000", [(560, 260), (500, 200)])]
assert m.check_endpoint_grazes_element(edge, box, 2) == []
print("ok")
`);
});

test("check_endpoint_grazes_element: the SOURCE endpoint is checked too, not just the target", () => {
  scaffold(`
box = [Rect("b", 400, 200, 100, 100)]
# source endpoint (points[0]) on the mid right edge, leaving parallel (vertical)
edge = [EdgePath("e", "#000", [(500, 250), (500, 320), (600, 320)])]
warn = m.check_endpoint_grazes_element(edge, box, 2)
assert len(warn) == 1 and "source" in warn[0], warn
print("ok")
`);
});

// ── wiring regression ───────────────────────────────────────────────────────

test("run_checks wiring: the warning checks are called in the library's warnings assembly", () => {
  const src = fs.readFileSync(path.resolve(GEOMETRY), "utf8");
  assert.ok(
    /warnings \+= check_page_fill\(elements, paths, page_w, page_h\)/.test(src),
    "check_page_fill must be wired into run_checks warnings",
  );
  assert.ok(
    /warnings \+= check_corner_deadzones\(elements, paths, page_w, page_h\)/.test(src),
    "check_corner_deadzones must be wired into run_checks warnings",
  );
  assert.ok(
    /warnings \+= check_endpoint_grazes_element\(paths, elements, ENDPOINT_SNAP_TOL\)/.test(src),
    "check_endpoint_grazes_element must be wired into run_checks warnings",
  );
});

test("generate_panel_template imports the shared library and calls enforce()", () => {
  const tpl = fs.readFileSync(path.resolve("assets/generate_panel_template.py"), "utf8");
  assert.ok(
    /from panel_geometry import Rect, EdgePath, enforce/.test(tpl),
    "the template must import Rect/EdgePath/enforce from panel_geometry",
  );
  assert.ok(
    /enforce\(elements, paths, PAGE_W, PAGE_H, bypass_warnings=bypass_warnings\)/.test(tpl),
    "build_params must delegate its checks to enforce()",
  );
  assert.ok(
    /sys\.path\.insert\(0, str\(Path\(__file__\)\.resolve\(\)\.parent\)\)/.test(tpl),
    "the template must self-bootstrap its own dir onto sys.path before importing",
  );
});
