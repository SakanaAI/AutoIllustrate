"""Lint a drawio template for math-delimiter and edge-structural rules.

Math rules (a)-(e) from references/template_authoring.md
("CRITICAL: preventing MathJax line breaks"). Edge rules (f)-(g) from
references/panel_agent.md ("No orthogonalEdgeStyle", "Python-owned
edge colors"):

  (a) Math-only labels must use $$...$$, not \\(...\\).
  (b) Any cell whose value contains math (\\(...\\) or $$...$$) must
      use `whiteSpace=wrap` in its cell `style` attribute.
      `whiteSpace=nowrap` is broken with MathJax CHTML in drawio: the
      renderer leaves the inner div at width:auto inside a foreignObject
      whose layout shrink-fits to each MathJax atom (each `mjx-container`
      is `display:inline-block`), so equations break at every space —
      i.e. at every `=`, `+`, `-`, `\\cdot`, etc. — even though the cell
      says "nowrap". `whiteSpace=wrap` instead sets an explicit
      width:<geometry>px on the inner div, giving MathJax a stable
      inline formatting context. The inner-span trick
      (`<span style="white-space:nowrap;display:inline-block">`)
      empirically does NOT help: MathJax replaces the span's contents
      with its own DOM, severing the CSS link. Only the cell-level
      `whiteSpace` matters.
  (c) Inline \\(...\\) must not "protect" operators with brace groups
      ({=}, {:}, {<}, {>}, {\\propto}, {\\leq}, {\\geq}) or explicit
      spacings (\\;, \\,). Brace groups INCREASE MathJax atom
      boundaries and produce more breaks, not fewer.
  (d) $$...$$ must NOT be used inline (i.e. in a label that also
      contains prose/HTML). Inline math is ALWAYS \\(...\\).
      $$...$$ is reserved for labels whose content is exclusively
      display math.
  (e) Single-dollar $...$ delimiters are forbidden. MathJax's
      single-dollar inline mode is disabled by default in drawio and
      the expression renders as literal text.
  (f) `edgeStyle=orthogonalEdgeStyle` (or any auto-routing edgeStyle)
      is forbidden in any mxCell style. Every routed edge's polyline
      is owned by the Python script's `build_paths()` and validated by
      `check_orthogonal_waypoints` / `check_path_crossings`; an
      auto-routed edge diverges from the Python-checked polyline and
      silently invalidates both checks. Either omit `edgeStyle`
      entirely or set `edgeStyle=none`, and declare waypoints inline
      via `<mxGeometry><Array as="points">…</Array></mxGeometry>`.
  (g) Edge mxCells (cells with `edge="1"`) must NOT carry a hardcoded
      `strokeColor=#…` hex literal — the value must be a Python
      `{placeholder}` filled from `Path.color`. The crossing check
      ("paths of different colors may cross") needs Python to be the
      single source of truth for stroke color.
  (h) An edge mxCell whose `<mxGeometry>` contains a
      `<Array as="points">` waypoint list (i.e. a routed edge) must
      NOT use `source="…"` / `target="…"` attributes or the
      `exitX` / `exitY` / `entryX` / `entryY` style tokens. With those
      set, drawio derives the rendered source/target endpoints from
      the connected shapes — NOT from `Path.points[0]` /
      `Path.points[-1]` — which silently invalidates the
      orthogonal-waypoint and crossing checks (the polyline drawn is
      not the polyline Python validated). Instead, declare both
      endpoints as `<mxPoint x="{…}" y="{…}" as="sourcePoint"/>` /
      `<mxPoint … as="targetPoint"/>` with `{placeholder}` slots
      filled from `Path.points[0]` and `Path.points[-1]`. The
      placeholder KEYS must end in `_x<digits>` / `_y<digits>` so the
      Phase 4 composer (compose.py `COORD_X_RE` / `COORD_Y_RE`)
      offsets them by the panel origin alongside the rest of the
      polyline; ad-hoc names like `_sx`/`_tx` silently break
      composition because endpoints stay in panel-local space while
      the `<Array as="points">` waypoints shift to composite space.
      Straight edges with no waypoint Array may keep
      `source=`/`target=`.

Usage:
    "$PYTHON" scripts/lint_math.py <template.drawio.template> [<template2> ...]

Exits non-zero on the first violation, printing the offending file +
mxCell id + value.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Match each <mxCell ...> open tag (attributes can be in any order, so we
# extract id/style/value with separate regexes from the captured tag).
CELL_OPEN_RE = re.compile(r"<mxCell\b[^>]*>", re.DOTALL)
ID_ATTR_RE = re.compile(r'\bid="([^"]*)"')
STYLE_ATTR_RE = re.compile(r'\bstyle="([^"]*)"')
VALUE_ATTR_RE = re.compile(r'\bvalue="([^"]*)"')

INLINE_MATH_RE = re.compile(r"\\\(.+?\\\)", re.DOTALL)
DISPLAY_MATH_RE = re.compile(r"\$\$.+?\$\$", re.DOTALL)
# Single-dollar $...$ that is NOT part of $$...$$. Negative lookarounds
# guard against adjacent $ on either side; we also strip $$...$$ blocks
# from the search text before applying this regex (see single_dollar_math).
SINGLE_DOLLAR_MATH_RE = re.compile(r"(?<!\$)\$(?!\$)[^$\n]+?(?<!\$)\$(?!\$)")
# Tokens that don't count as "prose" when checking whether a $$...$$ is
# used inline: pure whitespace, <br>, &nbsp;, and their HTML-escaped forms.
WHITESPACE_OR_BR_RE = re.compile(
    r"(?:\s|<br\s*/?>|&lt;br\s*/?&gt;|&nbsp;|&#160;)+",
    re.IGNORECASE,
)
# Brace-protected operators / spacing tricks that empirically cause MORE
# MathJax breaks, not fewer. Match `{=}`, `{:}`, `{<}`, `{>}`,
# `{\propto}`, `{\leq}`, `{\geq}`, `{\le}`, `{\ge}`, `{\neq}`, `{\sim}`,
# `{\cdot}`, plus explicit spacings `\;` and `\,`.
BRACE_PROTECTED_OP_RE = re.compile(
    r"\{(?:[=:<>]|\\(?:propto|leq|geq|le|ge|neq|sim|cdot))\}|\\[;,]"
)
# Match `whiteSpace=nowrap` as a discrete style token (i.e. preceded by
# `;` or start-of-string and followed by `;` or end-of-string). Without
# the boundaries we'd false-positive on substrings.
WHITESPACE_NOWRAP_RE = re.compile(r"(?:^|;)\s*whiteSpace\s*=\s*nowrap\s*(?:;|$)")
# Match `edge="1"` (or `edge='1'`) on an mxCell open tag.
EDGE_ATTR_RE = re.compile(r'\bedge\s*=\s*"1"')
# Match `edgeStyle=<value>` as a discrete style token. We flag ANY value
# other than `none` — `orthogonalEdgeStyle`, `elbowEdgeStyle`,
# `entityRelationEdgeStyle`, `isometricEdgeStyle`, `loopEdgeStyle`,
# `manhattan*`, etc. are all auto-routers that diverge from the
# Python-checked polyline.
EDGE_STYLE_RE = re.compile(r"(?:^|;)\s*edgeStyle\s*=\s*([^;]+?)\s*(?:;|$)")
# Match `strokeColor=<value>` as a discrete style token. The value is
# captured so we can tell a `{placeholder}` (allowed on edges) apart
# from a hex literal `#…` / `none` / a named color (all forbidden on
# edges).
STROKE_COLOR_RE = re.compile(r"(?:^|;)\s*strokeColor\s*=\s*([^;]+?)\s*(?:;|$)")
# Whole edge mxCell block: open tag (captured) + body up to </mxCell>
# (captured). mxCells don't nest, so the lazy match is safe. Edges
# always carry a child <mxGeometry>, so they can never be self-closed.
EDGE_CELL_BLOCK_RE = re.compile(
    r'(<mxCell\b[^>]*\bedge\s*=\s*"1"[^>]*>)(.*?)</mxCell>',
    re.DOTALL,
)
# `<Array as="points">` child — the marker for "this edge has waypoints".
WAYPOINT_ARRAY_RE = re.compile(r'<Array\b[^>]*\bas\s*=\s*"points"')
# `source="..."` / `target="..."` attributes on the open tag.
SOURCE_ATTR_RE = re.compile(r'\bsource\s*=\s*"')
TARGET_ATTR_RE = re.compile(r'\btarget\s*=\s*"')
# `exitX` / `exitY` / `entryX` / `entryY` as discrete style tokens.
EXIT_ENTRY_STYLE_RE = re.compile(
    r"(?:^|;)\s*(exitX|exitY|entryX|entryY)\s*="
)
# `<mxPoint ... as="sourcePoint"/>` / `<mxPoint ... as="targetPoint"/>`
# children. Capture the whole tag so the x/y attrs can be checked.
SOURCEPOINT_TAG_RE = re.compile(
    r'<mxPoint\b[^/>]*\bas\s*=\s*"sourcePoint"[^/>]*/?>'
)
TARGETPOINT_TAG_RE = re.compile(
    r'<mxPoint\b[^/>]*\bas\s*=\s*"targetPoint"[^/>]*/?>'
)
# `x="{name}"` / `y="{name}"` placeholder attributes on an mxPoint.
# The key is captured so rule (h) can verify it ends in `_x<digits>` /
# `_y<digits>` — matching the composer's offset regex (see compose.py
# COORD_X_RE / COORD_Y_RE). Endpoint keys that don't fit (e.g. `_sx`,
# `_tx`) silently break composition because they aren't shifted by the
# panel origin.
MXPOINT_X_PLACEHOLDER_RE = re.compile(r'\bx\s*=\s*"\{([^{}"]+)\}"')
MXPOINT_Y_PLACEHOLDER_RE = re.compile(r'\by\s*=\s*"\{([^{}"]+)\}"')
COMPOSER_X_KEY_RE = re.compile(r"_x\d*$")
COMPOSER_Y_KEY_RE = re.compile(r"_y\d*$")


def is_math_only(value: str) -> bool:
    """True if the value (after trimming) is exactly one \\(...\\) span and
    nothing else (no surrounding HTML/text)."""
    v = value.strip()
    if not (v.startswith("\\(") and v.endswith("\\)")):
        return False
    # Confirm no other \( inside (i.e. it's a single math span).
    return v.count("\\(") == 1 and v.count("\\)") == 1


def cell_whitespace_nowrap(style: str, value: str) -> list[str]:
    """Flag cells whose value contains math but whose style sets
    `whiteSpace=nowrap` (rule (b)). `whiteSpace=nowrap` is broken with
    MathJax CHTML in drawio and causes equations to wrap at every
    operator — use `whiteSpace=wrap` instead."""
    if not (INLINE_MATH_RE.search(value) or DISPLAY_MATH_RE.search(value)):
        return []
    if not WHITESPACE_NOWRAP_RE.search(style):
        return []
    return [
        "cell containing math has `whiteSpace=nowrap` in its style; this "
        "is BROKEN with MathJax CHTML and causes equations to wrap at "
        "every operator (=, +, -, \\cdot, ...). Use "
        "`whiteSpace=wrap;overflow=visible;` instead, and make sure the "
        "cell geometry is wide enough to fit the equation on one line."
    ]


def display_math_used_inline(value: str) -> list[str]:
    """Flag $$...$$ that appears in a value alongside any non-math content
    (rule (d)). Inline math is ALWAYS \\(...\\); $$...$$ is reserved for
    labels whose content is exclusively display math (whitespace and
    <br>/&nbsp; between $$ blocks is allowed)."""
    matches = list(DISPLAY_MATH_RE.finditer(value))
    if not matches:
        return []
    stripped = DISPLAY_MATH_RE.sub("", value)
    stripped = WHITESPACE_OR_BR_RE.sub("", stripped)
    if not stripped:
        return []
    return [
        f"$$...$$ used inline (label also contains non-math content "
        f"{stripped!r}); inline math must be \\(...\\). "
        f"Offending math: {m.group(0)!r}"
        for m in matches
    ]


def single_dollar_math(value: str) -> list[str]:
    """Flag single-dollar $...$ delimiters (rule (e)). MathJax's
    single-dollar inline mode is disabled by default in drawio, so the
    expression renders as literal text. Strip $$...$$ blocks first to
    avoid false positives on display-math dollar pairs."""
    cleaned = DISPLAY_MATH_RE.sub("", value)
    return [
        f"single-dollar delimiter {m.group(0)!r}; MathJax single-dollar "
        f"inline is disabled in drawio. Use $$...$$ for math-only labels "
        f"or \\(...\\) for inline math."
        for m in SINGLE_DOLLAR_MATH_RE.finditer(cleaned)
    ]


def brace_protected_operators(value: str) -> list[str]:
    """Flag brace-protected operators / explicit spacings inside any
    \\(...\\) span. These INCREASE MathJax atom boundaries and produce
    more breaks, not fewer (skill rule (c))."""
    errs: list[str] = []
    for m in INLINE_MATH_RE.finditer(value):
        math = m.group(0)
        for hit in BRACE_PROTECTED_OP_RE.finditer(math):
            errs.append(
                f"brace-protected operator / explicit spacing "
                f"{hit.group(0)!r} inside inline math {math!r}; "
                f"use natural form (e.g. `\\alpha = 3`, not `\\alpha{{=}}3`)."
            )
    return errs


def auto_routed_edge_style(style: str) -> list[str]:
    """Flag any `edgeStyle=<value>` token where `<value>` is not
    `none` (rule (f)). Auto-routers diverge from the Python-checked
    polyline and silently invalidate the orthogonal-waypoint and
    crossing checks."""
    errs: list[str] = []
    for hit in EDGE_STYLE_RE.finditer(style):
        val = hit.group(1).strip()
        if val == "none":
            continue
        errs.append(
            f"style declares `edgeStyle={val}` (auto-routing); this is "
            f"forbidden because Python owns the edge polyline via "
            f"`Path.points`. Either drop `edgeStyle=` entirely or set "
            f"`edgeStyle=none`, and put waypoints in "
            f"`<mxGeometry><Array as=\"points\">…</Array></mxGeometry>` "
            f"with `{{placeholder}}` slots."
        )
    return errs


def hardcoded_edge_stroke_color(style: str, is_edge: bool) -> list[str]:
    """For edge mxCells (`edge=\"1\"`), flag `strokeColor=<value>` where
    `<value>` is not a Python `{placeholder}` (rule (g)). The crossing
    check needs Python to own the stroke color so 'different colors are
    allowed to cross' is enforceable."""
    if not is_edge:
        return []
    errs: list[str] = []
    for hit in STROKE_COLOR_RE.finditer(style):
        val = hit.group(1).strip()
        if val.startswith("{") and val.endswith("}"):
            continue
        errs.append(
            f"edge mxCell has hardcoded `strokeColor={val}`; edge stroke "
            f"colors must be a Python `{{placeholder}}` filled from "
            f"`Path.color` so `check_path_crossings` can enforce the "
            f"'different-colored paths may cross' rule."
        )
    return errs


def waypointed_edge_endpoints(open_tag: str, body: str) -> list[str]:
    """Rule (h): an edge with a `<Array as=\"points\">` waypoint list
    must declare its endpoints with explicit Python-owned
    sourcePoint/targetPoint mxPoints — NOT via `source=`/`target=`
    attributes or `exitX/exitY/entryX/entryY` style tokens. The latter
    let drawio derive the rendered endpoints from the connected shapes,
    decoupling rendered geometry from `Path.points[0]` /
    `Path.points[-1]` and silently invalidating the orthogonal-waypoint
    and crossing checks."""
    if not WAYPOINT_ARRAY_RE.search(body):
        return []
    errs: list[str] = []
    style_m = STYLE_ATTR_RE.search(open_tag)
    style = style_m.group(1) if style_m else ""
    if SOURCE_ATTR_RE.search(open_tag):
        errs.append(
            "waypointed edge declares `source=\"…\"`; drawio will derive "
            "the rendered source endpoint from the connected shape, NOT "
            "from `Path.points[0]`. Drop `source=` and add "
            "`<mxPoint x=\"{…}\" y=\"{…}\" as=\"sourcePoint\"/>` as a "
            "child of `<mxGeometry>` with Python-owned `{placeholder}` "
            "coordinates."
        )
    if TARGET_ATTR_RE.search(open_tag):
        errs.append(
            "waypointed edge declares `target=\"…\"`; drawio will derive "
            "the rendered target endpoint from the connected shape, NOT "
            "from `Path.points[-1]`. Drop `target=` and add "
            "`<mxPoint x=\"{…}\" y=\"{…}\" as=\"targetPoint\"/>` as a "
            "child of `<mxGeometry>` with Python-owned `{placeholder}` "
            "coordinates."
        )
    for hit in EXIT_ENTRY_STYLE_RE.finditer(style):
        errs.append(
            f"waypointed edge style contains `{hit.group(1)}=…`; this only "
            f"affects rendering when paired with `source=`/`target=`, "
            f"which are forbidden on waypointed edges. Remove the "
            f"`{hit.group(1)}` token."
        )
    for label, tag_re, points_ref in (
        ("sourcePoint", SOURCEPOINT_TAG_RE, "Path.points[0]"),
        ("targetPoint", TARGETPOINT_TAG_RE, "Path.points[-1]"),
    ):
        tag_m = tag_re.search(body)
        if not tag_m:
            errs.append(
                f"waypointed edge has no `<mxPoint as=\"{label}\"/>` "
                f"child; every routed edge must declare its endpoint "
                f"with Python-owned `{{placeholder}}` coordinates "
                f"filled from `{points_ref}`."
            )
            continue
        tag = tag_m.group(0)
        x_m = MXPOINT_X_PLACEHOLDER_RE.search(tag)
        y_m = MXPOINT_Y_PLACEHOLDER_RE.search(tag)
        if not (x_m and y_m):
            errs.append(
                f"{label} {tag!r} has non-`{{placeholder}}` coordinates; "
                f"x and y must each be a `{{…}}` slot filled from "
                f"`{points_ref}`."
            )
            continue
        x_key, y_key = x_m.group(1), y_m.group(1)
        if not COMPOSER_X_KEY_RE.search(x_key):
            errs.append(
                f"{label} x placeholder `{{{x_key}}}` does not end in "
                f"`_x<digits>` — the Phase 4 composer only offsets keys "
                f"matching `_x\\d*$` by the panel origin, so this "
                f"endpoint stays in panel-local space while the rest of "
                f"the polyline shifts to composite space (the arrow "
                f"snaps to the wrong place). Rename so the key ends in "
                f"`_x<int>` (e.g. for a 4-point polyline name the "
                f"endpoints `<edge>_x0` / `<edge>_x3`)."
            )
        if not COMPOSER_Y_KEY_RE.search(y_key):
            errs.append(
                f"{label} y placeholder `{{{y_key}}}` does not end in "
                f"`_y<digits>` — the Phase 4 composer only offsets keys "
                f"matching `_y\\d*$` by the panel origin, so this "
                f"endpoint stays in panel-local space while the rest of "
                f"the polyline shifts to composite space (the arrow "
                f"snaps to the wrong place). Rename so the key ends in "
                f"`_y<int>` (e.g. for a 4-point polyline name the "
                f"endpoints `<edge>_y0` / `<edge>_y3`)."
            )
    return errs


def lint_file(path: Path) -> list[str]:
    text = path.read_text()
    errs: list[str] = []
    # Rule (h): waypointed edges must own their endpoints via
    # sourcePoint/targetPoint mxPoints, not source=/target=/exit*/entry*.
    for m in EDGE_CELL_BLOCK_RE.finditer(text):
        open_tag = m.group(1)
        body = m.group(2)
        id_m = ID_ATTR_RE.search(open_tag)
        cid = id_m.group(1) if id_m else "<no-id>"
        for e in waypointed_edge_endpoints(open_tag, body):
            errs.append(f"{path}: cell id={cid!r}: {e}")
    for m in CELL_OPEN_RE.finditer(text):
        tag = m.group(0)
        id_m = ID_ATTR_RE.search(tag)
        cid = id_m.group(1) if id_m else "<no-id>"
        style_m = STYLE_ATTR_RE.search(tag)
        style = style_m.group(1) if style_m else ""
        is_edge = bool(EDGE_ATTR_RE.search(tag))
        # Rule (f): no auto-routing edgeStyle on any cell.
        for e in auto_routed_edge_style(style):
            errs.append(f"{path}: cell id={cid!r}: {e}")
        # Rule (g): edge cells must use a `{placeholder}` strokeColor.
        for e in hardcoded_edge_stroke_color(style, is_edge):
            errs.append(f"{path}: cell id={cid!r}: {e}")
        value_m = VALUE_ATTR_RE.search(tag)
        if not value_m:
            continue
        value = value_m.group(1)
        if "$" not in value and "\\(" not in value:
            continue
        # Rule (a): math-only label must use $$...$$ not \(...\).
        if is_math_only(value):
            errs.append(
                f"{path}: cell id={cid!r} is math-only but uses \\(...\\); "
                f"use $$...$$ instead."
            )
            continue
        # Rule (b): cell containing math must use whiteSpace=wrap (not nowrap).
        for e in cell_whitespace_nowrap(style, value):
            errs.append(f"{path}: cell id={cid!r}: {e}")
        # Rule (c): no brace-protected operators / explicit spacings
        # inside \(...\).
        for e in brace_protected_operators(value):
            errs.append(f"{path}: cell id={cid!r}: {e}")
        # Rule (d): $$...$$ must not be used inline.
        for e in display_math_used_inline(value):
            errs.append(f"{path}: cell id={cid!r}: {e}")
        # Rule (e): no single-dollar $...$ delimiters.
        for e in single_dollar_math(value):
            errs.append(f"{path}: cell id={cid!r}: {e}")
    return errs


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("paths", nargs="+", type=Path)
    args = p.parse_args()
    all_errs: list[str] = []
    for path in args.paths:
        if not path.exists():
            print(f"ERROR: file not found: {path}", file=sys.stderr)
            return 2
        all_errs.extend(lint_file(path))
    if all_errs:
        for e in all_errs:
            print(e, file=sys.stderr)
        print(
            f"\nlint_math: {len(all_errs)} violation(s). See "
            f"references/template_authoring.md \"CRITICAL: preventing "
            f"MathJax line breaks\" (rules a-e) and "
            f"references/panel_agent.md (rules f-h: no "
            f"orthogonalEdgeStyle, Python-owned edge colors, "
            f"Python-owned waypointed-edge endpoints).",
            file=sys.stderr,
        )
        return 1
    print(f"lint_math: OK ({len(args.paths)} file(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
