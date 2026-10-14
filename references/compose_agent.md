# Compose agent — Phase 4 fallback composition

This file is the full instruction set for the **Phase 4 compose
sub-agent** of the autoillustrate pipeline. It is dispatched ONLY when
the orchestrator's deterministic compose threw — your job is to
reproduce that composition by hand, repair whatever broke, and leave
both deliverables on disk so Phase 5 (enhance) can proceed.

Execution constraint (never violate): run EVERY command in the
FOREGROUND — `compose.py`, `lint_math.py`, the generators, and the
`drawio` CLI are all synchronous. Do not use `run_in_background`, a
trailing `&`, scheduled wakeups/notifications, or sleep-poll loops;
your session ends the moment you end your turn, so backgrounded work
is reaped unfinished and the orchestrator fails the phase. The
`drawio` export must be its OWN standalone Bash call (the harness
auto-backgrounds any single command that runs too long, and once
backgrounded it is reaped when the turn ends). Chaining fast
deterministic steps (`generate_<panel>.py && generate_composite.py`)
is fine.

Reference every file by ABSOLUTE path; never assume the shell cwd. Run
every Python script with the `$PYTHON` interpreter from your dispatch
header (it has the toolkit's dependencies installed).

## Step 0 — Diagnose

Read `$WORKDIR/logs/phase4.log` first. It is the deterministic
compose's own log and names the exact step that failed and the error
(a Python traceback, a lint error, or a `drawio` export wedge). Fix
the cause of THAT failure, not a guess.

## The deterministic compose chain you are replacing

The orchestrator runs these four steps in order; reproduce them,
repairing as needed:

1. **Compose template + generator.** Aggregates the per-panel
   templates/generators into a composite:

   ```bash
   "$PYTHON" "$TOOLKIT_DIR/scripts/compose.py" \
       --workdir $WORKDIR/ --out-dir $WORKDIR/figures/
   ```

   Writes `$WORKDIR/composite.drawio.template` and
   `$WORKDIR/generate_composite.py`. It reads every panel's
   `build_params()` for layout — including the mandatory `page_w` /
   `page_h` keys (see "Common failures" below).

2. **Lint the composite template.**

   ```bash
   "$PYTHON" "$TOOLKIT_DIR/scripts/lint_math.py" \
       $WORKDIR/composite.drawio.template
   ```

3. **Generate the composite drawio** (warnings are bypassed at compose;
   errors still abort inside `build_params`):

   ```bash
   "$PYTHON" $WORKDIR/generate_composite.py --bypass-warnings
   ```

   Writes `$WORKDIR/figures/full_figure.drawio`.

4. **Export the PNG** (width 2560 for both placements; only the
   aspect/height differs). Use the HARDENED exporter — NEVER a raw
   `drawio -x` invocation: drawio's headless export intermittently
   wedges on math-bearing composites (unhandled `UnknownVizError`,
   idling forever without a PNG). The exporter fast-fails one direct
   attempt then falls back to SVG + headless-Chrome rasterization,
   completing in the foreground within ~2 minutes. Exit 0 +
   `wrote <png>` is success.

   ```bash
   node "$TOOLKIT_DIR/dist/cli.js" export \
       $WORKDIR/figures/full_figure.drawio \
       $WORKDIR/figures/full_figure.png \
       --export-width 2560
   ```

## Common failures and how to repair them

- **A panel breaks at composition.** A panel can render a valid
  `panels/<id>.png` yet fail `compose.py` — most often its
  `build_params()` omits `page_w` / `page_h`, which the composer reads
  as the panel's layout size. Fix `$WORKDIR/generate_<panel_id>.py` so
  `build_params(bypass_warnings=True)` returns both keys, then re-run
  from step 1.
- **Lint error in the composite template.** Fix the offending cell in
  `$WORKDIR/composite.drawio.template` (HTML tags, reserved ids, or
  base64 data-URI form are common culprits), then re-run from step 2.
- **Generator KeyError / traceback in `generate_composite.py`.** Trace
  it to the panel or template field it reads, fix that input, re-run
  `compose.py` (step 1) so the composite generator is regenerated, then
  continue.
- **`drawio` export wedge or empty PNG.** Re-run the hardened exporter
  (step 4). If the SVG fallback also fails, simplify the offending
  cell in the composite (or the panel template feeding it) and
  regenerate.

## Output contract

Composition is done when BOTH of these exist and are non-empty:

  - `$WORKDIR/figures/full_figure.drawio`
  - `$WORKDIR/figures/full_figure.png`

The orchestrator judges success on these two files alone (a non-zero
exit from your session is treated as a warning, not a failure, as long
as the deliverables are present). Do not stop until both exist. Report
one or two sentences on what you fixed.
