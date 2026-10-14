#!/usr/bin/env python3
# Skeleton starter for a per-panel `generate_<panel_id>.py`. Copy this
# file into the workdir, rename it `generate_<panel_id>.py`, and fill
# in the constants / build_elements() / build_paths() bodies.
#
# This script ONLY computes numbers (positions, sizes) and feeds them
# into template.format(**params). It must NEVER build mxCell XML
# strings — all cells live in the .drawio.template. (See
# references/panel_agent.md "No XML generation in Python".)
#
# All the FIXED geometry validation (collision, orthogonal-waypoint,
# short-segment, path-crossing, dangling-endpoint, page-fill and corner
# dead-zone checks, plus the Rect / EdgePath types) lives in the shared
# `panel_geometry` module — staged into this workdir next to the
# generators. Do NOT copy those checks in here; import them (below) and
# call `enforce(...)` from build_params(). Only panel-specific geometry
# (page size, element sizes, layout params, build_elements/build_paths)
# belongs in this file.
from pathlib import Path
import argparse
import math
import sys

# Import the shared geometry library from this generator's own directory
# (the workdir), so the import resolves however this file is loaded: run
# directly by the panel agent, imported by scripts/compose.py's
# generate_composite.py, or by scripts/check_params_contract.py. `__file__`
# is the generator's path in the workdir in every one of those contexts.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from panel_geometry import Rect, EdgePath, enforce  # noqa: E402

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
    # return EVERY routed edge in the panel, with full polyline + color
    return [ ... ]

# ── Position computation ──
# All positions derived from layout constants using center_x/center_y helpers
# Edge label positions computed from edge geometry (source/target points)

# ── Template filling ──
def build_params(bypass_warnings: bool = False) -> dict:
    """Compute every position. Runs the shared geometry checks first
    (`enforce`), which aborts on any error and on any warning unless
    bypassed. Returned dict MUST contain page_w / page_h as lowercase keys
    (NOT the PAGE_W / PAGE_H module constants — the Phase 4 composer reads
    lowercase), every rect-geometry placeholder, every path's waypoints as
    `<name>_x<i>` / `<name>_y<i>`, and every path's `<name>_color`.
    Coordinate keys end in `_x` / `_y` so the Phase 4 composer can offset
    them by the panel origin. Pure: no file I/O. Both `main()` here and
    the composer call this — keep it free of side effects.

    Generation does not run while EITHER errors or warnings remain.
    Errors are never bypassable. Warnings block too, unless
    `bypass_warnings=True` (surfaced as `--bypass-warnings` on the CLI) —
    pass it ONLY when every warning printed has been reviewed and each one
    has a valid reason to be bypassed.
    """
    elements = build_elements()
    paths = build_paths()
    enforce(elements, paths, PAGE_W, PAGE_H, bypass_warnings=bypass_warnings)
    return dict(...)  # all computed positions as ints, plus every path's points + color

def _assert_param_contract(params: dict) -> None:
    """Fail generation if build_params() omits the page_w / page_h keys the
    Phase 4 composer reads to size and place this panel. A panel renders a
    valid drawio without them (its own template can frame itself), so without
    this guard the omission stays invisible until compose raises a KeyError.
    Common slip: returning PAGE_W / PAGE_H — the module-constant names — when
    the composer requires lowercase page_w / page_h. Keep this call in main().
    """
    for key in ("page_w", "page_h"):
        if isinstance(params.get(key), int) and params[key] > 0:
            continue
        hint = ""
        if key.upper() in params:
            hint = f" (found '{key.upper()}' — the composer reads lowercase '{key}')"
        raise SystemExit(
            f"ERROR: build_params() must return a positive int '{key}'{hint}. "
            "Phase 4 compose reads page_w / page_h to lay this panel out."
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bypass-warnings",
        action="store_true",
        help="Run even when geometry warnings remain (errors still abort). "
             "Use ONLY if every warning printed above has been reviewed and "
             "each one has a valid reason to be bypassed.",
    )
    args = parser.parse_args()
    params = build_params(bypass_warnings=args.bypass_warnings)
    _assert_param_contract(params)
    template = Path("name.drawio.template").read_text()
    Path("name.drawio").write_text(template.format(**params))


if __name__ == "__main__":
    main()
