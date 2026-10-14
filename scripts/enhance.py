"""Style-enhance a drawio-figure composite figure with an image-edit model.

Takes the already-composed `full_figure.png` (in `figures/`) and asks
an image-edit model to produce a publication-grade, more compact
restyling suitable for the main figure of a scientific paper. The
input image is the sole source of truth — no methods text is sent to
the model so it cannot invent elements that are not actually drawn.

Defaults to OpenAI `gpt-image-2.5-sunburst`; Google's nanobanana models are
available via `--model nanobanana` (Gemini 3.1 Flash Image) and
`--model nanobanana-pro` (Gemini 3 Pro Image), and `--model codex`
runs the codex CLI's built-in $imagegen skill (gpt-image-2 underneath,
billed to the ChatGPT subscription — no API key). Any other model id
is passed through unchanged: `gemini*` ids go to the Gemini API, the
rest to the OpenAI Images API. The deterministic
`full_figure.png` is preserved untouched; the enhanced version is
written next to it as `figures/full_figure_enhanced.png`.

Usage:

    # Preview the prompt + cost without calling the API
    python scripts/enhance.py --workdir $WORKDIR/ --dry-run

    # Call the API
    OPENAI_API_KEY=... python scripts/enhance.py \
        --workdir $WORKDIR/

Flags:
    --model        gpt-image-2.5-sunburst | gpt-image-2 | nanobanana
                   | nanobanana-pro | codex | <model id>
                   (default: gpt-image-2.5-sunburst). Needs
                   OPENAI_API_KEY, GEMINI_API_KEY, or a
                   ChatGPT-authenticated `codex` CLI respectively.
    --placement    half-width | full-width (required). Affects only
                   the prompt's label-sizing guidance, not the
                   output dimensions.
    --size         WIDTHxHEIGHT (optional override). When omitted,
                   the output matches the input image's dimensions,
                   snapped to the nearest size gpt-image-2 accepts
                   (edges <= 3840 and multiples of 16, long/short
                   ratio <= 3:1). The nanobanana models take an
                   aspect ratio rather than exact pixels, so there
                   --size only steers the aspect-ratio snap.
    --quality      Output quality (default: high, or $ENHANCE_QUALITY —
                   the orchestrator's --enhance-quality exports it).
                   Passed to the model as-is, so the vocabulary is the
                   model's own: gpt-image-2.5-* take low | medium | high
                   | xhigh | max | auto, gpt-image-2 has no xhigh/max,
                   the nanobanana models take the same ladder or a
                   literal 1K | 2K | 4K (capped per model), codex
                   ignores it.
    --out          Output PNG path
                   (default: figures/full_figure_enhanced.png).
    --input        Input PNG path
                   (default: figures/full_figure.png).
    --dry-run      Print the composed prompt + input paths; skip the API call.
    --no-protect-mpl
                   Do not protect embedded matplotlib plots. By default the
                   image cells of `figures/full_figure.drawio` (the `[[mp:]]`
                   plots the panel agents embedded as base64 PNGs) are
                   located in the input PNG and listed in the prompt as
                   reproduce-verbatim regions with their position and the
                   panel's own description. A strong hint, not a pixel
                   guarantee: the whole canvas is regenerated. (The edit
                   endpoint's `mask` is NOT usable for this: GPT Image
                   blanks every transparent area instead of restyling it.)
                   $ENHANCE_PROTECT_MPL=0 is the env form.

This script is NOT part of the skill's required pipeline. The drawio-figure
composite is deterministic and exactly editable in draw.io; this helper
produces a separate, generatively-restyled artifact that sits alongside it.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

try:
    from _usage import record_usage, resolve_phase  # type: ignore
except ImportError:  # pragma: no cover - when cwd isn't the scripts dir
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from _usage import record_usage, resolve_phase  # type: ignore

# The orchestrator exports $ENHANCE_MODEL / $ENHANCE_QUALITY (from its
# --enhance-model / --enhance-quality flags) so the Phase 6 repair loop's
# re-enhances pick up the same choices without repeating the flags.
DEFAULT_MODEL = os.environ.get("ENHANCE_MODEL") or "gpt-image-2.5-sunburst"
# Not validated against a list: the accepted vocabulary is the image
# model's own (gpt-image-2.5 adds xhigh/max over gpt-image-2's
# low/medium/high/auto), so the value goes to the API as-is.
DEFAULT_QUALITY = os.environ.get("ENHANCE_QUALITY") or "high"
DEFAULT_PROTECT_MPL = os.environ.get("ENHANCE_PROTECT_MPL", "1").strip().lower() not in ("0", "false", "no", "off")

# CLI model name -> backend + API model id. Mirrors VLM_REGISTRY in
# verify.py. `max_image_size` is the largest output resolution the
# Gemini API accepts for that model (gpt-image-2 sizes pixel-exactly
# instead, see fit_gpt_image_size). The `codex` backend dispatches to
# the codex CLI's built-in $imagegen skill (gpt-image-2 underneath),
# billed against the ChatGPT subscription instead of API credits.
MODEL_REGISTRY: dict[str, dict[str, str]] = {
    "gpt-image-2.5-sunburst": {"backend": "openai", "model": "gpt-image-2.5-sunburst"},
    "gpt-image-2":    {"backend": "openai", "model": "gpt-image-2"},
    "nanobanana":     {"backend": "gemini", "model": "gemini-3.1-flash-image",
                       "max_image_size": "2K"},
    "nanobanana-pro": {"backend": "gemini", "model": "gemini-3-pro-image",
                       "max_image_size": "4K"},
    "codex":          {"backend": "codex",
                       "model": "gpt-image-2 (codex $imagegen)"},
}

# Resolution cap for a Gemini model id that isn't in the registry — 2K is
# accepted by every Gemini image model to date.
_PASSTHROUGH_GEMINI_MAX_IMAGE_SIZE = "2K"


def resolve_model(name: str) -> dict[str, str]:
    """Backend spec for a --model value: a registry alias, or a raw model
    id routed by prefix (mirrors enhanceBackend in src/context.ts)."""
    spec = MODEL_REGISTRY.get(name)
    if spec is not None:
        return spec
    if name.startswith("gemini"):
        return {"backend": "gemini", "model": name,
                "max_image_size": _PASSTHROUGH_GEMINI_MAX_IMAGE_SIZE}
    return {"backend": "openai", "model": name}

# Watchdog for the spawned codex agent; the pipeline's own
# AUTOILLUSTRATE_CMD_TIMEOUT (default 600s) kills enhance.py as a whole,
# so this only matters for standalone invocations.
_CODEX_TIMEOUT_SECS = int(os.environ.get("ENHANCE_CODEX_TIMEOUT", "1200"))

# Matches the Phase 4 composite export width (TARGET_WIDTH in
# src/phase-compose.ts) so the model sees the full export; gpt-image-2
# hard-caps the input at 3840px per edge.
DEFAULT_MAX_EDGE = 2560

# gpt-image-2 output-size constraints.
_MAX_OUTPUT_EDGE = 3840
_MIN_OUTPUT_PIXELS = 655_360
_MAX_OUTPUT_PIXELS = 8_294_400
_MAX_ASPECT_RATIO = 3.0


def read_image_size(path: Path) -> tuple[int, int]:
    """Return (width, height) of the image at `path`."""
    try:
        from PIL import Image, ImageFile  # type: ignore
    except ImportError:
        raise SystemExit(
            "ERROR: `pillow` is required to read the input image size.\n"
            f"  {sys.executable} -m pip install pillow"
        )
    ImageFile.LOAD_TRUNCATED_IMAGES = True
    try:
        with Image.open(path) as img:
            return img.size
    except Exception as exc:
        raise SystemExit(f"ERROR: cannot read image size of {path}: {exc}")


def fit_gpt_image_size(w: int, h: int) -> str:
    """Snap (w, h) to the nearest 'WIDTHxHEIGHT' that gpt-image-2 accepts:
    edges multiples of 16 and <= 3840, long/short aspect ratio <= 3:1, total
    pixels within [655360, 8294400]. Preserves the input aspect ratio as
    closely as the constraints allow."""
    fw, fh = float(w), float(h)
    # Clamp an extreme aspect ratio by growing the short edge.
    long_e, short_e = max(fw, fh), min(fw, fh)
    if short_e > 0 and long_e / short_e > _MAX_ASPECT_RATIO:
        short_e = long_e / _MAX_ASPECT_RATIO
        if fw >= fh:
            fh = short_e
        else:
            fw = short_e
    # Uniform scale to satisfy the edge cap and the total-pixel window.
    scale = min(1.0, _MAX_OUTPUT_EDGE / max(fw, fh))
    px = fw * fh * scale * scale
    if px > _MAX_OUTPUT_PIXELS:
        scale *= (_MAX_OUTPUT_PIXELS / px) ** 0.5
    elif px < _MIN_OUTPUT_PIXELS:
        scale *= (_MIN_OUTPUT_PIXELS / px) ** 0.5

    def _snap(v: float) -> int:
        snapped = max(16, round(v * scale / 16) * 16)
        return min(snapped, _MAX_OUTPUT_EDGE)

    out_w, out_h = _snap(fw), _snap(fh)
    # Rounding both edges down to a multiple of 16 can land just under the
    # pixel floor (1024x576 -> 1072x608 = 651,776); grow the long edge, which
    # perturbs the aspect least, until the floor is met.
    while out_w * out_h < _MIN_OUTPUT_PIXELS:
        if out_w >= out_h:
            out_w += 16
        else:
            out_h += 16
    # Rounding the short edge to the nearest 16 can push it just *under* the
    # long/3 floor, re-crossing the 3:1 cap (e.g. 853.3 -> 848, 2560/848 > 3).
    # Grow the short edge up to the next 16 that satisfies the ratio.
    long_o, short_o = max(out_w, out_h), min(out_w, out_h)
    if long_o / short_o > _MAX_ASPECT_RATIO:
        fixed = min(_MAX_OUTPUT_EDGE,
                    int(math.ceil((long_o / _MAX_ASPECT_RATIO) / 16) * 16))
        if out_w <= out_h:
            out_w = fixed
        else:
            out_h = fixed

    return f"{out_w}x{out_h}"


# Aspect ratios the nanobanana (Gemini image) models accept.
_GEMINI_ASPECT_RATIOS = (
    "1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9",
)

# --quality -> Gemini output resolution, capped per model by
# MODEL_REGISTRY["max_image_size"]. A literal 1K/2K/4K is taken as-is.
_QUALITY_TO_IMAGE_SIZE = {"low": "1K", "medium": "2K", "high": "4K",
                          "xhigh": "4K", "max": "4K", "auto": "2K"}
_IMAGE_SIZE_ORDER = ("1K", "2K", "4K")


def fit_gemini_aspect(w: int, h: int) -> str:
    """Snap (w, h) to the closest aspect ratio the nanobanana models
    accept, by log-ratio distance (so 2:1 is equidistant from 16:9 and
    21:9 in the right sense, not skewed toward wide ratios)."""
    target = w / h

    def _distance(ratio: str) -> float:
        rw, rh = ratio.split(":")
        return abs(math.log(target) - math.log(int(rw) / int(rh)))

    return min(_GEMINI_ASPECT_RATIOS, key=_distance)


def gemini_image_size(quality: str, max_image_size: str) -> str:
    """Map --quality to a Gemini output resolution, capped at the
    model's maximum. Raises KeyError for a value that is neither a
    ladder word nor a literal 1K/2K/4K."""
    upper = quality.upper()
    requested = upper if upper in _IMAGE_SIZE_ORDER else _QUALITY_TO_IMAGE_SIZE[quality]
    capped = min(_IMAGE_SIZE_ORDER.index(requested),
                 _IMAGE_SIZE_ORDER.index(max_image_size))
    return _IMAGE_SIZE_ORDER[capped]


SYSTEM_PROMPT = """\
You are polishing the main figure of a scientific research paper \
(ML / AI / computational research). It will appear in the paper AND in \
public-facing material (project page, blog, slides, social), so it must \
be both rigorous and genuinely eye-catching.

Produce a new version that is publication-ready for a top-tier venue \
(NeurIPS / ICLR / Nature-tier) and striking enough to stand on its own. \
The output MUST be distinctly more appealing than the input — while \
strictly preserving the same SET of content elements.

## REQUIRED STYLISTIC CHANGES (must visibly apply)
- Modern, cohesive palette — REFINE the input's existing colors, don't \
replace them. Build on the colors already in the image: harmonize them \
into a confident color story (typically 3–5 distinctive hues in clear \
semantic roles), tune saturation and lightness for cohesion, and add \
color only where the input is monochrome or default-gray. Bold accents \
and tinted fills are encouraged; avoid washed-out grays and flat \
default-looking schemes. Accent / result elements take a flat saturated \
fill, NOT a glossy gradient — glossy accents read as a marketing slide.
- Single modern sans-serif (e.g. Inter / Helvetica Neue), consistent \
sizes, distinctive weights for panel letters.
- Compact, grid-aligned layout. Figures get scaled down in LaTeX, so \
empty canvas costs label legibility — target the smallest bounding box \
that keeps labels uncrowded, and treat any empty rectangle larger than \
one label-height as a bug. Strip dead whitespace, pull related elements \
close. Keep comfortable padding INSIDE boxes so labels don't touch borders. \
You may freely reposition, regroup, re-flow, or re-route elements and \
arrows to eliminate dead space — including switching a panel between \
row / column / grid arrangements when that yields a tighter footprint. \
The SET of elements and the meaning of every connection must stay \
identical; their positions and routing do not.
- Clean arrows: uniform stroke per semantic role, consistent arrowheads, \
color reused from the palette to reinforce roles. Maximize symmetry — \
align same-role boxes on shared rows/columns and route paired flows \
symmetrically. Every arrow keeps its exact arrowhead count and placement: \
a single-headed arrow stays single-headed pointing at the same target, and \
a double-headed arrow stays double-headed — add no arrowhead, remove no \
arrowhead, and reverse no arrow.
- Strong visual hierarchy: the main takeaway must read in under 2 \
seconds via color, weight, and size — not extra annotation.
- Tasteful polish welcome, but ONE consistent treatment per figure. \
Depth (card shadows, gradients) is all-or-nothing within a semantic \
role: if you give one box of a role a shadow or gradient, give the SAME \
treatment to every box of that role — never a subset. Do NOT mix flat \
matte boxes with glossy gradient-and-shadow boxes in the same figure; a \
figure that mixes registers reads as less designed, not more. Rounded \
corners are fine everywhere. \
Small clarifying icons (simple, flat, monochrome or palette-matched) are \
allowed only when a concept is abstract or complex enough that a glyph \
genuinely shortcuts comprehension — never as decoration, and never if \
the label alone is already concrete. Icons are all-or-nothing within a \
peer group (a row or same-role set) and share one visual treatment: \
never icon only some boxes of a group, and never mix flat line icons \
with glossy filled ones. When in doubt, omit.

If the output looks unchanged from the input, or lifeless, you have failed.

Striking means clear and confident, not busy or ornate. If the output \
feels cluttered, over-decorated, or like a marketing slide, you have \
also failed. Every visual element must earn its place. \
Prefer one well-chosen accent over three competing ones.


## CONTENT PRESERVATION (must not violate)
- Preserve the SET of elements: every box, arrow, panel letter, and \
label in the input must be in the output. Do NOT add any new box, \
panel, equation, caption, legend, or annotation not visibly present.
- Preserve the meaning of every connection (source → target, polarity, \
dashed vs solid) and the overall panel ordering.
- Preserve short text verbatim: variable names, equations, panel \
letters, axis labels. No rewriting or paraphrasing. \
Math must render as math.
- No decorative elements that add NEW content (badges, captions, \
legends, watermarks, mascots). Visual polish on existing elements \
(shadows, rounded corners, gradients on existing fills) does not count \
as added content; nor do small clarifying icons that meet the bar above.
- Preserve color as information. In a scientific figure, color usually \
carries meaning: the same color links elements into a group/role, \
different colors mark a deliberate distinction, and specific hues are \
often named by the paper's caption ("the green section", "the red \
path") — swapping them breaks the text that refers to them. Keep every \
such grouping and distinction intact, and keep each element within its \
ORIGINAL hue family (a green region stays green, a red path stays red, \
a blue block stays blue). You MAY adjust saturation, lightness, and \
overall harmony, and unify near-duplicate shades within one role — but \
do not re-map, swap, or merge the existing color assignments, and do \
not recolor one role into another's hue.
{placement_block}{figure_summary_block}{placeholders_block}{protected_block}
Now generate the refined figure."""


PLACEMENT_BLOCKS = {
    "half-width": """
## INTENDED PLACEMENT IN PAPER

This figure will be placed in a SINGLE COLUMN of a double-column \
conference paper, so the reader will view it at narrow physical \
width. Scale up label text, panel letters, math symbols, and arrow \
stroke weights so they remain legible when the figure is rendered \
at half-page width — typography should sit roughly 1.3-1.5x larger \
relative to the canvas than you would use at full-width placement. \
Prefer slightly chunkier strokes and larger gaps over fine, dense \
detail.
""",
    "full-width": """
## INTENDED PLACEMENT IN PAPER

This figure will span the full paper width (left-to-right between \
margins, e.g. LaTeX `figure*` in a double-column paper, or a \
full-width figure in a single-column paper). Use natural relative \
sizes for labels, panel letters, and arrow strokes — the figure \
will be rendered wide enough that standard typography sizing stays \
legible.
""",
}


FIGURE_SUMMARY_TEMPLATE = """

## WHAT THE FIGURE DEPICTS (read-only inventory of what is in the input)

This describes the elements that ARE in the input image, so you can \
recognise them. It is NOT a license to add anything beyond what is \
listed: extra paragraphs of background, anything implied but not \
visible, or anything described elsewhere in the paper must be \
ignored.

{summary}
"""


PLACEHOLDERS_TEMPLATE = """

## PLACEHOLDERS — REPLACE EACH GRAY-DASHED BOX

The input contains one or more gray-dashed rectangles whose label is \
a literal token `[[ pl <panel> <n> ]]`. These are intentional \
placeholders: drawio cannot render the intended visualization \
(curves, histograms, sketches, etc.), so the panel author deferred \
each one to you. For EVERY placeholder listed below:

1. Replace the gray-dashed box at its location with the described \
visualization, drawn cleanly in a style consistent with the rest of \
the figure (palette, stroke weight, typography).
2. Use the box's footprint as the rough region; you may resize or \
re-aspect it modestly to fit the visualization, but do not push it \
into a neighbour.
3. Do NOT keep the gray dashed border or the `[[ pl ... ]]` token \
visible in the output — both must disappear, fully replaced by the \
visualization.
4. The `kind` is a hint about the visualization family; the \
`description` is authoritative. If they conflict, follow the \
description.

Placeholders:
{placeholders}
"""


PROTECTED_TEMPLATE = """

## PRE-RENDERED PLOTS — REPRODUCE VERBATIM

{count} of the input are matplotlib plots that were rendered exactly as \
intended before this pass. They are finished artwork, NOT placeholders. \
For every one of them:

1. Reproduce it faithfully: the same curves / bars / markers / axes with \
the same counts, shapes, slopes, and colors, at the SAME position and \
size on the canvas (the output canvas matches the input canvas).
2. Do NOT restyle, recolor, smooth, re-plot, relabel, resize, move, or \
reinterpret it, and do NOT add axes, ticks, legends, or labels it does \
not have. Treat it as a photograph pasted onto the figure.
3. Re-flow the rest of the figure AROUND these fixed anchors; they stay \
where they are even if that leaves the surrounding layout less compact.

Protected plots (x / y / w / h as % of canvas width and height):
{entries}
"""


def prepare_input_image(input_path: Path, max_edge: int) -> tuple[bytes, str, tuple[int, int]]:
    """Return (jpeg_bytes, filename, (w, h)) — downscaled so max(w, h) <= max_edge
    and re-encoded as JPEG.

    Re-encoding as JPEG serves two purposes:
    - gpt-image-2 caps the longest input edge at 3840px; the drawio CLI
      export at `--scale 2` on a multi-panel composite easily overshoots,
      so we resize here.
    - JPEG is smaller than PNG for screenshot-like content and, more
      importantly, re-encoding via Pillow launders any container-level
      damage in the source (e.g. a truncated PNG missing its IEND chunk
      from a killed drawio CLI export). LOAD_TRUNCATED_IMAGES lets Pillow
      decode whatever valid pixel data is present and drop the rest.

    `subsampling=0` (4:4:4) keeps full chroma resolution, which matters
    for diagram content: coloured labels, thin saturated strokes, and
    pure-colour panel backgrounds otherwise pick up visible chroma
    fringing under 4:2:2.
    """
    try:
        from PIL import Image, ImageFile  # type: ignore
    except ImportError:
        raise SystemExit(
            "ERROR: `pillow` is required to resize the input image.\n"
            f"  {sys.executable} -m pip install pillow"
        )

    ImageFile.LOAD_TRUNCATED_IMAGES = True
    try:
        img = Image.open(input_path)
        img.load()
    except Exception as exc:
        raise SystemExit(
            f"ERROR: cannot decode {input_path} as an image: {exc}\n"
            f"  File size: {input_path.stat().st_size} bytes."
        )
    img = img.convert("RGB")
    w, h = img.size
    scale = min(1.0, max_edge / max(w, h))
    if scale < 1.0:
        img = img.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92, subsampling=0, optimize=True)
    return buf.getvalue(), "full_figure.jpg", img.size


def load_dotenv_key(name: str, dotenv_path: Path | None = None) -> str | None:
    """Return the value of `name` from a .env file, or None if absent.

    Looks in the cwd first, then at the toolkit root (the parent of
    `scripts/`) — sub-agents are dispatched with cwd=$WORKDIR, where a
    cwd-only lookup would miss the project's `.env` entirely.

    Minimal parser: ignores blank lines and `#` comments, supports
    `KEY=value` with optional surrounding single/double quotes and an
    optional `export ` prefix. No interpolation, no multi-line values —
    enough to pick up an API key.
    """
    if dotenv_path is None:
        for candidate in (Path(".env"), Path(__file__).resolve().parent.parent / ".env"):
            if candidate.exists():
                found = load_dotenv_key(name, candidate)
                if found is not None:
                    return found
        return None
    if not dotenv_path.exists():
        return None
    for raw in dotenv_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, sep, val = line.partition("=")
        if not sep or key.strip() != name:
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        return val
    return None


def discover_placeholders(workdir: Path | None) -> list[tuple[str, dict]]:
    """Return list of (panel_id, entry) for every line of every
    `placeholders_<panel_id>.jsonl` in workdir. Empty if no workdir or
    no files.

    Excludes `placeholders_<panel_id>_mpl.jsonl`: those are matplotlib
    figures embedded as real PNGs BEFORE export, not gray-dashed boxes
    for the enhancer to paint. Including them would match with
    panel=`<panel>_mpl` and inject phantom placeholder instructions
    telling gpt-image to repaint already-rendered plots.
    """
    if workdir is None or not workdir.exists():
        return []
    out: list[tuple[str, dict]] = []
    pat = re.compile(r"^placeholders_(?P<panel>[A-Za-z0-9_]+)\.jsonl$")
    for path in sorted(workdir.glob("placeholders_*.jsonl")):
        if path.name.endswith("_mpl.jsonl"):
            continue
        m = pat.match(path.name)
        if not m:
            continue
        panel_id = m.group("panel")
        for i, raw in enumerate(path.read_text().splitlines(), start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"WARN: {path}:{i} not valid JSON ({exc}); skipping",
                      file=sys.stderr)
                continue
            if isinstance(obj, dict) and "id" in obj:
                out.append((panel_id, obj))
    return out


# ───────────────────── embedded-plot protection (prompt hint) ───────────────
# The edit endpoint's `mask` was tried and rejected: GPT Image treats every
# transparent (editable) pixel as erased, so a mask that keeps only the plots
# returns a blank canvas with two plots on it. The protection is prompt-only.

# `drawio -x ... -b 10`: the export crops to the diagram's content bounds
# and pads this many px (pre-scale) on every side.
_DRAWIO_EXPORT_BORDER = 10
# Template-match search radius (input-PNG px) around the geometry estimate.
_EMBED_SEARCH_RADIUS = 30
_DATA_URI_RE = re.compile(r"image=data:image/png[;,](?:base64,)?(?P<b64>[A-Za-z0-9+/=]+)")


class EmbeddedImage:
    # Plain class, not a dataclass: the tests load this module via
    # spec_from_file_location without registering it in sys.modules, which
    # breaks dataclass field resolution under `from __future__ import annotations`.
    def __init__(self, cell_id: str, rect: tuple[int, int, int, int], png: bytes):
        self.cell_id = cell_id
        self.rect = rect  # x, y, w, h in input-PNG pixels
        self.png = png
        self.match_error: float | None = None  # mean |diff| on 0-255 gray; None = not refined
        self.panel: str | None = None
        self.index: str | None = None
        self.kind: str | None = None
        self.description: str | None = None


def _geom_floats(geom, *keys) -> list[float]:
    return [float(geom.get(k, 0) or 0) for k in keys]


def discover_embedded_images(drawio_path: Path, png_size: tuple[int, int]) -> list[EmbeddedImage]:
    """Locate every `shape=image` cell carrying a base64 PNG in the exported
    PNG. drawio's export crops to the content bounds plus a fixed border, so
    the cell→pixel map is a uniform scale from those bounds; the estimate is
    refined by template matching in `refine_embedded_images`."""
    try:
        root = ET.parse(drawio_path).getroot()
    except ET.ParseError as exc:
        print(f"WARN: {drawio_path.name} did not parse ({exc}); embedded-plot protection skipped",
              file=sys.stderr)
        return []
    xs: list[float] = []
    ys: list[float] = []
    xe: list[float] = []
    ye: list[float] = []
    found: list[tuple[str, float, float, float, float, bytes]] = []
    for cell in root.iter("mxCell"):
        geom = cell.find("mxGeometry")
        if geom is None:
            continue
        if cell.get("vertex") == "1":
            x, y, w, h = _geom_floats(geom, "x", "y", "width", "height")
            if geom.get("relative") == "1":
                continue  # edge-label geometry, not canvas-absolute
            xs.append(x); ys.append(y); xe.append(x + w); ye.append(y + h)
            m = _DATA_URI_RE.search(cell.get("style", ""))
            if m and "shape=image" in cell.get("style", ""):
                try:
                    png = base64.b64decode(m.group("b64"))
                except Exception:
                    continue
                found.append((cell.get("id", "?"), x, y, w, h, png))
        for pt in geom.iter("mxPoint"):
            if pt.get("as") == "offset":
                continue  # label nudge, relative to the edge
            px, py = _geom_floats(pt, "x", "y")
            xs.append(px); ys.append(py); xe.append(px); ye.append(py)
    if not found or not xs:
        return []
    bx0, by0 = min(xs), min(ys)
    bw, bh = max(xe) - bx0, max(ye) - by0
    W, H = png_size
    b = _DRAWIO_EXPORT_BORDER
    scale = (W / (bw + 2 * b) + H / (bh + 2 * b)) / 2
    out = []
    for cid, x, y, w, h, png in found:
        rect = (round((x - bx0 + b) * scale), round((y - by0 + b) * scale),
                max(1, round(w * scale)), max(1, round(h * scale)))
        out.append(EmbeddedImage(cell_id=cid, rect=rect, png=png))
    return out


def refine_embedded_images(png_path: Path, embeds: list[EmbeddedImage],
                           radius: int = _EMBED_SEARCH_RADIUS) -> None:
    """Snap each estimated rect onto the actual rendered glyph by brute-force
    template matching (coarse stride 3, then fine ±3) in a ±radius window.
    Best-effort: without numpy the geometry estimate stands."""
    try:
        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
    except ImportError:
        return
    canvas = Image.open(png_path).convert("L")
    A = np.asarray(canvas, dtype=np.float32)
    H, W = A.shape
    for e in embeds:
        x0, y0, w, h = e.rect
        if w < 4 or h < 4 or w > W or h > H:
            continue
        try:
            g = Image.open(io.BytesIO(e.png)).convert("RGBA")
        except Exception:
            continue
        bg = Image.new("RGBA", g.size, (255, 255, 255, 255))
        bg.alpha_composite(g)
        G = np.asarray(bg.convert("L").resize((w, h), Image.Resampling.LANCZOS), dtype=np.float32)

        def err(x: int, y: int) -> float:
            if x < 0 or y < 0 or x + w > W or y + h > H:
                return float("inf")
            return float(np.abs(A[y:y + h, x:x + w] - G).mean())

        best = (err(x0, y0), x0, y0)
        for dy in range(-radius, radius + 1, 3):
            for dx in range(-radius, radius + 1, 3):
                v = err(x0 + dx, y0 + dy)
                if v < best[0]:
                    best = (v, x0 + dx, y0 + dy)
        _, cx, cy = best
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                v = err(cx + dx, cy + dy)
                if v < best[0]:
                    best = (v, cx + dx, cy + dy)
        e.match_error, bx, by = best
        if math.isfinite(e.match_error):
            e.rect = (bx, by, w, h)


def annotate_embedded_images(embeds: list[EmbeddedImage], workdir: Path | None) -> None:
    """Attach panel / index / kind / description from the panels'
    `placeholders_<panel>_mpl.jsonl`, matched to each cell by the exact bytes
    of its `mpl_<panel>_<id>.png` (the cell id carries no index)."""
    if workdir is None or not workdir.exists():
        return
    by_bytes: dict[bytes, tuple[str, dict]] = {}
    for path in sorted(workdir.glob("placeholders_*_mpl.jsonl")):
        panel = path.name[len("placeholders_"):-len("_mpl.jsonl")]
        for raw in path.read_text().splitlines():
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict) or "id" not in obj:
                continue
            script = obj.get("script_filename") or f"mpl_{panel}_{obj['id']}.py"
            png_path = workdir / (Path(script).stem + ".png")
            if png_path.exists():
                by_bytes[png_path.read_bytes()] = (panel, obj)
    for e in embeds:
        hit = by_bytes.get(e.png)
        if hit is None:
            continue
        panel, obj = hit
        e.panel, e.index = panel, str(obj.get("id"))
        e.kind, e.description = obj.get("kind"), (obj.get("description") or "").strip()


def _format_protected(embeds: list[EmbeddedImage], png_size: tuple[int, int]) -> str:
    W, H = png_size
    lines = []
    for e in embeds:
        x, y, w, h = e.rect
        where = f"x {100*x/W:.1f}% / y {100*y/H:.1f}% / w {100*w/W:.1f}% / h {100*h/H:.1f}%"
        if e.panel is not None:
            head = f"panel `{e.panel}`, plot {e.index} ({e.kind or 'plot'})"
            tail = f": {e.description}" if e.description else ""
        else:
            head, tail = f"embedded raster `{e.cell_id}`", ""
        lines.append(f"- {head} at {where}{tail}")
    return "\n".join(lines)


def build_protected_block(embeds: list[EmbeddedImage], png_size: tuple[int, int]) -> str:
    if not embeds:
        return ""
    n = len(embeds)
    count = "One region" if n == 1 else f"{n} regions"
    return PROTECTED_TEMPLATE.format(count=count, entries=_format_protected(embeds, png_size))


def _format_placeholders(entries: list[tuple[str, dict]]) -> str:
    lines = []
    for panel_id, entry in entries:
        pid = entry.get("id", "?")
        kind = entry.get("kind", "?")
        desc = entry.get("description", "").strip()
        lines.append(f"- `[[ pl {panel_id} {pid} ]]` (kind: {kind}) — {desc}")
    return "\n".join(lines)


def build_prompt(figure_summary: str | None, placement: str,
                 placeholders: list[tuple[str, dict]] | None = None,
                 protected_block: str = "") -> str:
    if figure_summary and figure_summary.strip():
        summary_block = FIGURE_SUMMARY_TEMPLATE.format(summary=figure_summary.strip())
    else:
        summary_block = ""
    if placeholders:
        placeholders_block = PLACEHOLDERS_TEMPLATE.format(
            placeholders=_format_placeholders(placeholders)
        )
    else:
        placeholders_block = ""
    placement_block = PLACEMENT_BLOCKS[placement]
    return SYSTEM_PROMPT.format(
        placement_block=placement_block,
        figure_summary_block=summary_block,
        placeholders_block=placeholders_block,
        protected_block=protected_block,
    )


def _cli() -> int:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--workdir", required=False, type=Path, default=None,
                   help="Per-invocation workdir; if it contains "
                        "`figure_summary.md`, that file's contents are "
                        "embedded as a tight, image-only inventory of "
                        "what the input figure depicts.")
    p.add_argument("--input", type=Path, default=None,
                   help="Input PNG "
                        "(default: figures/full_figure.png).")
    p.add_argument("--summary", type=Path, default=None,
                   help="Path to a figure_summary.md (default: "
                        "<workdir>/figure_summary.md if --workdir is given). "
                        "Optional. Should describe ONLY what is visibly in "
                        "the input image, not the paper's methodology.")
    p.add_argument("--out", type=Path, default=None,
                   help="Output PNG "
                        "(default: figures/full_figure_enhanced.png).")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help=f"Image-edit model (default: {DEFAULT_MODEL}). "
                        "nanobanana = Gemini 3.1 Flash Image, "
                        "nanobanana-pro = Gemini 3 Pro Image; both need "
                        "GEMINI_API_KEY instead of OPENAI_API_KEY. "
                        "codex = the codex CLI's $imagegen skill "
                        "(gpt-image-2; needs a ChatGPT-authenticated "
                        "codex CLI, no API key). Any other id is passed "
                        "through: gemini* to the Gemini API, the rest to "
                        "the OpenAI Images API.")
    p.add_argument("--size", default=None,
                   help="Output size 'WIDTHxHEIGHT' (optional override). "
                        "When omitted, the output matches the input image's "
                        "dimensions, snapped to the nearest size gpt-image-2 "
                        "accepts (both edges <= 3840 and multiples of 16, "
                        "long/short ratio <= 3:1, total pixels in "
                        "[655360, 8294400]). The nanobanana models size by "
                        "aspect ratio + resolution, so --size only steers "
                        "the aspect-ratio snap.")
    p.add_argument("--quality", default=DEFAULT_QUALITY,
                   help=f"Output quality (default: {DEFAULT_QUALITY}, from "
                        "$ENHANCE_QUALITY when set). Passed to the model "
                        "as-is, so use its own vocabulary: gpt-image-2.5-* "
                        "take low|medium|high|xhigh|max|auto, gpt-image-2 "
                        "has no xhigh/max. For nanobanana models the same "
                        "ladder maps to the output resolution (low=1K, "
                        "medium/auto=2K, high/xhigh/max=4K) or pass a "
                        "literal 1K|2K|4K; capped at the model's max.")
    p.add_argument("--placement", required=True,
                   choices=["half-width", "full-width"],
                   help="Where the figure will sit in the paper. Affects "
                        "only the prompt's label-sizing guidance, not the "
                        "output dimensions. 'half-width' = one column of a "
                        "double-column conference paper (prompt asks for "
                        "larger labels). 'full-width' = spans paper margins, "
                        "single- or double-column.")
    p.add_argument("--max-edge", type=int, default=DEFAULT_MAX_EDGE,
                   help=f"Max input image edge in px before resize (default: {DEFAULT_MAX_EDGE}; "
                        f"hard limit on gpt-image-2 is 3840).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the composed prompt and exit without calling the API.")
    p.add_argument("--protect-mpl", action=argparse.BooleanOptionalAction,
                   default=DEFAULT_PROTECT_MPL,
                   help="Protect the matplotlib plots embedded in the "
                        "composite .drawio next to --input: locate them in "
                        "the PNG and list them in the prompt as "
                        "reproduce-verbatim regions with position and "
                        "description (a strong hint, not a pixel guarantee). "
                        f"Default: {'on' if DEFAULT_PROTECT_MPL else 'off'} "
                        "($ENHANCE_PROTECT_MPL=0 turns it off).")
    args = p.parse_args()

    if not args.quality.strip():
        print("ERROR: --quality must not be empty", file=sys.stderr)
        return 2

    figures_dir = Path("figures")
    input_path: Path = args.input or (figures_dir / "full_figure.png")
    out_path: Path = args.out or (figures_dir / "full_figure_enhanced.png")
    summary_path: Path | None = args.summary
    if summary_path is None and args.workdir is not None:
        candidate = args.workdir / "figure_summary.md"
        summary_path = candidate if candidate.exists() else None

    if not input_path.exists():
        print(f"ERROR: input PNG not found at {input_path}", file=sys.stderr)
        return 2

    summary_text: str | None = None
    if summary_path is not None:
        if not summary_path.exists():
            print(f"ERROR: --summary path not found at {summary_path}", file=sys.stderr)
            return 2
        summary_text = summary_path.read_text()
        print(f"loaded figure summary: {summary_path} ({len(summary_text)} chars)")

    placeholders = discover_placeholders(args.workdir)
    if placeholders:
        panels_seen = sorted({p for p, _ in placeholders})
        print(f"loaded placeholders: {len(placeholders)} entr"
              f"{'y' if len(placeholders)==1 else 'ies'} "
              f"across {len(panels_seen)} panel(s): {', '.join(panels_seen)}")

    spec = resolve_model(args.model)
    backend, api_model = spec["backend"], spec["model"]

    embeds: list[EmbeddedImage] = []
    raw_size = read_image_size(input_path)
    drawio_path = input_path.with_suffix(".drawio")
    if args.protect_mpl and drawio_path.exists():
        embeds = discover_embedded_images(drawio_path, raw_size)
        if embeds:
            refine_embedded_images(input_path, embeds)
            annotate_embedded_images(embeds, args.workdir)
            print(f"protecting {len(embeds)} embedded plot(s) from {drawio_path.name}:")
            for e in embeds:
                tag = f"{e.panel}/{e.index}" if e.panel else e.cell_id
                err = f", match err {e.match_error:.1f}" if e.match_error is not None else ""
                print(f"  {tag}: rect x={e.rect[0]} y={e.rect[1]} w={e.rect[2]} h={e.rect[3]}{err}")
    elif args.protect_mpl:
        print(f"no {drawio_path.name} next to the input; embedded-plot protection skipped")

    prompt = build_prompt(summary_text, placement=args.placement,
                          placeholders=placeholders,
                          protected_block=build_protected_block(embeds, raw_size))

    # Resize first so the requested output size tracks the image the model
    # actually sees, not the raw export.
    img_bytes, img_name, (sent_w, sent_h) = prepare_input_image(input_path, args.max_edge)

    size = aspect = image_size = ""
    if backend == "gemini":
        try:
            image_size = gemini_image_size(args.quality, spec["max_image_size"])
        except KeyError:
            print(f"ERROR: --quality {args.quality!r} is not a Gemini resolution; "
                  f"use one of {', '.join(_QUALITY_TO_IMAGE_SIZE)} or a literal "
                  f"{'/'.join(_IMAGE_SIZE_ORDER)}.", file=sys.stderr)
            return 2
        if args.size:
            try:
                sw, sh = (int(v) for v in args.size.lower().split("x", 1))
                if sw <= 0 or sh <= 0:
                    raise ValueError
            except ValueError:
                print(f"ERROR: --size must be 'WIDTHxHEIGHT' (positive), "
                      f"got {args.size!r}", file=sys.stderr)
                return 2
            aspect = fit_gemini_aspect(sw, sh)
            size_note = (f"aspect from --size {args.size}; nanobanana sizes by "
                         "aspect ratio + resolution, not exact pixels")
        else:
            aspect = fit_gemini_aspect(sent_w, sent_h)
            size_note = f"matched to input {sent_w}x{sent_h}"
        size_desc = f"{aspect} @ {image_size}"
        quality_desc = f"{args.quality} → {image_size}"
    else:
        # openai and codex both target gpt-image-2 sizes; for codex the
        # size is prompt guidance to the agent rather than an API param.
        if args.size:
            size, size_note = args.size, "override"
        else:
            size = fit_gpt_image_size(sent_w, sent_h)
            size_note = f"matched to input {sent_w}x{sent_h}"
        size_desc = size
        quality_desc = args.quality
        if backend == "codex":
            size_note += "; prompt guidance only — codex $imagegen decides"
            quality_desc = f"{args.quality} (ignored by codex $imagegen)"

    if args.dry_run:
        print(f"[dry-run] model:     {args.model} → {api_model} ({backend})")
        print(f"[dry-run] placement: {args.placement}")
        print(f"[dry-run] size:      {size_desc} ({size_note})")
        print(f"[dry-run] quality:   {quality_desc}")
        print(f"[dry-run] input:     {input_path} → {img_name} {sent_w}x{sent_h}")
        print(f"[dry-run] out:       {out_path}")
        print(f"[dry-run] protected: {len(embeds)} embedded plot(s)")
        print(f"[dry-run] prompt ({len(prompt)} chars):")
        print("─" * 72)
        print(prompt)
        print("─" * 72)
        print("[dry-run] API call skipped.")
        return 0

    print(f"output size: {size_desc} ({size_note})")
    print(f"quality: {quality_desc} (change with --quality here, or "
          "--enhance-quality on the autoillustrate CLI)")
    print(f"input: {input_path} → {img_name} {sent_w}x{sent_h} ({len(img_bytes)/1024:.1f} KB)")

    out_path.parent.mkdir(parents=True, exist_ok=True)

    if backend == "gemini":
        return _call_gemini(api_model, aspect, image_size, img_bytes, prompt, out_path, args.workdir)
    if backend == "codex":
        return _call_codex(size, img_bytes, prompt, out_path, args.workdir)
    return _call_openai(api_model, size, args.quality, img_bytes, img_name, prompt, out_path, args.workdir)


def _call_openai(model: str, size: str, quality: str, img_bytes: bytes,
                 img_name: str, prompt: str, out_path: Path, workdir) -> int:
    if not os.environ.get("OPENAI_API_KEY"):
        from_dotenv = load_dotenv_key("OPENAI_API_KEY")
        if from_dotenv:
            os.environ["OPENAI_API_KEY"] = from_dotenv
            print("loaded OPENAI_API_KEY from .env")
        else:
            print("ERROR: OPENAI_API_KEY is not set in env or .env (cwd).",
                  file=sys.stderr)
            return 2

    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        print(
            "ERROR: the `openai` package is not installed.\n"
            f"  {sys.executable} -m pip install 'openai>=1.50'",
            file=sys.stderr,
        )
        return 2

    client = OpenAI()
    print(f"calling {model} ({size}, quality={quality}) ...")
    image_file = io.BytesIO(img_bytes)
    image_file.name = img_name
    started = time.perf_counter()
    result = client.images.edit(
        model=model,
        image=image_file,
        prompt=prompt,
        size=size,
        quality=quality,
    )
    elapsed = time.perf_counter() - started
    # Record immediately: images.edit is billed whether or not the payload is
    # usable, and it returns no token usage — cost is per-image (TS estimates
    # from size). Recording before the guard avoids undercounting a billed but
    # empty response.
    record_usage(workdir, phase=resolve_phase(5), source="openai-image", model=model,
                 duration_secs=elapsed, basis="image", images=1,
                 size=size, quality=quality)

    b64 = result.data[0].b64_json
    if not b64:
        print("ERROR: API response had no b64_json payload", file=sys.stderr)
        return 1
    out_path.write_bytes(base64.b64decode(b64))
    print(f"wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")
    return 0


def _call_gemini(model: str, aspect_ratio: str, image_size: str,
                 img_bytes: bytes, prompt: str, out_path: Path, workdir) -> int:
    if not os.environ.get("GEMINI_API_KEY"):
        from_dotenv = load_dotenv_key("GEMINI_API_KEY")
        if from_dotenv:
            os.environ["GEMINI_API_KEY"] = from_dotenv
            print("loaded GEMINI_API_KEY from .env")
        else:
            print("ERROR: GEMINI_API_KEY is not set in env or .env (cwd).",
                  file=sys.stderr)
            return 2

    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except ImportError:
        print(
            "ERROR: the `google-genai` package is not installed.\n"
            f"  {sys.executable} -m pip install 'google-genai>=2.0'",
            file=sys.stderr,
        )
        return 2

    # Explicit key: a bare Client() prefers GOOGLE_API_KEY when both are
    # set, but the preflight above only guarantees GEMINI_API_KEY.
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    print(f"calling {model} (aspect={aspect_ratio}, resolution={image_size}) ...")
    started = time.perf_counter()
    try:
        result = client.models.generate_content(
            model=model,
            contents=[
                types.Part.from_text(text=prompt),
                types.Part.from_bytes(data=img_bytes, mime_type="image/jpeg"),
            ],
            config=types.GenerateContentConfig(
                response_modalities=["TEXT", "IMAGE"],
                image_config=types.ImageConfig(
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                ),
            ),
        )
    except Exception as exc:
        print(f"ERROR: Gemini API call failed: {exc}", file=sys.stderr)
        return 1
    elapsed = time.perf_counter() - started
    # Record immediately — the call is billed even if it returns no image part
    # (e.g. a safety refusal still consumes tokens).
    _record_gemini_usage(workdir, model, elapsed, result)

    parts = result.parts or []
    out_bytes = next(
        (part.inline_data.data for part in parts
         if part.inline_data and part.inline_data.data),
        None,
    )
    if out_bytes is None:
        # Surface any text the model returned instead of an image —
        # typically a safety/policy refusal — so re-roll loops don't
        # retry blind.
        for part in parts:
            if part.text:
                print(f"API text response: {part.text[:500]}", file=sys.stderr)
        print("ERROR: API response had no image part", file=sys.stderr)
        return 1
    out_path.write_bytes(_ensure_png(out_bytes))
    print(f"wrote {out_path} ({out_path.stat().st_size / 1024:.1f} KB)")
    return 0


def _record_gemini_usage(workdir, model: str, elapsed: float, result) -> None:
    """Record token usage from a Gemini response. Gemini bills image output
    as tokens, so basis is "tokens" (TS prices it). Best-effort on the
    usage_metadata shape."""
    meta = getattr(result, "usage_metadata", None)
    prompt_tokens = getattr(meta, "prompt_token_count", None)
    out_tokens = getattr(meta, "candidates_token_count", None)
    record_usage(workdir, phase=resolve_phase(5), source="gemini-image", model=model,
                 duration_secs=elapsed, basis="tokens",
                 input_tokens=prompt_tokens, output_tokens=out_tokens)


def _call_codex(size: str, img_bytes: bytes, prompt: str, out_path: Path, workdir) -> int:
    """Restyle via the codex CLI's built-in $imagegen skill (gpt-image-2
    underneath, billed against the ChatGPT subscription). The agent gets
    the prepared input image attached and must save to `out_path`."""
    codex = shutil.which("codex")
    if codex is None:
        print(
            "ERROR: the `codex` CLI is not on PATH (needed for --model codex).\n"
            "  npm install -g @openai/codex  # then: codex login",
            file=sys.stderr,
        )
        return 2

    # The agent works in a scratch dir so its workspace-write sandbox
    # cannot touch the deterministic ground-truth artifacts next to
    # out_path (full_figure.png / full_figure.drawio feed phase 6).
    out_abs = out_path.resolve()
    scratch = out_abs.parent / f".{out_abs.stem}_codex_scratch"
    scratch.mkdir(exist_ok=True)
    input_img = scratch / "input.jpg"
    result_img = scratch / "enhanced.png"
    input_img.write_bytes(img_bytes)

    agent_prompt = (
        "You are running non-interactively inside an automated pipeline.\n"
        "Use the built-in $imagegen skill to restyle the attached reference\n"
        "image according to the brief below.\n"
        "\n"
        "- Edit the attached image; do not create an unrelated image.\n"
        f"- Target output size: approximately {size} pixels (match the\n"
        "  reference aspect ratio).\n"
        f"- Save the result exactly to: {result_img}\n"
        "- Do not modify any other files, do not run any other commands,\n"
        "  and do not post-process the image beyond saving it to that path.\n"
        "\n"
        "RESTYLE BRIEF\n"
        "=============\n"
        f"{prompt}\n"
    )

    # `--` is load-bearing: -i is variadic and would swallow the prompt.
    argv = [codex, "exec", "--skip-git-repo-check", "--ephemeral",
            "-s", "workspace-write", "-C", str(scratch),
            "-i", str(input_img), "--", agent_prompt]
    print(f"calling codex $imagegen (target ~{size}) ...")
    started = time.perf_counter()
    try:
        # DEVNULL so an unauthenticated codex errors out instead of
        # blocking on an interactive login prompt until the watchdog.
        proc = subprocess.run(argv, stdin=subprocess.DEVNULL,
                              timeout=_CODEX_TIMEOUT_SECS)
        if proc.returncode != 0:
            print(f"ERROR: codex exec failed with exit code {proc.returncode}",
                  file=sys.stderr)
            return 1
        if not result_img.exists() or result_img.stat().st_size == 0:
            print("ERROR: codex run completed but did not write the output "
                  "image", file=sys.stderr)
            return 1
        try:
            out_abs.write_bytes(_ensure_png(result_img.read_bytes()))
        except Exception as exc:
            print(f"ERROR: codex output is not a decodable image: {exc}",
                  file=sys.stderr)
            return 1
    except subprocess.TimeoutExpired:
        print(f"ERROR: codex exec timed out after {_CODEX_TIMEOUT_SECS}s",
              file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    # codex $imagegen is billed against the ChatGPT subscription, not metered
    # API credits — record runtime with no dollar cost (TS treats it as $0).
    record_usage(workdir, phase=resolve_phase(5), source="codex",
                 model="gpt-image-2 (codex $imagegen)",
                 duration_secs=time.perf_counter() - started,
                 basis="subscription")
    print(f"wrote {out_path} ({out_abs.stat().st_size / 1024:.1f} KB)")
    return 0


def _ensure_png(img_bytes: bytes) -> bytes:
    """Gemini returns JPEG bytes; the pipeline's output contract is a real
    PNG at full_figure_enhanced.png, so re-encode anything that isn't one."""
    if img_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return img_bytes
    from PIL import Image  # hard dep already (prepare_input_image)

    buf = io.BytesIO()
    Image.open(io.BytesIO(img_bytes)).convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


if __name__ == "__main__":
    sys.exit(_cli())
