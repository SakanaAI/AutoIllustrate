"""Schema + validation for the drawio-figure decomposition.

A figure is a flat list of panels (max 3) arranged under a single
top-level layout (`row` | `column` | `grid`). There is no nesting and
no notion of a tree — just one figure with up to three panels. The
per-panel field that drives downstream work is `drawio_prompt`, fed
verbatim to the per-panel rendering workflow when each panel is
rendered as its own draw.io diagram. The top-level `placement` field
(`half-width` | `full-width`) records the figure's intended placement
in the paper; it sets the target aspect ratio (16:9 for half-width,
21:9 for full-width) the layout should aim for and is passed to the
Phase 5 enhancer to drive its default `--size`.

Each panel additionally carries a `proportion_w` and `proportion_h`
in (0, 1] — its share of the composite's inner width and height. By
construction, along the axis the figure's layout divides:

- `row`     → sum of panels' `proportion_w` is 1.0; each panel's
              `proportion_h` is 1.0.
- `column`  → each panel's `proportion_w` is 1.0; sum of panels'
              `proportion_h` is 1.0.
- `grid`    → `proportion_w = colspan / grid_cols`,
              `proportion_h = rowspan / grid_rows`; per-row width
              shares and per-column height shares each sum to 1.0
              when that row/column is fully packed.

These proportions are normally populated automatically by running
this script with `--populate-targets` after `--validate`. The
per-panel rendering subagent uses them to pick `PAGE_W` / `PAGE_H`,
and `inspect_panel.py` uses them to dimension-check the rendered
PNG (±15% tolerance, see `inspect_panel.py`).

Run as a script:

    # validate structure only
    python schema.py --validate path/to/figure.json

    # validate, then back-fill proportion_w / proportion_h
    python schema.py --validate path/to/figure.json --populate-targets
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, Field

Layout = Literal["grid", "row", "column"]
Placement = Literal["half-width", "full-width"]

# Canonical interior dimensions of the composite, in draw.io "panel-space"
# units. The composer builds the composite at this fixed coordinate size;
# the Phase 4 `drawio --width` export then rescales it to the target PNG
# width (2560 px). These are the composite's inner area AFTER subtracting
# the composite page margin (24 px on each side, matching `compose.py`'s
# DEFAULT_PAGE_MARGIN). They determine the absolute panel-space target
# size each panel should aim for, given its `proportion_w/h`.
#   full-width: 21:9 outer → 2000 × 832 panel-space (export rescaled to 2560 px wide)
#   half-width: 16:9 outer → 2000 × 1104 panel-space (export rescaled to 2560 px wide)
CANONICAL_INNER: dict[str, tuple[int, int]] = {
    "full-width": (2000, 832),
    "half-width": (2000, 1104),
}


class Panel(BaseModel):
    id: str
    title: str
    short_caption: str

    # The per-panel prompt fed verbatim to the per-panel rendering
    # workflow when this panel is rendered as a draw.io diagram.
    drawio_prompt: str

    # Placement within the figure (only meaningful if layout == "grid").
    row: Optional[int] = None
    col: Optional[int] = None
    rowspan: Optional[int] = Field(default=1)
    colspan: Optional[int] = Field(default=1)

    # Share of the composite's inner width / height this panel should
    # occupy. Both in (0, 1]. Populated by `--populate-targets`; the
    # per-panel agent uses them to pick PAGE_W / PAGE_H and the
    # inspector uses them to dimension-check the rendered PNG.
    proportion_w: Optional[float] = None
    proportion_h: Optional[float] = None


class LetterMark(BaseModel):
    """A caption sub-label ((a), (b), …) placed on the figure.

    Letters form a figure-wide enumeration that maps many-to-one onto
    panels: one panel may own several letters, and there may be more
    letters than panels. Phase 1 assigns each letter to a panel and an
    anchor (prose describing where inside that panel it sits); Phase 2
    draws it. Populated only when the source caption enumerates
    sub-labels; absent otherwise.
    """

    label: str    # "a", "b", ...
    panel: str    # id of the panel this letter appears in
    anchor: str   # short prose: where inside that panel it sits


class FigureDoc(BaseModel):
    version: int = 1
    figure_caption: str
    placement: Placement

    # Single top-level layout for the whole figure.
    layout: Layout
    grid_rows: Optional[int] = None
    grid_cols: Optional[int] = None

    panels: list[Panel]

    # Caption sub-labels ((a), (b), …) to draw on the figure. None when
    # the caption has no sub-labels.
    letters: Optional[list[LetterMark]] = None


def validate(doc: FigureDoc, max_panels: int = 3) -> None:
    """Raise ValueError with a human-readable message on any invariant violation."""
    errors: list[str] = []

    seen: set[str] = set()
    for p in doc.panels:
        if p.id in seen:
            errors.append(f"duplicate panel id: {p.id}")
        seen.add(p.id)
        if not p.drawio_prompt or not p.drawio_prompt.strip():
            errors.append(f"panel {p.id!r} missing drawio_prompt")

    if len(doc.panels) < 1:
        errors.append("figure has no panels")
    if len(doc.panels) > max_panels:
        errors.append(f"{len(doc.panels)} panels exceeds max_panels {max_panels}")

    if doc.layout not in ("grid", "row", "column"):
        errors.append(f"invalid layout {doc.layout!r}")

    if doc.layout == "grid":
        if not doc.grid_rows or not doc.grid_cols:
            errors.append("grid layout missing grid_rows/grid_cols")
        else:
            occupied: set[tuple[int, int]] = set()
            for p in doc.panels:
                if p.row is None or p.col is None:
                    errors.append(f"panel {p.id!r} missing row/col under grid layout")
                    continue
                rs = p.rowspan or 1
                cs = p.colspan or 1
                if (
                    p.row < 0
                    or p.col < 0
                    or p.row + rs > doc.grid_rows
                    or p.col + cs > doc.grid_cols
                ):
                    errors.append(f"panel {p.id!r} placement out of bounds")
                    continue
                for r in range(p.row, p.row + rs):
                    for cc in range(p.col, p.col + cs):
                        if (r, cc) in occupied:
                            errors.append(
                                f"grid cell ({r},{cc}) occupied twice"
                            )
                        occupied.add((r, cc))

    if doc.letters:
        seen_labels: set[str] = set()
        for lm in doc.letters:
            if lm.panel not in seen:
                errors.append(
                    f"letter {lm.label!r} references unknown panel {lm.panel!r}"
                )
            if lm.label in seen_labels:
                errors.append(f"duplicate letter label: {lm.label!r}")
            seen_labels.add(lm.label)

    if errors:
        raise ValueError("schema validation failed:\n  - " + "\n  - ".join(errors))


def ordered_panels(doc: FigureDoc) -> list[Panel]:
    """Panels in display order — used for panel labels A, B, C, ...

    For grid layouts, sort by (row, col). For row / column layouts,
    keep the panels' declared order.
    """
    if doc.layout == "grid":
        return sorted(
            doc.panels,
            key=lambda p: (p.row if p.row is not None else 0,
                           p.col if p.col is not None else 0),
        )
    return list(doc.panels)


# ──────────────────────────── proportions / targets ─────────────────────────


def compute_panel_proportions(doc: FigureDoc) -> dict[str, tuple[float, float]]:
    """Derive each panel's (proportion_w, proportion_h) from the figure's
    top-level layout.

    Both numbers are in (0, 1]. Along the axis the layout divides, sibling
    proportions sum to 1; along the other axis each panel takes the full
    extent (1.0). For `grid`, each panel's proportions are its colspan /
    rowspan share of the grid.
    """
    n = len(doc.panels)
    out: dict[str, tuple[float, float]] = {}

    if doc.layout == "row":
        share = 1.0 / n
        for p in doc.panels:
            out[p.id] = (share, 1.0)
        return out

    if doc.layout == "column":
        share = 1.0 / n
        for p in doc.panels:
            out[p.id] = (1.0, share)
        return out

    if doc.layout == "grid":
        rows = doc.grid_rows
        cols = doc.grid_cols
        if not rows or not cols:
            raise ValueError("grid layout missing grid_rows/grid_cols")
        for p in doc.panels:
            cs = p.colspan or 1
            rs = p.rowspan or 1
            out[p.id] = (cs / cols, rs / rows)
        return out

    raise ValueError(f"unknown layout {doc.layout!r}")


def compute_panel_target_dims(doc: FigureDoc) -> dict[str, tuple[float, float]]:
    """Resolve each panel's (target_w, target_h) in panel-space units,
    using its `proportion_w/h` (or computing them) and the canonical
    interior composite size for the figure's `placement`."""
    if doc.placement not in CANONICAL_INNER:
        raise ValueError(f"unknown placement {doc.placement!r}")
    inner_w, inner_h = CANONICAL_INNER[doc.placement]

    proportions = compute_panel_proportions(doc)
    targets: dict[str, tuple[float, float]] = {}
    for p in doc.panels:
        pw = p.proportion_w if p.proportion_w is not None else proportions[p.id][0]
        ph = p.proportion_h if p.proportion_h is not None else proportions[p.id][1]
        targets[p.id] = (pw * inner_w, ph * inner_h)
    return targets


def populate_proportions(doc: FigureDoc) -> None:
    """Mutate `doc` in place, writing computed `proportion_w/h` into each
    panel (overwriting any existing values to keep them consistent with
    the layout)."""
    proportions = compute_panel_proportions(doc)
    for p in doc.panels:
        pw, ph = proportions[p.id]
        # Round to avoid noisy floats like 0.3333333333333333 in figure.json.
        p.proportion_w = round(pw, 4)
        p.proportion_h = round(ph, 4)


def _cli() -> int:
    p = argparse.ArgumentParser(description="Validate a drawio-figure figure.json.")
    p.add_argument("--validate", required=True, type=Path,
                   help="Path to figure.json.")
    p.add_argument("--max-panels", type=int, default=3)
    p.add_argument("--populate-targets", action="store_true",
                   help="After validating, compute each panel's "
                        "proportion_w/proportion_h from the figure's layout "
                        "and write them back to the file in place.")
    args = p.parse_args()

    if not args.validate.exists():
        print(f"ERROR: file not found: {args.validate}", file=sys.stderr)
        return 2
    raw = args.validate.read_text()
    try:
        doc = FigureDoc.model_validate_json(raw)
    except Exception as e:
        print(f"ERROR: JSON/Pydantic parse failed: {e}", file=sys.stderr)
        return 1
    try:
        validate(doc, max_panels=args.max_panels)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1

    if args.populate_targets:
        try:
            populate_proportions(doc)
        except ValueError as e:
            print(f"ERROR: cannot populate proportions: {e}", file=sys.stderr)
            return 1
        # Preserve any orderly formatting choices in the source file by
        # re-serialising from the validated model.
        args.validate.write_text(
            json.dumps(doc.model_dump(exclude_none=True), indent=2) + "\n"
        )
        targets = compute_panel_target_dims(doc)
        print(
            f"OK: {len(doc.panels)} panels, layout={doc.layout!r}, "
            f"placement={doc.placement!r}; populated proportions and "
            f"resolved targets (panel-space units):"
        )
        for panel in doc.panels:
            tw, th = targets[panel.id]
            print(
                f"  - {panel.id}: proportion=({panel.proportion_w}, "
                f"{panel.proportion_h}) → target=({tw:.0f}, {th:.0f})"
            )
        return 0

    print(f"OK: {len(doc.panels)} panels, layout={doc.layout!r}.")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
