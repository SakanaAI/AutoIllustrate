# Running and resuming

## What a run looks like

The terminal view is concise: a run header, one block per phase, one line
per panel, and the deliverable paths plus a token/runtime table at the end.
Token counts are response length only (output tokens), not prompt input or
cache reads.

```text
Autoillustrate · paper.pdf · medium mode
Agent: claude / claude-opus-5-5 / high effort
Figure: placement infer · enhance gpt-image-2.5-sunburst · audit disabled · unit tests disabled
Loops: 0 panel inspects · 1 enhancement attempt · parallel panels
Run dir: runs/2026-09-11-101500

Phase 1/6 · Plan
  Planning the figure…
  ✓ completed · 3 panels · full-width · 2m 10s · 4.1k tokens

Phase 2/6 · Render panels
  Rendering 3 panels…
  Rendering panel: architecture
  Rendering panel: update_rule
  Rendering panel: training_loop
  ✓ architecture · ok · 3m 2s
  ✓ update_rule · ok · 3m 10s
  ⚠ training_loop · degraded · 4m 1s
  ⚠ degraded · 2/3 panels ok · 1 degraded · 4m 1s · 11.2k tokens (run 15.3k)
  …

Pipeline finished · completed · 14m 20s
  Figure: runs/2026-09-11-101500/figures/full_figure_enhanced.png
  Editable: runs/2026-09-11-101500/figures/full_figure.drawio
```

- On an interactive terminal the active step is a spinner line that
  refreshes in place; a panel fan-out shows one spinner row per panel, and
  each row turns into that panel's result line as soon as it finishes.
  Redirected output (a log file, CI) gets a `still running` heartbeat every
  `--heartbeat-seconds` (default 60; `0` disables), naming the panels still
  in flight.
- Colours are semantic and restrained, and only used on a terminal. Set
  `NO_COLOR=1` for plain output or `FORCE_COLOR=1` to keep colours in a pipe.
- Sub-agent launches, log paths, and the output of the deterministic
  python/drawio steps are hidden by default; `--verbose` shows them, and
  `--debug` additionally streams the raw sub-agent traces. Everything always
  lands in `<workdir>/logs/` regardless.
- `--log-format json` prints one JSON record per line for machine consumers.
  Every run also journals the complete event stream (including the hidden
  diagnostics) to `<workdir>/events.jsonl`.
- A failure prints `ERROR: …`, the failing log's path and its last 50 lines,
  then `Pipeline finished · failed`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (including the `--skip-enhance` / `--enhancement-attempts 1` early exits, and leaving the `--interactive` gate with Esc) |
| 1 | A phase failed (the failing log's last 50 lines are tailed) |
| 2 | Usage error or failed preflight (`doctor`-style remediation printed) |
| 130 | Interrupted (Ctrl+C / SIGTERM) after agent teardown |
| 141 | Output pipe closed downstream (e.g. `autoillustrate … \| head`), after agent teardown |

## Editing the figure before it is enhanced

Run with `-i` / `--interactive`. After Phase 4 the run opens
`full_figure.drawio` in the diagrams.net editor in your browser (served from
a loopback port, so nothing leaves your machine except the editor itself,
which loads from embed.diagrams.net) and pauses:

```text
Phase 4.5/6 · Edit
  Edit the figure at http://127.0.0.1:52731/ — every change autosaves into figures/full_figure.drawio
  Press Enter to continue to the enhance phase, or Esc to leave.
```

Every change autosaves straight into the `.drawio` file. Enter re-exports
`full_figure.png` from your edited diagram and continues to Phase 5 (which
only ever reads that PNG); Esc ends the run there with the deterministic
figure, edits included.

On a remote machine without a browser the run prints the URL and an
`ssh -L` hint instead; use `--editor-port <n>` to fix the port so the tunnel
can be set up ahead of time:

```bash
ssh -L 8765:127.0.0.1:8765 <remote>
autoillustrate ./methods.tex --prompt "…" --interactive --editor-port 8765
```

Note that `--resume-from compose --force` regenerates the composite from the
panel generators and discards hand edits; resume from `enhance` to keep them.

## Resuming an earlier run

Every phase leaves a sentinel report in the run directory, so re-running on
the same `--workdir` skips whatever already completed:

```bash
autoillustrate --workdir runs/2026-05-20-101010
```

Re-run explicitly from a given phase (`1|plan`, `2|panels`, `3|inspect`,
`4|compose`, `5|enhance`, `6|verify`):

```bash
autoillustrate --workdir runs/2026-05-20-101010 --resume-from compose
```

Touch up the composed figure by hand, then re-enhance it:

```bash
autoillustrate --workdir runs/2026-05-20-101010 --resume-from enhance --interactive
```

Add `--force` to re-run phases that already have a sentinel.
