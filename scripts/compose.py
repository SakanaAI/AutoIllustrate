"""Compose per-panel draw.io templates into a single composite.

Reads a `figure.json`, then for every panel:
  - Loads the panel's `<panel_id>.drawio.template` (Python `str.format` source).
  - Strips the universal `mxCell id="0"` / `id="1"` cells.
  - Prefixes every cell `id`/`parent`/`source`/`target` reference with
    `<panel_id>__` (skipping the universal "0"/"1" parents) so that cell IDs
    stay unique across panels.
  - Prefixes every single-brace `{placeholder}` with `<panel_id>__` (so
    each panel's own coordinate names remain unique in the composite).

Then writes two artifacts INTO the workdir (alongside `figure.json` and
the per-panel templates / generators):
  - `composite.drawio.template` — one combined template, wrapped in a fresh
    `mxfile` envelope, with `{page_w}` / `{page_h}` slots for the composite
    page size.
  - `generate_composite.py` — a self-contained generator that imports each
    `generate_<panel_id>.py` module from the workdir, pulls each panel's
    `params` dict (preferring `build_params()` if defined), computes a
    panel layout from `figure.json`'s top-level layout hints (`row` /
    `column` / `grid`), offsets every placeholder used as an absolute
    `x="…"` / `y="…"` attribute by its panel origin (style-string
    fractions like `entryX={…}` are left untouched), and fills the
    composite template. The generator writes
    the editable `full_figure.drawio` to OUT_DIR (default: `figures/`).

Run as a script:

    python scripts/compose.py --workdir $WORKDIR/

All per-panel templates and generators are expected to live INSIDE
`--workdir`. Only the headline `full_figure.drawio` lands at the project
root (or wherever `--out-dir` points).
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from schema import FigureDoc, validate  # noqa: E402


def stage_panel_geometry(workdir: Path) -> None:
    """Ensure the shared geometry-validation library is in the workdir next to
    the panel generators. Each generate_<panel>.py (imported by
    generate_composite.py at compose time) imports `panel_geometry`; the panel
    phase normally stages it, but copy it here too so a compose-only run on an
    existing workdir is self-sufficient. Overwrites to mirror the toolkit."""
    src = SCRIPT_DIR.parent / "assets" / "panel_geometry.py"
    if src.exists():
        shutil.copyfile(src, workdir / "panel_geometry.py")

# Single-brace `{name}` placeholders, ignoring doubled `{{` / `}}` used by
# str.format escaping (common in LaTeX labels).
PLACEHOLDER_RE = re.compile(r"(?<!\{)\{([A-Za-z_][A-Za-z_0-9]*)\}(?!\})")
ID_ATTR_RE = re.compile(r'\b(id|parent|source|target)="([^"]+)"')

DEFAULT_PANEL_GAP = 40
DEFAULT_PAGE_MARGIN = 24

# IDs of the universal background cells that must NOT be prefixed.
UNIVERSAL_IDS = {"0", "1"}


# ───────────────────────────── template combination ─────────────────────────


def prefix_placeholders(template_text: str, prefix: str) -> str:
    """Rewrite `{x}` → `{prefix__x}` for every single-brace placeholder."""
    return PLACEHOLDER_RE.sub(lambda m: f"{{{prefix}__{m.group(1)}}}", template_text)


def prefix_id_refs(template_text: str, prefix: str) -> str:
    """Prefix `id`/`parent`/`source`/`target` attribute values with `prefix__`.

    Skips the universal `0` / `1` references so the composite's single root
    pair still parents every cell correctly.
    """

    def repl(m: re.Match[str]) -> str:
        attr, val = m.group(1), m.group(2)
        if val in UNIVERSAL_IDS:
            return m.group(0)
        return f'{attr}="{prefix}__{val}"'

    return ID_ATTR_RE.sub(repl, template_text)


def extract_inner_cells(template_text: str) -> str:
    """Return everything inside the panel template's `<root>...</root>` minus
    the universal background cells."""
    m = re.search(r"<root>(.*?)</root>", template_text, re.DOTALL)
    if not m:
        raise ValueError("template has no <root> element")
    inner = m.group(1)
    inner = re.sub(r'<mxCell\s+id="0"\s*/>\s*', "", inner)
    inner = re.sub(r'<mxCell\s+id="1"\s+parent="0"\s*/>\s*', "", inner)
    return inner.strip()


COMPOSITE_TEMPLATE_HEADER = (
    '<mxfile host="drawio-figure-compose" version="24.0.0">\n'
    '  <diagram id="composite" name="Composite">\n'
    '    <mxGraphModel math="1" adaptiveColors="auto" '
    'pageWidth="{page_w}" pageHeight="{page_h}" '
    'grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" '
    'fold="1" page="1" pageScale="1" shadow="0">\n'
    "      <root>\n"
    '        <mxCell id="0"/>\n'
    '        <mxCell id="1" parent="0"/>\n'
)
COMPOSITE_TEMPLATE_FOOTER = (
    "      </root>\n"
    "    </mxGraphModel>\n"
    "  </diagram>\n"
    "</mxfile>\n"
)


def build_composite_template(panel_ids: list[str], workdir: Path) -> str:
    """Combine each panel's inner cells into one composite template string."""
    parts: list[str] = []
    for panel_id in panel_ids:
        path = workdir / f"{panel_id}.drawio.template"
        if not path.exists():
            raise FileNotFoundError(f"missing per-panel template: {path}")
        text = path.read_text()
        inner = extract_inner_cells(text)
        inner = prefix_id_refs(inner, panel_id)
        inner = prefix_placeholders(inner, panel_id)
        # Indent to match the surrounding root's formatting.
        indented = "        " + inner.replace("\n", "\n        ")
        parts.append(indented)
    body = "\n".join(parts) + "\n"
    return COMPOSITE_TEMPLATE_HEADER + body + COMPOSITE_TEMPLATE_FOOTER


# ───────────────────────────── generator emission ───────────────────────────


GENERATE_COMPOSITE_TEMPLATE = '''"""Generate full_figure.drawio from per-panel templates and generators.

Auto-generated by autoillustrate's scripts/compose.py — do not
edit by hand. Re-run compose.py to regenerate.

All per-panel artifacts (templates, generators) live under WORKDIR. The
composite template also lives in WORKDIR. Only the headline editable
diagram (`full_figure.drawio`) is written to OUT_DIR (default: cwd).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

WORKDIR = Path({workdir!r})
OUT_DIR = Path({out_dir!r})
PANEL_GAP = {panel_gap}
PAGE_MARGIN = {page_margin}

# Placeholders used as absolute `x="…"` / `y="…"` attributes (mxGeometry,
# mxPoint) — derived at runtime from the composite template so that
# panel-template edits can't desync the generator from its key set.
# Style-string fractions like `entryX={{…}}` deliberately don't match.
_COORD_X_USE_RE = re.compile(r'\\bx="\\{{([A-Za-z_][A-Za-z_0-9]*)\\}}"')
_COORD_Y_USE_RE = re.compile(r'\\by="\\{{([A-Za-z_][A-Za-z_0-9]*)\\}}"')


def _load_module(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot import {{path}}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[path.stem] = mod
    spec.loader.exec_module(mod)
    return mod


def _get_params(mod, bypass_warnings: bool = False) -> dict:
    if hasattr(mod, "build_params"):
        return mod.build_params(bypass_warnings=bypass_warnings)
    if hasattr(mod, "params"):
        return mod.params
    raise AttributeError(
        f"{{mod.__name__}} exposes neither build_params() nor module-level params"
    )


def _compute_layout(figure: dict, panel_sizes: dict[str, tuple[float, float]],
                    gap: float) -> tuple[dict[str, tuple[float, float]],
                                         tuple[float, float]]:
    """Compute panel origins from the figure's top-level layout.

    Returns (panel_origin_by_id, total_size).
    """
    panels = figure["panels"]
    layout = figure["layout"]

    if layout == "row":
        sizes = [panel_sizes[p["id"]] for p in panels]
        total_w = sum(s[0] for s in sizes) + gap * (len(panels) - 1)
        total_h = max(s[1] for s in sizes)
        origins: dict[str, tuple[float, float]] = {{}}
        x = 0.0
        for p, (pw, ph) in zip(panels, sizes):
            origins[p["id"]] = (x, (total_h - ph) / 2)
            x += pw + gap
        return origins, (total_w, total_h)

    if layout == "column":
        sizes = [panel_sizes[p["id"]] for p in panels]
        total_w = max(s[0] for s in sizes)
        total_h = sum(s[1] for s in sizes) + gap * (len(panels) - 1)
        origins = {{}}
        y = 0.0
        for p, (pw, ph) in zip(panels, sizes):
            origins[p["id"]] = ((total_w - pw) / 2, y)
            y += ph + gap
        return origins, (total_w, total_h)

    if layout == "grid":
        rows = figure["grid_rows"]
        cols = figure["grid_cols"]
        col_w = [0.0] * cols
        row_h = [0.0] * rows
        for p in panels:
            pw, ph = panel_sizes[p["id"]]
            rs = (p.get("rowspan") or 1)
            cs = (p.get("colspan") or 1)
            if cs == 1:
                col_w[p["col"]] = max(col_w[p["col"]], pw)
            if rs == 1:
                row_h[p["row"]] = max(row_h[p["row"]], ph)
        for p in panels:
            pw, ph = panel_sizes[p["id"]]
            rs = (p.get("rowspan") or 1)
            cs = (p.get("colspan") or 1)
            if cs > 1:
                cur = sum(col_w[p["col"]:p["col"] + cs]) + gap * (cs - 1)
                if cur < pw:
                    extra = (pw - cur) / cs
                    for c in range(p["col"], p["col"] + cs):
                        col_w[c] += extra
            if rs > 1:
                cur = sum(row_h[p["row"]:p["row"] + rs]) + gap * (rs - 1)
                if cur < ph:
                    extra = (ph - cur) / rs
                    for r in range(p["row"], p["row"] + rs):
                        row_h[r] += extra
        col_x: list[float] = []
        x_acc = 0.0
        for cw in col_w:
            col_x.append(x_acc)
            x_acc += cw + gap
        row_y: list[float] = []
        y_acc = 0.0
        for rh in row_h:
            row_y.append(y_acc)
            y_acc += rh + gap
        origins = {{}}
        for p in panels:
            pw, ph = panel_sizes[p["id"]]
            rs = (p.get("rowspan") or 1)
            cs = (p.get("colspan") or 1)
            cell_w = sum(col_w[p["col"]:p["col"] + cs]) + gap * (cs - 1)
            cell_h = sum(row_h[p["row"]:p["row"] + rs]) + gap * (rs - 1)
            cx = col_x[p["col"]] + (cell_w - pw) / 2
            cy = row_y[p["row"]] + (cell_h - ph) / 2
            origins[p["id"]] = (cx, cy)
        total_w = sum(col_w) + gap * (cols - 1)
        total_h = sum(row_h) + gap * (rows - 1)
        return origins, (total_w, total_h)

    raise ValueError(f"unknown layout {{layout!r}}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bypass-warnings",
        action="store_true",
        help="Run even when a panel's geometry checks emit warnings (errors "
             "still abort). Each panel's build_params() re-runs here, so a "
             "warning bypassed in Phase 2 reappears at compose — pass this "
             "ONLY if every such warning has a valid reason to be bypassed.",
    )
    args = parser.parse_args()

    figure = json.loads((WORKDIR / "figure.json").read_text())
    panel_ids = [p["id"] for p in figure["panels"]]

    panel_params: dict[str, dict] = {{}}
    panel_sizes: dict[str, tuple[float, float]] = {{}}
    for pid in panel_ids:
        mod = _load_module(WORKDIR / f"generate_{{pid}}.py")
        p = _get_params(mod, bypass_warnings=args.bypass_warnings)
        panel_params[pid] = p
        panel_sizes[pid] = (p["page_w"], p["page_h"])

    origins, (total_w, total_h) = _compute_layout(figure, panel_sizes, PANEL_GAP)

    template = (WORKDIR / "composite.drawio.template").read_text()
    coord_x_keys = set(_COORD_X_USE_RE.findall(template))
    coord_y_keys = set(_COORD_Y_USE_RE.findall(template))

    composite_params: dict[str, int] = {{}}
    for pid, p in panel_params.items():
        ox, oy = origins[pid]
        for k, v in p.items():
            # page_w/page_h flow through like any param: a panel template may
            # legitimately reference its own page size (e.g. a page-sized
            # frame), and prefix_placeholders renamed those slots to
            # <pid>__page_w/_h — skipping them KeyErrors the format() below.
            full_key = f"{{pid}}__{{k}}"
            if full_key in coord_x_keys:
                composite_params[full_key] = round(v + ox + PAGE_MARGIN)
            elif full_key in coord_y_keys:
                composite_params[full_key] = round(v + oy + PAGE_MARGIN)
            else:
                composite_params[full_key] = v
    composite_params["page_w"] = round(total_w + 2 * PAGE_MARGIN)
    composite_params["page_h"] = round(total_h + 2 * PAGE_MARGIN)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "full_figure.drawio"
    out_path.write_text(template.format(**composite_params))
    print(
        f"wrote {{out_path}} "
        f"({{composite_params['page_w']}}x{{composite_params['page_h']}}, "
        f"{{len(panel_ids)}} panels)"
    )


if __name__ == "__main__":
    main()
'''


def emit_generator(workdir: Path, out_dir: Path, panel_gap: int, page_margin: int) -> str:
    return GENERATE_COMPOSITE_TEMPLATE.format(
        workdir=str(workdir),
        out_dir=str(out_dir),
        panel_gap=panel_gap,
        page_margin=page_margin,
    )


# ─────────────────────────────────── CLI ────────────────────────────────────


def _cli() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--workdir", required=True, type=Path,
                   help="Per-invocation working dir, e.g. $WORKDIR/. "
                        "Per-panel templates and generators must live here, and the "
                        "composite template + generator are written here too.")
    p.add_argument("--out-dir", type=Path, default=None,
                   help="Where the headline `full_figure.drawio` lands "
                        "(default: figures/).")
    p.add_argument("--panel-gap", type=int, default=DEFAULT_PANEL_GAP,
                   help=f"Gap between adjacent panels in px (default: {DEFAULT_PANEL_GAP}).")
    p.add_argument("--page-margin", type=int, default=DEFAULT_PAGE_MARGIN,
                   help=f"Outer page margin in px (default: {DEFAULT_PAGE_MARGIN}).")
    args = p.parse_args()

    figure_path = args.workdir / "figure.json"
    if not figure_path.exists():
        print(f"ERROR: figure.json not found at {figure_path}", file=sys.stderr)
        return 2
    doc = FigureDoc.model_validate_json(figure_path.read_text())
    validate(doc)

    panel_ids = [p.id for p in doc.panels]
    if not panel_ids:
        print("ERROR: figure has no panels to compose", file=sys.stderr)
        return 1

    out_dir = args.out_dir or Path("figures")

    stage_panel_geometry(args.workdir)

    composite_template = build_composite_template(panel_ids, args.workdir)
    (args.workdir / "composite.drawio.template").write_text(composite_template)

    gen = emit_generator(args.workdir, out_dir, args.panel_gap, args.page_margin)
    (args.workdir / "generate_composite.py").write_text(gen)

    print(
        f"OK: wrote {args.workdir}/composite.drawio.template + "
        f"{args.workdir}/generate_composite.py "
        f"({len(panel_ids)} panels: {', '.join(panel_ids)})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
