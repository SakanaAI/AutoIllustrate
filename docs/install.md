# Installation

```bash
npm install -g autoillustrate    # or: npx autoillustrate ...
autoillustrate doctor            # checks every prerequisite and prints fix-it hints
```

> **Security note** — AutoIllustrate launches coding agents that can run
> arbitrary commands and inherit your environment, including your API keys.
> The source document you pass in steers those agents, so treat it like
> code: only run it on papers and files you trust, and preferably inside a
> container or VM rather than directly on your workstation. Run logs under
> `<workdir>/logs/` can echo document contents, so review them before
> sharing a run directory.

## Prerequisites

- **draw.io desktop CLI** on `PATH` as `drawio`. Install the
  [draw.io desktop app](https://github.com/jgraph/drawio-desktop/releases);
  the CLI binary is bundled with it.
- **Node ≥ 22**.
- **Python ≥ 3.10** — no manual setup is needed. On first run, the CLI
  creates a cached venv under `~/.cache/autoillustrate/`. Set
  `VENV_PY=/path/to/python` to use your own environment instead.
- **Headless CLI** (`@roberttlange/headless`) — all agent calls go through
  it. It is installed with AutoIllustrate. The default agent is Claude Code,
  so `claude` must also be on `PATH` unless you select a different `--agent`.
- **`OPENAI_API_KEY`** — required by default. Phase 3 and Phase 6 vision
  audits use `gpt-6-astra`, and the Phase 5 restyle uses
  `gpt-image-2.5-sunburst` unless a different `--enhance-model` is selected.
- **`GEMINI_API_KEY`** — required only for a Gemini backend:
  `--enhance-model nanobanana|nanobanana-pro|gemini-*` or
  `--audit-vlm gemini-3.1-pro`.

Either export the keys in your shell or place them in a `.env` file in the
directory you run `autoillustrate` from. `autoillustrate credentials` reports
which keys and agent logins the pipeline can see.

## draw.io on a headless Linux box

On a Linux machine with no display, run the `install_drawio.sh` script that
ships inside the package (`autoillustrate doctor` prints its full path). It
installs a pinned drawio via Nix and wraps it in `xvfb-run` so `drawio -x`
works without an X server.

## Chrome for the export fallback

drawio's own PNG export occasionally wedges on formula-heavy figures. When a
Chrome or Chromium binary is available (auto-detected, or set
`AUTOILLUSTRATE_CHROME`), the pipeline falls back to rasterizing an SVG export
with it. Without Chrome the fallback is unavailable; see
[Export reliability](cli.md#export-reliability).

## Other agents

The `--agent` flag switches the coding agent that runs the LM sub-agents:
`claude` (default), `codex`, `cursor`, `gemini`, `opencode`, or `pi`. The
chosen agent's CLI must be on `PATH` and logged in; `autoillustrate doctor
--agent <name>` checks it. See the [CLI reference](cli.md#models-and-backends)
for per-agent model and effort defaults.
