# CLI reference

```
autoillustrate <source> --prompt "<text>" [options]
autoillustrate --workdir <run-dir> --resume-from <phase> [options]
autoillustrate doctor [--agent <name>]
autoillustrate credentials
autoillustrate export <in.drawio> <out.png> [--export-width <px> | --export-scale <f>]
```

## Positional and core options

```
<source>                  PDF, .tex file, or directory the planner reads.
                          Optional when --resume-from >= 2.
-p, --prompt <text>       What the figure should depict.
    --mode <m>            light | medium | full (default: medium). Speed preset
                          that sets the agent, effort, and the two correction-loop
                          budgets at once; individual flags below override it. All
                          tiers run the claude agent (Opus 5.5).
                            light  — claude, low effort,     0 panel inspects, 0 verify, 0 repair (~10 min)
                            medium — claude, high effort,    0 panel inspects, 0 verify, 0 repair (~15 min)
                            full   — claude, high effort,    3 panel inspects, 3 verify, 2 repair (~30 min)
                          (verify/repair counts are --enhancement-attempts n and
                          n-1; light and medium are n=1, full n=3.) light and
                          medium share the same loop budgets and differ only in
                          effort (low vs high); full adds the inspect +
                          verify/repair loops on top.
    --placement <p>       half-width | full-width | infer (default: infer — Phase 1 decides)
-o, --out-dir <dir>       Parent dir for new runs (default: ./runs).
-w, --workdir <path>      Use this exact run dir (resume an earlier run).
    --output <path>       Copy the final figure (enhanced if produced, else
                          the deterministic export) to <path> when the run
                          finishes, and drop the run's figure.json plan beside
                          it as <stem>.prompts.json. Promote the deliverable
                          without locating the run workdir.
    --resume-from <ph>    1|plan, 2|panels, 3|inspect, 4|compose, 5|enhance,
                          6|verify. Requires --workdir.
    --force               Re-run already-completed phases (ignore sentinels).
    --source <path>, --instructions <text>
                          Legacy aliases of the <source> positional and --prompt.
-h, --help / -V, --version
```

## Models and backends

```
    --enhance-model <m>   gpt-image-2.5-sunburst | gpt-image-2 | nanobanana
                          | nanobanana-pro | codex | <model id>
                          (default: gpt-image-2.5-sunburst). Image model for
                          the Phase 5 restyle; nanobanana = Gemini 3.1 Flash
                          Image, nanobanana-pro = Gemini 3 Pro Image (both need
                          GEMINI_API_KEY); codex = the codex CLI's $imagegen
                          skill (needs a ChatGPT-authenticated codex CLI). Any
                          other id is passed through unchanged: gemini-* to the
                          Gemini API, everything else to the OpenAI Images API.
    --enhance-quality <q> Output quality of the Phase 5 restyle and of the
                          Phase 6 repair re-enhances (default: high). Passed to
                          the image model as-is, so the accepted values are the
                          model's own: gpt-image-2.5-* take low | medium | high
                          | xhigh | max | auto, gpt-image-2 has no xhigh or max,
                          the nanobanana models take the same ladder or a
                          literal 1K | 2K | 4K (capped per model), and codex
                          ignores it.
    --audit-vlm <m>       gpt-6-astra | gpt-5.5 | gemini-3.1-pro (default:
                          gpt-6-astra, at high reasoning effort). Vision
                          model for the content audits — Phase 3 panel inspect
                          and Phase 6 verify Stage A (one shared knob). Sets
                          $AUDIT_VLM for the sub-agents.
    --unit-test-vlm <b>   auto | openai | openai-single | gemini | gemini-single
                          | codex (default: openai-single). Backend for the
                          Phase 6 Stage B unit-test probes, independent of
                          --audit-vlm. '*-single' answers all questions in one
                          call (cheapest); the others fan out one call per
                          question. Sets $UNIT_TEST_VLM for the verify sub-agent.
    --agent <name>        claude | codex | cursor | gemini | opencode | pi
                          (default: from --mode; all presets use claude).
    --model <id>          Model override (default: claude-opus-5-5 for the claude
                          agent, gemini-3.1-pro-preview for gemini; headless
                          per-agent default otherwise).
    --effort <level>      low | medium | high | xhigh
                          (default: from --mode; light uses low, medium and full
                          use high). Not supported
                          with --agent gemini.
    --tmux                Run each sub-agent inside a tmux session (forwards
                          --tmux --wait --delete to headless; headless blocks
                          until the agent finishes, then deletes the session).
                          Not supported with --agent cursor, opencode, gemini, or pi.
                          headless forbids --json/--usage with --tmux, so this
                          mode omits agent usage; those rows show no tokens.
```

## Correction loops and phase control

```
    --skip-enhance        Stop after Phase 4 (deterministic PNG only).
    --panel-inspects <n>  Phase 3 per-panel inspect/refine budget: 1 initial
                          inspect + up to (n-1) repair passes (1-20; default from
                          --mode). 0 skips Phase 3 (panels ship as Phase 2 rendered).
    --enhancement-attempts <n>
                          Enhanced candidates to judge (1-20; default from
                          --mode): the Phase 5 enhance plus (n-1) Phase 6 repair
                          re-enhances, each judged by its own verify. So n verify
                          attempts and (n-1) repair passes. n=1 enhances once and
                          skips Phase 6 entirely (verify only exists to pick a
                          winner and drive repairs).
    --sequential          Run Phase 2/3 per-panel sub-agents one at a time.
-i, --interactive         After Phase 4, open the composed figure in the
                          diagrams.net editor (your browser, served from
                          127.0.0.1 only) and pause. Edits autosave into
                          figures/full_figure.drawio. Press Enter to re-export
                          the PNG and continue to the enhance phase, or Esc to
                          leave with the deterministic figure. Also offered by
                          --resume-from 5.
    --editor-port <n>     Fixed 127.0.0.1 port for the --interactive editor
                          (default: a random free port). Pick one to reach it
                          from a remote machine: ssh -L <n>:127.0.0.1:<n>
```

## Output and logging

```
    --verbose             Also show diagnostics: sub-agent launches, log and
                          prompt paths, deterministic-step output. Implied by
                          --debug.
    --debug               Stream raw sub-agent traces to the terminal too
                          (they always land in <workdir>/logs/ regardless).
    --log-format <f>      human | json (default: human). json writes one JSON
                          record per line to stdout and keeps child output on
                          stderr. Every run also journals all events to
                          <workdir>/events.jsonl.
    --heartbeat-seconds <n>
                          When stdout is not a terminal, print a "still
                          running" line this often during a long phase
                          (default: 60; 0 disables). Interactive terminals
                          refresh one spinner line in place.
```

See [Running and resuming](running.md) for what the terminal output looks
like and the exit codes.

## Subcommands

```
doctor                    Check prerequisites (python3, venv, drawio, headless,
                          agent CLI, OPENAI_API_KEY) and print fix-it hints.
credentials               Report every credential the pipeline can use:
                          OPENAI_API_KEY / GEMINI_API_KEY presence (env or
                          ./.env), plus codex and Claude Code login state.
                          Always exits 0.
export                    Hardened drawio → PNG export; see "Export
                          reliability" below.
```

## Environment variables

| Variable | Effect |
|----------|--------|
| `AGENT_INVOKE_TIMEOUT` | Per-sub-agent watchdog in seconds (default 7200). |
| `AUTOILLUSTRATE_CMD_TIMEOUT` | Watchdog in seconds for deterministic python/drawio steps (default 600). A wedged drawio export fails the phase instead of hanging forever. |
| `AUTOILLUSTRATE_CHROME` | Chrome/Chromium binary for the export fallback (auto-detected by default). |
| `VENV_PY` | Python interpreter override; skips the cached venv. |
| `AUTOILLUSTRATE_PRICE_FILE` | Overrides the API list prices used for the dollar estimates in `metrics/run_metrics.json`. Those estimates ignore subscriptions (Claude Code, ChatGPT) and are never shown in the terminal. |
| `NO_COLOR` / `FORCE_COLOR=1` | Disable / force ANSI colours in the terminal output. |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | See [Installation](install.md). |

## Export reliability

drawio's headless PNG export can wedge on MathJax-bearing figures (an
unhandled `UnknownVizError` inside the renderer). Phase 4 retries the direct
export and then falls back to a drawio SVG export rasterized at full width by
headless Chrome/Chromium, verifying every formula survived the conversion.
Without a Chrome install the fallback is unavailable and a persistent wedge
fails the phase with remediation hints.

The same hardened path is exposed as
`autoillustrate export <in.drawio> <out.png>` (`--export-width <px>` or
`--export-scale <f>`, default scale 2). The sub-agent contracts use it for
every panel and repair re-export instead of raw `drawio -x`, and it is handy
for manually re-exporting a run's artifacts.
