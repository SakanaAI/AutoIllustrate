# Panel agent — per-panel generation lifecycle

This file is the full instruction set for a single-panel **generation**
subagent dispatched by the orchestrator at Phase 2. The dispatcher
forks one of these per panel; panels are independent until composition
(Phase 4), so dispatch them in parallel when the runtime supports it,
otherwise sequentially.

The generation agent's job ends at the rendered PNG. Visual
inspection, repair, and the unit-test inspections file are handled by
a separate **inspect** sub-agent in Phase 3 — see
`references/panel_inspect_agent.md`. The two roles share the same
workdir and template/generator on disk; the inspect agent is
permitted to modify both during its repair loop.

## Inputs (from the orchestrator)

The dispatcher passes the panel agent these handles:

- `panel_id` — the stable lowercase-snake id from `figure.json` (also
  the filename stem for every per-panel artifact).
- `$WORKDIR` — the per-invocation temp directory (created by
  `mktemp -d`); every artifact this agent produces lives here.
- `$WORKDIR/figure.json` — the figure plan; the agent reads its own
  panel entry by `panel_id` and uses the panel's `drawio_prompt`,
  `proportion_w`, and `proportion_h` (the last two drive PAGE_W /
  PAGE_H — see "Panel size from figure.json proportions" below).
- `$WORKDIR/methods.md` — methodology brief; every shape, arrow, and
  label this panel emits must be traceable to a fact in this file.
- `$WORKDIR/theme.txt` — the figure-wide theme; the panel agent
  honours it for stylistic consistency with sibling panels.
- `$WORKDIR/style.md` — the figure-wide visual style chosen by the
  Style phase (Phase 1.5): the figure's designed palette (anchor + rationale),
  the role→fill+font hex table, edge color / stroke rules, corner convention, fonts, and the
  per-panel emphasis note. Draw ALL fills, stroke colors, corner radii,
  and fonts from this file — never draw.io's defaults (the stock
  `#dae8fc` fill or a black outline). If `style.md` is absent (e.g. a
  resumed run that predates it), fall back to a clean light-pastel
  palette with non-black edges.

## Output contract (back to the orchestrator)

A panel's generation is "done" when the workdir contains, for this
`<panel_id>`:

- `<panel_id>.plan.md` — design plan (with the panel's `drawio_prompt`
  quoted verbatim at the top).
- `<panel_id>.drawio.template` — XML template with `{placeholder}`
  slots, lint-clean per `scripts/lint_math.py`.
- `generate_<panel_id>.py` — the panel's layout script.
- `<panel_id>.drawio` — the generated editable diagram.
- `panels/<panel_id>.png` — the deliverable PNG.
- `placeholders_<panel_id>.jsonl` (optional) — one JSON object per
  deferred visualization (curves, histograms, sketches, etc.) the
  panel handed off to the Phase 5 enhancer. Omit the file entirely if
  the panel has no deferred visuals. See "Deferring complex visuals
  (placeholders)" below.
- `placeholders_<panel_id>_mpl.jsonl` (optional) — one JSON object per
  matplotlib-rendered visualization the panel generates LOCALLY (not
  via the Phase 5 enhancer). Each entry names its generator script
  and intended pixel dimensions. Omit the file entirely if the panel
  has no matplotlib placeholders. See "Matplotlib placeholders
  (`[[mp:]]`)" below.
- For every entry in `placeholders_<panel_id>_mpl.jsonl`: the named
  Python script (e.g. `mpl_<panel_id>_<id>.py`) AND its rendered PNG
  (e.g. `mpl_<panel_id>_<id>.png`), both in `$WORKDIR/`. The
  `<panel_id>.drawio.template` (NOT just the rendered `.drawio`) MUST
  embed each PNG as a base64 data URI in place of its gray placeholder
  box, so that Phase 4 composition — which reads templates, not
  rendered `.drawio` files — picks the image up in the composite. See
  step 6 below.

The PNG at `$WORKDIR/panels/<panel_id>.png` is the deliverable for
this panel. Phase 3 will inspect it and may overwrite the PNG, the
template, and the generator as part of its repair loop.

## Per-panel CRITICAL RULES (invariants — never violate)

### Foreground commands only, absolute paths only

Run **every** command in the foreground. Do NOT use `run_in_background`,
a trailing `&`, or `until`/`while` + `sleep` poll loops. Every script in
this toolkit (`lint_math.py`, the `drawio` CLI, ...) is synchronous —
invoke it and read its result directly. A background task left running
keeps the `claude -p` sub-agent process alive, which hangs the
orchestrator until its watchdog force-kills the run.

Reference every file by **absolute path** — the orchestrator passes
`$WORKDIR` as an absolute path; build all paths from it. Never use a
path relative to the project root and never assume the shell's cwd
(steps in the lifecycle below may `cd`, so a root-relative path silently
resolves to the wrong place).

### No auto-placed labels

**NEVER use draw.io `edgeLabel` cells.** Edge labels are positioned by
draw.io's rendering engine, making them unpredictable and invisible to
collision detection.

Instead, ALL text labels — including arrow/edge labels — must be
regular `text` or `rounded` mxCells with explicit `x`, `y`, `width`,
`height` geometry controlled by the Python script. This ensures every
visible element is covered by the collision checker.

### No pointers into a multi-glyph cell

Never aim an arrow, underline, bracket, or callout at a **sub-part** of
a single text or MathJax cell. Python sees the cell's outer bbox, not
glyph x-coordinates, so any "this underline tags the `η` term" pointer
is blind alignment — the PNG drifts under a neighbour and neither
inspector catches it. To label parts of an equation, either split it
into one mxCell per term (each gets a real bbox) or replace the
pointers with a single inline legend (e.g. `η: rate · e_j: routed
error · …`). Otherwise drop the per-term annotations.

### No hardcoded positions in the template

The `.drawio.template` file must contain **zero hardcoded coordinates**.
Every `x`, `y`, `width`, and `height` value must be a `{placeholder}`
filled by the Python script. The only hardcoded values allowed in the
template are:
- Style strings (fonts, fills, stroke widths/dashes) — **except** edge
  `strokeColor`, which must be a `{placeholder}` filled from
  `EdgePath.color` (see "Python-owned edge colors" below)
- Cell IDs and parent references
- LaTeX/HTML label content
- Edge connection properties (source, target, exitX, exitY, entryX,
  entryY)

### No XML generation in Python

The `generate_<panel_id>.py` script must ONLY compute numeric values
(positions, sizes) and pass them to `template.format(**params)`. It
must NEVER build mxCell XML strings, f-string XML fragments, or any
other draw.io markup in Python. Helpers like `bar_xml(...)`,
`make_node(...) -> str`, or string-concatenated `<mxCell ...>` blocks
are forbidden.

Why: every shape, label, and edge belongs in the `.drawio.template`
where it is reviewable and survives Phase 4 composition. Generating
XML in Python bypasses the template, splits the panel definition
across two files, and produces a messy composite generator (the
composer concatenates templates — it cannot pull in Python-emitted
cells). If you find yourself wanting to build XML in Python, add the
cell to the template with `{placeholder}` slots instead.

### Layout integrity is mandatory

The Python script must validate the full panel geometry before writing
the `.drawio` file. It does this by calling `enforce(elements, paths,
PAGE_W, PAGE_H, bypass_warnings=...)` from the shared `panel_geometry`
library (staged in the workdir, imported at the top of the generator) —
`enforce` runs every check below and **aborts without writing** on any
error (or any warning, unless bypassed). You never re-implement these
checks in the generator. The checks `enforce` runs include:

1. **Bounding-box collisions** — overlap of every visible `Rect`:
   - All node boxes (shapes, containers)
   - All text labels (titles, annotations, edge labels)
   - Page bounds (nothing may extend beyond the page)
   - A configurable safety margin (default: 4px)

2. **Orthogonal waypoints** — every segment of every `EdgePath`
   (straight two-point edges included) is classified; a diagonal
   segment is a *warning*, and consecutive axis-aligned segments on
   the same axis are an *error* (a collinear "fake" waypoint). This
   forces every interior waypoint to a true 90° bend. A straight
   diagonal edge between two unaligned boxes therefore always warns —
   that is expected; at step 5 you decide whether to keep it or add
   an orthogonal waypoint.

3. **No same-color path crossings** — pairwise segment intersection
   across all `EdgePath`s, skipping pairs where the two paths have
   different `color` (different colors may cross). Shared endpoints at
   a common node do NOT count as a crossing.

(plus the short-segment, dangling-endpoint, page-fill, and corner
dead-zone checks — all wired into `enforce`.) See
`references/python_layout.md` for the `Rect` / `EdgePath` dataclasses and
the full check list; all of it lives in `panel_geometry.py`, which you
import but never edit.

### No `orthogonalEdgeStyle` (or any auto-routing)

Every routed edge's polyline is owned by Python. The template MUST
declare its waypoints inline via `<mxGeometry><Array as="points">…
</Array></mxGeometry>` using `{placeholder}` slots filled from the
`EdgePath.points` returned by `build_paths()`. The edge mxCell `style`
attribute must NOT contain `edgeStyle=orthogonalEdgeStyle` (or any
other auto-routing edgeStyle): auto-routing diverges from the
Python-checked polyline and silently invalidates both the
orthogonal-waypoint and crossing checks. `lint_math.py` enforces this
at step 4.

### Python-owned endpoints on waypointed edges

For any edge with at least one interior waypoint (`len(points) >= 3`),
BOTH endpoints must be Python-owned too — not just the waypoints in
between. The template MUST emit:

- `<mxPoint x="{<name>_x0}" y="{<name>_y0}" as="sourcePoint"/>` filled from `EdgePath.points[0]`
- `<mxPoint x="{<name>_x<N>}" y="{<name>_y<N>}" as="targetPoint"/>` filled
  from `EdgePath.points[-1]` (where `N = len(points) - 1`)

Every polyline coordinate placeholder — endpoints included — MUST end
in `_x<int>` / `_y<int>`. The Phase 4 composer offsets only keys
matching `_x\d*$` / `_y\d*$` by the panel origin; ad-hoc names like
`_sx`/`_tx` silently break composition (endpoints stay in panel-local
space while waypoints shift to composite space, snapping the arrow to
nowhere). `lint_math.py` rule (h) rejects sourcePoint/targetPoint
placeholders whose key doesn't end in `_x<digits>` / `_y<digits>`.

The edge mxCell MUST NOT set `source="…"`, `target="…"`, or the
`exitX`/`exitY`/`entryX`/`entryY` style tokens on the edge mxCell. With
those set, drawio derives the rendered source/target endpoints from
the connected shapes' geometry — independent of `EdgePath.points[0]` /
`EdgePath.points[-1]` — so the polyline drawn is not the polyline Python
validated. (Concretely: a `source="block4"` + `exitX=0.5;exitY=1` edge
will be rendered starting at block4's bottom-center even if the Python
script's first point is somewhere else entirely; the orthogonal-
waypoint check then passes on a polyline drawio never draws.)
`lint_math.py` enforces this at step 4 (rule (h)).

Straight edges with no waypoints (`len(points) == 2`, no `<Array>`)
may keep `source=`/`target=` — there's no interior polyline for drawio
to diverge from. (The diagonal-segment warning still fires on such an
edge if its two endpoints are not aligned; step 5 says how to handle
it.)

### Python-owned edge colors

Every edge mxCell's `strokeColor` must be a `{placeholder}` filled
from the matching `EdgePath.color`. Hardcoded hex literals like
`strokeColor=#1f78b4` in an edge style are forbidden — the crossing
check needs Python to be the single source of truth for color, or
"different colors are allowed to cross" cannot be enforced.
`lint_math.py` enforces this at step 4.

### Edge stroke weight and dashes

Every edge mxCell carries `strokeWidth=3` — 3pt arrows stay legible
once the figure is scaled into a paper column; thinner strokes wash
out. Every dashed edge MUST pin its dash pattern with
`dashed=1;dashPattern=4 2;` — drawio's default dash spacing is never
relied on, so all dashed arrows render identically. Solid edges carry
neither `dashed` nor `dashPattern`. See
`references/template_authoring.md` for the full edge style string.

### Panel size from figure.json proportions

The panel's `figure.json` entry carries `proportion_w` and
`proportion_h` (each in (0, 1]) — its share of the composite's
inner width and height. Set `PAGE_W` / `PAGE_H` in
`generate_<panel_id>.py` to match:

```
inner = (2000, 832) if placement == "full-width" else (2000, 1104)
PAGE_W = round(proportion_w * inner_w)
PAGE_H = round(proportion_h * inner_h)
```

Soft ±15% tolerance on each axis. The Phase 3 inspect agent flags a
`check: "dimensions"` critical issue if the rendered PNG drifts
further; the fix is in those two constants.

### Minimum font size for readability

Use `fontSize=14` as the default for every label, and treat 14 as a
soft floor — anything smaller is legible on screen but looks cramped
once the figure is scaled down into a paper column. Go below 14 only
when a dense label genuinely cannot fit otherwise, and prefer
enlarging the cell or shortening the text first. If the Phase 3
inspect agent flags an illegible label, bump `fontSize` (toward 14+)
rather than shrinking it further.

## Deferring complex visuals (placeholders)

drawio is bad at curves, histograms, scatters, density plots, heatmaps,
hand-sketched icons, and similar illustrations. Rather than burning
the inspect budget on shapes drawio cannot draw, defer them: emit a
gray-dashed placeholder box in the deterministic panel and fill it
later — either via the Phase 5 enhancer (gpt-image-2), or via a local
matplotlib render embedded back into the drawio file.

There are TWO kinds of placeholders, picked by token prefix:

- **`[[ pl <panel_id> <n> ]]`** — handed off to the Phase 5 enhancer
  (gpt-image-2). The enhancer paints the box during restyling.
  Described in `placeholders_<panel_id>.jsonl`. Use for hand-sketched
  icons, abstract illustrations, photorealistic textures, or anything
  matplotlib cannot draw cleanly.
- **`[[ mp <panel_id> <n> ]]`** — rendered LOCALLY by the panel agent
  via matplotlib and embedded back into the drawio file as a base64
  data URI before the panel ships. Described in
  `placeholders_<panel_id>_mpl.jsonl`. Use for any data-driven
  scientific plot matplotlib renders well: curves, histograms,
  scatters, density plots, heatmaps, error bars, log-axes — anything
  where you want crisp, deterministic, paper-grade vector-quality
  output instead of an enhancer's interpretation.

**Strongly prefer `[[mp:]]` whenever matplotlib can plausibly produce
the visual.** The Phase 5 image enhancer is notoriously bad at exactly
the things scientific panels need most: curves are wobbly and
non-monotonic, histogram bars are uneven and miscounted, axes are
crooked, tick labels are garbled, scatter densities are invented,
legends drift, and numeric values on axes are routinely wrong. Any
data-driven plot — even something as simple as a single decreasing
loss curve, a bar chart, or a labeled axis — should be `[[mp:]]`, not
`[[pl:]]`. Matplotlib is deterministic, debuggable, paper-grade, and
is protected through the enhancement pass: `enhance.py` locates each
embedded plot in the composite and lists it in the prompt as a
reproduce-verbatim region with its position and this file's
`description`. That is a strong hint, not a pixel guarantee — the
image model regenerates the whole canvas — so `[[mp:]]` plots must
still carry a qualitative message (see "Deferring complex visuals").

Reserve `[[pl:]]` strictly for what matplotlib genuinely cannot do:
hand-sketched icons, abstract illustrations, photorealistic textures,
organic shapes. If you are reaching for `[[pl:]]` to render a plot,
a chart, a graph, a curve, a histogram, an axis, or anything with
numbers on it, stop and use `[[mp:]]` instead.

### gpt-image-2 placeholders (`[[pl:]]`)

**When to use.** Any visualization that is awkward or impossible in
drawio AND not a clean fit for matplotlib. Example `kind` strings
(open set, not enforced — pick the most natural label): `sketch`,
`icon`, `drawing`, `abstract_illustration`, `texture`, `photo`.

**When NOT to use.** Anything drawio renders cleanly — boxes, arrows,
labels, equations, swim lanes, flow diagrams. Don't placeholder away
ordinary layout work. Also avoid for anything matplotlib renders
cleanly (use `[[mp:]]` instead).

**Token form.** The placeholder cell's label is the literal ASCII
string `[[ pl <panel_id> <n> ]]` where `<n>` is a 1-based integer
index, unique within the panel and matching the placeholder's line
order in `placeholders_<panel_id>.jsonl` (first entry → `1`). The
inner spaces are REQUIRED: the cell style uses `whiteSpace=wrap`,
which can only break the label across lines at spaces. Without them a
long label overflows its box, and if the enhancer fails to remove the
box the raw label leaks into the PNG as one giant line of text (a
readability veto). The integer index — not a descriptive slug — keeps
any such leak innocuous (`pl foo 1`, not a code-identifier). Keep the
`[[ ]]` brackets: they signal to the enhancer that the box must be
deleted, and avoid Python `str.format()` collisions and XML escaping.

**Cell style** (use verbatim; the generator still fills `x/y/w/h`,
and the box IS included in collision detection):

```
rounded=0;whiteSpace=wrap;html=1;fillColor=#F0F0F0;strokeColor=#9E9E9E;dashed=1;fontFamily=monospace;fontColor=#616161;fontSize=14;
```

**`placeholders_<panel_id>.jsonl`** — one JSON object per line, EXACT
keys:

```json
{"id": "1", "kind": "line_plot", "description": "monotonically decreasing training-loss curve over ~100 steps, single dark-blue line, log-y, axis labels 'step' (x) and 'loss' (y); no legend"}
{"id": "2", "kind": "histogram", "description": "right-skewed posterior histogram, ~12 bins, soft blue fill, x-axis 'theta', y-axis 'count'"}
```

- `id` is the placeholder's 1-based index; it matches `<n>` in the
  box label and the entry's line order in this file. (The geometry
  slots in the generator are keyed by the mxCell `id`, which is
  independent of this index.)
- `kind` is a hint (any short string).
- `description` is self-contained: name axes, data shape, color,
  count of items. The enhancer has only this text + the box's aspect
  ratio + location to go on.

Omit the file if the panel has no `[[pl:]]` placeholders. The plan
(step 1) should also list each deferred visualization under a
`Placeholders` bullet so the design intent is auditable.

### Matplotlib placeholders (`[[mp:]]`)

**When to use.** Any data-driven scientific plot matplotlib renders
well: `line_plot`, `histogram`, `scatter`, `density`, `heatmap`,
`bar_chart`, `box_plot`, `error_bars`, `loss_curve`, `roc_curve`,
`confusion_matrix`, etc. Prefer this over `[[pl:]]` whenever the
visual is a plot (axes, ticks, lines / markers / bars / cells).

**When NOT to use.** Anything drawio renders cleanly (boxes, arrows,
labels, equations) — don't placeholder away ordinary layout work.
Hand-drawn / artistic / non-axis content — use `[[pl:]]` instead.

**Keep the message qualitative.** A deferred plot should convey an
*ordinal / structural* message — trend direction, ranking/ordering, or
the presence/location of structure (a hotspot, a cluster, a bright
near-diagonal) — not one that depends on reading precise values off
calibrated axes (exact slopes, intercepts, crossing points, error
bars, or a legend mapping colours to specific numeric series). This is
a methods schematic, not a results figure: a value-precise plot is out
of scope and stays correct only under pixel-perfect fidelity, whereas
an ordinal message survives any small rendering perturbation (export
scaling, base64 embed, downscaling into a paper column, the Phase 5
pass). The test is on the message, not the chart type — a curve whose
point is "flat then convex" (e.g. a reward-shaping shape) is fine; a
curve a reader reads numbers off is not.

**Token form.** The placeholder cell's label is the literal ASCII
string `[[ mp <panel_id> <n> ]]` where `<n>` is a 1-based integer
index, unique within the panel and matching the entry's line order in
`placeholders_<panel_id>_mpl.jsonl` (first entry → `1`). The inner
spaces are REQUIRED (the cell style uses `whiteSpace=wrap`, which only
breaks at spaces) and the integer index keeps the label innocuous —
mirroring the `[[pl:]]` rules above. This box is normally replaced by
the rendered PNG before export (step 6.3), so the token should never
reach the final image; the spaced+indexed form is defense-in-depth for
the case where the embed step fails to run.

**Cell style** (use verbatim while the placeholder is unfulfilled;
identical to `[[pl:]]` styling — the generator still fills `x/y/w/h`,
and the box IS included in collision detection):

```
rounded=0;whiteSpace=wrap;html=1;fillColor=#F0F0F0;strokeColor=#9E9E9E;dashed=1;fontFamily=monospace;fontColor=#616161;fontSize=14;
```

The Python generator emits the box at the same `x/y/w/h` the final
matplotlib PNG will occupy — this geometry is what `intended_dimensions`
must match (modulo the optional `--scale` factor used at export).

**`placeholders_<panel_id>_mpl.jsonl`** — one JSON object per line,
EXACT keys (every key is REQUIRED):

```json
{"id": "1", "kind": "line_plot", "description": "monotonically decreasing training-loss curve over ~100 steps, single dark-blue line, log-y, axis labels 'step' (x) and 'loss' (y); no legend", "script_filename": "mpl_panel1_1.py", "intended_dimensions": {"w": 248, "h": 220}}
{"id": "2", "kind": "histogram", "description": "right-skewed posterior histogram, ~12 bins, soft blue fill, x-axis 'theta', y-axis 'count'", "script_filename": "mpl_panel1_2.py", "intended_dimensions": {"w": 240, "h": 180}}
```

- `id` is the placeholder's 1-based index; it matches `<n>` in the
  box label and the entry's line order in this file. (Geometry slots
  are keyed by the mxCell `id`, independent of this index.)
- `kind` is a hint (any short string).
- `description` is self-contained: name axes, data shape, color,
  count of items.
- `script_filename` is the basename of the Python script the panel
  agent will write into `$WORKDIR/` to render this plot. Convention:
  `mpl_<panel_id>_<id>.py`.
- `intended_dimensions` is `{"w": <int>, "h": <int>}` in pixels — the
  target output size of the PNG, matching the placeholder cell's
  `width` × `height` in the drawio. The script MUST size its figure
  (via `figsize` × `dpi`, or `savefig(..., bbox_inches=None)` with an
  explicit figure size) so the saved PNG comes out at exactly these
  dimensions, within ±2 px tolerance.

Omit the file if the panel has no `[[mp:]]` placeholders. The plan
(step 1) should also list each matplotlib visualization under the
same `Placeholders` bullet (mark each with kind `[[mp:]]` vs `[[pl:]]`)
so the design intent is auditable.

**Lifecycle.** Matplotlib placeholders are filled by step 6 of the
lifecycle below, BEFORE the panel PNG is exported (step 7) — so the
PNG handed to Phase 3 contains the real plots, not gray boxes. The
flow per entry is: (1) write `script_filename`, (2) run it to produce
`$WORKDIR/mpl_<panel_id>_<id>.png`, (3) replace the gray placeholder
cell in `$WORKDIR/<panel_id>.drawio.template` in place with an
image-shape mxCell whose `style` embeds the PNG as a base64 data URI,
then re-run the generator so `<panel_id>.drawio` mirrors the updated
template:

```xml
<mxCell id="<original-cell-id>" value=""
        style="shape=image;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;imageAspect=0;image=data:image/png;base64,<BASE64_BYTES>;"
        vertex="1" parent="1">
  <mxGeometry x="{<original-x-placeholder>}" y="{<original-y-placeholder>}" width="<w>" height="<h>" as="geometry" />
</mxCell>
```

Keep the same `x/y/w/h` (including the existing `{...}` coordinate
slots) the placeholder box had. Use `imageAspect=0` so drawio does
not re-letterbox the PNG inside the cell (the PNG was already
rendered to the cell's aspect). Base64 only uses `A-Z a-z 0-9 + / =`
— it contains no `{`/`}`, so it is safe to inline inside a
`str.format` template; the generator's `template.format(**params)`
will not touch it.

**Phase 3 inspect treatment.** The two kinds of placeholder are
treated asymmetrically by `inspect_panel.py`:

- `[[pl:]]` placeholders (`placeholders_<panel_id>.jsonl`) — still
  gray-dashed boxes at inspect time; the script tells all vision-model
  passes to ignore them. They are filled by the Phase 5 enhancer
  later, not by the panel agents.
- `[[mp:]]` placeholders (`placeholders_<panel_id>_mpl.jsonl`) —
  already realized as embedded PNGs at inspect time. The script does
  NOT mask them; instead it passes each entry's `description` to
  the vision model under a "MATPLOTLIB FIGURES" prompt block, so the rendering
  and truth passes can validate that each plot actually matches what
  it was meant to depict (axes, data shape, color, item counts).

## Lifecycle (steps 1–7)

**File location convention:** every per-panel artifact lives INSIDE
the workdir `$WORKDIR/`. Nothing per-panel lands at the project root.
The PNG goes in the `panels/` subdir. The plan, template, generator,
and editable `.drawio` sit directly in the workdir.

For a panel with id `<panel_id>` and workdir `WD = $WORKDIR`:

1. **Write the design plan** — `WD/<panel_id>.plan.md`. Start the file
   by quoting the panel's `drawio_prompt` verbatim (under a `## Prompt`
   heading) so the panel is regenerable from local artifacts without
   consulting `figure.json`. Then add a short, explicit design plan
   derived from that prompt. Cover: intent (one sentence), in/out
   scope, structural paradigm (top-down flow / left-to-right flow /
   layered / grid / hub-and-spoke / swim lanes / graph), grouping &
   organization (containers, color roles from `style.md`, alignment),
   element inventory (concrete nodes, edges, labels with stable short IDs
   that become mxCell IDs and Python variable names), an **arrow budget**
   (see below), visual hierarchy (what draws the eye first / second /
   third, applying `style.md`'s accent + per-panel emphasis note),
   spatial balance (content fills the panel rectangle — no large empty
   corner or one-sided cluster that wastes the frame), risks (anything
   tight, anything ambiguous), and — under a
   `Placeholders` heading,
   if any — each deferred visualization with its id, kind, token
   prefix (`[[pl:]]` vs `[[mp:]]`), and the description that will be
   written to `placeholders_<panel_id>.jsonl` or
   `placeholders_<panel_id>_mpl.jsonl` (sibling files written
   alongside the panel's other artifacts; matplotlib entries also
   carry `script_filename` and `intended_dimensions` — see the
   "Deferring complex visuals (placeholders)" section above). Keep
   the plan section to ~15–40 lines, bullets over prose.

   **Label budget.** Canvas labels are *names, not explanations* — a
   noun phrase, symbol, or short imperative, never a full sentence. The
   `drawio_prompt`'s text budget should already be label-grade; but if a
   prescribed label reads as a sentence or asserts a mechanism /
   justification (`so …`, `because …`, `to avoid …`), shorten it to a
   name on the canvas and leave the explanation to the figure / panel
   caption — never transcribe a caption sentence, or a phrase lifted
   from `methods.md`, into a node; a box is a named concept, not copied
   method text. Render
   labels otherwise verbatim: trimming an over-long sentence-like label
   to a name is the one expected exception, not a deviation.

   **No figure title.** Never render the figure's title, the paper or
   method *name* as a heading, or the figure / panel caption as a text
   cell inside the panel — the caption lives outside the image, so a
   title banner inside the pixels duplicates it, adds visual noise, and
   wastes vertical space in the paper. In particular, do NOT lift the
   `methods.md` H1 heading (the method name) into a title cell. Section / stage labels that name a phase the panel
   actually depicts (`Training`, `Inference`, `Encoder`) are names, not
   titles, and stay — the ban is on the figure-level title / caption,
   not on labeling a stage.

   **Arrow budget.** Arrows are the single biggest source of Phase 5
   enhancer breakage: each one is another polyline whose direction,
   color, and endpoints the enhancer can mis-redraw, and a thicket of
   arrows (especially crossing arrows) compounds that risk. Plan the
   panel with the fewest arrows that still carry the methodology
   faithfully. Concretely:

   - Under the `Arrow budget` heading, list each intended edge with a
     one-line justification of what it conveys. Short arrows between
     adjacent boxes are cheap and legible — keep them whenever they
     carry a real step of the methodology. Try to minimize the long
     arrows that span the panel — those are the ones that cause trouble
     for the Phase 5 enhancement step.
   - Collapse redundant or near-parallel arrows: if three arrows
     fan out from one source to convey "broadcast", a single arrow into
     a labelled group is usually clearer. If two arrows convey the
     same conceptual step at different abstraction levels, keep the
     one that matches this panel's grain and drop the other.
   - Prefer few crossings: order nodes along the dominant flow axis
     so arrows go forward and route feedback edges around (not
     through) the main flow. When a crossing is the cleaner drawing
     (two edges that swap lanes, a diagonal that would otherwise need
     a long detour), draw it and give the two crossing edges two different
     colors from `style.md`'s secondary edge pool — those colors are
     role-free, so the two members of a same-role pair may differ in
     hue; the label and solid/dashed carry the meaning. The Python
     crossing check only forbids same-color crossings; differently-
     coloured crossings are allowed but each one is another spot the
     Phase 5 enhancer can mis-redraw, so weigh a crossing against the
     detour it saves.

2. **Create `WD/<panel_id>.drawio.template`** — draw.io XML with
   `{placeholder}` slots for every position and size. The template must
   contain ZERO hardcoded coordinates. Only style strings, cell IDs and
   parent references, label content, and edge connection properties
   (source/target/exitX/exitY/entryX/entryY) are hardcoded. Take every
   fill, stroke color, corner radius, and font in those style strings
   from `$WORKDIR/style.md` (the figure-wide palette) — not draw.io's
   default `#dae8fc`/black.

   Before writing, read `references/template_authoring.md` for the
   drawio XML grammar, math-delimiter rules, and the MathJax
   line-break prevention convention.

3. **Create `WD/generate_<panel_id>.py`** — a Python script that
   computes every position from semantic layout parameters, validates
   the geometry over ALL element bounding boxes (including text labels)
   by calling `enforce(...)` from the imported `panel_geometry` library,
   and fills the template. The script MUST abort without writing if any
   check fails. Use `Path(__file__).parent / "..."` for both the
   template read and the `<panel_id>.drawio` write so the script works
   regardless of CWD.

   Start from `assets/generate_panel_template.py` (copy-and-modify
   skeleton). For layout idioms (edge label placement, label-size
   estimates, the `build_params()` contract), see
   `references/python_layout.md`.

4. **Lint the template for math-delimiter rules** (pre-export, must
   pass before step 5):

   ```bash
   # $PYTHON = the absolute interpreter path from your dispatch header.
   "$PYTHON" "$TOOLKIT_DIR/scripts/lint_math.py" \
       $WORKDIR/<panel_id>.drawio.template
   ```

   The linter exits non-zero on violations of the rules from the
   "CRITICAL: preventing MathJax line breaks" section of
   `references/template_authoring.md`:
   (a) math-only labels must use `$$...$$`, not `\(...\)`;
   (b) any cell containing math (`\(...\)` or `$$...$$`) must use
   `whiteSpace=wrap` in its cell style — `whiteSpace=nowrap` is
   broken with MathJax CHTML and causes equations to wrap at every
   operator. Fix the template (or the value passed in via Python
   format) and re-run until the linter passes.

   **Math, sparingly**: reserve MathJax for load-bearing formulas and
   keep other labels plain text — "novelty weight", not
   `\(w_i = s_i \cdot h_i\)`. A figure dense with formulas reads like
   a paper section, not a figure. This is a readability preference,
   not an enforced limit; the linter does not count math cells.

5. **Run the script** — `"$PYTHON" $WORKDIR/generate_<panel_id>.py`
   → produces `$WORKDIR/<panel_id>.drawio`. The script does NOT run
   while EITHER errors or warnings remain:
   - **Errors** (collision, zero-length / collinear waypoint,
     too-short segment, same-color crossing) always abort and are
     never bypassable — fix the geometry.
   - **Warnings** (diagonal segment / missing orthogonal waypoint,
     dangling edge endpoint, low page fill / corner dead-zone) also
     abort, printing a `BLOCKED:` line. Read each one and use your
     judgement: fix a warning that points at a real routing bug (a
     bend you forgot a waypoint for, an endpoint that misses its
     box); for a diagonal segment on an edge you drew on purpose — a
     straight two-point edge between unaligned boxes, a tree branch,
     a fan-out — feel free to bypass it if the diagonal reads fine,
     or add an orthogonal waypoint if you think the bend would
     improve the design. Once every remaining warning is one you are
     happy with, re-run with
     `"$PYTHON" $WORKDIR/generate_<panel_id>.py --bypass-warnings`.
   This panel script is the ONLY place warnings are gated — Phase 4
   (compose) always runs with `--bypass-warnings` (it re-runs
   `build_params()` only to harvest layout numbers, and still aborts
   on errors). So any warning must be resolved or consciously
   bypassed here, at panel-render time.

   **Contract self-test (mandatory).** Once the generator runs clean,
   confirm Phase 4 compose can actually use it — compose imports your
   generator and calls `build_params(bypass_warnings=True)`, then reads
   `page_w`/`page_h`. A valid `.drawio` does not prove either holds.
   Run the exact gate the orchestrator runs after you exit:

   ```bash
   "$PYTHON" "$TOOLKIT_DIR/scripts/check_params_contract.py" \
       $WORKDIR/generate_<panel_id>.py
   ```

   It exits 0 on success; on failure it prints a `CONTRACT:` line
   naming the fix (commonly: `build_params(bypass_warnings: bool =
   False)` must accept that arg — keep the template signature — and
   must return `page_w`/`page_h`). Fix, re-run the generator, and
   repeat until it passes; never report `status: "ok"` while it fails.

6. **Fulfill matplotlib placeholders** — skip entirely if
   `$WORKDIR/placeholders_<panel_id>_mpl.jsonl` is absent or empty.
   Otherwise, for each JSON line in that file, do three things IN
   ORDER (do not reorder; do not interleave entries):

   1. **Write the generator script** at
      `$WORKDIR/<script_filename>` (`<script_filename>` is the value
      from the JSONL entry). Start from
      `assets/mpl_panel_template.py` (copy-and-modify skeleton —
      already wires up the Agg backend, LaTeX rendering, the
      figsize/DPI idiom, and a schematic-by-default rcParams block
      with axes/ticks/spines hidden). The script must:
      - Use `matplotlib` with `Agg` backend (no GUI / no `plt.show()`).
      - Compute its own data (numpy or stdlib only — no external
        datasets) consistent with the entry's `description`.
      - Size the figure so the saved PNG comes out at EXACTLY
        `intended_dimensions.w × intended_dimensions.h` pixels
        (±2 px). The standard idiom is
        `fig = plt.figure(figsize=(w/dpi, h/dpi), dpi=dpi)` with a
        chosen `dpi` (e.g. 100), then `fig.savefig(out, dpi=dpi,
        bbox_inches=None, pad_inches=0)`. Do NOT use
        `bbox_inches="tight"` — it changes the output dimensions.
      - Write the PNG to `$WORKDIR/mpl_<panel_id>_<id>.png` using an
        absolute path derived from `Path(__file__).parent`.
      - Be self-contained and runnable as
        `"$PYTHON" $WORKDIR/<script_filename>`.

   2. **Run the script** in the foreground:

      ```bash
      "$PYTHON" $WORKDIR/<script_filename>
      ```

      Verify the produced PNG's pixel dimensions match
      `intended_dimensions` within ±2 px (e.g. via
      `"$PYTHON" -c "from PIL import Image; print(Image.open('...').size)"`).
      If it's off, fix the script's `figsize` / `dpi` and re-run —
      do not proceed to step 6.3 with a wrong-size PNG.

   3. **Embed the PNG into the panel template** —
      `$WORKDIR/<panel_id>.drawio.template`, NOT just the rendered
      `<panel_id>.drawio`. Phase 4 composition reads the template
      (not the rendered file), so an image embedded only in the
      rendered file is silently dropped from the composite. Locate
      the gray placeholder mxCell whose `value` is the literal
      `[[ mp <panel_id> <n> ]]` token, and replace it in-place with an
      image-shape mxCell that keeps the SAME `id`, the SAME `parent`,
      and the SAME `<mxGeometry x y width height>` — including any
      existing `{...}` coordinate placeholders. Read the PNG bytes,
      base64-encode them, and embed via a
      `data:image/png;base64,<...>` URI in the `image=` style token:

      ```xml
      <mxCell id="<original-cell-id>" value=""
              style="shape=image;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;imageAspect=0;image=data:image/png;base64,<BASE64_BYTES>;"
              vertex="1" parent="1">
        <mxGeometry x="{<original-x-placeholder>}" y="{<original-y-placeholder>}" width="<w>" height="<h>" as="geometry" />
      </mxCell>
      ```

      Base64 contains only `A-Z a-z 0-9 + / =` — no `{`/`}` — so it
      is safe to inline inside a `str.format` template; the
      generator's `template.format(**params)` will leave the image
      bytes untouched, and Phase 4 compose's placeholder/ID prefixing
      will not touch them either. Use `imageAspect=0` so drawio does
      not re-letterbox the image inside the cell (the PNG already
      matches the cell's aspect via step 6.2). Do NOT change
      `x/y/w/h` — collision detection already validated those.

      After editing the template, re-run the generator
      (`"$PYTHON" $WORKDIR/generate_<panel_id>.py`) so
      `$WORKDIR/<panel_id>.drawio` mirrors the updated template.

   Note: `[[pl:]]` placeholders (gpt-image-2) are NOT touched here —
   they stay as gray boxes for the Phase 5 enhancer.

7. **Export to PNG** via the draw.io desktop CLI, into the workdir's
   `panels/` subdir (CLI paths and flags in `references/drawio_cli.md`):

   ```bash
   node "$TOOLKIT_DIR/dist/cli.js" export \
       $WORKDIR/<panel_id>.drawio \
       $WORKDIR/panels/<panel_id>.png \
       --export-scale 2
   ```

   Use this hardened exporter — NOT a raw `drawio -x` invocation.
   drawio's headless export intermittently wedges on math-bearing
   files (unhandled `UnknownVizError`; the process idles forever
   without writing the PNG); the exporter fast-fails a direct
   attempt, then falls back to an SVG export rasterized by headless
   Chrome, all in the foreground within ~2 minutes. It exits 0 and
   prints `wrote <png>` on success; non-zero is a hard failure.

   This is the deliverable for Phase 2. Stop here — visual inspection
   and repair are Phase 3's job (see
   `references/panel_inspect_agent.md`).

## Cross-references

- `references/panel_inspect_agent.md` — Phase 3 inspect / repair /
  unit-test-inspections contract that operates on this agent's output.
- `references/template_authoring.md` — drawio XML grammar, math
  delimiters, MathJax line-break rules, XML well-formedness.
- `references/python_layout.md` — Python skeleton, edge-label
  positioning, label-size estimates.
- `references/drawio_cli.md` — CLI paths and export flags.
- `assets/generate_panel_template.py` — the copy-and-modify Python
  skeleton for the panel's `generate_<panel_id>.py`.
- `assets/panel_geometry.py` — the shared, fixed geometry-validation
  library (Rect / EdgePath + all checks + `enforce`) that every
  generator imports; staged into the workdir, never edited per panel.
- `assets/mpl_panel_template.py` — the copy-and-modify skeleton for
  each per-placeholder `mpl_<panel_id>_<id>.py` (LaTeX-on,
  schematic-by-default styling, correct figsize/DPI idiom).
- `scripts/lint_math.py` — the deterministic template linter used in
  step 4.
