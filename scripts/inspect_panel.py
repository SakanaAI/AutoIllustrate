"""Inspect a single panel PNG against its drawio spec AND against methods.md.

Phase 3 visual-inspection helper. For one panel, this script runs THREE
Gemini calls against the rendered `$WORKDIR/panels/<panel_id>.png`:

  1. RENDERING pass — audits the PNG against the panel's spec
     (`<panel_id>.plan.md`, which embeds `drawio_prompt` verbatim and
     lists the intended element inventory). Flags VISUAL DEFECTS:
     overlapping text, arrows running on top of unrelated shapes,
     clipped or out-of-box text, missing labels, MathJax rendering
     failures, equations wrapping at operators, illegible labels, etc.
  2. TRUTH pass — audits the PNG against `<workdir>/methods.md`
     (the source of truth) and the panel's plan (which scopes the
     audit to this panel's slice of methods). Flags CONTENT errors:
     wrong-way arrows, mangled symbols, swapped subscripts, mislabeled
     components, misplaced annotations, and methods-named concepts
     the panel was meant to depict but did not.
  3. DETAIL pass — audits the PNG against `<workdir>/methods.md`
     (scoped by the panel's plan) and asks the single question:
     "is there enough detail in this panel to understand the method?"
     Flags COMPLETENESS gaps: missing intermediate steps, undefined
     symbols, components shown as opaque blobs where methods describes
     internal structure, ambiguous dataflow, and so on.

Issues from all three passes are merged into a single `issues` list in
the output JSON, each tagged with `check: "rendering" | "truth" |
"detail"`. `has_defects` is true iff at least one issue across any pass
is `severity: "critical"`.

This is NOT the same as `verify.py` (Phase 6):
- `verify.py` audits the gpt-image-2 ENHANCED composite PNG against
  methods.md and looks for content drift introduced by the
  image-edit model.
- `inspect_panel.py` (this script) audits ONE deterministic panel PNG
  for both rendering defects and content correctness, before the
  composite is even built.

The check is delegated to a vision model because Claude Code's main
agent is unreliable at reading these screenshots and tends to either
miss obvious overlaps or hallucinate problems that are not there.

Writes a structured verdict to `$WORKDIR/panels/<panel_id>.inspect.json`
so the calling agent can decide whether to repair. The Phase 3 repair
loop fires while ANY issue (critical or minor) remains; the agent
processes critical issues first and minors after, with up to 4 repair
passes (5 inspect attempts total) per panel. The script never loops;
the agent orchestrates retries.

The vision model is selected via `--audit-vlm` (default `gpt-6-astra`
at high reasoning effort,
from $AUDIT_VLM — the same knob that drives the Phase 6 verify audit,
so one setting covers both vision-audit stages). `gemini-3.1-pro` is
available as a fallback. The backend choice picks both the API client
and the credential the script expects (`OPENAI_API_KEY` for OpenAI,
`GEMINI_API_KEY` for Gemini); either key may be supplied via env or
via a `.env` file in the cwd.

Usage:

    # Preview both prompts + skip the API calls ($PYTHON is the cached-venv
    # interpreter from the dispatch header; VENV_PY overrides it)
    "$PYTHON" scripts/inspect_panel.py \
        --workdir $WORKDIR/ --panel-id enc_attn --dry-run

    # Real call (default audit-vlm = gpt-6-astra; OPENAI_API_KEY required)
    OPENAI_API_KEY=... "$PYTHON" scripts/inspect_panel.py \
        --workdir $WORKDIR/ --panel-id enc_attn

    # Real call against Gemini instead
    GEMINI_API_KEY=... "$PYTHON" scripts/inspect_panel.py \
        --workdir $WORKDIR/ --panel-id enc_attn --audit-vlm gemini-3.1-pro

Exit codes:
    0  verdict written (regardless of `has_defects`)
    1  API error or unparseable model output (raw response saved)
    2  missing input files (PNG / plan / methods.md), bad CLI args,
       or missing API key for the selected backend
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _usage import record_usage  # type: ignore  # noqa: E402
from enhance import load_dotenv_key, prepare_input_image  # noqa: E402
from schema import (  # noqa: E402
    FigureDoc,
    compute_panel_target_dims,
    validate as validate_figure,
)

# VLM choices exposed via --audit-vlm. Each maps to a backend ("openai" /
# "gemini") and the canonical API model id. To add a third option,
# add another row here AND extend the `if backend ==` dispatch in
# `_run_pass`. DEFAULT_VLM reads $AUDIT_VLM — the SAME env var as verify.py's
# Stage A audit — so the orchestrator's single --audit-vlm flag drives the
# vision model for both Phase 3 (panel inspect) and Phase 6 (verify).
DEFAULT_VLM = os.environ.get("AUDIT_VLM", "gpt-6-astra")
VLM_REGISTRY: dict[str, dict[str, str]] = {
    "gpt-6-astra":    {"backend": "openai", "model": "gpt-6-astra",
                       "reasoning_effort": "high"},
    "gpt-5.5":        {"backend": "openai", "model": "gpt-5.5"},
    "gemini-3.1-pro": {"backend": "gemini", "model": "gemini-3.1-pro-preview"},
}
VLM_CHOICES = list(VLM_REGISTRY)

DEFAULT_MAX_EDGE = 2048
SCHEMA_VERSION = 2

VALID_SEVERITIES = {"critical", "minor"}
VALID_CHECKS = {"rendering", "truth", "detail", "dimensions"}

# Panel PNGs are exported with `drawio -b 10 --scale 2` (see
# references/drawio_cli.md). Each panel-space unit therefore maps to
# EXPORT_SCALE pixels; the export adds EXPORT_BORDER pixels of padding on
# every side (at the post-scale resolution).
EXPORT_SCALE = 2
EXPORT_BORDER = 10

# Soft constraint on how close the rendered PNG must be to the target
# size derived from the panel's `proportion_w / proportion_h` in
# figure.json. A panel rendered more than ±15% off on either axis trips
# a `check: "dimensions"` issue (severity "critical") that re-enters
# the repair loop.
DIMENSION_TOLERANCE = 0.15


RENDERING_SYSTEM_PROMPT = """\
You are a layout / rendering auditor for a single panel of a scientific \
figure produced by draw.io.

You will receive:
  1. SPEC: the panel's design plan in markdown. The plan begins with the \
panel's `drawio_prompt` quoted verbatim (the single idea, the element \
inventory, the intended labels, the visual hierarchy). Treat the SPEC \
as authoritative for WHAT the panel should contain.
  2. RENDERED PNG: the panel actually exported by draw.io. Audit it \
against the spec.

Your job is to flag VISUAL DEFECTS in the rendered PNG — places where \
the PNG fails to be a clean, legible rendering of the spec. Focus on \
problems a human reviewer would call out at a glance.

## DO flag these defects
- Two visible elements (shapes, text labels, edge labels) overlap or \
touch in a way that obscures either one. This includes a text label \
sitting on top of a shape, a label sitting on top of another label, \
or two shapes intersecting.
- An arrow / edge passes THROUGH an unrelated shape (i.e. the arrow's \
source and target are not that shape, but its routing crosses over the \
shape's interior). Edges that correctly enter/exit their endpoints are \
fine — only flag arrows that visually cut through a third party.
- Text is clipped / cropped at the edge of its container or extends \
past the panel's page bounds.
- A label listed in the SPEC's element inventory is not visible in the \
PNG (or is so faint / so small it cannot be read).
- A LaTeX expression failed to render: raw `$$`, `\\(`, `\\)`, backslash \
commands like `\\mathbf`, `\\frac`, or visible curly braces appear as \
literal text instead of formatted math.
- An equation has been broken across multiple visual lines at an \
operator (`=`, `+`, `-`, `\\cdot`, `\\propto`, `\\leq`, `\\geq`, etc.) \
when the spec presents it as a single equation.
- A label is rendered but at a font size so small it is not legible \
relative to the rest of the panel.
- An element extends beyond the page background (off-page).

## PLACEHOLDERS — do not flag
Gray-dashed boxes whose label is a token of the form \
`[[ pl <panel_id> <n> ]]` are INTENTIONAL placeholders for content \
the Phase 5 enhancer will fill in (curves, histograms, sketches, \
etc.). The panel's placeholder list — id, kind, description — is \
provided under "PANEL PLACEHOLDERS" below when applicable. Do NOT \
flag these boxes as empty, illegible, missing content, raw-token \
labels, or wasted whitespace. They are expected.
- Severe alignment / asymmetry that breaks the spec's described layout \
(e.g. spec says "two parallel columns" but the PNG has the columns \
visibly skewed at different heights with no apparent reason).
- Excessive wasted whitespace: the panel's content occupies a small \
region of the page bounds and large empty bands surround it (e.g. the \
content fills less than ~60% of the page area, or there is a band of \
empty space along an edge wider than roughly a third of the panel's \
shorter dimension). This wastes space in the final paper. A modest \
margin around the content is fine and expected — only flag this when \
the empty space is clearly disproportionate to the content.

## DO NOT flag these
- Stylistic choices (colors, font family, stroke width, corner radius) \
unless they actively prevent the panel from being read.
- Minor positional drift that does not cause overlap or clipping.
- Spec-listed elements being rendered with reasonable but not pixel- \
perfect spacing.
- Labels that are short and clearly legible even if small.
- Decorative-looking icons or whitespace inside a box.
- The fact that the figure looks "plain" or "could be prettier" — that \
is what Phase 5 (gpt-image-2 enhance) is for. Only flag defects that a \
later restyle cannot fix (overlaps, broken math, missing content).

## RULES
- If you are unsure whether something is a defect, DO NOT flag it. \
False positives trigger an unnecessary repair pass; false negatives \
get caught in the next phase. Be conservative.
- For each issue, quote the offending text or describe the offending \
geometry as precisely as you can ("the label `e_j` overlaps the right \
edge of the box `phi_post`"; "the arrow from `p0` to `p_l` passes \
through the box `bias_term`"). The agent uses these descriptions to \
locate the element in the panel generator.
- Use `severity: "critical"` for defects that meaningfully hurt the \
panel: overlaps, clipped labels, missing labels, raw LaTeX, equations \
that wrapped at an operator, arrows through unrelated shapes, and \
panels with clearly excessive wasted whitespace that would burn page \
budget in the final paper. Use `severity: "minor"` for cosmetic drift \
like very mild misalignment that is still readable, or for slightly \
larger-than-ideal margins that still look reasonable.

## RESPONSE FORMAT
Respond with a single JSON object, no prose, no code fences. Schema:

{
  "has_defects": <bool>,
  "issues": [
    {
      "location": "<short human-readable region, e.g. 'top-right of the \
panel, near box phi_post'>",
      "element": "<spec id, label text, or short description of the \
offending element>",
      "description": "<what is wrong, in one sentence>",
      "severity": "<critical | minor>"
    }
  ],
  "summary": "<one sentence overall verdict>"
}

`has_defects` MUST be true if and only if at least one issue has \
`severity: \"critical\"`. If you find no defects, return \
`{\"has_defects\": false, \"issues\": [], \"summary\": \"...\"}`.
"""


TRUTH_SYSTEM_PROMPT = """\
You are a content auditor for a single panel of a scientific figure \
produced by draw.io.

You will receive:
  1. METHODS — markdown describing the methodology / system / process \
the FULL figure is supposed to depict. This is the SOURCE OF TRUTH \
for the content of the panel.
  2. PANEL SPEC — the panel's plan, beginning with the panel's \
`drawio_prompt` quoted verbatim. The plan tells you what SLICE of \
METHODS this panel is supposed to depict. Use it ONLY to scope your \
audit: ideas in METHODS that are out of this panel's scope are NOT \
your concern (they belong to other panels).
  3. RENDERED PNG — the panel exported by draw.io. Audit it.

Your job is to flag depicted elements that fail one of two tests:

  (T) Truth — an element in the panel contradicts METHODS.
  (M) Missing — a key concept that the panel's plan AND METHODS \
      together say the panel must depict is materially absent.

**Arrow direction is mandatory.** Before finalising your verdict, \
sweep every arrow in the panel, name its source and target, and \
confirm the direction matches what METHODS describes. Wrong-way \
arrows silently invert the meaning of a figure and are the single \
most common content failure — never skip this pass.

**Annotation correctness is mandatory.** Sweep every annotation — \
text label, caption, callout, tag, inline gloss, legend entry, \
bracket, brace, dimension marker, or any other piece of text or mark \
whose job is to describe, name, or point at another element. For \
each one verify TWO things: (a) the annotation's CONTENT is correct \
per METHODS (the right word, symbol, value, equation, or description \
— no mangled glyphs, no swapped subscripts, no substituted terms); \
and (b) the annotation is ATTACHED TO THE RIGHT ELEMENT (sits on / \
points at / brackets the object METHODS says it describes, not a \
neighbour). A well-rendered label pinned to the wrong shape is just \
as wrong as a mangled label.

## DO NOT flag
- Rendering / layout defects: overlap, clipping, illegibility, raw \
LaTeX, equation line-wrapping, off-page elements, excessive \
whitespace. A separate rendering-audit pass already handles those — \
do not duplicate them here.
- Aesthetic choices (colors, font, stroke width, corner radius, \
spacing) unless they directly cause a truth or missing failure.
- Concepts from METHODS that fall OUTSIDE this panel's plan/scope.
- The panel adding extra annotations, icons, or illustrations that \
are consistent with METHODS — additions are welcome when they are \
correct.
- Concepts named under "PANEL PLACEHOLDERS" below (when present): \
those visualizations are deliberately deferred to the Phase 5 \
enhancer and stand in as gray-dashed boxes here. They will be \
verified post-enhancement; do NOT flag them as missing concepts.

## RULES
- If you are unsure whether something fails (T) or (M), DO NOT flag \
it. False positives trigger unnecessary repair passes; false \
negatives are recoverable by the Phase 6 verifier later.
- In `description`, state what METHODS requires versus what the \
panel currently shows, in one sentence (e.g. "METHODS says the \
gradient flows from L to θ but the arrow points θ → L"; "METHODS \
defines the residual as e_j = y_j - ŷ_j but the panel shows \
e_i = y_j - ŷ_j").
- Use `severity: "critical"` for any element that is factually \
wrong or a clearly missing key concept. Use `severity: "minor"` for \
borderline cases (a secondary concept softly underplayed, a label \
slightly under-specified but still inferable).

## RESPONSE FORMAT
Respond with a single JSON object, no prose, no code fences. Schema:

{
  "has_defects": <bool>,
  "issues": [
    {
      "location": "<short human-readable region within the panel>",
      "element": "<spec id, label text, or short description of the offending element>",
      "description": "<what METHODS requires vs what the panel shows, in one sentence>",
      "severity": "<critical | minor>"
    }
  ],
  "summary": "<one sentence overall verdict>"
}

`has_defects` MUST be true iff at least one issue has \
`severity: \"critical\"`. If you find no truth or missing-concept \
problems, return `{\"has_defects\": false, \"issues\": [], \
\"summary\": \"...\"}`.
"""


DETAIL_SYSTEM_PROMPT = """\
You are a sufficiency auditor for a single panel of a scientific \
figure produced by draw.io.

You will receive:
  1. METHODS — markdown describing the methodology / system / process \
the FULL figure is supposed to depict. This is the SOURCE OF TRUTH.
  2. PANEL SPEC — the panel's plan, beginning with the panel's \
`drawio_prompt` quoted verbatim. The plan tells you which SLICE of \
METHODS this panel is supposed to depict. Use it to scope the audit: \
ideas in METHODS that belong to OTHER panels are not your concern.
  3. RENDERED PNG — the panel exported by draw.io.

Your single job is to answer one question:

  > Given the rendered PNG and the methods, is there enough detail in \
this panel for a reader to understand the slice of the method it is \
supposed to depict?

A reader is assumed to have access to BOTH the figure and METHODS; the \
figure does not have to restate every sentence of METHODS, but it MUST \
visually convey the structure, dataflow, and key components of the \
panel's slice with enough fidelity that, after looking at it, the \
reader knows WHAT happens, WHERE the inputs and outputs are, and HOW \
the named components relate. If a knowledgeable reader would have to \
re-derive the method from METHODS instead of READING IT OFF the panel, \
the panel does not have enough detail.

## DO flag detail / completeness gaps
- A multi-step process that METHODS describes as having N stages is \
collapsed into a single unlabelled blob (e.g. METHODS describes an \
encoder + attention + decoder but the panel shows one box \
"transformer"); the intermediate stage is part of the panel's slice.
- A symbol or component is shown without enough labelling for the \
reader to know what it is — even after consulting METHODS, the \
mapping between the panel element and the METHODS concept is \
ambiguous (e.g. an unlabelled box next to an arrow, no name, no \
caption).
- A flow direction is left unmarked when METHODS says a specific \
direction matters (no arrowhead on an edge whose direction METHODS \
treats as load-bearing).
- A core relation METHODS defines for the panel's slice is not \
visualised at all (e.g. METHODS says "the loss is back-propagated \
through θ" and the panel shows neither the loss nor the gradient \
path).
- Loss, objective, update rule, or other governing relation that \
METHODS attaches to the panel's slice is absent entirely — neither \
named, symbolised, nor drawn. A named block carrying a load-bearing \
symbol ("Gated fusion", "L_CE"), or the operation drawn as its visual \
primitive (a sum node with its weights on the incoming edges, a mask \
glyph consuming a mask), SATISFIES this: flag the missing operation, \
never the missing formula.
- A grouping / module boundary METHODS calls out (a named submodule, \
a phase, a buffer) is not visually delimited, making the panel feel \
like one undifferentiated lump.
- A reader who only has METHODS plus this PNG would still be unable \
to tell which arrow is which, which symbol corresponds to which \
METHODS variable, or what the panel is depicting at all.

## DO NOT flag
- Concepts that fall OUTSIDE this panel's plan/scope (those belong to \
other panels — the figure as a whole carries them).
- Aesthetics, color choices, font weight, stroke width.
- Layout defects (overlap, clipping, raw LaTeX, line wrapping, \
illegible labels). A separate rendering-audit pass handles those.
- Truth errors (wrong-way arrow, mangled symbol, mislabel). A \
separate truth-audit pass handles those.
- The mere absence of restated prose from METHODS — the figure is \
not a transcript. Only flag missing CONTENT, not missing TEXT.
- A named operation whose raw formula is not shown, or a block that \
does not list its own internals (softmax(QK^T)V, mask unions, \
null-fill) beneath its name. The figure is allowed exactly ONE raw \
multi-term equation and the plan already spent it; the name REPLACES \
the formula rather than captioning it.
- Concepts named under "PANEL PLACEHOLDERS" below (when present). \
Those visualizations are deliberately deferred to the Phase 5 \
enhancer. Treat them as if they were already rendered with their \
description.

## RULES
- If you are unsure whether the panel has enough detail, DO NOT flag \
it. Conservative is safer than chatty: false positives waste repair \
budget; later phases can still catch real gaps.
- For each flagged gap, quote what METHODS asks the panel to show \
versus what the panel currently shows, in one sentence (e.g. \
"METHODS describes the residual update as e_j = y_j - ŷ_j followed \
by a back-prop step into θ, but the panel only shows e_j with no \
back-prop arrow and no θ box"; "METHODS says the encoder has a \
self-attention + FFN stack but the panel shows a single 'encoder' \
box with no internal structure").
- Use `severity: "critical"` when the gap genuinely blocks \
understanding of the panel's slice of the method (e.g. a core \
component is missing entirely, or the dataflow is unrecoverable \
from the panel). Use `severity: "minor"` when the panel is \
understandable but would clearly benefit from one more label, \
arrow, or sub-box.

## RESPONSE FORMAT
Respond with a single JSON object, no prose, no code fences. Schema:

{
  "has_defects": <bool>,
  "issues": [
    {
      "location": "<short human-readable region within the panel>",
      "element": "<spec id, label text, or short description of the under-detailed element>",
      "description": "<what METHODS asks the panel to convey vs what the panel shows, in one sentence>",
      "severity": "<critical | minor>"
    }
  ],
  "summary": "<one sentence overall verdict on whether the panel has enough detail to understand its slice of the method>"
}

`has_defects` MUST be true iff at least one issue has \
`severity: \"critical\"`. If the panel conveys enough detail, return \
`{\"has_defects\": false, \"issues\": [], \"summary\": \"...\"}`.
"""


SPEC_BLOCK = """\

## PANEL SPEC (authoritative for WHAT the panel should contain)

Panel id: `{panel_id}`

{plan}
"""


PLACEHOLDERS_BLOCK = """\

## PANEL PLACEHOLDERS (deferred to the Phase 5 enhancer — ignore in this audit)

The panel's `placeholders_<panel_id>.jsonl` lists visualizations that
were deferred to the enhancer; each appears as a gray-dashed box with
a token label `[[ pl {panel_id} <n> ]]` in the rendered PNG.

{placeholders}
"""


MPL_BLOCK = """\

## PANEL MATPLOTLIB FIGURES (already rendered — validate against description)

The panel's `placeholders_<panel_id>_mpl.jsonl` lists matplotlib-rendered
figures the panel agent embedded into the drawio BEFORE export. Each
entry below has been replaced in the PNG by a real matplotlib plot at
the listed cell location, NOT a gray-dashed placeholder. Treat each
entry's `description` as the spec for that figure: flag a critical
issue if the rendered plot is clearly inconsistent with the
description (wrong axes, wrong data shape, wrong color family, wrong
item count, missing axis labels the description names, etc.). Do NOT
flag stylistic choices the description leaves open (exact tick
spacing, font face, minor color shade).

{mpl_placeholders}
"""


METHODS_BLOCK = """\

## METHODS (source of truth)

The following markdown is the methodology brief the full figure is \
supposed to depict. Treat its claims as authoritative when judging \
truth. Anything in the panel that contradicts it within the panel's \
scope is a critical issue; a key concept named here that the \
panel's plan says the panel must show but that is clearly absent \
from the rendered PNG is a missing-concept issue.

{methods}
"""


def _format_placeholders(panel_id: str, placeholders: list[dict]) -> str:
    lines = []
    for entry in placeholders:
        pid = entry.get("id", "?")
        kind = entry.get("kind", "?")
        desc = entry.get("description", "").strip()
        lines.append(f"- `[[ pl {panel_id} {pid} ]]` ({kind}): {desc}")
    return "\n".join(lines)


def _format_mpl_placeholders(panel_id: str, mpl_placeholders: list[dict]) -> str:
    lines = []
    for entry in mpl_placeholders:
        pid = entry.get("id", "?")
        kind = entry.get("kind", "?")
        desc = entry.get("description", "").strip()
        lines.append(f"- `[[ mp {panel_id} {pid} ]]` ({kind}): {desc}")
    return "\n".join(lines)


def _maybe_append_placeholder_blocks(
    out: str,
    panel_id: str,
    placeholders: list[dict] | None,
    mpl_placeholders: list[dict] | None,
) -> str:
    if placeholders:
        out += PLACEHOLDERS_BLOCK.format(
            panel_id=panel_id,
            placeholders=_format_placeholders(panel_id, placeholders),
        )
    if mpl_placeholders:
        out += MPL_BLOCK.format(
            panel_id=panel_id,
            mpl_placeholders=_format_mpl_placeholders(panel_id, mpl_placeholders),
        )
    return out


def build_rendering_prompt(panel_id: str, plan: str,
                           placeholders: list[dict] | None = None,
                           mpl_placeholders: list[dict] | None = None) -> str:
    out = RENDERING_SYSTEM_PROMPT + SPEC_BLOCK.format(
        panel_id=panel_id, plan=plan.strip()
    )
    return _maybe_append_placeholder_blocks(
        out, panel_id, placeholders, mpl_placeholders
    )


def build_truth_prompt(panel_id: str, plan: str, methods: str,
                       placeholders: list[dict] | None = None,
                       mpl_placeholders: list[dict] | None = None) -> str:
    out = (
        TRUTH_SYSTEM_PROMPT
        + METHODS_BLOCK.format(methods=methods.strip())
        + SPEC_BLOCK.format(panel_id=panel_id, plan=plan.strip())
    )
    return _maybe_append_placeholder_blocks(
        out, panel_id, placeholders, mpl_placeholders
    )


def build_detail_prompt(panel_id: str, plan: str, methods: str,
                        placeholders: list[dict] | None = None,
                        mpl_placeholders: list[dict] | None = None) -> str:
    out = (
        DETAIL_SYSTEM_PROMPT
        + METHODS_BLOCK.format(methods=methods.strip())
        + SPEC_BLOCK.format(panel_id=panel_id, plan=plan.strip())
    )
    return _maybe_append_placeholder_blocks(
        out, panel_id, placeholders, mpl_placeholders
    )


def _load_placeholders(path: Path) -> list[dict]:
    if not path.exists():
        return []
    entries: list[dict] = []
    for i, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"WARN: {path}:{i} is not valid JSON ({exc}); skipping",
                  file=sys.stderr)
            continue
        if isinstance(obj, dict) and "id" in obj:
            entries.append(obj)
    return entries


def _resolve_panel_target(figure_path: Path, panel_id: str
                          ) -> tuple[float, float] | None:
    """Load `figure.json`, look up `panel_id`, return its (target_w,
    target_h) in panel-space units.

    Returns None if the figure file doesn't exist, the panel id is
    absent, or the figure document can't be parsed/validated — in any
    of those cases the dimension check is silently skipped (backwards
    compatible with figure.json files predating proportion fields).
    """
    if not figure_path.exists():
        print(f"WARN: figure.json not found at {figure_path}; "
              "skipping dimension check.", file=sys.stderr)
        return None
    try:
        doc = FigureDoc.model_validate_json(figure_path.read_text())
        validate_figure(doc)
    except Exception as exc:
        print(f"WARN: cannot parse/validate {figure_path} for dimension "
              f"check ({exc}); skipping.", file=sys.stderr)
        return None
    if panel_id not in {p.id for p in doc.panels}:
        print(f"WARN: panel id {panel_id!r} not in {figure_path}; "
              "skipping dimension check.", file=sys.stderr)
        return None
    try:
        targets = compute_panel_target_dims(doc)
    except ValueError as exc:
        print(f"WARN: cannot compute panel targets ({exc}); skipping "
              "dimension check.", file=sys.stderr)
        return None
    return targets[panel_id]


def _raw_png_dims(png_path: Path) -> tuple[int, int] | None:
    """Return the PNG's true on-disk pixel dimensions, independent of
    any downscaling `prepare_input_image` applies for the vision API.

    Returns None on decode error — the dimension check is then skipped.
    """
    try:
        from PIL import Image  # type: ignore
    except ImportError:
        print("WARN: pillow not installed; skipping dimension check.",
              file=sys.stderr)
        return None
    try:
        with Image.open(png_path) as img:
            return img.size
    except Exception as exc:
        print(f"WARN: cannot read raw PNG dims from {png_path} ({exc}); "
              "skipping dimension check.", file=sys.stderr)
        return None


def _expected_png_dims(target_w: float, target_h: float) -> tuple[int, int]:
    """Convert panel-space target dims to expected PNG pixel dims for the
    standard `drawio -b 10 --scale 2` panel export."""
    w = round(target_w * EXPORT_SCALE + 2 * EXPORT_BORDER)
    h = round(target_h * EXPORT_SCALE + 2 * EXPORT_BORDER)
    return w, h


def _dimension_issues(panel_id: str, png_size: tuple[int, int],
                      target: tuple[float, float] | None,
                      tolerance: float = DIMENSION_TOLERANCE) -> list[dict]:
    """Return zero or one `check: "dimensions"` issue if the rendered PNG
    is more than `tolerance` off the expected size on either axis.

    Returns an empty list when `target` is None (no dimension constraint
    available — backwards-compat path) or when both axes are within
    tolerance.
    """
    if target is None:
        return []
    actual_w, actual_h = png_size
    target_w, target_h = target
    expected_w, expected_h = _expected_png_dims(target_w, target_h)
    if expected_w <= 0 or expected_h <= 0:
        return []
    ratio_w = actual_w / expected_w
    ratio_h = actual_h / expected_h
    lo, hi = 1.0 - tolerance, 1.0 + tolerance
    if lo <= ratio_w <= hi and lo <= ratio_h <= hi:
        return []
    pct = round(tolerance * 100)
    return [{
        "location": "panel page bounds",
        "element": f"PAGE_W × PAGE_H in generate_{panel_id}.py",
        "description": (
            f"the rendered PNG is {actual_w}x{actual_h} px but the panel's "
            f"figure.json proportion_w / proportion_h implies "
            f"~{expected_w}x{expected_h} px "
            f"(width off by {(ratio_w - 1) * 100:+.1f}%, "
            f"height off by {(ratio_h - 1) * 100:+.1f}%; tolerance ±{pct}%). "
            f"Adjust PAGE_W / PAGE_H in generate_{panel_id}.py so the panel "
            f"is roughly {target_w:.0f} x {target_h:.0f} panel-space units."
        ),
        "severity": "critical",
        "check": "dimensions",
    }]


def _validate_verdict(obj: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(obj, dict):
        return ["top-level value is not a JSON object"]
    if not isinstance(obj.get("has_defects"), bool):
        errors.append("`has_defects` missing or not a bool")
    issues = obj.get("issues")
    if not isinstance(issues, list):
        errors.append("`issues` missing or not a list")
        return errors
    for i, issue in enumerate(issues):
        if not isinstance(issue, dict):
            errors.append(f"issues[{i}] is not an object")
            continue
        for key in ("location", "element", "description", "severity"):
            if not isinstance(issue.get(key), str):
                errors.append(f"issues[{i}].{key} missing or not a string")
        if isinstance(issue.get("severity"), str) and issue["severity"] not in VALID_SEVERITIES:
            errors.append(f"issues[{i}].severity={issue['severity']!r} not in {sorted(VALID_SEVERITIES)}")
    if not isinstance(obj.get("summary"), str):
        errors.append("`summary` missing or not a string")
    return errors


def _cli() -> int:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--workdir", required=True, type=Path,
                   help="Per-invocation workdir containing the panel's plan "
                        "and `panels/<panel_id>.png`.")
    p.add_argument("--panel-id", required=True,
                   help="Panel id (matches the id in figure.json and the "
                        "filename stems of the panel's artifacts).")
    p.add_argument("--png", type=Path, default=None,
                   help="PNG to inspect "
                        "(default: <workdir>/panels/<panel_id>.png).")
    p.add_argument("--plan", type=Path, default=None,
                   help="Plan markdown for the panel "
                        "(default: <workdir>/<panel_id>.plan.md).")
    p.add_argument("--methods", type=Path, default=None,
                   help="Path to methods.md (default: "
                        "<workdir>/methods.md). Source of truth for "
                        "the truth-pass audit.")
    p.add_argument("--figure-json", type=Path, default=None,
                   help="Path to figure.json (default: "
                        "<workdir>/figure.json). Used to look up the "
                        "panel's proportion_w / proportion_h for the "
                        "deterministic dimension check; if the file is "
                        "missing or the proportions are absent the "
                        "dimension check is silently skipped.")
    p.add_argument("--out", type=Path, default=None,
                   help="Verdict JSON output "
                        "(default: <workdir>/panels/<panel_id>.inspect.json).")
    # dest="vlm" keeps the internal attribute stable (args.vlm, VLM_REGISTRY
    # lookups); the user-facing flag is --audit-vlm, shared with Phase 6.
    p.add_argument("--audit-vlm", dest="vlm", default=DEFAULT_VLM,
                   choices=VLM_CHOICES,
                   help=f"Vision-language model to audit the panel. "
                        f"Choices: {', '.join(VLM_CHOICES)} "
                        f"(default: {DEFAULT_VLM}, from $AUDIT_VLM — shared "
                        f"with the Phase 6 verify audit). Determines both the "
                        f"API backend (OpenAI vs Gemini) and the resolved "
                        f"model id.")
    p.add_argument("--vlm", dest="vlm", choices=VLM_CHOICES,
                   default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    p.add_argument("--model", default=None,
                   help="Override the API model id (advanced). By default "
                        "this is derived from --audit-vlm "
                        "(gpt-6-astra → gpt-6-astra at high reasoning "
                        "effort; gpt-5.5 → gpt-5.5; gemini-3.1-pro → "
                        "gemini-3.1-pro-preview). Setting this only "
                        "changes the model id sent to the selected "
                        "backend; it does not switch backend.")
    p.add_argument("--max-edge", type=int, default=DEFAULT_MAX_EDGE,
                   help=f"Max input image edge in px before resize "
                        f"(default: {DEFAULT_MAX_EDGE}).")
    p.add_argument("--attempt", type=int, default=1,
                   help="Repair-loop attempt number, recorded in the JSON "
                        "verdict for traceability (default: 1).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the prompt and resolved paths; skip the API call.")
    args = p.parse_args()

    panel_id: str = args.panel_id
    workdir: Path = args.workdir

    png_path: Path = args.png or (workdir / "panels" / f"{panel_id}.png")
    plan_path: Path = args.plan or (workdir / f"{panel_id}.plan.md")
    methods_path: Path = args.methods or (workdir / "methods.md")
    figure_json_path: Path = args.figure_json or (workdir / "figure.json")
    out_path: Path = args.out or (workdir / "panels" / f"{panel_id}.inspect.json")

    if not png_path.exists():
        print(f"ERROR: panel PNG not found at {png_path}", file=sys.stderr)
        return 2
    if not plan_path.exists():
        print(f"ERROR: panel plan not found at {plan_path}", file=sys.stderr)
        return 2
    if not methods_path.exists():
        print(
            f"ERROR: methods file not found at {methods_path}.\n"
            "  methods.md is the source of truth for the truth-pass "
            "audit; pass --methods or place it at <workdir>/methods.md.",
            file=sys.stderr,
        )
        return 2

    plan_text = plan_path.read_text()
    print(f"loaded plan:    {plan_path} ({len(plan_text)} chars)")
    methods_text = methods_path.read_text()
    print(f"loaded methods: {methods_path} ({len(methods_text)} chars)")

    placeholders_path = workdir / f"placeholders_{panel_id}.jsonl"
    placeholders = _load_placeholders(placeholders_path)
    if placeholders:
        print(f"loaded placeholders: {placeholders_path} "
              f"({len(placeholders)} entr{'y' if len(placeholders)==1 else 'ies'})")

    mpl_placeholders_path = workdir / f"placeholders_{panel_id}_mpl.jsonl"
    mpl_placeholders = _load_placeholders(mpl_placeholders_path)
    if mpl_placeholders:
        print(f"loaded mpl placeholders: {mpl_placeholders_path} "
              f"({len(mpl_placeholders)} entr{'y' if len(mpl_placeholders)==1 else 'ies'})")

    rendering_prompt = build_rendering_prompt(
        panel_id, plan_text, placeholders, mpl_placeholders
    )
    truth_prompt = build_truth_prompt(
        panel_id, plan_text, methods_text, placeholders, mpl_placeholders
    )
    detail_prompt = build_detail_prompt(
        panel_id, plan_text, methods_text, placeholders, mpl_placeholders
    )

    target = _resolve_panel_target(figure_json_path, panel_id)
    if target is not None:
        tw, th = target
        ew, eh = _expected_png_dims(tw, th)
        print(
            f"dimension target: proportion-derived panel-space "
            f"{tw:.0f}x{th:.0f} → expected PNG ~{ew}x{eh} px "
            f"(±{round(DIMENSION_TOLERANCE * 100)}%, "
            f"--scale {EXPORT_SCALE} -b {EXPORT_BORDER})"
        )

    backend = VLM_REGISTRY[args.vlm]["backend"]
    resolved_model = args.model or VLM_REGISTRY[args.vlm]["model"]
    reasoning_effort = VLM_REGISTRY[args.vlm].get("reasoning_effort")

    if args.dry_run:
        print(f"[dry-run] audit-vlm:   {args.vlm} (backend={backend})")
        print(f"[dry-run] model:       {resolved_model}"
              f"{' (override)' if args.model else ' (from --audit-vlm)'}")
        print(f"[dry-run] reasoning:   {reasoning_effort or '(backend default)'}")
        print(f"[dry-run] panel-id:    {panel_id}")
        print(f"[dry-run] png:         {png_path}")
        print(f"[dry-run] plan:        {plan_path}")
        print(f"[dry-run] methods:     {methods_path}")
        print(f"[dry-run] figure-json: {figure_json_path}")
        print(f"[dry-run] out:         {out_path}")
        print(f"[dry-run] attempt:     {args.attempt}")
        print(f"[dry-run] rendering prompt ({len(rendering_prompt)} chars):")
        print("─" * 72)
        print(rendering_prompt)
        print("─" * 72)
        print(f"[dry-run] truth prompt ({len(truth_prompt)} chars):")
        print("─" * 72)
        print(truth_prompt)
        print("─" * 72)
        print(f"[dry-run] detail prompt ({len(detail_prompt)} chars):")
        print("─" * 72)
        print(detail_prompt)
        print("─" * 72)
        print("[dry-run] API calls skipped.")
        return 0

    raw_png_size = _raw_png_dims(png_path)
    png_bytes, _, png_size = prepare_input_image(png_path, args.max_edge)
    print(f"png: {png_path} → raw "
          f"{raw_png_size[0]}x{raw_png_size[1]} px"
          if raw_png_size else f"png: {png_path}")
    print(f"vision input: {png_size[0]}x{png_size[1]} "
          f"({len(png_bytes)/1024:.1f} KB)")

    dimension_issues = (
        _dimension_issues(panel_id, raw_png_size, target)
        if raw_png_size is not None else []
    )
    if dimension_issues:
        print(f"dimension check: FAIL ({dimension_issues[0]['description']})")
    elif target is not None and raw_png_size is not None:
        print("dimension check: OK (within tolerance)")

    out_path.parent.mkdir(parents=True, exist_ok=True)

    return _call_backend(
        vlm=args.vlm,
        backend=backend,
        model=resolved_model,
        reasoning_effort=reasoning_effort,
        rendering_prompt=rendering_prompt,
        truth_prompt=truth_prompt,
        detail_prompt=detail_prompt,
        png_bytes=png_bytes,
        png_path=png_path,
        panel_id=panel_id,
        out_path=out_path,
        attempt=args.attempt,
        dimension_issues=dimension_issues,
        workdir=workdir,
    )


# --- OpenAI / Gemini client bootstrap helpers ---------------------------------


def _b64_data_url(jpeg_bytes: bytes) -> str:
    import base64
    return "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode("ascii")


def _ensure_openai_key() -> int | None:
    if os.environ.get("OPENAI_API_KEY"):
        return None
    from_dotenv = load_dotenv_key("OPENAI_API_KEY")
    if from_dotenv:
        os.environ["OPENAI_API_KEY"] = from_dotenv
        print("loaded OPENAI_API_KEY from .env")
        return None
    print("ERROR: OPENAI_API_KEY is not set in env or .env (cwd).",
          file=sys.stderr)
    return 2


def _import_openai():
    try:
        from openai import OpenAI  # type: ignore
        return OpenAI
    except ImportError:
        print(
            "ERROR: the `openai` package is not installed.\n"
            f"  {sys.executable} -m pip install 'openai>=1.50'",
            file=sys.stderr,
        )
        return None


def _ensure_gemini_key() -> int | None:
    if os.environ.get("GEMINI_API_KEY"):
        return None
    from_dotenv = load_dotenv_key("GEMINI_API_KEY")
    if from_dotenv:
        os.environ["GEMINI_API_KEY"] = from_dotenv
        print("loaded GEMINI_API_KEY from .env")
        return None
    print("ERROR: GEMINI_API_KEY is not set in env or .env (cwd).",
          file=sys.stderr)
    return 2


def _import_gemini():
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
        return genai, types
    except ImportError:
        print(
            "ERROR: the `google-genai` package is not installed.\n"
            f"  {sys.executable} -m pip install 'google-genai>=1.0'",
            file=sys.stderr,
        )
        return None


# --- Backend dispatcher -------------------------------------------------------


def _call_backend(*, vlm: str, backend: str, model: str,
                  reasoning_effort: str | None = None,
                  rendering_prompt: str, truth_prompt: str,
                  detail_prompt: str,
                  png_bytes: bytes, png_path: Path, panel_id: str,
                  out_path: Path, attempt: int, workdir: Path,
                  dimension_issues: list[dict] | None = None) -> int:
    """Run rendering + truth + detail passes against the selected backend."""
    raw_path = out_path.with_name(out_path.stem + ".raw.txt")

    if backend == "openai":
        err = _ensure_openai_key()
        if err is not None:
            return err
        OpenAI = _import_openai()
        if OpenAI is None:
            return 2
        client = OpenAI()
        run_pass = lambda **kw: _run_pass_openai(
            client=client, workdir=workdir, source="openai-vision",
            reasoning_effort=reasoning_effort, **kw
        )
    elif backend == "gemini":
        err = _ensure_gemini_key()
        if err is not None:
            return err
        imp = _import_gemini()
        if imp is None:
            return 2
        genai, types = imp
        client = genai.Client()
        run_pass = lambda **kw: _run_pass_gemini(
            client=client, types_module=types, workdir=workdir,
            source="gemini-vision", **kw
        )
    else:
        print(f"ERROR: unknown backend {backend!r} for --audit-vlm {vlm!r}",
              file=sys.stderr)
        return 2

    rendering_verdict, err = run_pass(
        model=model,
        system_prompt=rendering_prompt,
        png_bytes=png_bytes,
        panel_id=panel_id,
        attempt=attempt,
        check_name="rendering",
        user_text=(
            f"RENDERED PNG for panel `{panel_id}`. Audit it against "
            "the panel spec embedded above and return JSON only."
        ),
        raw_path=raw_path,
    )
    if err is not None:
        return err

    truth_verdict, err = run_pass(
        model=model,
        system_prompt=truth_prompt,
        png_bytes=png_bytes,
        panel_id=panel_id,
        attempt=attempt,
        check_name="truth",
        user_text=(
            f"RENDERED PNG for panel `{panel_id}`. Audit it against "
            "METHODS (scoped by the panel spec) and return JSON only."
        ),
        raw_path=raw_path,
    )
    if err is not None:
        return err

    detail_verdict, err = run_pass(
        model=model,
        system_prompt=detail_prompt,
        png_bytes=png_bytes,
        panel_id=panel_id,
        attempt=attempt,
        check_name="detail",
        user_text=(
            f"RENDERED PNG for panel `{panel_id}`. Answer the single "
            "question: is there enough detail in this panel to "
            "understand the slice of the method it depicts? Return "
            "JSON only."
        ),
        raw_path=raw_path,
    )
    if err is not None:
        return err

    rendering_issues = [
        {**issue, "check": "rendering"}
        for issue in rendering_verdict.get("issues", [])
    ]
    truth_issues = [
        {**issue, "check": "truth"}
        for issue in truth_verdict.get("issues", [])
    ]
    detail_issues = [
        {**issue, "check": "detail"}
        for issue in detail_verdict.get("issues", [])
    ]
    dimension_issues = list(dimension_issues or [])
    issues = rendering_issues + truth_issues + detail_issues + dimension_issues
    has_critical = any(
        isinstance(i, dict) and i.get("severity") == "critical"
        for i in issues
    )

    dimensions_summary = (
        dimension_issues[0]["description"] if dimension_issues
        else "panel PNG matches the figure.json proportions within tolerance"
    )

    full_verdict = {
        "schema_version": SCHEMA_VERSION,
        "attempt": attempt,
        "model": model,
        "panel_id": panel_id,
        "png": str(png_path),
        "has_defects": has_critical,
        "issues": issues,
        "summary": (
            f"rendering pass — {rendering_verdict.get('summary', '').strip()}"
            f"\ntruth pass — {truth_verdict.get('summary', '').strip()}"
            f"\ndetail pass — {detail_verdict.get('summary', '').strip()}"
            f"\ndimensions pass — {dimensions_summary}"
        ),
        "rendering_summary": rendering_verdict.get("summary", ""),
        "truth_summary": truth_verdict.get("summary", ""),
        "detail_summary": detail_verdict.get("summary", ""),
        "dimensions_summary": dimensions_summary,
    }
    out_path.write_text(json.dumps(full_verdict, indent=2) + "\n")
    print(
        f"wrote {out_path}: has_defects={has_critical}, "
        f"{len(rendering_issues)} rendering + {len(truth_issues)} truth + "
        f"{len(detail_issues)} detail + "
        f"{len(dimension_issues)} dimensions = {len(issues)} issue(s)"
    )
    if raw_path.exists():
        raw_path.unlink()
    return 0


def _salvage_json(raw: str) -> dict | None:
    """Best-effort recovery of a verdict object from malformed model output.

    The Gemini backend intermittently emits an otherwise-valid verdict object
    wrapped in code fences, followed by a stray closing brace, or truncated
    before its final brace. Only the error path calls this; the fast path is
    an untouched `json.loads`. Returns a dict on success, else None.
    """
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    if start == -1:
        return None
    text = text[start:]
    # Trailing extra data (e.g. a duplicated closing brace): decode just the
    # leading JSON value and drop whatever follows.
    try:
        obj, _ = json.JSONDecoder().raw_decode(text)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    # Unterminated object/array: append the missing closers outside strings.
    stack: list[str] = []
    in_str = False
    escaped = False
    for ch in text:
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]" and stack:
            stack.pop()
    if in_str:
        text += '"'
    candidate = text + "".join(reversed(stack))
    try:
        obj = json.loads(candidate)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def _parse_and_validate(raw: str, *, check_name: str,
                        raw_path: Path) -> tuple[dict, int | None]:
    """Shared post-call parsing: decode JSON, schema-validate, persist raw
    text on failure. Returns (verdict_dict, error_code_or_None)."""
    try:
        verdict = json.loads(raw)
    except json.JSONDecodeError as exc:
        verdict = _salvage_json(raw)
        if verdict is None:
            raw_path.write_text(raw)
            print(
                f"ERROR: {check_name} pass returned non-JSON output ({exc}); "
                f"raw saved to {raw_path}",
                file=sys.stderr,
            )
            return {}, 1
        print(
            f"note: {check_name} pass returned malformed JSON ({exc}); "
            f"salvaged a valid verdict from the leading object.",
            file=sys.stderr,
        )

    schema_errors = _validate_verdict(verdict)
    if schema_errors:
        raw_path.write_text(raw)
        print(
            f"ERROR: {check_name} pass output failed schema validation:",
            file=sys.stderr,
        )
        for err in schema_errors:
            print(f"  - {err}", file=sys.stderr)
        print(f"raw saved to {raw_path}", file=sys.stderr)
        return {}, 1

    return verdict, None


def _run_pass_gemini(*, client, types_module, model: str, system_prompt: str,
                     png_bytes: bytes, panel_id: str, attempt: int,
                     check_name: str, user_text: str, raw_path: Path,
                     workdir: Path, source: str) -> tuple[dict, int | None]:
    """Run one Gemini audit pass. Returns (verdict_dict, error_code_or_None)."""
    parts = [
        types_module.Part.from_text(text=user_text),
        types_module.Part.from_bytes(data=png_bytes, mime_type="image/jpeg"),
    ]

    print(
        f"calling {model} (attempt={attempt}, check={check_name}) "
        f"for panel `{panel_id}` ..."
    )
    started = time.perf_counter()
    try:
        result = client.models.generate_content(
            model=model,
            contents=parts,
            config=types_module.GenerateContentConfig(
                system_instruction=system_prompt,
                response_mime_type="application/json",
                temperature=0.2,
            ),
        )
    except Exception as exc:
        print(f"ERROR: Gemini API call ({check_name}) failed: {exc}",
              file=sys.stderr)
        return {}, 1

    # Record before parse/validation — the API cost is incurred regardless of
    # whether the returned JSON later validates.
    meta = getattr(result, "usage_metadata", None)
    record_usage(workdir, phase=3, source=source, model=model,
                 duration_secs=time.perf_counter() - started, basis="tokens",
                 input_tokens=getattr(meta, "prompt_token_count", None),
                 output_tokens=getattr(meta, "candidates_token_count", None))
    return _parse_and_validate(result.text or "",
                               check_name=check_name, raw_path=raw_path)


def _reasoning_kwargs(effort: str | None) -> dict:
    return {"reasoning_effort": effort} if effort else {}


def _run_pass_openai(*, client, model: str, system_prompt: str,
                     png_bytes: bytes, panel_id: str, attempt: int,
                     check_name: str, user_text: str, raw_path: Path,
                     workdir: Path, source: str,
                     reasoning_effort: str | None = None) -> tuple[dict, int | None]:
    """Run one OpenAI audit pass. Returns (verdict_dict, error_code_or_None)."""
    data_url = _b64_data_url(png_bytes)
    print(
        f"calling {model} (attempt={attempt}, check={check_name}) "
        f"for panel `{panel_id}` ..."
    )
    started = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ]},
            ],
            response_format={"type": "json_object"},
            **_reasoning_kwargs(reasoning_effort),
        )
    except Exception as exc:
        print(f"ERROR: OpenAI API call ({check_name}) failed: {exc}",
              file=sys.stderr)
        return {}, 1

    usage = getattr(response, "usage", None)
    record_usage(workdir, phase=3, source=source, model=model,
                 duration_secs=time.perf_counter() - started, basis="tokens",
                 input_tokens=getattr(usage, "prompt_tokens", None),
                 output_tokens=getattr(usage, "completion_tokens", None))
    raw = response.choices[0].message.content or ""
    return _parse_and_validate(raw, check_name=check_name, raw_path=raw_path)


if __name__ == "__main__":
    sys.exit(_cli())
