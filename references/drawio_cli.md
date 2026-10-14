# draw.io export — the hardened exporter

ALWAYS export through the toolkit's hardened exporter — never invoke
`drawio -x` directly. drawio's headless export intermittently wedges
on MathJax-bearing files (an unhandled `UnknownVizError` inside the
Electron renderer leaves the process idling forever without writing
the PNG). The exporter fast-fails one direct attempt, then falls back
to a drawio SVG export rasterized by headless Chrome (verifying every
formula survived), all in the foreground within ~2 minutes.

## Export commands

```bash
# Per-panel PNG at 2x scale (intermediate, inspected individually):
node "$TOOLKIT_DIR/dist/cli.js" export name.drawio name.png --export-scale 2

# Composite PNG at a fixed pixel width keyed to placement
# (matches the gpt-image-2 canvas used in Phase 5 — no upscale):
node "$TOOLKIT_DIR/dist/cli.js" export full_figure.drawio full_figure.png --export-width 2560
```

`--export-width` and `--export-scale` are mutually exclusive — pass
only one (default: `--export-scale 2`). Exit 0 + a `wrote <png>` line
is success; non-zero is a hard failure (the transcript also lands in
`<png>.export.log`). Use absolute paths for both arguments.

## Underlying CLI (context only — do not invoke directly)

The exporter shells out to the draw.io desktop CLI:

| Environment | Path |
|-------------|------|
| macOS | `/Applications/draw.io.app/Contents/MacOS/draw.io` |
| Linux | `drawio` (on PATH via snap/apt/flatpak) |
| WSL2 | `` `/mnt/c/Program Files/draw.io/draw.io.exe` `` |
| Windows | `"C:\Program Files\draw.io\draw.io.exe"` |

with `-x` export mode, `-f` format, `-b 10` border — plus the
SVG+Chrome fallback when the direct export wedges
(`AUTOILLUSTRATE_CHROME` overrides Chrome auto-detection).

The PNG export deliberately omits `-e` (embed diagram XML into the
PNG): the embed path (`writePngWithText`) is regressed in
drawio-desktop v30.0.2+ and crashes with a buffer overflow on large
canvases. The editable `.drawio` source is preserved alongside every
export, so embedding it into the PNG is redundant.
