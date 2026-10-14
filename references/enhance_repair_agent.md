# Enhance / verify-repair lifecycle

Execution constraint (never violate): run EVERY command in the
FOREGROUND — `verify.py`, `enhance.py`, generators, and the `drawio`
CLI are all synchronous. Do not use `run_in_background`, a trailing
`&`, scheduled wakeups/notifications, or sleep-poll loops; your
session ends the moment you end your turn, so backgrounded work is
reaped unfinished and the orchestrator fails the phase.

ONE slow command per Bash call (never violate): do NOT chain two
API-calling or long-running steps with `&&` (or `;`) in a single
invocation. `enhance.py`, `verify.py`, and the `drawio` export must
each be their OWN standalone foreground command. The harness
AUTO-backgrounds any single command that runs too long, and an
`enhance.py && verify.py` chain reliably crosses that threshold (a
gpt-image enhance plus an API verify back-to-back). Once the harness
has backgrounded a command you cannot foreground-wait on it — it is
reaped when your turn ends, which is exactly the failure this rule
prevents. Chaining fast deterministic steps is fine
(`generate_<panel>.py && generate_composite.py`); the API/render
steps (`enhance.py`, `verify.py`, `drawio` export) never are.

This file is the full instruction set for the **Phase 6 sub-agent**
of the autoillustrate pipeline. The orchestrator dispatches one
foreground sub-agent after Phase 5 has produced the initial
`figures/full_figure_enhanced.png`; the sub-agent owns the
verify → repair → re-enhance loop and the Step 5d selection.

The dispatch prompt gives the sub-agent: `$WORKDIR/`, the
`--placement` value, paths to `$WORKDIR/{figure.json, methods.md,
theme.txt, figure_summary.md}` (last is optional), and the 5/4
budget. The sub-agent does not see the orchestrator's conversation;
treat the workdir + figures/ directory as the entire shared state.

At the end, return a structured report to the orchestrator:

- `winner_attempt`: the attempt number Step 5d selected.
- `shipped`: `"enhanced"` (canonical files updated to the winner) or
  `"deterministic"` (fell back to `figures/full_figure.png`).
- `residual_critical` / `residual_minor`: lists of issues that
  survived into the winner (each a short `{location, expected,
  actual}` snippet).
- `summary`: one or two sentences for the orchestrator to surface to
  the user.

Do NOT print full verify JSONs back to the orchestrator — they are
already on disk under `figures/verify.attempt-<N>.json`.

Phase 6 replaces the manual eyeball comparison that used to live at
the end of Phase 5. `verify.py` runs TWO stages against the candidate
and merges them into a single `figures/verify.json` verdict:

**Stage A — Open-ended content audit (one Gemini call).** Sends both
the deterministic `full_figure.png` (helper / disambiguation only)
and the `full_figure_enhanced.png` (candidate) to a Gemini vision
model (default `gemini-3.1-pro-preview`) and asks it to identify
content errors — mangled labels, dropped / added panels, swapped
subscripts, fabricated arrows, misplaced annotations, changed
equation operands, missing panel letters, and clearly excessive
wasted whitespace — plus understandability problems (elements that
are too abstract, elements whose meaning is unclear). Style and
aesthetic differences are NOT flagged. This catches *unanticipated*
regressions that nobody pre-listed.

**Stage B — Per-panel unit-test inspections (parallel Gemini
calls).** Auto-discovers `unit_test_inspections_<panel_id>.jsonl`
files written by the Phase 3 panel-inspect agent. A `--panel-inspects 0`
run has none; Stage B then self-skips with `enabled: false`, which is
expected and not an error.
These files have a **mandatory arrows core** — every line in it probes
one arrow / edge / connector of a panel (existence, endpoints,
direction, edge label, or head-semantics) — plus an **optional extras
section** where the panel agent may add probes about other
load-bearing, enhancement-fragile content facts (e.g. that a grouping
rectangle still encloses exactly the expected elements). Each line is
`{"question": "...", "expected_answer": "yes"|"no"}`, testing meaning
and never appearance. Every question is replayed against the candidate
in CLEAN CONTEXT — the model never sees other questions, the panel
plan, `methods.md`, or the figure spec — so its answer is not biased
by the surrounding probes. This catches *anticipated* regressions:
each panel pre-declares every arrow (and any extra content facts)
the enhancer must preserve, and Stage B verifies them one-by-one.
Failed tests are promoted into the verdict's `issues` list as
`severity: critical` (with `source: "unit_test"`), so the existing
repair loop fires uniformly on either stage's failures. Whatever the
pre-declared probes do not cover is still caught by Stage A's
open-ended audit.

### Stage B execution policy (backend, isolation, cost)

- **Backend (default `openai-single`).** Stage B runs on `verify.py`'s
  `--unit-test-vlm` (default `openai-single`, overridable via
  `$UNIT_TEST_VLM` or
  `--unit-test-vlm openai|openai-single|gemini|gemini-single|codex|auto`).
  Stage A still uses `--audit-vlm`. The default `openai-single` answers ALL
  unit-test questions in **one** gpt-6-astra call: the candidate PNG is
  sent exactly once and the model returns a JSON array of answers
  keyed by question number. This is the cheapest mode — the ~2K image
  is billed once instead of once per question — and is why it is the
  default. The trade-off is that the model sees all questions
  together, so the per-question "clean context" isolation of the
  other modes is given up.
- **Other backends (one call per question).** `openai` fans out one
  gpt-6-astra call per question with the image inline each time;
  `gemini` fans out per-question but holds the candidate PNG in ONE
  Gemini context cache so it is billed once at the cached-input rate
  (falls back to inline bytes if the cache is rejected); `codex`
  routes each probe through an independent `codex exec` call billed
  to a ChatGPT **subscription** (run `codex login` once on the host).
  `codex` falls back to `openai-single` with a warning if `codex` is
  not on PATH. These per-question modes preserve clean-context
  isolation (each question is its own conversation: candidate PNG +
  fixed unit-test system prompt + the single question) and are
  bounded by `--unit-test-concurrency` (default 8).
- **`gemini-single` (one call, all questions).** The Gemini analog of
  `openai-single`: every question is answered in **one** Gemini call
  with the candidate PNG inline once — no per-question fan-out and no
  context-cache create/delete round-trip. Cheapest Gemini path; like
  `openai-single`, it gives up per-question clean-context isolation
  because the model sees all questions together. When Stage A runs on
  OpenAI, the `gemini*` backends fall back to the default Gemini VLM
  for a valid model id (mirroring how `openai*` fall back to the
  default OpenAI VLM when Stage A is on Gemini).
- **Determinism.** JSON-only response mode with one retry on
  malformed output. Answers are forced to lowercase `"yes"` / `"no"`
  before comparison; anything else (including a question the single
  call omits from its array) is recorded as an errored result and is
  NOT promoted to a critical issue (tool failure, not a figure
  regression).

## `verify.json` schema

The script writes `figures/verify.json` with this shape:

```json
{
  "schema_version": 4,
  "attempt": 1,
  "model": "gemini-3.1-pro-preview",
  "reference": "figures/full_figure.png",
  "candidate": "figures/full_figure_enhanced.png",
  "has_wrong_content": true,
  "issues": [
    {
      "location": "Panel B, equation row 2",
      "expected": "e_j = y_j - \\hat{y}_j",
      "actual": "e_i = y_j - \\hat{y}_j",
      "severity": "critical"
    },
    {
      "location": "Panel A, right edge",
      "expected": "content filling the page with tight margins",
      "actual": "large empty band along the right edge spanning ~40% of the figure width",
      "severity": "critical"
    },
    {
      "location": "Panel panel_b (unit test)",
      "expected": "answer 'yes' to: Does the residual equation read `e_j = y_j - ŷ_j` (not `e_i`)?",
      "actual": "answer 'no' — the visible equation reads `e_i = y_j - ŷ_j`",
      "severity": "critical",
      "source": "unit_test",
      "panel_id": "panel_b"
    }
  ],
  "unit_tests": {
    "enabled": true,
    "model": "gemini-3.1-pro-preview",
    "cached": true,
    "n_total": 23,
    "n_pass": 22,
    "n_fail": 1,
    "n_error": 0,
    "has_regressions": true,
    "results": [
      {
        "panel_id": "panel_b",
        "question": "Does the residual equation read `e_j = y_j - ŷ_j` (not `e_i`)?",
        "expected_answer": "yes",
        "actual_answer": "no",
        "rationale": "the visible equation reads `e_i = y_j - ŷ_j`",
        "pass": false,
        "error": false,
        "source_file": "$WORKDIR/unit_test_inspections_panel_b.jsonl",
        "line": 4
      }
    ]
  },
  "summary": "..."
}
```

`has_wrong_content` is `true` iff at least one issue has
`severity: critical` (after the unit-test promotion step). **The
Phase 6 repair loop is driven by the full `issues` list — both
`critical` and `minor` entries (and any unit-test failure, which
gets promoted to `critical`) trigger another repair pass while
attempt budget remains.** Unit-test entries with `error: true` (the
model failed to return a valid yes/no after retry) are recorded in
the `unit_tests.results` block but are NOT promoted to `issues` —
tool failures should not silently invalidate the candidate.

## Verify budget and termination

**Verify budget: `N` attempts**, where `N` is the verify-attempts
value on the `BUDGET:` line of your dispatch header (default 3).
Attempt 1 is the initial run; attempts 2 through `N` each follow one
repair pass (`N - 1` repair passes max). Phase 5 terminates ONLY when
one of these conditions holds:

  (A) the most recent verify returned an empty `issues` list (no
      critical AND no minor issues), OR
  (B) you have just completed verify attempt `N` (regardless of outcome).

**Do NOT return to the orchestrator while `issues` is non-empty
and `attempt < N`.** The minimum work after a failing verify is one
repair pass plus the next verify attempt — binding rule, not advice.
If you find yourself drafting a final report while `attempt` is
still below `N` and `issues` is non-empty, you are exiting Phase 6 early;
run the next repair pass instead.

## Trace preservation

Every enhanced PNG and verify verdict must be archived per attempt —
do NOT let later attempts overwrite the trace. After each `enhance.py`
run AND after each `verify.py` run, copy the canonical files to
attempt-suffixed names:

```bash
cp figures/full_figure_enhanced.png \
   figures/full_figure_enhanced.attempt-<N>.png
cp figures/verify.json figures/verify.attempt-<N>.json
```

`<N>` is the verify attempt the artifacts belong to. The canonical
`full_figure_enhanced.png` and `verify.json` always reflect the most
recent attempt; the `.attempt-<N>.{png,json}` files are the audit
trail and stay in `figures/`.

## Repair loop

The repair loop, executed in the agent (not the script):

```
attempt = 1
run enhance
run verify (attempt 1)
archive enhanced PNG + verify.json as attempt-1
while len(issues) > 0 and attempt < N:    # N = verify BUDGET from dispatch header
    run Step 5c repair chain (modify the reference, re-enhance)
    attempt += 1
    run verify (attempt = current attempt)
    archive enhanced PNG + verify.json as attempt-<current>
# Always run Step 5d after exit — gpt-image-2 is non-monotonic, so
# the latest attempt is not necessarily the most faithful.
run Step 5d (select most-truthful attempt)
```

The `--attempt` flag is recorded in the JSON for traceability only; the
loop is orchestrated by the agent.

### Step 5a — Run the verifier (attempt 1)

```bash
# $PYTHON = the absolute interpreter path from your dispatch header.
OPENAI_API_KEY=... "$PYTHON" \
    "$TOOLKIT_DIR/scripts/verify.py" \
    --workdir $WORKDIR/ --attempt 1
```

(Both stages default to OpenAI — Stage A `--audit-vlm gpt-6-astra` and Stage B
`--unit-test-vlm openai-single` — so `OPENAI_API_KEY` is the key
needed by default. Use `GEMINI_API_KEY` only when you switch a stage to
a Gemini backend. Either may instead be read from `.env` in the cwd.
The defaults themselves are overridable without touching this command:
`$AUDIT_VLM` sets Stage A and `$UNIT_TEST_VLM` sets Stage B — the
orchestrator's `--audit-vlm` / `--unit-test-vlm` flags export exactly
these, and the verify sub-agent inherits them. `$AUDIT_VLM` is the same
knob that drives the Phase 3 panel-inspect audit.)

The verifier auto-discovers, from the workdir:

- `<workdir>/figure_summary.md` — embedded as a read-only inventory
  (same convention as `enhance.py`).
- `<workdir>/unit_test_inspections_*.jsonl` — every panel's
  pre-declared probes (Stage B). All discovered files are loaded and
  replayed. Each file is an exhaustive arrows core (every arrow's
  existence, endpoints, direction, label, or head-semantics) plus an
  optional handful of extra content probes (a key equation, a
  critical label, a named submodule). There are no
  placeholder-fulfillment probes — a placeholder the enhancer ignored
  or fumbled is caught by Stage A, not Stage B.

Useful flags:

- `--dry-run` — preview both prompts (audit + unit-test system
  prompt) and the discovered JSONL files without spending a call.
- `--skip-unit-tests` — run Stage A only.
- `--unit-test-vlm openai-single|openai|gemini|gemini-single|codex|auto`
  (default `openai-single`) — Stage B backend; see the execution
  policy above.
- `--unit-test-concurrency N` (default 8) — cap on concurrent
  unit-test calls; applies only to the per-question modes
  (`openai`/`gemini`/`codex`), not `openai-single` (one call).
- `--unit-test-cache-ttl 600s` (default) — TTL for the Gemini
  context cache holding the candidate image; applies only to the
  `gemini` backend. Raise it for very large question sets.

Immediately after Step 5a, archive the attempt-1 trace:

```bash
cp figures/full_figure_enhanced.png \
   figures/full_figure_enhanced.attempt-1.png
cp figures/verify.json figures/verify.attempt-1.json
```

### Step 5b — Read `figures/verify.json` and decide

- If `len(issues) == 0` → **loop done**. Proceed to **Step 5d** to
  confirm this attempt is also the best across the archived trace
  (a clean pass is the strongest possible score, so it will win, but
  Step 5d still updates the canonical files and writes the
  selection record).
- If `len(issues) > 0` and `attempt < N` → run the **full repair
  chain** in Step 5c, then re-run `verify.py` with
  `--attempt <next>`. Do NOT just re-run `enhance.py` against the
  unchanged reference — gpt-image-2 reproduces the same mistake on
  re-rolls when the reference is identical. The reliable fix is to
  modify the reference image so the mistake becomes less likely.
  This applies to BOTH `critical` and `minor` issues — minors that
  survive the budget will be surfaced to the human, but while budget
  remains we still try to fix them.
- If `len(issues) > 0` and `attempt == N` → **loop done**. Proceed
  to **Step 5d**. Do NOT try another repair — the cheap
  reference-side fixes are exhausted once the budget is spent.

### Step 5c — Repair chain (executed once per failing verify attempt while `attempt < N`)

For each issue:

1. Locate the offending element in the responsible panel:
   `$WORKDIR/<panel_id>.drawio.template` (the visual / label) and
   `$WORKDIR/generate_<panel_id>.py` (the geometry). For an issue
   with `source: "unit_test"`, the `panel_id` field on the issue
   names the responsible panel directly; the `expected` field quotes
   the original yes/no question, which usually points at the precise
   element to fix (label content, arrow direction, equation operand,
   etc.).
2. Modify the reference so the restyle is more likely to succeed.
   Patterns that work:
   - Subscript flipped (`o_i` → `θ_i`): widen the cell, increase
     `fontSize`, or substitute a less-ambiguous symbol.
   - Tiny label dropped: enlarge the cell, increase font size, add
     padding so the label stands alone.
   - Adjacent labels merged in the candidate: push them apart in
     the layout, or relabel one to disambiguate.
   - Panel letter missing: increase its font size and contrast.
   - Arrow polarity inverted by the model (loop direction confused):
     simplify the topology — collapse a multi-edge path into a single
     direct edge with inline labels along the arc — so there is only
     one possible read direction.
3. Re-run that panel's generator and the composer:

   ```bash
   "$PYTHON" $WORKDIR/generate_<panel_id>.py
   "$PYTHON" $WORKDIR/generate_composite.py
   ```

4. Re-export the deterministic composite PNG (use the same
   `--width` as Phase 4 — `2560` for both placements; only the
   aspect/height differs):

   ```bash
   node "$TOOLKIT_DIR/dist/cli.js" export \
       $WORKDIR/figures/full_figure.drawio \
       $WORKDIR/figures/full_figure.png \
       --export-width 2560
   ```

   Use this hardened exporter — NEVER a raw `drawio -x` invocation:
   drawio's headless export intermittently wedges on math-bearing
   composites (unhandled `UnknownVizError`, idling forever without a
   PNG). The exporter fast-fails one direct attempt then falls back
   to SVG + headless-Chrome rasterization, completing in the
   foreground within ~2 minutes. Exit 0 + `wrote <png>` is success.

5. Re-run `enhance.py` (Phase 5b) to produce a fresh
   `figures/full_figure_enhanced.png`, with the SAME model and
   quality as Phase 5 (the ENHANCE line of your dispatch header):

   ```bash
   $PYTHON $TOOLKIT_DIR/scripts/enhance.py \
       --workdir $WORKDIR/ --placement <placement> \
       --model <ENHANCE model> --quality <ENHANCE quality> \
       --input $WORKDIR/figures/full_figure.png \
       --out $WORKDIR/figures/full_figure_enhanced.png
   ```

   (The orchestrator also exports `$ENHANCE_MODEL` / `$ENHANCE_QUALITY`,
   which `enhance.py` reads as its defaults, so an invocation without
   `--model`/`--quality` still matches Phase 5.) `enhance.py`
   auto-discovers `<workdir>/placeholders_*.jsonl` and instructs the
   model to fill each gray-dashed `[[ pl <panel> <n> ]]` box with the
   given description, and protects the matplotlib plots embedded in
   `figures/full_figure.drawio` (a reproduce-verbatim prompt block with
   each plot's position and description) — no extra flag needed. The
   protection is a hint: a redrawn plot is still a legitimate Stage A
   finding, and `--no-protect-mpl` is the escape hatch. This is its OWN Bash
   call — never `enhance.py && verify.py` (see the "ONE slow command
   per Bash call" rule; that chain is what gets auto-backgrounded and
   reaped).
6. Re-run `verify.py` with `--attempt <n+1>` as a SEPARATE foreground
   Bash call.
7. Archive the new artifacts under attempt `<n+1>` so the trace is
   preserved for downstream review:

   ```bash
   cp figures/full_figure_enhanced.png \
      figures/full_figure_enhanced.attempt-<n+1>.png
   cp figures/verify.json figures/verify.attempt-<n+1>.json
   ```

   Then return to Step 5b.

### Step 5d — Select the most truthful attempt

Run once after the loop exits. Score every
`figures/verify.attempt-<N>.json` by reading the JSON (do not
eyeball PNGs) and pick a winner using these tiers, in order:

1. fewest `severity: critical` issues (empty `issues` always wins),
2. fewest unit-test failures (`pass: false, error: false`; errored
   tests don't count),
3. fewest `severity: minor` issues,
4. highest attempt number.

Promote the winner:

```bash
cp figures/full_figure_enhanced.attempt-<W>.png figures/full_figure_enhanced.png
cp figures/verify.attempt-<W>.json             figures/verify.json
```

If the winner still has criticals, fall back to the deterministic
`figures/full_figure.png` only when residuals are structural
(fabricated/dropped panel, inverted arrow polarity, swapped
load-bearing operand). Local glyph/subscript mistakes are not
enough to discard the styling — ship the enhanced winner.

Report which attempt won, residual criticals/minors, and whether
you fell back to deterministic.

## Phase 6 exit codes

- `0` — verdict written (regardless of `has_wrong_content`).
- `1` — API error or model returned malformed JSON (raw response
  saved to `figures/verify.raw.txt` for debugging).
- `2` — missing input PNG, missing `GEMINI_API_KEY`, or bad CLI
  args.
