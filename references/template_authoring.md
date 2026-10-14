# Template authoring — drawio XML, math delimiters, MathJax line-break rules

Read this file before writing any `<panel_id>.drawio.template` (Phase 2)
or modifying the composite template. It bundles the drawio XML grammar
this toolkit relies on, the math-delimiter rules, the MathJax line-break
prevention convention (the single most common defect in these figures),
and XML well-formedness rules.

## Template format

The `.drawio.template` uses Python `str.format()` syntax. Curly braces
in LaTeX must be doubled for escaping.

### Basic structure

```xml
<mxGraphModel math="1" adaptiveColors="auto" ...
              pageWidth="{page_w}" pageHeight="{page_h}">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>

    <mxCell id="mynode" value="$$\mathbf{{x}}^{{(l)}}$$"
            style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;..."
            vertex="1" parent="1">
      <mxGeometry x="{mynode_x}" y="{mynode_y}"
                  width="{node_w}" height="{node_h}" as="geometry"/>
    </mxCell>

    <mxCell id="myedge" style="endArrow=block;endFill=1;strokeWidth=3;..."
            edge="1" source="srcnode" target="tgtnode" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>

    <mxCell id="myedge_label" value="$$W_{{pp}}$$"
            style="text;html=1;align=center;verticalAlign=middle;fontSize=14;..."
            vertex="1" parent="1">
      <mxGeometry x="{myedge_label_x}" y="{myedge_label_y}"
                  width="{label_w}" height="{label_h}" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>
```

Key points:
- `math="1"` on mxGraphModel enables LaTeX rendering via MathJax.
- **Display math** (block, centered on its own line): wrap in `$$...$$`.
- **Inline math** (mixed with surrounding HTML/text in the same label):
  wrap in `\( ... \)` — **never** use single `$...$` in draw.io, as
  MathJax's inline `$...$` is disabled by default and the expression
  will render as literal text. Use `\(` / `\)` whenever math appears
  alongside HTML like `<b>`, `<br>`, or plain words in the same `value`
  attribute.
- Double all `{` `}` inside LaTeX for Python `str.format()` escaping:
  `\mathbf{{x}}`, `\phi_{{\alpha_i}}`.
- Edge labels are regular `text` cells with explicit geometry — NOT
  `edgeLabel` cells parented to edges.
- Every edge must have `<mxGeometry relative="1" as="geometry">` —
  with a `<Array as="points">…</Array>` child if it has any waypoints
  (see "Edges — explicit waypoints, Python-owned colors" below).

### Edges — explicit waypoints, Python-owned colors

Every routed edge is owned by the Python script's `build_paths()` and
validated by `check_orthogonal_waypoints` + `check_path_crossings`
(see `references/python_layout.md`). For the rendered diagram to match
what was checked, the template MUST:

1. **Forbid `orthogonalEdgeStyle` (and any auto-routing edgeStyle).**
   Auto-routing diverges from the Python-checked polyline. Either omit
   `edgeStyle` entirely or set `edgeStyle=none`. `lint_math.py` rejects
   any mxCell whose style contains `edgeStyle=orthogonalEdgeStyle`.

2. **Declare every waypoint inline** via
   `<mxGeometry><Array as="points">…</Array></mxGeometry>` using
   `{placeholder}` slots filled from the INTERIOR points
   (`EdgePath.points[1..-2]`). A straight edge with no waypoints needs no
   `<Array>`.

3. **Own both endpoints from Python on waypointed edges.** If the
   edge has any interior waypoint, the template MUST also emit
   `<mxPoint x="{…}" y="{…}" as="sourcePoint"/>` (filled from
   `EdgePath.points[0]`) and `<mxPoint x="{…}" y="{…}" as="targetPoint"/>`
   (filled from `EdgePath.points[-1]`) as children of `<mxGeometry>`, and
   MUST NOT carry `source="…"`, `target="…"`, `exitX`, `exitY`,
   `entryX`, or `entryY`. Those let drawio derive the endpoints from
   the connected shapes — independent of Python — so the polyline
   drawn diverges from the one `check_orthogonal_waypoints` /
   `check_path_crossings` validated. Straight edges (no waypoints)
   may keep `source=`/`target=`.

4. **Use a `{placeholder}` for `strokeColor`**, filled from
   `EdgePath.color`. Hardcoded `strokeColor=#…` on an edge is forbidden:
   the crossing check needs Python to be the sole source of truth for
   color. `lint_math.py` rejects hardcoded edge stroke colors.

5. **Stroke weight.** Every edge uses `strokeWidth=3` — 3pt arrows
   read clearly once the figure is scaled into a paper column; thinner
   strokes wash out.

6. **Dash pattern.** Every dashed edge MUST pin its dash pattern
   explicitly with `dashed=1;dashPattern=4 2;`. Never rely on drawio's
   default dash spacing — `dashPattern=4 2` is mandatory on every
   dashed arrow so all dashed edges render identically. Solid edges
   carry neither `dashed` nor `dashPattern`.

**Coordinate-name convention** (REQUIRED for the composer to work).
Every polyline coordinate placeholder must end in `_x<int>` / `_y<int>`,
indexed by position in the full polyline:

- `points[0]`  → `{<name>_x0}` / `{<name>_y0}` (sourcePoint)
- `points[i]`  → `{<name>_x<i>}` / `{<name>_y<i>}` (interior waypoint i)
- `points[-1]` → `{<name>_x<N>}` / `{<name>_y<N>}` where N = `len(points)-1`
  (targetPoint)

The Phase 4 composer offsets every param key matching `_x\d*$` /
`_y\d*$` by the panel origin. Names like `{e_sx}` / `{e_tx}` do NOT
match that pattern, so source/target endpoints would stay in
panel-local space while the rest of the polyline shifts to composite
space — producing a snapped, misplaced arrow. `lint_math.py` rule (h)
rejects sourcePoint/targetPoint placeholders that don't end in
`_x<digits>` / `_y<digits>`.

Example — a routed edge with two interior waypoints, so the full
polyline has 4 points (indices 0..3). Python emits `e_color`,
`e_x0/y0`, `e_x1/y1`, `e_x2/y2`, `e_x3/y3`:

```xml
<mxCell id="path_e"
        style="endArrow=block;endFill=1;strokeColor={e_color};strokeWidth=3;"
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

A straight edge with zero waypoints (allowed to keep `source=`/`target=`):

```xml
<mxCell id="path_s"
        style="endArrow=block;endFill=1;strokeColor={s_color};strokeWidth=3;"
        edge="1" source="src" target="tgt" parent="1">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

### Inline vs display math — quick reference

| Context | Delimiter | Example |
|---------|-----------|---------|
| Label contains ONLY math | `$$...$$` | `value="$$\mathbf{{p}}^{{(l)}}$$"` |
| Math embedded in HTML/text | `\(...\)` (cell style must use `whiteSpace=wrap`) | `value="&lt;b&gt;Output&lt;/b&gt; \(\hat{{y}} \in \mathbb{{R}}^C\)"` |
| Multi-line aligned equation | `$$\begin{{aligned}}...\end{{aligned}}$$` | block only |

If an expression renders as literal `$x$` or shows raw backslashes in
the PNG, the delimiter is wrong — switch inline math to `\(...\)`.

### Always use LaTeX for variable names and formulae (NOT HTML)

Every mathematical symbol — including bare variable names like
`a_pre`, `e_j`, `\phi'_i`, `W_{pp}` — must be rendered via LaTeX
(`$$...$$` or `\(...\)`-in-nowrap-span), **never** via HTML markup like
`<b>a<sub>pre</sub></b>` or `<i>e</i><sub>j</sub>`. Mixing the two
produces visually inconsistent typography across a single panel:
the LaTeX-rendered equations use MathJax's serif italic math font,
while HTML `<sub>`/`<i>`/`<b>` falls back to the cell's plain
sans-serif font — readers immediately notice the mismatch.

Concretely, for a factor annotation like "presynaptic activity" tagged
with the symbol `a_pre`, write the value as:

```
\(\mathbf{{a}}_{{\text{{pre}}}}\): presynaptic activity
```

(The cell's `style` must use `whiteSpace=wrap;overflow=visible;` — see
the next section.) NOT:

```
&lt;b&gt;a&lt;sub&gt;pre&lt;/sub&gt;&lt;/b&gt;: presynaptic activity
```

The same rule applies to legend rows, captions, panel sub-titles, and
edge labels: any symbol that appears anywhere else in the panel as
LaTeX must also be LaTeX here. Only purely descriptive prose (words
like "presynaptic activity", "conv layers", "rebalances 1 positive
vs 9 negative entries") may be plain HTML/text.

### CRITICAL: preventing MathJax line breaks in equations

drawio ships MathJax with `linebreaks: {{ automatic: true }}` globally
enabled. Without defensive handling, any equation containing a relation
or binary operator (`=`, `+`, `-`, `\cdot`, `\propto`, `\leq`, `\geq`,
`<`, `>`, etc.) will wrap at that operator — frequently producing a
one-token-per-line visual mess in the exported PNG.

The safe, tested convention is:

1. **Mandatory cell style for any cell containing math: use
   `whiteSpace=wrap;overflow=visible;`.** Counter-intuitively,
   `whiteSpace=nowrap` is *broken* with MathJax CHTML in drawio: the
   renderer leaves the inner div at `width:auto` inside a foreignObject
   whose layout shrink-fits to each `mjx-container` (each MathJax atom
   is `display:inline-block`), so the equation breaks at every space —
   i.e. at every `=`, `+`, `-`, `\cdot`, etc. — even though the cell
   says "nowrap". `whiteSpace=wrap` instead sets an explicit
   `width:<geometry>px` on the inner div, giving MathJax a stable
   inline formatting context where atoms flow on one line as long as
   they fit. This was verified empirically on 8 style combinations
   (cell `whiteSpace` × inner span CSS): only the cell `whiteSpace`
   matters; the inner span is irrelevant.
   - Therefore: **make the cell wide enough to fit the equation on one
     line**, since `whiteSpace=wrap` will wrap a too-narrow cell at
     operators just as the buggy `nowrap` path does.
   - **Do not** wrap inline math in a
     `<span style="white-space:nowrap;display:inline-block">…</span>`.
     The span has no effect (MathJax replaces the span's contents with
     its own DOM, severing the CSS link), it clutters the value, and
     it is fragile to drawio's editor round-tripping.
   - `overflow=visible` lets the rendered math extend past the cell
     box if it slightly exceeds the planned width, rather than
     clipping.

2. **Math-only labels → always use `$$...$$`.** Display math is
   rendered as a single atomic block and is not fragmented by the
   `linebreaks` extension at all (independent of cell `whiteSpace`),
   but you should still set `whiteSpace=wrap;overflow=visible;` on the
   cell for consistency.
   - Example: `value="$$\Delta W \propto -\eta \cdot \mathbf{{a}}_{{\text{{pre}}}} \cdot \phi'(z_{{\text{{post}}}}) \cdot e_j$$"`

3. **Math mixed with HTML/text → use `\(...\)` directly.** No span
   wrapper needed:
   ```xml
   value="Split input \(\mathbf{{p}}_0 = \mathrm{{ReLU}}(\mathbf{{x}})\)"
   ```
   ```xml
   value="Wider sigmoids (\(\alpha = 3\) conv, \(\alpha = 6\) FC) keep gradients alive"
   ```
   Single-line behaviour comes from the cell-level
   `whiteSpace=wrap;overflow=visible;` style plus a wide-enough cell
   geometry, NOT from any inner span.

4. **Never try to "protect" operators with `{{=}}` / `{{:}}` /
   `{{\propto}}` / `\;` / `\,` inside the math.** Empirically, adding
   brace groups or explicit spacings INCREASES the number of MathJax
   atom boundaries and produces more breaks, not fewer. Write
   equations in their natural form (`e_j = y_j - \hat{{y}}_j`,
   `\alpha = 3`, `W_{{\text{{exc}}}} : W_{{\text{{inh}}}} = 1.5 : 0.5`).
   `lint_math.py` flags `{{=}}` / `{{:}}` / `{{<}}` / `{{>}}` /
   `{{\propto}}` / `{{\leq}}` / `{{\geq}}` style brace-wraps inside
   `\(...\)`.

5. **Don't use single `$...$` delimiters.** MathJax's single-dollar
   inline is disabled by default in drawio.

Verify in the exported PNG that every equation sits on exactly one
visual line. If an equation still wraps, first check the cell style
contains `whiteSpace=wrap` (NOT `nowrap`), then widen the enclosing
cell.

## CRITICAL: XML well-formedness

- **NEVER include XML comments (`<!-- -->`)** — they waste tokens and
  can cause parse errors.
- Escape special characters in attribute values: `&amp;`, `&lt;`,
  `&gt;`, `&quot;`.
- Always use unique `id` values for each `mxCell`.
- Every edge mxCell must contain `<mxGeometry relative="1" as="geometry" />`
  as a child.
