# Panel inspect agent — per-panel inspect + repair lifecycle

This file is the full instruction set for a single-panel **inspect /
repair** subagent dispatched by the orchestrator at Phase 3. The
dispatcher forks one of these per panel; panels remain independent
until composition (Phase 4), so dispatch them in parallel.

This agent picks up where the Phase 2 generation agent left off — the
panel's `.plan.md`, `.drawio.template`, `generate_<panel_id>.py`,
`.drawio`, and `panels/<panel_id>.png` already exist on disk. The
inspect agent's job is to:

1. Run `scripts/inspect_panel.py` on the rendered PNG.
2. Repair any defects by editing the template / generator and
   re-running the build steps from `references/panel_agent.md`
   (lint → generate → re-embed mpl → export).
3. Once the panel passes inspect (or exhausts its budget), write the
   panel's `unit_test_inspections_<panel_id>.jsonl` file.

It is the only role permitted to overwrite the Phase 2 deliverables
(`.drawio.template`, `generate_<panel_id>.py`, `<panel_id>.drawio`,
`panels/<panel_id>.png`) for that panel; downstream phases treat the
artifacts as immutable.

## Inputs (from the orchestrator)

The dispatcher passes the inspect agent these handles:

- `panel_id` — the stable lowercase-snake id from `figure.json`.
- `$WORKDIR` — the per-run absolute directory.
- All Phase 2 panel artifacts on disk for this `<panel_id>`:
  - `$WORKDIR/<panel_id>.plan.md`
  - `$WORKDIR/<panel_id>.drawio.template`
  - `$WORKDIR/generate_<panel_id>.py`
  - `$WORKDIR/<panel_id>.drawio`
  - `$WORKDIR/panels/<panel_id>.png`
  - `$WORKDIR/placeholders_<panel_id>.jsonl` (optional)
  - `$WORKDIR/placeholders_<panel_id>_mpl.jsonl` (optional, with its
    sibling `mpl_<panel_id>_<id>.py` scripts and `.png` outputs)
- The shared planning files:
  - `$WORKDIR/figure.json`
  - `$WORKDIR/methods.md`
  - `$WORKDIR/theme.txt`

## Output contract (back to the orchestrator)

A panel is "inspected" when the workdir contains, for this
`<panel_id>`:

- `panels/<panel_id>.inspect.json` — the most recent inspect verdict,
  ideally with an empty `issues` list. If the attempt budget (the
  inspect-attempts value on your dispatch header's `BUDGET:` line,
  default 5) is exhausted, this is the last verdict that ran.
- `panels/<panel_id>.attempt-<N>.png` and
  `panels/<panel_id>.inspect.attempt-<N>.json` for every attempt run
  (`<N>` = 1 .. attempts_used) — the archive of the repair trace.
- `unit_test_inspections_<panel_id>.jsonl` — a panel-scoped set of
  atomic yes/no probes that the Phase 6 verifier replays against the
  enhanced composite to detect regressions introduced by the
  gpt-image-2 enhancement pass (see step 3 below). The file has a
  **mandatory arrows core** — every arrow of the panel is exhaustively
  probed for its MEANING: what it connects, which way it flows, and
  what its label says — plus an **optional extras section** where the
  agent may add high-value probes about other load-bearing,
  enhancement-fragile facts (e.g. that a grouping rectangle still
  encloses exactly the expected elements). Every probe — core or
  extra — tests meaning, never how an element is drawn.

After repair, the panel's template / generator / `.drawio` /
`panels/<panel_id>.png` may have been overwritten. That is intended:
the inspected PNG is the panel's final deliverable to Phase 4.

## CRITICAL RULES (invariants — never violate)

### Foreground commands only, absolute paths only

Run **every** command in the foreground. Do NOT use `run_in_background`,
a trailing `&`, or `until`/`while` + `sleep` poll loops. Every script in
this toolkit (`inspect_panel.py`, `lint_math.py`, the `drawio` CLI, ...)
is synchronous — invoke it and read its result directly. A background
task left running keeps the `claude -p` sub-agent process alive, which
hangs the orchestrator until its watchdog force-kills the run.

Reference every file by **absolute path** — the orchestrator passes
`$WORKDIR` as an absolute path; build all paths from it. Never use a
path relative to the project root and never assume the shell's cwd.

### Visual inspection is mandatory (delegated to `inspect_panel.py`)

You MUST run `scripts/inspect_panel.py` against the panel — do NOT
read the PNG yourself. Claude Code's vision is unreliable on these
screenshots: it misses obvious overlaps and hallucinates problems
that are not there. The script delegates the check to a vision model
and runs THREE passes against the rendered PNG, then merges their
issues into one verdict (`has_defects`, list of issues with
`location`, `element`, `description`, `severity`, and a
`check: "rendering" | "truth" | "detail"` discriminator):

- **Rendering pass** — the panel's spec (`<panel_id>.plan.md`) is
  ground truth; flags visual defects in the deterministic draw.io
  export.
- **Truth pass** — `methods.md` is ground truth (scoped by the
  panel's plan); flags content errors within the panel's slice.
- **Detail pass** — `methods.md` is ground truth (scoped by the
  panel's plan); answers the single question "is there enough detail
  in this panel to understand the method?" and flags completeness
  gaps within the panel's slice (collapsed sub-steps, undefined
  symbols, unvisualised governing relations, unmarked but load-bearing
  flow direction, etc.).

The verdict covers, between the three vision-model passes plus a
deterministic dimensions pass:

Rendering:
- Overlapping text or elements
- Text clipped or extending beyond boxes
- Arrows routing through unrelated shapes
- Missing or unreadable labels
- Severe layout asymmetry
- LaTeX rendering failures (raw `$$` / `\(` / `\mathbf{...}` showing
  as literal text instead of formatted math)
- **Equation line breaks at `=`, `+`, `-`, `\cdot`, `\propto` etc.** —
  if any equation splits across lines, the delimiter / cell-style
  convention in `references/template_authoring.md` was violated.

Truth:
- Wrong-way arrows (the panel's arrow source/target contradicts METHODS).
- Mangled or swapped symbols, subscripts, operands relative to METHODS.
- Mislabeled or misplaced annotations (label pinned to the wrong
  shape, arrow, or region).
- Methods-named concepts the panel's plan says it must depict but
  that are clearly absent from the rendered PNG.

Detail (sufficiency for understanding):
- Multi-step processes METHODS describes for the panel's slice but
  the panel collapses into a single opaque blob.
- Symbols / components shown without enough labelling to map them
  back to METHODS even with METHODS in hand.
- Load-bearing flow direction left unmarked.
- Core governing relation / loss / update rule from METHODS that the
  panel hints at but never visualises.
- Named submodules or phases METHODS calls out but the panel does
  not visually delimit.

A named block carrying a load-bearing symbol (`Gated fusion` +
`$$\mathcal{L}_{CE}$$`), or an operation drawn as its visual primitive
(a `⊕` node with weights on its incoming edges, `⊗` with a mask),
**already visualises** its governing relation — do not report it as a
detail gap. Never ask for a raw formula to be added, or for a block to
list its own internals (`softmax(QK^T/\lambda)V`, mask unions,
null-fill) beneath its name: the figure is allowed exactly ONE raw
multi-term equation, already spent by the plan. Prefer flagging that an
operation is unnamed or its inputs are unlabelled over flagging that its
equation is absent.

Dimensions (deterministic, no model call):
- The rendered PNG's pixel dimensions diverge from the size implied
  by `figure.json`'s `proportion_w` / `proportion_h` by more than
  ±15% on either axis. See the "Panel size from figure.json
  proportions" section in `references/panel_agent.md`.

### No direction edits

Repairs may not change an edge's direction (which endpoint is the
head) or flip it between single- and double-headed. That semantics is
pinned by the panel's `drawio_prompt` and probed by the unit-test
inspections file in step 3 below, so it must stay stable across the
repair loop. Fix arrow defects by re-routing the polyline, moving
endpoints, or relabeling — not by reversing or re-heading the arrow.
(Incidental arrowhead *marker shape* — open vs filled, etc. — is not
probed and may be changed freely if it helps a repair.)

## Lifecycle (steps 1–3)

For a panel with id `<panel_id>` and workdir `WD = $WORKDIR`:

1. **Run the initial inspect** —

   ```bash
   # Default audit-vlm is gpt-6-astra (OpenAI backend, high reasoning effort) → needs OPENAI_API_KEY.
   # ($AUDIT_VLM, shared with the Phase 6 verify audit, sets this default.)
   # For the fallback, add `--audit-vlm gemini-3.1-pro` and set GEMINI_API_KEY.
   # $PYTHON = the absolute interpreter path from your dispatch header.
   OPENAI_API_KEY=... "$PYTHON" \
       "$TOOLKIT_DIR/scripts/inspect_panel.py" \
       --workdir $WORKDIR/ --panel-id <panel_id> --attempt 1
   ```

   The script reads `$WORKDIR/panels/<panel_id>.png`,
   `$WORKDIR/<panel_id>.plan.md` (which already quotes the panel's
   `drawio_prompt` verbatim and lists the intended element inventory),
   `$WORKDIR/methods.md` (the source of truth), and
   `$WORKDIR/figure.json` (for the panel's `proportion_w` /
   `proportion_h`). It runs THREE vision-model passes plus a
   deterministic dimensions check against the rendered PNG, and merges their
   issues into `$WORKDIR/panels/<panel_id>.inspect.json` with this
   shape:

   ```json
   {
     "schema_version": 2,
     "attempt": 1,
     "model": "gpt-6-astra",
     "panel_id": "<panel_id>",
     "png": "$WORKDIR/panels/<panel_id>.png",
     "has_defects": true,
     "issues": [
       {
         "location": "top-right of the panel, near box phi_post",
         "element": "label e_j",
         "description": "the label `e_j` overlaps the right edge of `phi_post`",
         "severity": "critical",
         "check": "rendering"
       },
       {
         "location": "middle of the panel, residual equation",
         "element": "residual e_i = y_j - ŷ_j",
         "description": "METHODS defines the residual as e_j = y_j - ŷ_j but the panel shows e_i = y_j - ŷ_j",
         "severity": "critical",
         "check": "truth"
       },
       {
         "location": "panel page bounds",
         "element": "PAGE_W × PAGE_H in generate_<panel_id>.py",
         "description": "the rendered PNG is 1200x900 px but the panel's figure.json proportion_w / proportion_h implies ~1780x2228 px (width off by -32.6%, height off by -59.6%; tolerance ±15%). Adjust PAGE_W / PAGE_H ...",
         "severity": "critical",
         "check": "dimensions"
       }
     ],
     "summary": "rendering pass — ...\ntruth pass — ...\ndetail pass — ...\ndimensions pass — ...",
     "rendering_summary": "...",
     "truth_summary": "...",
     "detail_summary": "...",
     "dimensions_summary": "..."
   }
   ```

   The four checks have distinct mandates:

   - `check: "rendering"` (Pass 1, vision model) — flags ONLY visual defects
     against the panel spec: overlaps, clipped or out-of-box text,
     arrows running through unrelated shapes, missing labels, raw
     LaTeX (`$$`, `\(`, `\mathbf` showing as literal text), equations
     broken across lines at operators, illegible labels, off-page
     elements. Does NOT flag stylistic choices.
   - `check: "truth"` (Pass 2, vision model) — flags ONLY content errors
     against `methods.md` within this panel's scope: wrong-way arrows,
     mangled symbols, swapped subscripts, mislabeled components,
     misplaced annotations, and methods-named concepts the panel was
     meant to depict but did not. Does NOT duplicate the rendering
     pass.
   - `check: "detail"` (Pass 3, vision model) — answers "is there enough
     detail in this panel to understand the method?" given the PNG
     and `methods.md` (scoped by the panel's plan). Flags ONLY
     completeness gaps: multi-step processes collapsed into one
     blob, symbols / components shown without labels that map back
     to METHODS, missing governing equations, unmarked but
     load-bearing flow direction, named submodules METHODS calls
     out but the panel does not visually delimit. Does NOT
     duplicate the rendering or truth passes.
   - `check: "dimensions"` (deterministic, no API call) — flags ONLY
     a PNG-vs-target dimension mismatch larger than ±15% on either
     axis (see `references/panel_agent.md` → "Panel size from
     figure.json proportions"). When it fires, the fix is in
     `PAGE_W` / `PAGE_H` in `generate_<panel_id>.py`, not in shape
     positions.

   `has_defects` is `true` iff at least one issue (from any check)
   has `severity: critical`. Use `--dry-run` to preview the
   vision-model prompts and the resolved dimension target.

   After this initial inspect, archive the PNG and verdict:

   ```bash
   cp $WORKDIR/panels/<panel_id>.png \
      $WORKDIR/panels/<panel_id>.attempt-1.png
   cp $WORKDIR/panels/<panel_id>.inspect.json \
      $WORKDIR/panels/<panel_id>.inspect.attempt-1.json
   ```

2. **Repair any defects** — read
   `$WORKDIR/panels/<panel_id>.inspect.json` and iterate:

   **Inspect budget: `N` attempts per panel**, where `N` is the
   inspect-attempts value on the `BUDGET:` line of your dispatch header
   (default 5). Attempt 1 is the initial run from step 1; attempts 2
   through `N` each follow one repair pass (`N - 1` repair passes max).
   The loop continues while ANY issue remains in the verdict, regardless
   of severity — both `critical` and `minor` issues are repaired. After
   each inspect, archive the PNG and verdict so the trace is preserved.

   ```
   attempt = 1
   (attempt 1 was already produced + archived in step 1)
   while len(issues) > 0 and attempt < N:    # N = BUDGET from dispatch header
       for each issue (critical or minor):
           locate the offending element in <panel_id>.drawio.template
           and generate_<panel_id>.py, then adjust layout / geometry /
           label content (widen a cell, push two boxes apart, switch
           a math delimiter, increase a font size, re-route an edge,
           etc.).
       re-run the build steps from references/panel_agent.md:
           step 4 (lint)       — "$PYTHON" lint_math.py <template>
           step 5 (generate)   — "$PYTHON" generate_<panel_id>.py
           step 6 (re-embed mpl placeholders, if any)
           step 7 (export PNG) — node "$TOOLKIT_DIR/dist/cli.js" export
               <drawio> <png> --export-scale 2
               (the hardened exporter; never invoke raw `drawio -x` —
               it intermittently wedges on math-bearing files)
       attempt += 1
       run inspect with --attempt <current attempt>
       archive PNG + verdict for the new attempt
   if len(issues) > 0:
       ship the panel as-is (status="degraded").
   ```

   Do NOT declare the panel done while any issue remains and
   `attempt < N`. The minimum work after a failing inspect is one
   repair pass plus the next inspect attempt.

3. **Write the unit-test inspections file** —
   `WD/unit_test_inspections_<panel_id>.jsonl`. Once the panel has
   passed inspect (or exhausted its budget), distil the panel into a
   set of atomic yes/no probes that the Phase 6 verifier will replay
   against the enhanced composite to detect any regression introduced
   by the gpt-image-2 enhancement pass.

    The file has two parts: a **mandatory arrows core** (every arrow,
    exhaustively) and an **optional extras section** (a few additional
    high-value probes the agent judges relevant). The arrows core is
    the non-negotiable floor; the extras are where you exercise
    judgement so the suite is not artificially rigid.

    ### Part A — the arrows core (mandatory, exhaustive)

    Every arrow of this panel MUST be probed. An arrow is an
    `<mxCell ... edge="1">` in `WD/<panel_id>.drawio`. If the panel
    contains zero arrows, Part A is empty (but Part B may still add
    extras).

    **Every arrow must be covered, strictly.** Enumerate every edge in
    `WD/<panel_id>.drawio`. For EACH arrow, emit probes that pin down
    its MEANING — the three things that matter are what it connects,
    which way it flows, and what it says:
    - **Existence + endpoints (connectivity)** (mandatory for every
      arrow): an arrow connects source shape X to target shape Y, each
      named by its visible label text or its location in the panel.
      This is the single most important fact to pin down — the whole
      point of the probe set is to catch an arrow that ends up wired to
      the wrong box (or to no box) after enhancement.
    - **Direction** (mandatory for every arrow): which way the arrow
      points / which endpoint is the head — and, ONLY where a two-way
      relationship is load-bearing, whether it is one-way or
      double-headed.
    - **Edge label / message** (mandatory for every arrow that carries
      a label): the arrow's label reads exactly `<verbatim text>`. The
      label is part of the message the arrow conveys, so a dropped or
      mangled label is a real regression worth catching.
    No arrow may be left without at least an existence+endpoints probe
    AND a direction probe. This exhaustive arrow coverage is the floor
    and may never be skipped or thinned out to make room for extras.

    **Probe meaning, never appearance.** A probe must test what the
    arrow *means*, never how it is *drawn*. The gpt-image-2 enhancement
    pass is explicitly allowed to restyle edges, so it is FORBIDDEN to
    write a probe about any of: dashed-vs-solid (or any line / dash
    style), color or tint, stroke width, curvature or routing, or
    arrowhead marker shape. A probe whose answer would flip merely
    because a dashed arrow was redrawn solid, or a gray arrow was
    redrawn black, tests nothing we care about — do not write it. In
    the arrows core, if a fact cannot be phrased as connectivity,
    direction, or label, it does not belong here — move it to Part B if
    it is a content fact worth protecting, otherwise drop it.

    Each line is a JSON object with EXACTLY two keys:

    ```json
    {"question": "Is there an arrow from the `phi_post` box to the `e_j` box?", "expected_answer": "yes"}
    {"question": "Does the arrow between `phi_post` and `e_j` point rightward (arrowhead at `e_j`)?", "expected_answer": "yes"}
    {"question": "Does the arrow from `loss` to `update` carry the label `backprop`?", "expected_answer": "yes"}
    {"question": "Does the top incoming arrow labeled `parent + inspirations` terminate on the `LLM pool` box?", "expected_answer": "no"}
    {"question": "Does the arrow between `encoder` and `decoder` flow both ways (an arrowhead at each end)?", "expected_answer": "no"}
    ```

    Authoring rules for the arrows core — every question MUST satisfy
    ALL of:
    - About exactly one arrow of this panel (see above) — no exceptions
      in Part A.
    - Answerable from the rendered PNG ALONE, with no access to
      `methods.md`, the plan, or the template.
    - Answerable as exactly `"yes"` or `"no"` (lowercase, no other
      value). Anything fuzzy ("how many arrows…", "which color…") is
      forbidden; rephrase as "Are there exactly N arrows leaving X?".
    - Atomic — one fact about one arrow per question. Split compound
      checks into separate lines.
    - Concrete and visually grounded — name the arrow by its endpoint
      shapes' label text or its location ("leftmost arrow", "the arrow
      entering the `decode` box from below"), never by an internal
      mxCell id.
    - Phrased so a wrong / missing / reversed / mislabeled arrow flips
      the answer. Write a mix of `expected_answer: "yes"`
      (presence/correctness checks) AND `expected_answer: "no"`
      (absence-of-defect checks, e.g. a fabricated or inverted arrow)
      so the verifier cannot pass by always answering one value.

    Coverage — emit as many probes as it takes to cover every arrow's
    connectivity, direction, and label (typically 2–3 probes per
    arrow). There is no fixed question count and no upper cap; the only
    hard requirements are that every arrow has at least its
    connectivity and direction probes and no probe tests appearance.

    ### Part B — extra probes (optional, agent's judgement)

    The arrows core is exhaustive but it is not the whole story: a panel
    can also regress in ways an arrow probe will never catch. After
    Part A is complete, you MAY append any number of extra probes (zero
    is fine) about whichever non-arrow facts you judge most worth
    protecting through the enhancement pass — there is no cap. Choose
    the facts whose corruption would most damage the figure's
    correctness.

    For example, when the panel uses a grouping rectangle to enclose a
    set of elements, probe that the group still contains EXACTLY the
    expected elements — no fewer and no more — since the enhancement
    pass can quietly drop a member out of the group or pull an unrelated
    box into it:

    ```json
    {"question": "Does the dashed group box labeled `encoder` enclose exactly the `conv`, `pool`, and `norm` boxes (and no others)?", "expected_answer": "yes"}
    ```

    Extra probes obey the SAME discipline as the arrows core, with the
    "arrow" requirement lifted. Every extra probe MUST:
    - Be about exactly one concrete, visually-grounded element of this
      panel, named by its visible text or location — never by an mxCell
      id.
    - Be answerable from the rendered PNG ALONE (no `methods.md`, plan,
      or template), as exactly `"yes"` or `"no"` (lowercase), atomic
      (one fact per line).
    - Test MEANING, never appearance. It is still FORBIDDEN to probe
      anything gpt-image-2 is free to restyle: color or tint, font or
      font size, stroke width, corner radius, exact position or
      whitespace, drop shadows, or any purely cosmetic treatment. A
      good extra probe is one whose answer flips only if the *content*
      changed — not because the element was redrawn in a different
      style.
    - Be phrased so a real regression flips the answer, and keep the
      yes/no mix (some `expected_answer: "yes"`, some `"no"`).

    Skip anything already caught more cheaply elsewhere: rendering
    defects (overlaps, clipping, raw LaTeX), dimensions, and arrow
    facts (those belong in Part A). Extras are for *content* facts the
    earlier Phase-3 inspect cannot guard once the panel is handed to
    Phase 6.

    Keep questions stable across enhancement: phrase them about the
    arrow's semantic content (endpoints, direction, label), NOT about
    styling that gpt-image-2 is allowed to change (dashed-vs-solid,
    color, stroke width, curvature, arrowhead marker shape). If the
    answer would flip merely because the enhancement restyled the edge
    while preserving what it connects and which way it flows, the probe
    is testing the wrong thing — do not write it.

The unit-test JSONL written in step 3 is NOT replayed by the inspect
agent — it is consumed downstream by the Phase 6 verifier. See
`references/enhance_repair_agent.md` for that stage's execution
policy (clean-context-per-question, async fan-out, image caching,
determinism) and the `verify.json` shape it emits.

## Cross-references

- `references/panel_agent.md` — Phase 2 generation contract;
  describes the panel artifacts this agent reads and the build steps
  (4 → 5 → 6 → 7) the repair loop re-runs.
- `references/template_authoring.md` — drawio XML grammar, math
  delimiters, MathJax line-break rules, XML well-formedness.
- `references/python_layout.md` — Python skeleton, edge-label
  positioning, label-size estimates.
- `references/drawio_cli.md` — CLI paths and export flags.
- `scripts/inspect_panel.py`, `scripts/lint_math.py` — the
  deterministic visual-audit and lint tools used in step 1 and the
  repair re-build loop.
