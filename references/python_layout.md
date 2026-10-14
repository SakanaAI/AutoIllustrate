# Python layout — script structure, edge labels, label sizes

Read this file when writing any per-panel `generate_<panel_id>.py`
(Phase 2). Start from `assets/generate_panel_template.py` and fill in
the constants / `build_elements()` / `build_params()` bodies; the
edge-label and label-size guidance below feeds those bodies.

## Python script structure

```python
#!/usr/bin/env python3
# This script ONLY computes numbers (positions, sizes) and feeds them
# into template.format(**params). It must NEVER build mxCell XML
# strings — all cells live in the .drawio.template. (See "No XML
# generation in Python" in references/panel_agent.md.)
from pathlib import Path
import sys
import math

# The Rect / EdgePath types and ALL the geometry checks live in the shared
# `panel_geometry` library, staged into the workdir next to the generators.
# Import them (don't re-implement); self-bootstrap this file's own dir onto
# sys.path so the import resolves however this generator is loaded (run
# directly, or imported by compose / check_params_contract).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from panel_geometry import Rect, EdgePath, enforce

# ── Page ──
PAGE_W, PAGE_H = 1000, 540

# ── Element sizes ──
NODE_W, NODE_H = 120, 48
# ... all sizes as constants ...

# ── Layout parameters ──
COL_GAP = 200              # center-to-center between columns
L_CENTER = ...             # center x of left half
# ... vertical tier positions ...

# ── Edge label placement ──
SAME_LABEL_GAP = 8         # gap from arrow to same-polarity label
CROSS_LABEL_T = 0.22       # position along diagonal (0=source, 1=target)
CROSS_LABEL_PERP_OFFSET = 16  # perpendicular push outward from diagonal

def build_elements() -> list[Rect]:
    # return ALL visible elements including edge labels
    return [ ... ]

def build_paths() -> list[EdgePath]:
    # return EVERY routed edge in the panel with full polyline + color
    return [ ... ]

# ── Position computation ──
# All positions derived from layout constants using center_x/center_y helpers
# Edge label positions computed from edge geometry (source/target points)

# ── Template filling ──
def build_params(bypass_warnings: bool = False) -> dict:
    """Compute every position. `enforce(...)` runs all the collision /
    path-geometry / page-fill checks and aborts on any error (or on any
    warning, unless bypassed). Returned dict MUST contain page_w / page_h,
    every rect-geometry placeholder, every path's waypoints as
    `<name>_x<i>` / `<name>_y<i>`, and every path's `<name>_color`.
    Coordinate keys end in `_x` / `_y` so the Phase 4 composer can offset
    them by the panel origin. Pure: no file I/O. Both `main()` here and
    the composer call this — keep it free of side effects.

    Errors are never bypassable. Warnings also block generation unless
    `bypass_warnings=True` (surfaced as `--bypass-warnings` on the CLI) —
    pass it ONLY when every warning has been reviewed and each has a
    valid reason to be bypassed.
    """
    elements = build_elements()
    paths    = build_paths()
    enforce(elements, paths, PAGE_W, PAGE_H, bypass_warnings=bypass_warnings)
    return dict(...)  # all computed positions as ints, plus every path's points + color

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bypass-warnings", action="store_true")
    args = parser.parse_args()
    params = build_params(bypass_warnings=args.bypass_warnings)
    template = Path("name.drawio.template").read_text()
    Path("name.drawio").write_text(template.format(**params))
```

The `assets/generate_panel_template.py` file ships this skeleton as a
copy-and-modify starter — copy it into the workdir, rename to
`generate_<panel_id>.py`, and fill in the bodies. The shared
`panel_geometry.py` library it imports is already staged in the workdir
by the orchestrator — do NOT copy, edit, or delete it, and do NOT
re-implement its checks in the generator.

## Edge label positioning strategies

**Same-polarity labels** (beside vertical arrows):
- Place at the vertical midpoint between source bottom and target top.
- Offset horizontally: left of the arrow for one stream, right for the
  other.
- Use `SAME_LABEL_GAP` to control distance from the arrow line.

**Cross-polarity labels** (beside diagonal arrows):
- Compute position at fraction `CROSS_LABEL_T` along the source→target
  line.
- Push perpendicular to the line by `CROSS_LABEL_PERP_OFFSET`, outward
  from the crossing zone.
- This guarantees the two cross labels fan apart rather than
  converging.

## Path / waypoint constraints

Every routed edge in the panel is an `EdgePath(name, color, points)`:

- `points` is the FULL polyline — `[source_xy, *waypoints, target_xy]`,
  `len(points) >= 2`. Source/target are the exit/entry points on the
  connected node, NOT the node centers. Python owns these endpoints
  exactly; drawio is never allowed to pick them.
- `color` is a hex literal (e.g. `"#1f78b4"`) and is the SOLE source of
  truth for that edge's stroke color. The template's edge mxCell must
  carry `strokeColor={<name>_color}` — never a hardcoded hex — so the
  rendered color matches what `check_path_crossings` saw.
- Stroke weight is fixed: every edge mxCell carries `strokeWidth=3`
  (3pt arrows stay legible once the figure is scaled into a paper
  column).
- Every dashed edge MUST pin its dash pattern: `dashed=1;dashPattern=4
  2;`. Drawio's default dash spacing is never relied on — `dashPattern=4
  2` is mandatory on all dashed arrows. Solid edges carry neither
  attribute.

`build_params()` calls `enforce(elements, paths, PAGE_W, PAGE_H,
bypass_warnings=...)` from `panel_geometry`, which runs all the checks
below and must pass before the template is filled. `enforce` aborts on
any error, and on any warning unless bypassed; you never call the
individual checks yourself. For reference, the checks it runs:

1. **`check_orthogonal_waypoints(paths)`** — walks every segment of
   every path, straight two-point edges included. A diagonal segment
   (`dx!=0` and `dy!=0`) is a warning; two consecutive axis-aligned
   segments on the same axis are an error (a collinear "fake"
   waypoint, three points on one line). This forces every interior
   waypoint to a real 90° bend. A deliberate straight diagonal edge
   between unaligned boxes always produces the warning — expected;
   bypass it if the diagonal reads fine, or add an orthogonal
   waypoint if you think the bend would improve the design.
2. **`check_short_segments(paths, MIN_SEGMENT_LEN)`** — flags polyline
   segments shorter than `MIN_SEGMENT_LEN` (degenerate near-zero-length
   bends).
3. **`check_path_crossings(paths)`** — pairwise segment-intersection
   over all paths. Skip pairs where `a.color != b.color` (different
   colors are allowed to cross). Treat shared endpoints (`a.points[0]
   == b.points[0]`, etc.) as non-crossings so legitimate fan-ins /
   fan-outs at a node aren't flagged.
4. **`check_edge_endpoints_on_elements(paths, elements,
   ENDPOINT_SNAP_TOL)`** — warns (does not error) when an edge endpoint
   does not sit on a connected element's border within
   `ENDPOINT_SNAP_TOL`.

The template MUST declare every routed (`len(points) >= 3`) edge with
Python-owned endpoints (see `references/template_authoring.md`):

- `points[0]`  → `<mxPoint x="{<name>_x0}" y="{<name>_y0}" as="sourcePoint"/>`
- `points[-1]` → `<mxPoint x="{<name>_x<N>}" y="{<name>_y<N>}" as="targetPoint"/>`
  where `N = len(points) - 1`
- `points[i]`  → child entry `<mxPoint x="{<name>_x<i>}" y="{<name>_y<i>}"/>`
  inside `<Array as="points">` for `1 <= i <= N-1`

Every polyline coordinate key MUST end in `_x<int>` / `_y<int>` —
including the source and target endpoints. The Phase 4 composer
offsets only keys matching `_x\d*$` / `_y\d*$` by the panel origin;
names like `<name>_sx` / `<name>_tx` silently break composition (the
endpoints stay in panel-local space while the waypoints shift to
composite space, producing a snapped, misplaced arrow). Pick a single
naming scheme: number every point in the polyline `0..N`, with `0` as
source and `N` as target, and `build_params()` emits the matching
`{<name>_x<i>}` / `{<name>_y<i>}` keys. `lint_math.py` rule (h)
enforces this on the template.

```xml
<mxCell id="path_e" style="endArrow=block;endFill=1;strokeColor={e_color};strokeWidth=3;..."
        edge="1" parent="1">
  <mxGeometry relative="1" as="geometry">
    <Array as="points">
      <mxPoint x="{e_x1}" y="{e_y1}"/>
      <mxPoint x="{e_x2}" y="{e_y2}"/>
    </Array>
    <mxPoint x="{e_x0}" y="{e_y0}" as="sourcePoint"/>
    <mxPoint x="{e_x3}" y="{e_y3}" as="targetPoint"/>
  </mxGeometry>
</mxCell>
```

`source="…"`, `target="…"`, and `exitX/exitY/entryX/entryY` are
forbidden on waypointed edges: they let drawio derive the source/
target endpoints from the connected shapes' geometry, which decouples
the rendered polyline from the one Python checked (the polyline drawn
is not the polyline validated). `lint_math.py` enforces this at step
4 (rule (h)).

Straight edges with no waypoints (`len(points) == 2`, no `<Array>`)
may keep `source=`/`target=`: the rendered shape is a single segment
between two connected shapes, so there is no polyline for drawio to
diverge from. (A diagonal two-point edge still gets the
diagonal-segment warning.)

`orthogonalEdgeStyle` (and any other auto-routing edgeStyle) is
forbidden on every edge: it diverges from the Python-owned polyline
and silently invalidates both checks above.

## Page fill & dead-zone checks

Two more checks run inside `build_params()` (both **warnings**, so
`--bypass-warnings` clears them). They guard the panel's *use of its
own page*, because a panel that doesn't fill its `PAGE_W × PAGE_H` box
becomes dead space when the composer tiles it — that is where a
composed figure's dead zones (protruding legends, unbalanced corners,
wasted margins) originate. Fixing it here, per panel, keeps the
deterministic compose step a dumb tiler.

Both operate on the SAME inputs the geometry checks already use —
`build_elements()` (boxes **and** edge labels, i.e. text) and
`build_paths()` (arrows) — so every content type is accounted for:
Rects contribute their filled area, and arrow polylines are rasterized
along their path into a coarse occupancy grid (a thin arrow still marks
the region it crosses as "live").

1. **`check_page_fill(elements, paths, PAGE_W, PAGE_H)`** — warns when
   the content bounding box (Rect corners + arrow endpoints) spans less
   than `MIN_BBOX_FILL` (0.60) of the page: content clustered in a
   small region. Position-independent by design — it does **not** flag
   per-edge margins, since the composite is cropped to its content bbox
   on export and a panel cannot know which edges will be outer
   (croppable) vs. abut a neighbour.
2. **`check_corner_deadzones(elements, paths, PAGE_W, PAGE_H)`** — one
   warning **per corner** that holds a corner-anchored empty rectangle
   (grown inward to the midlines until it hits content) covering ≥
   `EMPTY_CORNER_FRAC` (0.50) of its quadrant, while the panel is
   otherwise filled (overall occupancy ≥ `MIN_OVERALL_FILL`, 0.30). The
   `MIN_OVERALL_FILL` guard keeps the two checks from double-firing (a
   uniformly sparse panel is `check_page_fill`'s concern). Central voids
   not anchored to a corner are out of scope.

   This is a **guardrail toward a compact rectangular composition, not a
   hard rule**. A non-rectangular (L-shaped) silhouette wastes column
   space once the figure is scaled into a paper, but a large empty corner
   can also be legitimate visual hierarchy — so the warning surfaces each
   large corner and leaves the call to the panel agent: fill it to stay
   rectangular, or `--bypass-warnings` if the whitespace is deliberate.
   Expect it to fire fairly often; make the intentional-or-not call each
   time rather than reflex-bypassing.

The occupancy grid is sized by `_grid_dims()`: `SHORT_AXIS_SUBDIV` (8)
cells along the shorter page axis, the longer axis scaled to keep cells
~square (so arrow/thin-label stamping is direction-independent), both
rounded even so the quadrant split lands on a cell boundary. All four
thresholds are starting points; calibrate them against real panels
before treating a warning as authoritative.

## Estimated label sizes

Since LaTeX rendering sizes are not known at generation time, use
conservative estimates for collision detection. Use `fontSize=14` as
the default — at least 14 keeps labels comfortably readable in the
rendered figure; smaller sizes are legible on screen but tend to look
cramped once the figure is scaled into a paper column. Typical values
at fontSize=14:

| Label type | Estimated width | Estimated height |
|-----------|----------------|-----------------|
| `W_{pp}^{≥0}` (with superscript) | 70–78px | 26–31px |
| `-W_{np}` (simple) | 58–66px | 23–28px |
| Short text ("Conv+BN") | 90–115px | 36–41px |

Overestimate rather than underestimate — false positives (collision
checker too strict) are better than false negatives (overlapping labels
in the output).
