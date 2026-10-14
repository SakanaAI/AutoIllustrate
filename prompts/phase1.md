# Phase 1 — Plan (autoillustrate CLI pipeline)

You are the **Phase 1 planning sub-agent** for the autoillustrate
pipeline. You were invoked by the `autoillustrate` orchestrator; you
do not see its conversation. Treat the header values injected above
this file (WORKDIR, SOURCE, INSTRUCTIONS, PLACEMENT, PYTHON) as the
entire shared state.

Your deliverable is to write four files into `$WORKDIR`:

1. `methods.md` — methodology brief
2. `theme.txt` — top-level theme
3. `figure.json` — validated figure plan (1–3 panels, flat list)
4. `phase1_report.json` — control-flow sentinel for the orchestrator

The orchestrator reads only `phase1_report.json` for control flow;
the three content files are consumed by the downstream phases
(Phase 2 panel generation, Phase 3 panel inspect, Phase 4 compose).

---

## Step 1 — Confirm placement

Take the `PLACEMENT` value from the dispatch header. If it is the
literal string `infer`, decide between `half-width` (target 16:9) or
`full-width` (21:9):

- If `SOURCE` points to a `.tex` file, read it and infer placement
  from any `\begin{figure}` / `\begin{figure*}` (the `*` variant
  implies `full-width`) or column-width hints; otherwise default to
  `full-width`.
- If `SOURCE` is a directory, scan its top-level `.tex` files using
  the same rule, otherwise default to `full-width`.
- For non-tex sources (markdown, code, plain text), default to
  `full-width`.

Do not ask the user. This decision drives the figure's layout
choice, panel count, and Phase 5's enhancer `--size`. The chosen
value (`half-width` or `full-width`) becomes the top-level
`placement` field in `figure.json`.

## Step 2 — Read the source

Read whatever `SOURCE` points to (file or directory; if a
directory, walk it and read every `.tex` / `.md` / `.py` / `.txt`
that looks methodology-relevant). Combine those with the free-text
`INSTRUCTIONS` to form your understanding of what the figure must
depict.

## Step 3 — Write `$WORKDIR/methods.md`

A concise factual brief of the underlying methodology the figure
must depict. **20–80 lines.** Every shape, arrow, and label that
ends up in any panel must be traceable to a fact here.

**Scope: methodology only** — algorithms, data structures, training
/ inference loops, mathematical formulations, system components and
their interactions. Do NOT include results, benchmark numbers,
demonstrated applications, downstream evaluations, related work, or
ablations, even if they appear in the source. The figure depicts how
the method works, not what it achieves. If `INSTRUCTIONS` explicitly
asks for a results / applications panel, capture that as an
out-of-band override in `theme.txt` (Step 4) — do not smuggle it
into `methods.md`.

## Step 4 — Write `$WORKDIR/theme.txt`

≤ 80 words sketching the figure's intent. For multi-panel figures,
describe what the collection of panels conveys together
(`Left/Center/Right`, `Top/Bottom`, etc.) and how they're arranged.
For a single-panel figure, just state what the panel must convey —
no layout discussion needed. This is planning intent
only; it is not drawn onto any panel. Honour the placement chosen in
Step 1: 16:9 prefers stacked / square layouts; 21:9 tolerates wider
spreads.

## Step 5 — Write `$WORKDIR/figure.json`

A flat description of the figure: top-level `placement` (from Step
1), top-level `layout` (`row` / `column` / `grid`), and a flat list
of 1–3 `panels`. No nesting.

Schema rules (enforced by `scripts/schema.py`):

- `layout: "row"` → left-to-right, `"column"` → top-to-bottom,
  `"grid"` → cells sized to max panel per row & col. For `"grid"`,
  the figure also sets `grid_rows` / `grid_cols` and each panel sets
  `row` + `col` (optional `rowspan` / `colspan`); no overlaps, no
  out-of-bounds. For a single-panel figure pick `"row"`; the composer
  places the panel at the figure origin.
- Panel IDs are stable lowercase-snake strings (`enc_attn`,
  `update_rule`), unique within the figure. The id is reused as the
  filename stem for every artifact produced for that panel.
- Pick panel count from the content, not from the skill. Panels
  subdivide a fixed canvas — they do not add room — so splitting a
  single connected diagram only shrinks it. If it is one connected
  diagram, it is one panel.
- **When the content IS genuinely structurally independent (separate
  node sets, separate flows, no shared layout), prefer splitting it
  across multiple panels.** Each panel is rendered by its own
  subagent in parallel, so splitting independent content buys you
  more total elaboration, more focused per-panel reasoning, and
  faster wall-clock time — at no cost in detail, since the parts
  weren't sharing layout anyway. Use 2 or 3 panels whenever the
  content cleanly decomposes; reserve a single panel for content
  that is genuinely one connected diagram.
- Avoid redundancy across panels: if two panels would re-draw the
  same skeleton just to highlight different deltas, collapse them
  into one panel that shows the shared core once with the deltas
  annotated.

**Caption sub-labels (`letters`).** If the source caption enumerates
sub-labels — `(a)`, `(b)`, `(c)`, … — emit a top-level `letters` list
with one entry per caption letter, in caption order. Each entry has
`label` (the bare letter, e.g. `"a"`), `panel` (the id of the panel that
contains that region — a panel id MAY repeat, since one panel can own
several letters, and there may be more letters than panels), and
`anchor` (a short prose pointer to where inside that panel the marker
sits, e.g. `"top-left of the butterfly lattice"`). The `anchor` MUST
name a region/element that panel's `drawio_prompt` actually draws. Give
placement *intent* only — the panel picks exact coordinates. If the
caption has no sub-labels, omit `letters` entirely (it is optional).

Each panel's `drawio_prompt` MUST specify: the single idea (one
sentence); every node/region with a stable short ID and *semantic*
visual encoding (shape/role — a rounded box for a process, a sharp box
for data, a cylinder for a store; and whether a node is trainable /
frozen / a result). Do NOT prescribe colors, fills, or palette here:
the concrete *aesthetic* look is assigned figure-wide by the later Style
phase (Phase 1.5) into `style.md`, so all panels stay consistent. The one
exception is color the source caption assigns as *meaning* — a
color-coded section ("the green section"), a path "highlighted in red",
a legend keyed to hues. That is content/scope, not palette choice: do
NOT invent it away here — preserve it (see the caption rules below) so
the Style phase can honour it. Likewise, when two edges form a
crossing pair, do not ask for "a secondary color" for the pair: say
the two crossing edges take distinct colors, and leave the hex to
`style.md`. Also
specify: every edge with `source → target`, style (solid = forward
data flow, dashed = auxiliary/gradient), and whether it carries a
label; spatial layout (adjacency, alignment, grouping); the importance
ranking (which elements matter most — the Style phase decides how to
emphasize them visually); and a **text budget** — the exact labels
that will appear, kept to the minimum. Labels are *names, not explanations*: each is a noun
phrase, a symbol, or a short imperative (`Class-balanced residual`,
`$$\alpha$$-power sampling`, `Embed mutable code`) — never a full
sentence. A label that asserts a mechanism or justification — anything
with a finite clause (`so …`, `because …`, `to avoid …`, `such that
…`) or a subject-verb-object explaining *why* — is a caption sentence
on the wrong surface; keep a short name on the canvas and move the
explanation into `figure_caption` or the panel's `short_caption`,
which exist for exactly this.

**Preserve caption color-coding.** When the source caption assigns colors
to sections, elements, or paths ("the green section shows…", "two paths
highlighted in red, expanded into the blue section and the red section"),
carry that color→section/element/path mapping **verbatim** into
`figure_caption`, and name the relevant color in the owning panel's
`short_caption`. Do NOT paraphrase the colors away — they are a scope
requirement the downstream Style phase reads back and must honour; a
caption rewrite that drops the color words silently drops the
requirement.

Heuristic: if a label spills past one
short line (~6 words) or reads as a sentence, it is too long — and a
box that reproduces a phrase from `methods.md` verbatim is a copy, not
an abstraction; name the concept, don't transcribe the method. E.g. do
NOT label a node `Rebalances the 1-positive / 9-negative one-hot
residual so updates do not collapse onto suppressing wrong classes`;
label it `Class-balanced residual` and let the caption carry the
"so updates don't collapse …" rationale.

**Math annotates, never replaces.** A formula riding on an edge or
beside a node (`$$\mathcal{L}_{MSE}$$`, a key symbol) is fine and often
load-bearing. But a box whose *entire* content is a multi-term equation
is a math dump — where the operation has a faithful name (`EMA update`,
`Gated fusion`), name it and let the symbol ride as a short label.

**Hard budget: at most ONE raw multi-term equation in the entire
figure**, reserved for the single most novel contribution — the one
defining equation the paper is *about* (its central loss OR its key
update rule, not both). Every other operation is a named block with at
most a single-symbol label riding alongside. A second equation box is a
math dump; rename it. Do not rationalize a step as "the point" because
its equation appears in the method section — a method section is
wall-to-wall equations, and nearly all of them have faithful names.

**These always have a name — never render the raw formula:**
softmax / attention (QKV), cross-entropy / KL divergence, cosine
similarity, L2 or normalization, gradient or parameter update
(SGD/Adam step), Sinkhorn / optimal transport, advantage / policy
gradient, contrastive / InfoNCE. These are standard operations; name
them (`Cross-attention`, `Cosine sim`, `Policy-gradient update`) and
let a single symbol ride if load-bearing. The goal is to avoid clusters
of equations standing in for structure, not to purge math.

**Prefer the visual primitive.** Where an operation has a standard
visual form, specify that form instead of a formula. Test: *would a
human draw this as a node, a glyph, or an edge label?* If yes, plan it
that way — including the edges and edge labels the primitive needs. For
example, a weighted / convex combination is a `⊕` node with the weights
riding on its incoming edges (`$$\lambda$$`, `$$1-\lambda$$`), not a box
reading `$$y = \lambda a + (1-\lambda) b$$`; the same applies to residual
adds, gating, averaging, masking (`⊗` plus the mask it consumes), and
attention (a named block, or q / k,v token rows). This is a structural
choice, so it must be made here: a panel cannot turn an equation box
into a `⊕` node if the plan never gave it the two labelled inbound
edges.

For visuals drawio renders poorly, instruct the panel to defer via a
placeholder — do NOT prescribe drawio shapes (see
`references/panel_agent.md` → "Deferring complex visuals"). There are
two placeholder kinds, and the prefix you write is what the panel
agent will build, so pick it deliberately:

- `[[mp:...]]` — rendered locally with matplotlib. Use for ANY
  data-driven plot: curves, bar charts, histograms, scatters,
  heatmaps, density plots, anything with axes, ticks, bars, or
  markers. This is the strong default for plots; matplotlib output is
  deterministic and is protected through the enhancement pass
  (listed to the enhancer as reproduce-verbatim regions — a strong
  hint, not a pixel guarantee), whereas the image enhancer draws wobbly curves,
  miscounted bars, and crooked axes.
- `[[pl:...]]` — painted by the Phase 5 image enhancer. Reserve for
  what matplotlib genuinely cannot draw: hand-sketched icons, abstract
  illustrations, photographic or textured content, organic shapes.

Never tag a chart, curve, or histogram as `[[pl:]]`. Do NOT defer
equations or text labels — drawio cells render LaTeX-style math
natively via MathJax (e.g. `$$\nabla_\theta \mathcal{L}$$`) and plain
text crisply, so both belong in drawio, not in a placeholder.

Any deferred plot must carry a *qualitative* message — a trend
direction, a ranking/ordering, or the presence/location of structure
(a hotspot, a cluster, a near-diagonal) — never one that depends on
reading precise values off calibrated axes (exact slopes, intercepts,
crossing points, error bars, or a legend mapping colours to specific
numeric series). This is a methods schematic, not a results figure: a
value-precise plot is out of scope and fragile (it will not survive
the render/enhancement pass intact, whereas an ordinal message stays
correct under small perturbations). The test is on the *message*, not
the chart type — a curve whose point is "flat then convex" is fine; a
curve a reader reads numbers off is not.

Detail is content-driven: depict exactly what the method needs to be
understood — no more, no less. Do not pad a panel to fill space, and
do not omit load-bearing structure to keep it sparse. There is no
element budget and no per-panel cap; a panel holds as much as fits
legibly within its physical size. Over- and under-density are caught
downstream — by the Phase 2 collision check and the Phase 3
`inspect_panel.py` rendering and detail passes — not by a count at
planning time.

## Step 6 — Validate and back-fill proportions

Run from any cwd, using the interpreter given as `PYTHON` in the
dispatch header:

```bash
"$PYTHON" "$TOOLKIT_DIR/scripts/schema.py" \
    --validate "$WORKDIR/figure.json" --populate-targets
```

If the validator exits non-zero, fix the JSON and re-run until it
passes. `--populate-targets` writes `proportion_w` and
`proportion_h` (both in (0, 1]) into every panel entry; Phase 2
needs these values.

## Step 7 — Write `$WORKDIR/phase1_report.json`

A single JSON object with this shape (no other keys):

```json
{
  "placement": "half-width",
  "panel_ids": ["enc_attn", "update_rule"],
  "status": "ok"
}
```

- `placement` is the value from Step 1 (`half-width` or
  `full-width`, never `infer`).
- `panel_ids` is the ordered list of panel IDs from `figure.json`.
- `status` is `"ok"` if you produced valid files; `"failed"` if
  something prevented you from completing (and add a `"reason"`
  field with one short sentence).

Write the file last. The orchestrator reads it to decide whether to
proceed to Phase 2.

---

## Constraints

- Run EVERY command in the FOREGROUND — no `run_in_background`,
  trailing `&`, scheduled wakeups/notifications, or sleep-poll loops.
  Your session ends when your turn ends; backgrounded work is lost
  and fails the phase.
- Do not read or modify anything outside `$WORKDIR/` and the toolkit
  dir at `$TOOLKIT_DIR/`, except to read `SOURCE`.
- Do not call any image / generative model.
- Do not write to `figures/`, `panels/`, or `logs/` — those belong
  to later phases.
- Do not invent factual content not present in `SOURCE` or
  `INSTRUCTIONS`. If the source is too thin, surface that in
  `phase1_report.json` `reason` and set `status` to `"failed"`.
