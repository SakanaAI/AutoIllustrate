#!/usr/bin/env python3
# Skeleton starter for a per-placeholder `mpl_<panel_id>_<id>.py`.
# Copy this file into the workdir, rename it to match the
# `script_filename` declared in `placeholders_<panel_id>_mpl.jsonl`,
# and fill in `compute_data()` / `draw()`.
#
# Contract (see references/panel_agent.md §"Matplotlib placeholders"
# and step 6 of the lifecycle):
#   * Use the Agg backend (no GUI, no plt.show()).
#   * Numpy + stdlib only — no external datasets.
#   * Saved PNG must be EXACTLY intended_dimensions.w × .h pixels
#     (±2 px). Achieved here via figsize=(W/DPI, H/DPI) +
#     savefig(..., bbox_inches=None, pad_inches=0).
#   * Output goes to $WORKDIR/mpl_<panel_id>_<id>.png, resolved via
#     Path(__file__).parent so the script works from any CWD.
#
# Design intent: the final figure is an ILLUSTRATIVE / SCHEMATIC
# diagram inside a larger composite — not a standalone publication
# plot. Default styling below is deliberately minimal: LaTeX text,
# no axes, no ticks, no labels, no legend, no grid. Override any of
# the rcParams / ax settings as the specific placeholder requires
# (e.g. flip on an x-axis tick for a histogram), but keep the result
# clean and uncluttered — do NOT re-enable every spine and tick just
# because matplotlib defaults to them.
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# ── Output geometry ──
# Must match the `intended_dimensions` declared for this placeholder
# in placeholders_<panel_id>_mpl.jsonl. DPI is free — pick something
# round (100 is fine) and let figsize absorb the rest.
OUT_W, OUT_H = 248, 220        # pixels
DPI = 100

# ── Global style ──
# LaTeX rendering on. Requires a working LaTeX install on PATH
# (latex, dvipng). If LaTeX is unavailable in the environment, swap
# `text.usetex` to False — matplotlib's built-in mathtext still
# renders $...$ math, just with slightly different glyphs.
plt.rcParams.update({
    "text.usetex": True,
    "font.family": "serif",
    "font.size": 11,
    # Schematic defaults: hide every chrome element. Re-enable
    # selectively in `draw()` if a specific plot needs an axis.
    "axes.spines.top":    False,
    "axes.spines.right":  False,
    "axes.spines.bottom": False,
    "axes.spines.left":   False,
    "xtick.bottom": False, "xtick.top":   False, "xtick.labelbottom": False,
    "ytick.left":   False, "ytick.right": False, "ytick.labelleft":   False,
    "axes.grid": False,
})


def compute_data():
    """Return whatever arrays / values `draw()` needs. Pure: no I/O,
    no global state. Use numpy + stdlib only — the placeholder is
    meant to look right, not to be reproducible from a real dataset.
    Seed any RNG so reruns produce the same PNG."""
    rng = np.random.default_rng(0)
    x = np.linspace(0, 1, 200)
    y = ...  # fill in
    return x, y


def draw(ax, data) -> None:
    """Draw onto `ax`. Keep it SCHEMATIC: one or two visual elements,
    no legend, no title, no axis labels unless the placeholder's
    `description` explicitly calls for them. If you need a tick or a
    spine back, re-enable it locally here (e.g.
    `ax.spines['bottom'].set_visible(True)`), not via rcParams."""
    x, y = data
    ax.plot(x, y, color="#1f78b4", linewidth=1.6)
    # ax.set_xlabel(r"$\theta$")    # uncomment if the description demands it
    # ax.set_ylabel(r"$p(\theta)$")
    # ax.spines["bottom"].set_visible(True); ax.tick_params(bottom=True, labelbottom=True)


def main() -> None:
    out = Path(__file__).parent / f"{Path(__file__).stem.replace('mpl_', 'mpl_')}.png"
    # ↑ Convention: script `mpl_<panel_id>_<id>.py` → PNG
    #   `mpl_<panel_id>_<id>.png`. Override `out` directly if you
    #   need a different name.

    fig = plt.figure(figsize=(OUT_W / DPI, OUT_H / DPI), dpi=DPI)
    ax = fig.add_subplot(111)
    # Fill the whole figure — no whitespace gutters. Tweak only if
    # the placeholder genuinely needs internal margins for labels.
    fig.subplots_adjust(left=0, right=1, bottom=0, top=1)

    draw(ax, compute_data())

    fig.savefig(out, dpi=DPI, bbox_inches=None, pad_inches=0)
    plt.close(fig)


if __name__ == "__main__":
    main()
