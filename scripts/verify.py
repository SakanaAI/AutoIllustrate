"""Verify a gpt-image-2 enhanced drawio-figure output.

Runs TWO stages against the candidate (`figures/full_figure_enhanced.png`)
and merges them into a single verdict at `figures/verify.json`:

  Stage A — Open-ended content audit (one Gemini call):
    1. **Truth** — every depicted element must be consistent with the
       methodology described in `methods.md` (the source of truth).
    2. **Understandability** — every depicted element's role must be
       graspable from the figure alone (no opaque abstract blocks, no
       unexplained single-letter symbols, no ambiguous arrows).

    The deterministic `figures/full_figure.png` is provided to the
    auditor as a HELPER ONLY — useful for disambiguating mangled
    labels in the candidate, not as authority. The candidate is
    allowed to add illustrations, icons, annotations, and to
    rearrange / re-lay-out panels relative to the reference;
    differences are flagged ONLY when they fail truth or
    understandability.

    Model: Stage A runs on `--audit-vlm` (default `gpt-6-astra` at high
    reasoning effort, from $AUDIT_VLM), independent of Stage B's
    `--unit-test-vlm`.

  Stage B — Per-panel unit-test inspections:
    Auto-discovers `unit_test_inspections_<panel_id>.jsonl` files
    written by each panel agent in step 9 of the panel lifecycle.
    Each line is `{"question": "...", "expected_answer": "yes"|"no"}`.

    Backend: Stage B runs on `--unit-test-vlm` (default
    `openai-single`, from $UNIT_TEST_VLM), independent of Stage
    A's `--audit-vlm`. The available modes are:

      - `openai-single` (default) — ALL questions are answered in ONE
        gpt-6-astra call: the candidate image is sent exactly once and the
        model returns a JSON array of answers keyed by question number.
        This is the cheapest mode — the ~2K candidate image is billed
        once instead of once per question. The trade-off is that the
        model sees every question together, so the per-question "clean
        context" isolation of the other modes is lost.
      - `openai` — one gpt-6-astra call per question, candidate image sent
        inline each time. Preserves clean-context isolation but bills
        the image N times.
      - `gemini` — one call per question, but a single Gemini context
        cache holds the candidate image so it is billed once at the
        cached-input rate; falls back to inline bytes if caching is
        unavailable.
      - `gemini-single` — the Gemini analog of `openai-single`: ALL
        questions are answered in ONE Gemini call with the candidate
        image inline once. The cheapest Gemini path — no per-question
        fan-out and no context-cache create/delete round-trip — at the
        same loss of per-question isolation as `openai-single`.
      - `codex` — one `codex exec` probe per question, billed to a
        ChatGPT subscription. (Currently unreliable; kept for fallback,
        falls back to `openai-single` if `codex` is not installed.)
      - `auto` — follow Stage A's `--audit-vlm` backend.

    Each failing unit test is promoted into the verdict's `issues`
    list as `severity: critical` with `source: "unit_test"`, so the
    Phase 6 repair loop is triggered uniformly by any failure from
    either stage.

`issues` of `severity: critical` set `has_wrong_content`; the Phase 6
repair loop fires while ANY issue (critical or minor) remains in the
verdict — `has_wrong_content` only governs the final fall-back to the
deterministic PNG once the budget is spent.

Writes a structured verdict to `figures/verify.json` so the calling
agent can decide whether to repair (any non-empty `issues` list
triggers a repair pass while attempt budget remains). The script never
loops; the agent orchestrates retries, to the budget on its Phase 6
dispatch header (`references/enhance_repair_agent.md`).

Usage:

    # Preview the prompt + skip the API call ($PYTHON is the cached-venv
    # interpreter from the dispatch header; VENV_PY overrides it)
    "$PYTHON" scripts/verify.py \
        --workdir $WORKDIR/ --dry-run

    # Real call
    GEMINI_API_KEY=... "$PYTHON" scripts/verify.py \
        --workdir $WORKDIR/

Exit codes:
    0  verdict written (regardless of `has_wrong_content`)
    1  API error or unparseable model output (raw response saved)
    2  missing input files / bad CLI args / missing GEMINI_API_KEY
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _usage import record_usage  # type: ignore  # noqa: E402
from enhance import load_dotenv_key, prepare_input_image  # noqa: E402

# VLM choices exposed via --audit-vlm. Each maps to a backend ("openai" /
# "gemini") and the canonical API model id. To add a third option, add another
# row here AND extend the `if vlm ==` dispatch in _call_backend / _cli.
# DEFAULT_VLM reads $AUDIT_VLM so the orchestrator can pick the Stage A auditor
# without editing code (mirrors $UNIT_TEST_VLM for Stage B); an explicit
# --audit-vlm on the command line still overrides it.
DEFAULT_VLM = os.environ.get("AUDIT_VLM", "gpt-6-astra")
VLM_REGISTRY: dict[str, dict[str, str]] = {
    "gpt-6-astra":    {"backend": "openai", "model": "gpt-6-astra",
                       "reasoning_effort": "high"},
    "gpt-5.5":        {"backend": "openai", "model": "gpt-5.5"},
    "gemini-3.1-pro": {"backend": "gemini", "model": "gemini-3.1-pro-preview"},
}
VLM_CHOICES = list(VLM_REGISTRY)
# OpenAI VLM the `openai*` Stage B modes fall back to when Stage A runs on
# Gemini (NOT DEFAULT_VLM — that follows $AUDIT_VLM and may itself be Gemini).
DEFAULT_OPENAI_VLM = "gpt-6-astra"

DEFAULT_MAX_EDGE = 2560
DEFAULT_UT_CONCURRENCY = 8
DEFAULT_UT_CACHE_TTL = "600s"
SCHEMA_VERSION = 4  # bumped: adds `unit_tests` block

# Stage B (unit-test probes) defaults to `openai-single`: ONE gpt-6-astra call that
# answers every question with the candidate image sent once (cheapest). The
# other modes fan out one call per question — `openai` (image billed N times),
# `gemini` (image cached, billed once), or `codex` (ChatGPT subscription via
# `codex exec`) — except `gemini-single`, the Gemini analog of `openai-single`:
# ONE Gemini call with the image inline once (no per-question fan-out, no cache
# round-trip). Defaults are read from the environment so the orchestrator can
# flip the whole pipeline without editing code; `auto` follows --audit-vlm's
# backend.
DEFAULT_UT_BACKEND = os.environ.get("UNIT_TEST_VLM", "openai-single")
DEFAULT_CODEX_MODEL = os.environ.get("CODEX_MODEL") or None
DEFAULT_CODEX_CONCURRENCY = 4
UT_BACKEND_CHOICES = ("auto", "openai", "openai-single", "gemini",
                      "gemini-single", "codex")

VALID_SEVERITIES = {"critical", "minor"}
VALID_YES_NO = {"yes", "no"}


SYSTEM_PROMPT = """\
You are a content auditor for scientific figures.

You will be given up to four inputs:
  1. METHODS — a markdown brief describing the methodology / system / \
process the figure is supposed to depict. This is the SOURCE OF TRUTH \
for what the figure must be consistent with.
  2. FIGURE_SPEC (optional) — a markdown inventory describing what \
the REFERENCE draw.io image was specified to depict (panel letters, \
exact labels, counts, colors that carry meaning, things explicitly \
NOT to include). This is the specification of the REFERENCE only — \
the CANDIDATE is the gpt-image-2 restyle and may have legitimately \
modified, restyled, rearranged, or extended what the spec lists, AS \
LONG AS those modifications remain true to METHODS. Use FIGURE_SPEC \
to anchor the figure's intended scope when judging `missing_concept` \
(absent from candidate but the figure was meant to show it) and to \
disambiguate canonical labels — NOT as a checklist the candidate \
must match element-for-element.
  3. REFERENCE — a deterministic export of the figure from draw.io. \
Use it ONLY as a helper to read symbols you cannot decipher in the \
candidate (e.g. mangled small subscripts in the candidate that the \
reference renders cleanly). The reference is NOT itself authoritative — \
the candidate is fully entitled to add illustrations, add icons, \
introduce annotations, rearrange panels, change layout, redraw the \
topology, and otherwise diverge from the reference, AS LONG AS the \
candidate remains true to METHODS and remains understandable.
  4. CANDIDATE — the gpt-image-2 restyle. Audit this image.

Your job is to flag a depicted element ONLY when it fails one of two \
tests:

  (T) Truth — the element contradicts METHODS, OR a key concept named \
      in METHODS is materially absent from the figure.
  (U) Understandability — the element's role or meaning cannot be \
      grasped from the figure alone (an opaque abstract block, an \
      unexplained single-letter symbol, an ambiguous arrow, etc.).

You must NOT comment on aesthetic / style differences, and you must \
NOT flag a difference between candidate and reference unless that \
difference also fails (T) or (U).

**Arrow direction is mandatory.** Before finalising your verdict, \
sweep every arrow in the candidate, name its source and target, and \
confirm the direction matches what METHODS describes. Wrong-way \
arrows silently invert the meaning of a figure and are the single \
most common content failure — never skip this pass.

**Annotation correctness is mandatory.** Before finalising your \
verdict, sweep every annotation in the candidate — that is, every \
text label, caption, callout, tag, inline gloss, legend entry, \
bracket, brace, dimension marker, or any other piece of text or \
mark whose job is to describe, name, or point at another element. \
For each one, verify TWO things: (a) the annotation's CONTENT is \
correct per METHODS (the right word, symbol, value, equation, or \
description — no mangled glyphs, no swapped subscripts, no \
substituted terms); and (b) the annotation is ATTACHED TO THE RIGHT \
ELEMENT (the label sits on / points at / brackets the object \
METHODS says it describes, not a neighbour). An annotation that is \
individually well-rendered but pinned to the wrong shape, arrow, \
region, axis, or sub-component is just as wrong as a mangled label, \
and is `annotation_wrong` at `severity: critical`. Misplaced \
annotations are a frequent failure mode of the restyle step because \
the model may move labels during layout cleanup — never skip this \
pass. **Pay special attention to underlines, brackets, or arrows that \
appear to point at a specific term inside an equation or multi-glyph \
text run** (e.g. three underlines below a single equation, each \
notionally tagging one factor): trace each pointer's endpoint to the \
exact symbol directly above/beside it, and flag it `annotation_wrong: \
critical` whenever the pointer does not visibly sit under or on its \
intended term. This pattern almost always drifts because the author \
cannot see glyph-level x-coordinates inside a one-cell equation.

## DO flag these

- **Truth**: any element whose depiction contradicts METHODS — wrong \
arrow direction, mangled symbol or equation, missing key concept, \
misplaced annotation, missing panel letter, illegible label, swapped \
operand, mislabeled component.
- **Understandability**: an element whose role cannot be inferred \
from the figure alone — an overly abstract / unlabeled block, an \
unexplained single-letter symbol, an ambiguous arrow. In `expected`, \
describe the clarification a reviewer would ask for.
- **Layout**: clearly excessive empty space — content fills less \
than ~60% of the page area, or there is an empty band along an edge \
wider than roughly a third of the figure's shorter dimension. A \
modest margin is fine; only flag clearly disproportionate empty \
regions.

## DO NOT flag these

- Aesthetic differences (palette, font, weight, alignment, spacing, \
stroke width, arrowhead style, corner radius, background tint, drop \
shadow, gradient, panel border style).
- The candidate adding extra illustrations, icons, decorative shapes, \
inline annotations, captions, or arrows that are NOT in the reference, \
as long as they are consistent with METHODS (or at least not \
contradicted by METHODS) and they aid rather than hurt clarity. The \
candidate is a restyle, not a tracing — additions are welcome when \
they're correct.
- Re-arrangements: different panel order, different alignment within \
a panel, different grid layout, different aspect, larger or smaller \
panels, redrawn topology that preserves the relationships in METHODS.
- Re-flowed but still-correct labels (same characters, different \
position).
- Reference-only artifacts the candidate cleaned up (e.g. arbitrary \
placeholder text, rendering scaffolding from the template).

## RULES
- If you are unsure whether something fails (T) or (U), DO NOT flag \
it. False positives trigger expensive repair loops; false negatives \
are recoverable by the human author.
- Quote `expected` and `actual` exactly as the relevant source \
presents them: for truth issues, `expected` should reflect METHODS \
(or the reference when METHODS does not specify the glyph) and \
`actual` should quote the candidate verbatim. For understandability \
issues, `expected` should describe the clarification a reviewer would \
ask for and `actual` should describe what the candidate currently \
shows.
- Use `severity: "critical"` for any issue that makes the figure \
factually wrong, illegible in a meaningful place, or clearly burns \
page budget. Use `severity: "minor"` for borderline cases — a single \
label illegible but identifiable from context, an element that's \
slightly under-explained but still inferable, slightly larger-than- \
ideal margins.

## RESPONSE FORMAT
Respond with a single JSON object, no prose, no code fences. Schema:

{
  "has_wrong_content": <bool>,
  "issues": [
    {
      "location": "<short human-readable region, e.g. 'Panel B, top equation'>",
      "expected": "<what truth or understandability requires>",
      "actual":   "<what the candidate currently shows>",
      "severity": "<critical | minor>"
    }
  ],
  "summary": "<one sentence overall verdict>"
}

`has_wrong_content` MUST be true if and only if at least one issue has \
`severity: \"critical\"`. If you find no truth and no \
understandability problems, return \
`{\"has_wrong_content\": false, \"issues\": [], \"summary\": \"...\"}`.
"""


METHODS_BLOCK = """\

## METHODS (source of truth)

The following markdown is the methodology brief the figure is supposed \
to depict. Treat its claims as authoritative when judging truth. \
Anything in the candidate that contradicts it is a `factually_wrong` \
or `arrow_changed` issue; a key concept named here that the candidate \
clearly omits is a `missing_concept` issue.

{methods}
"""


FIGURE_SPEC_BLOCK = """\

## FIGURE_SPEC (specification of the REFERENCE image)

The following markdown is the inventory of what the REFERENCE draw.io \
image was specified to depict (panel letters, exact labels, counts, \
meaningful colors, and things explicitly NOT to include). It \
describes the REFERENCE only — the CANDIDATE is a gpt-image-2 \
restyle and may have legitimately modified, restyled, rearranged, \
or extended what is listed here, AS LONG AS those modifications \
remain true to METHODS.

Use this block to (a) anchor what the figure was intended to show \
when deciding whether something missing from the candidate is a real \
`missing_concept` issue, and (b) recover canonical labels for \
disambiguation. Do NOT flag the candidate for divergences from this \
spec that remain consistent with METHODS.

{figure_spec}
"""


def build_prompt(methods_text: str | None, figure_spec_text: str | None) -> str:
    prompt = SYSTEM_PROMPT
    if methods_text and methods_text.strip():
        prompt = prompt + METHODS_BLOCK.format(methods=methods_text.strip())
    if figure_spec_text and figure_spec_text.strip():
        prompt = prompt + FIGURE_SPEC_BLOCK.format(
            figure_spec=figure_spec_text.strip()
        )
    return prompt


def _validate_verdict(obj: object) -> list[str]:
    """Return a list of schema violations; empty list = OK."""
    errors: list[str] = []
    if not isinstance(obj, dict):
        return ["top-level value is not a JSON object"]
    if not isinstance(obj.get("has_wrong_content"), bool):
        errors.append("`has_wrong_content` missing or not a bool")
    issues = obj.get("issues")
    if not isinstance(issues, list):
        errors.append("`issues` missing or not a list")
        return errors
    for i, issue in enumerate(issues):
        if not isinstance(issue, dict):
            errors.append(f"issues[{i}] is not an object")
            continue
        for key in ("location", "expected", "actual", "severity"):
            if not isinstance(issue.get(key), str):
                errors.append(f"issues[{i}].{key} missing or not a string")
        if isinstance(issue.get("severity"), str) and issue["severity"] not in VALID_SEVERITIES:
            errors.append(f"issues[{i}].severity={issue['severity']!r} not in {sorted(VALID_SEVERITIES)}")
    if not isinstance(obj.get("summary"), str):
        errors.append("`summary` missing or not a string")
    return errors


UNIT_TEST_SYSTEM_PROMPT = """\
You are answering a single binary yes/no inspection question about a \
scientific figure.

You will be given exactly one image — the CANDIDATE figure — and one \
question. Answer ONLY based on what is visible in the image. Do not \
invent details. Do not assume anything that is not depicted.

Respond with a single JSON object, no prose, no code fences, exactly \
this shape:

  {"answer": "yes" | "no", "rationale": "<one short sentence>"}

Rules:
  - `answer` MUST be exactly the lowercase string "yes" or "no". No \
other value is permitted.
  - `rationale` is one short sentence describing what you saw in the \
image that led to your answer; cite the specific region or label.
  - If the question asks whether something is present and you do not \
see it in the image, answer "no".
  - If the question asks whether some defect is visible (e.g. "is any \
raw LaTeX visible?") and you do not see the defect, answer "no".
  - Do not consider any other questions; you are answering this one \
question in isolation.
"""


def discover_unit_test_files(workdir: Path) -> list[Path]:
    """Return sorted paths of `unit_test_inspections_*.jsonl` files."""
    return sorted(workdir.glob("unit_test_inspections_*.jsonl"))


def _panel_id_from_jsonl(path: Path) -> str:
    stem = path.stem
    prefix = "unit_test_inspections_"
    return stem[len(prefix):] if stem.startswith(prefix) else stem


def load_unit_tests(files: list[Path]) -> list[dict]:
    """Parse + validate JSONL files. Returns one dict per question with
    keys: panel_id, question, expected_answer, source_file, line.
    Bad lines are skipped with a warning to stderr."""
    questions: list[dict] = []
    for path in files:
        panel_id = _panel_id_from_jsonl(path)
        for lineno, raw in enumerate(path.read_text().splitlines(), 1):
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError as exc:
                print(f"WARNING: {path}:{lineno} not valid JSON ({exc}); "
                      f"skipping", file=sys.stderr)
                continue
            q = obj.get("question")
            e = obj.get("expected_answer")
            if not isinstance(q, str) or not q.strip():
                print(f"WARNING: {path}:{lineno} `question` missing or "
                      f"not a non-empty string; skipping", file=sys.stderr)
                continue
            if e not in VALID_YES_NO:
                print(f"WARNING: {path}:{lineno} `expected_answer` must "
                      f"be 'yes' or 'no' (got {e!r}); skipping",
                      file=sys.stderr)
                continue
            questions.append({
                "panel_id": panel_id,
                "question": q,
                "expected_answer": e,
                "source_file": str(path),
                "line": lineno,
            })
    return questions


async def _ask_unit_test(
    client, *,
    model: str,
    question_text: str,
    cache_name: str | None,
    candidate_bytes: bytes | None,
    workdir: Path,
    max_retries: int = 1,
) -> dict:
    """Ask one question, with at most one retry on malformed output.
    Returns {"answer": "yes"|"no"|None, "rationale": str, "error": bool}.
    """
    from google.genai import types  # type: ignore

    last_error: str | None = None
    for _ in range(max_retries + 1):
        try:
            if cache_name is not None:
                contents: object = question_text
                cfg = types.GenerateContentConfig(
                    cached_content=cache_name,
                    response_mime_type="application/json",
                    temperature=0,
                )
            else:
                assert candidate_bytes is not None
                contents = [
                    types.Part.from_bytes(
                        data=candidate_bytes, mime_type="image/jpeg",
                    ),
                    types.Part.from_text(text=question_text),
                ]
                cfg = types.GenerateContentConfig(
                    system_instruction=UNIT_TEST_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    temperature=0,
                )
            started = time.perf_counter()
            result = await client.aio.models.generate_content(
                model=model, contents=contents, config=cfg,
            )
            meta = getattr(result, "usage_metadata", None)
            record_usage(workdir, phase=6, source="gemini-vision", model=model,
                         duration_secs=time.perf_counter() - started,
                         basis="tokens",
                         input_tokens=getattr(meta, "prompt_token_count", None),
                         output_tokens=getattr(meta, "candidates_token_count", None))
            raw = (result.text or "").strip()
            obj = json.loads(raw)
            ans = obj.get("answer")
            rat = obj.get("rationale", "")
            if isinstance(ans, str):
                ans = ans.strip().lower()
            if ans in VALID_YES_NO and isinstance(rat, str):
                return {"answer": ans, "rationale": rat, "error": False}
            last_error = f"unexpected shape: {obj!r}"
        except Exception as exc:
            last_error = repr(exc)
    return {
        "answer": None,
        "rationale": f"FAILED after retries: {last_error}",
        "error": True,
    }


async def _run_unit_tests_async(
    *,
    model: str,
    candidate_bytes: bytes,
    questions: list[dict],
    max_concurrency: int,
    cache_ttl: str,
    workdir: Path,
) -> tuple[list[dict], bool]:
    """Run all questions concurrently. Returns (results, used_cache)."""
    from google import genai  # type: ignore
    from google.genai import types  # type: ignore

    client = genai.Client()

    cache_handle = None
    cache_name: str | None = None
    try:
        cache_handle = client.caches.create(
            model=model,
            config=types.CreateCachedContentConfig(
                system_instruction=UNIT_TEST_SYSTEM_PROMPT,
                contents=[types.Content(role="user", parts=[
                    types.Part.from_bytes(
                        data=candidate_bytes, mime_type="image/jpeg",
                    ),
                ])],
                ttl=cache_ttl,
            ),
        )
        cache_name = cache_handle.name
        print(f"unit-tests: created Gemini cache {cache_name} "
              f"(image billed once at cached rate)")
    except Exception as exc:
        print(f"unit-tests: WARNING — could not create Gemini cache "
              f"({exc!r}); falling back to per-question inline image",
              file=sys.stderr)

    sem = asyncio.Semaphore(max_concurrency)

    async def _bounded(q: dict) -> tuple[dict, dict]:
        async with sem:
            ans = await _ask_unit_test(
                client,
                model=model,
                question_text=q["question"],
                cache_name=cache_name,
                candidate_bytes=candidate_bytes,
                workdir=workdir,
            )
            return q, ans

    pairs = await asyncio.gather(*[_bounded(q) for q in questions])

    results: list[dict] = []
    for q, ans in pairs:
        passed = (ans["answer"] is not None
                  and ans["answer"] == q["expected_answer"])
        results.append({
            "panel_id": q["panel_id"],
            "question": q["question"],
            "expected_answer": q["expected_answer"],
            "actual_answer": ans["answer"],
            "rationale": ans["rationale"],
            "pass": passed,
            "error": ans["error"],
            "source_file": q["source_file"],
            "line": q["line"],
        })

    if cache_handle is not None:
        try:
            client.caches.delete(name=cache_handle.name)
        except Exception as exc:
            print(f"unit-tests: WARNING — failed to delete cache "
                  f"{cache_handle.name}: {exc!r}", file=sys.stderr)

    return results, (cache_name is not None)


def _build_unit_tests_block(
    *,
    enabled: bool,
    reason: str | None,
    model: str,
    cached: bool,
    results: list[dict],
) -> dict:
    n_total = len(results)
    n_pass = sum(1 for r in results if r["pass"])
    n_error = sum(1 for r in results if r["error"])
    n_fail = n_total - n_pass
    block: dict = {
        "enabled": enabled,
        "model": model,
        "cached": cached,
        "n_total": n_total,
        "n_pass": n_pass,
        "n_fail": n_fail,
        "n_error": n_error,
        "has_regressions": n_fail > 0,
        "results": results,
    }
    if reason is not None:
        block["reason"] = reason
    return block


def _promote_failed_unit_tests_to_issues(
    results: list[dict],
) -> list[dict]:
    """Turn each failed unit test into a critical issue so the existing
    Phase 6 repair loop fires uniformly. Errored answers (no model
    response) are NOT promoted — they indicate tool failure, not a
    figure regression."""
    promoted: list[dict] = []
    for r in results:
        if r["pass"] or r["error"]:
            continue
        promoted.append({
            "location": f"Panel {r['panel_id']} (unit test)",
            "expected": (
                f"answer '{r['expected_answer']}' to: {r['question']}"
            ),
            "actual": (
                f"answer '{r['actual_answer']}' "
                f"— {r['rationale']}"
            ),
            "severity": "critical",
            "source": "unit_test",
            "panel_id": r["panel_id"],
        })
    return promoted


def _cli() -> int:
    p = argparse.ArgumentParser(
        description=__doc__.split("\n", 1)[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--workdir", required=True, type=Path,
                   help="Per-invocation workdir. Auto-discovers "
                        "`methods.md` (source of truth) from this "
                        "directory.")
    p.add_argument("--reference", type=Path, default=None,
                   help="Deterministic draw.io export, used as a "
                        "helper for symbol disambiguation only "
                        "(default: figures/full_figure.png).")
    p.add_argument("--candidate", type=Path, default=None,
                   help="Enhanced PNG to audit "
                        "(default: figures/full_figure_enhanced.png).")
    p.add_argument("--out", type=Path, default=None,
                   help="Verdict JSON output "
                        "(default: figures/verify.json).")
    p.add_argument("--methods", type=Path, default=None,
                   help="Path to methods.md (default: "
                        "<workdir>/methods.md). This is the source of "
                        "truth the candidate is audited against.")
    p.add_argument("--summary", type=Path, default=None,
                   help="Path to figure_summary.md describing the "
                        "REFERENCE image's intended content (default: "
                        "<workdir>/figure_summary.md if present). "
                        "Embedded in the prompt as FIGURE_SPEC. The "
                        "candidate is allowed to diverge from it as "
                        "long as it stays true to methods.md.")
    # dest="vlm" keeps the internal attribute stable (args.vlm, VLM_REGISTRY
    # lookups) while the user-facing flag is the more specific --audit-vlm.
    p.add_argument("--audit-vlm", dest="vlm", default=DEFAULT_VLM,
                   choices=VLM_CHOICES,
                   help=f"Vision-language model for the Stage A content audit. "
                        f"Choices: {', '.join(VLM_CHOICES)} "
                        f"(default: {DEFAULT_VLM}, from $AUDIT_VLM). Determines "
                        f"both the API backend (OpenAI vs Gemini) and the "
                        f"resolved model id.")
    p.add_argument("--vlm", dest="vlm", choices=VLM_CHOICES,
                   default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    p.add_argument("--model", default=None,
                   help="Override the API model id (advanced). By default "
                        "this is derived from --audit-vlm "
                        f"(gpt-6-astra → gpt-6-astra at high reasoning "
                        f"effort; gpt-5.5 → gpt-5.5; "
                        f"gemini-3.1-pro → gemini-3.1-pro-preview). "
                        "Setting this only changes the model id sent to the "
                        "selected backend; it does not switch backend.")
    p.add_argument("--max-edge", type=int, default=DEFAULT_MAX_EDGE,
                   help=f"Max input image edge in px before resize (default: {DEFAULT_MAX_EDGE}).")
    p.add_argument("--attempt", type=int, default=1,
                   help="Repair-loop attempt number, recorded in the JSON "
                        "verdict for traceability (default: 1).")
    p.add_argument("--skip-unit-tests", action="store_true",
                   help="Skip Stage B (unit-test inspections). The "
                        "open-ended audit still runs.")
    p.add_argument("--unit-test-concurrency", type=int,
                   default=DEFAULT_UT_CONCURRENCY,
                   help=f"Max concurrent unit-test calls per panel "
                        f"(default: {DEFAULT_UT_CONCURRENCY}). Each call "
                        f"is independent; raise to speed up large "
                        f"question sets, lower to stay under provider "
                        f"RPM limits.")
    p.add_argument("--unit-test-cache-ttl", default=DEFAULT_UT_CACHE_TTL,
                   help=f"TTL for the Gemini context cache holding the "
                        f"candidate image (default: "
                        f"{DEFAULT_UT_CACHE_TTL}). Long enough to cover "
                        f"the whole question fan-out.")
    # dest="unit_test_backend" keeps the internal attribute stable while the
    # user-facing flag is --unit-test-vlm (paired with --audit-vlm).
    p.add_argument("--unit-test-vlm", dest="unit_test_backend",
                   choices=UT_BACKEND_CHOICES, default=DEFAULT_UT_BACKEND,
                   help="Backend for Stage B unit-test probes, independent of "
                        "--audit-vlm (which still drives Stage A). "
                        "'openai-single' "
                        "(default) answers ALL questions in ONE OpenAI call "
                        "with the candidate image sent once (cheapest, no "
                        "per-question isolation); 'openai' fans out one call "
                        "per question (image billed N times); 'gemini' fans "
                        "out per-question but caches the image; 'gemini-single' "
                        "is the Gemini analog of 'openai-single' (ALL questions "
                        "in ONE Gemini call, image inline once, no cache "
                        "round-trip); 'codex' routes "
                        "each probe through `codex exec` (ChatGPT "
                        "subscription); 'auto' follows --audit-vlm. Default from "
                        f"$UNIT_TEST_VLM or '{DEFAULT_UT_BACKEND}'. 'codex' "
                        "falls back to 'openai-single' (with a warning) if "
                        "`codex` is not installed.")
    p.add_argument("--unit-test-backend", dest="unit_test_backend",
                   choices=UT_BACKEND_CHOICES, default=argparse.SUPPRESS,
                   help=argparse.SUPPRESS)
    p.add_argument("--codex-model", default=DEFAULT_CODEX_MODEL,
                   help="Model id for `codex exec` when "
                        "--unit-test-vlm=codex (default: $CODEX_MODEL, "
                        "else whatever your codex config selects).")
    p.add_argument("--dry-run", action="store_true",
                   help="Print the prompt and resolved paths; skip the API call.")
    args = p.parse_args()

    figures_dir = Path("figures")
    reference: Path = args.reference or (figures_dir / "full_figure.png")
    candidate: Path = args.candidate or (figures_dir / "full_figure_enhanced.png")
    out_path: Path = args.out or (figures_dir / "verify.json")

    methods_path: Path = args.methods or (args.workdir / "methods.md")

    if not reference.exists():
        print(f"ERROR: reference PNG not found at {reference}", file=sys.stderr)
        return 2
    if not candidate.exists():
        print(f"ERROR: candidate PNG not found at {candidate}", file=sys.stderr)
        return 2
    if not methods_path.exists():
        print(
            f"ERROR: methods file not found at {methods_path}.\n"
            "  methods.md is the source of truth the candidate is "
            "audited against; pass --methods or place it at "
            "<workdir>/methods.md.",
            file=sys.stderr,
        )
        return 2

    methods_text = methods_path.read_text()
    print(f"loaded methods: {methods_path} ({len(methods_text)} chars)")

    summary_path: Path | None = args.summary
    if summary_path is None:
        candidate_summary = args.workdir / "figure_summary.md"
        summary_path = candidate_summary if candidate_summary.exists() else None
    summary_text: str | None = None
    if summary_path is not None:
        if not summary_path.exists():
            print(f"ERROR: --summary path not found at {summary_path}",
                  file=sys.stderr)
            return 2
        summary_text = summary_path.read_text()
        print(f"loaded figure spec: {summary_path} ({len(summary_text)} chars)")
    else:
        print("no figure_summary.md found; FIGURE_SPEC block omitted")

    prompt = build_prompt(methods_text, summary_text)

    unit_test_files: list[Path] = []
    unit_tests: list[dict] = []
    if not args.skip_unit_tests:
        unit_test_files = discover_unit_test_files(args.workdir)
        unit_tests = load_unit_tests(unit_test_files)
        if unit_test_files:
            print(f"unit-tests: discovered {len(unit_test_files)} JSONL "
                  f"file(s) → {len(unit_tests)} valid question(s)")
        else:
            print("unit-tests: no `unit_test_inspections_*.jsonl` found "
                  "in workdir; Stage B will be skipped")
    else:
        print("unit-tests: --skip-unit-tests passed; Stage B skipped")

    backend = VLM_REGISTRY[args.vlm]["backend"]
    resolved_model = args.model or VLM_REGISTRY[args.vlm]["model"]
    reasoning_effort = VLM_REGISTRY[args.vlm].get("reasoning_effort")

    if args.dry_run:
        print(f"[dry-run] audit-vlm: {args.vlm} (backend={backend})")
        print(f"[dry-run] model:     {resolved_model}"
              f"{' (override)' if args.model else ' (from --audit-vlm)'}")
        print(f"[dry-run] reasoning: {reasoning_effort or '(backend default)'}")
        _eff_ut = backend if args.unit_test_backend == "auto" else args.unit_test_backend
        print(f"[dry-run] unit-test-vlm: {args.unit_test_backend}"
              f" (effective={_eff_ut})")
        if _eff_ut == "openai-single":
            print("[dry-run] unit-test mode: ONE call, image sent once, "
                  f"{len(unit_tests)} question(s) batched")
        if _eff_ut == "codex":
            _cx_fallback = "openai-single" if backend == "openai" else backend
            print(f"[dry-run] codex:     {'on PATH' if _codex_available() else 'NOT FOUND — would fall back to ' + _cx_fallback}"
                  f"; model={args.codex_model or '(codex config default)'}")
        print(f"[dry-run] reference: {reference}")
        print(f"[dry-run] candidate: {candidate}")
        print(f"[dry-run] summary:   {summary_path or '(none)'}")
        print(f"[dry-run] out:       {out_path}")
        print(f"[dry-run] attempt:   {args.attempt}")
        print(f"[dry-run] unit-test files: {len(unit_test_files)} "
              f"({len(unit_tests)} questions)")
        for f in unit_test_files:
            print(f"[dry-run]   - {f}")
        print(f"[dry-run] prompt ({len(prompt)} chars):")
        print("─" * 72)
        print(prompt)
        print("─" * 72)
        print("[dry-run] unit-test system prompt "
              f"({len(UNIT_TEST_SYSTEM_PROMPT)} chars):")
        print("─" * 72)
        print(UNIT_TEST_SYSTEM_PROMPT)
        print("─" * 72)
        print("[dry-run] API call skipped.")
        return 0

    ref_bytes, _, ref_size = prepare_input_image(reference, args.max_edge)
    cand_bytes, _, cand_size = prepare_input_image(candidate, args.max_edge)
    print(f"reference: {reference} → {ref_size[0]}x{ref_size[1]} ({len(ref_bytes)/1024:.1f} KB)")
    print(f"candidate: {candidate} → {cand_size[0]}x{cand_size[1]} ({len(cand_bytes)/1024:.1f} KB)")

    out_path.parent.mkdir(parents=True, exist_ok=True)

    return _call_backend(
        vlm=args.vlm,
        model=resolved_model,
        reasoning_effort=reasoning_effort,
        prompt=prompt,
        reference_bytes=ref_bytes,
        candidate_bytes=cand_bytes,
        reference_path=reference,
        candidate_path=candidate,
        out_path=out_path,
        attempt=args.attempt,
        workdir=args.workdir,
        unit_tests=unit_tests,
        unit_test_files=unit_test_files,
        unit_tests_skipped=args.skip_unit_tests,
        unit_test_concurrency=args.unit_test_concurrency,
        unit_test_cache_ttl=args.unit_test_cache_ttl,
        unit_test_backend=args.unit_test_backend,
        codex_model=args.codex_model,
    )


# --- OpenAI backend ----------------------------------------------------------
#
# Stage A is one chat-completion with the REFERENCE + CANDIDATE images and the
# audit system prompt. Stage B fans out one chat-completion per unit-test
# question, each carrying the candidate image inline. There is no explicit
# context-cache API like Gemini's; OpenAI's prefix-cache is implicit so we
# always report cached=False for traceability.


def _b64_data_url(jpeg_bytes: bytes) -> str:
    import base64
    return "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode("ascii")


def _ensure_openai_key() -> int | None:
    if os.environ.get("OPENAI_API_KEY"):
        return None
    from_dotenv = load_dotenv_key("OPENAI_API_KEY")
    if from_dotenv:
        os.environ["OPENAI_API_KEY"] = from_dotenv
        print("loaded OPENAI_API_KEY from .env")
        return None
    print("ERROR: OPENAI_API_KEY is not set in env or .env (cwd).",
          file=sys.stderr)
    return 2


def _import_openai():
    try:
        from openai import OpenAI, AsyncOpenAI  # type: ignore
        return OpenAI, AsyncOpenAI
    except ImportError:
        print(
            "ERROR: the `openai` package is not installed.\n"
            f"  {sys.executable} -m pip install 'openai>=1.50'",
            file=sys.stderr,
        )
        return None


def _reasoning_kwargs(effort: str | None) -> dict:
    return {"reasoning_effort": effort} if effort else {}


def _stage_a_openai(*, model: str, prompt: str,
                    reference_bytes: bytes, candidate_bytes: bytes,
                    attempt: int, workdir: Path,
                    reasoning_effort: str | None = None) -> str | int:
    """Run the open-ended content audit via OpenAI chat.completions.
    Returns raw JSON text, or an int exit code on error."""
    err = _ensure_openai_key()
    if err is not None:
        return err
    imp = _import_openai()
    if imp is None:
        return 2
    OpenAI, _ = imp

    client = OpenAI()
    print(f"calling {model} (attempt={attempt}) ...")
    started = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": [
                    {"type": "text",
                     "text": "REFERENCE — deterministic draw.io export. "
                             "Helper only: use it to disambiguate symbols "
                             "you cannot read in the candidate. The "
                             "reference is NOT authoritative — the "
                             "candidate may add, remove, or rearrange "
                             "visual elements freely."},
                    {"type": "image_url",
                     "image_url": {"url": _b64_data_url(reference_bytes)}},
                    {"type": "text",
                     "text": "CANDIDATE — the gpt-image-2 restyle. Audit "
                             "it against METHODS for truth and against "
                             "itself for understandability, and return "
                             "JSON only."},
                    {"type": "image_url",
                     "image_url": {"url": _b64_data_url(candidate_bytes)}},
                ]},
            ],
            response_format={"type": "json_object"},
            **_reasoning_kwargs(reasoning_effort),
        )
    except Exception as exc:
        print(f"ERROR: OpenAI API call failed: {exc}", file=sys.stderr)
        return 1

    usage = getattr(response, "usage", None)
    record_usage(workdir, phase=6, source="openai-vision", model=model,
                 duration_secs=time.perf_counter() - started, basis="tokens",
                 input_tokens=getattr(usage, "prompt_tokens", None),
                 output_tokens=getattr(usage, "completion_tokens", None))
    return response.choices[0].message.content or ""


async def _ask_unit_test_openai(client, *, model: str,
                                question_text: str,
                                candidate_data_url: str,
                                workdir: Path,
                                max_retries: int = 1,
                                reasoning_effort: str | None = None) -> dict:
    last_error: str | None = None
    for _ in range(max_retries + 1):
        try:
            started = time.perf_counter()
            result = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": UNIT_TEST_SYSTEM_PROMPT},
                    {"role": "user", "content": [
                        {"type": "image_url",
                         "image_url": {"url": candidate_data_url}},
                        {"type": "text", "text": question_text},
                    ]},
                ],
                response_format={"type": "json_object"},
                **_reasoning_kwargs(reasoning_effort),
            )
            usage = getattr(result, "usage", None)
            record_usage(workdir, phase=6, source="openai-vision", model=model,
                         duration_secs=time.perf_counter() - started,
                         basis="tokens",
                         input_tokens=getattr(usage, "prompt_tokens", None),
                         output_tokens=getattr(usage, "completion_tokens", None))
            raw = (result.choices[0].message.content or "").strip()
            obj = json.loads(raw)
            ans = obj.get("answer")
            rat = obj.get("rationale", "")
            if isinstance(ans, str):
                ans = ans.strip().lower()
            if ans in VALID_YES_NO and isinstance(rat, str):
                return {"answer": ans, "rationale": rat, "error": False}
            last_error = f"unexpected shape: {obj!r}"
        except Exception as exc:
            last_error = repr(exc)
    return {
        "answer": None,
        "rationale": f"FAILED after retries: {last_error}",
        "error": True,
    }


async def _run_unit_tests_openai_async(
    *, model: str, candidate_bytes: bytes,
    questions: list[dict], max_concurrency: int, workdir: Path,
    reasoning_effort: str | None = None,
) -> tuple[list[dict], bool]:
    """Run all questions concurrently against OpenAI. The candidate image is
    sent inline on every call (OpenAI has no explicit context-cache API like
    Gemini); cross-call prefix caching is implicit and not surfaced here, so
    we always return used_cache=False."""
    err = _ensure_openai_key()
    if err is not None:
        raise RuntimeError("OPENAI_API_KEY missing")
    imp = _import_openai()
    if imp is None:
        raise RuntimeError("openai package missing")
    _, AsyncOpenAI = imp

    client = AsyncOpenAI()
    candidate_data_url = _b64_data_url(candidate_bytes)
    sem = asyncio.Semaphore(max_concurrency)

    async def _bounded(q: dict) -> tuple[dict, dict]:
        async with sem:
            ans = await _ask_unit_test_openai(
                client, model=model,
                question_text=q["question"],
                candidate_data_url=candidate_data_url,
                workdir=workdir,
                reasoning_effort=reasoning_effort,
            )
            return q, ans

    pairs = await asyncio.gather(*[_bounded(q) for q in questions])

    results: list[dict] = []
    for q, ans in pairs:
        passed = (ans["answer"] is not None
                  and ans["answer"] == q["expected_answer"])
        results.append({
            "panel_id": q["panel_id"],
            "question": q["question"],
            "expected_answer": q["expected_answer"],
            "actual_answer": ans["answer"],
            "rationale": ans["rationale"],
            "pass": passed,
            "error": ans["error"],
            "source_file": q["source_file"],
            "line": q["line"],
        })
    return results, False


# --- OpenAI single-call backend for Stage B (default) ------------------------
#
# Instead of one chat-completion per question (each re-uploading the ~2K
# candidate image), `openai-single` sends the image ONCE and asks every
# unit-test question in a single call, numbered 0..N-1. The model returns a
# JSON array of {id, answer, rationale}, which we map back to the questions by
# id. This is ~1/N the image cost; the trade-off is the model sees all
# questions together (no per-question isolation). Answers missing from the
# array are recorded as errors (not promoted to issues).

UNIT_TEST_BATCH_SYSTEM_PROMPT = """\
You are answering a batch of independent binary yes/no inspection \
questions about a single scientific figure.

You will be given exactly one image — the CANDIDATE figure — and a \
numbered list of questions. Answer EACH question ONLY based on what is \
visible in the image. Treat every question independently: your answer \
to one question must not influence another. Do not invent details. Do \
not assume anything that is not depicted.

Respond with a single JSON object, no prose, no code fences, exactly \
this shape:

  {"answers": [{"id": <int>, "answer": "yes" | "no", "rationale": "<one short sentence>"}, ...]}

Rules:
  - Return exactly ONE entry per question. `id` MUST equal the \
question's number in the list (the integer printed before the period).
  - `answer` MUST be exactly the lowercase string "yes" or "no". No \
other value is permitted.
  - `rationale` is one short sentence describing what you saw in the \
image that led to your answer; cite the specific region or label.
  - If a question asks whether something is present and you do not see \
it in the image, answer "no".
  - If a question asks whether some defect is visible (e.g. "is any \
raw LaTeX visible?") and you do not see the defect, answer "no".
"""


def _run_unit_tests_openai_single(
    *, model: str, candidate_bytes: bytes, questions: list[dict],
    workdir: Path, max_retries: int = 1,
    reasoning_effort: str | None = None,
) -> tuple[list[dict], bool]:
    """Answer ALL unit-test questions in ONE OpenAI call. The candidate image
    is sent exactly once and every question is enumerated 0..N-1; the model
    returns a JSON array of answers keyed by id. Trades per-question isolation
    for ~1/N the image cost. used_cache is always False (single call)."""
    err = _ensure_openai_key()
    if err is not None:
        raise RuntimeError("OPENAI_API_KEY missing")
    imp = _import_openai()
    if imp is None:
        raise RuntimeError("openai package missing")
    OpenAI, _ = imp

    client = OpenAI()
    numbered = "\n".join(f"{i}. {q['question']}" for i, q in enumerate(questions))
    user_text = (
        "Answer every question below about the CANDIDATE image. Return one "
        "entry per question, keyed by the question number shown before each "
        "question.\n\n" + numbered
    )

    answers_by_id: dict[int, dict] = {}
    last_error: str | None = None
    print(f"unit-tests: single {model} call for {len(questions)} question(s) "
          f"(image sent once) ...")
    for _ in range(max_retries + 1):
        try:
            started = time.perf_counter()
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system",
                     "content": UNIT_TEST_BATCH_SYSTEM_PROMPT},
                    {"role": "user", "content": [
                        {"type": "image_url",
                         "image_url": {"url": _b64_data_url(candidate_bytes)}},
                        {"type": "text", "text": user_text},
                    ]},
                ],
                response_format={"type": "json_object"},
                **_reasoning_kwargs(reasoning_effort),
            )
            usage = getattr(response, "usage", None)
            record_usage(workdir, phase=6, source="openai-vision", model=model,
                         duration_secs=time.perf_counter() - started,
                         basis="tokens",
                         input_tokens=getattr(usage, "prompt_tokens", None),
                         output_tokens=getattr(usage, "completion_tokens", None))
            raw = (response.choices[0].message.content or "").strip()
            obj = json.loads(raw)
            arr = obj.get("answers")
            if isinstance(arr, list):
                for entry in arr:
                    if not isinstance(entry, dict):
                        continue
                    eid = entry.get("id")
                    ans = entry.get("answer")
                    rat = entry.get("rationale", "")
                    if isinstance(ans, str):
                        ans = ans.strip().lower()
                    if (isinstance(eid, int) and ans in VALID_YES_NO
                            and isinstance(rat, str)):
                        answers_by_id[eid] = {"answer": ans, "rationale": rat}
                if answers_by_id:
                    break
            last_error = f"unexpected shape: {obj!r}"
        except Exception as exc:
            last_error = repr(exc)

    results: list[dict] = []
    for i, q in enumerate(questions):
        a = answers_by_id.get(i)
        if a is None:
            results.append({
                "panel_id": q["panel_id"],
                "question": q["question"],
                "expected_answer": q["expected_answer"],
                "actual_answer": None,
                "rationale": (f"FAILED: no answer returned for question {i}"
                              + (f" ({last_error})" if last_error else "")),
                "pass": False,
                "error": True,
                "source_file": q["source_file"],
                "line": q["line"],
            })
            continue
        passed = a["answer"] == q["expected_answer"]
        results.append({
            "panel_id": q["panel_id"],
            "question": q["question"],
            "expected_answer": q["expected_answer"],
            "actual_answer": a["answer"],
            "rationale": a["rationale"],
            "pass": passed,
            "error": False,
            "source_file": q["source_file"],
            "line": q["line"],
        })
    return results, False


# --- Gemini single-call backend for Stage B ----------------------------------
#
# The Gemini analog of `openai-single`: instead of fanning out one call per
# question (the `gemini` backend, which holds the image in a context cache),
# `gemini-single` sends the candidate image inline ONCE and asks every question
# in a single generate_content call, numbered 0..N-1. The model returns the same
# {"answers": [{id, answer, rationale}, ...]} shape as the OpenAI batch mode, so
# the parsing/mapping logic is identical. Cheapest Gemini path (no cache
# create/delete round-trip); trade-off is the loss of per-question isolation.


def _run_unit_tests_gemini_single(
    *, model: str, candidate_bytes: bytes, questions: list[dict],
    workdir: Path, max_retries: int = 1,
) -> tuple[list[dict], bool]:
    """Answer ALL unit-test questions in ONE Gemini call. The candidate image is
    sent inline exactly once and every question is enumerated 0..N-1; the model
    returns a JSON array of answers keyed by id. Trades per-question isolation
    for a single inline image. used_cache is always False (single call)."""
    from google import genai  # type: ignore
    from google.genai import types  # type: ignore

    client = genai.Client()
    numbered = "\n".join(f"{i}. {q['question']}" for i, q in enumerate(questions))
    user_text = (
        "Answer every question below about the CANDIDATE image. Return one "
        "entry per question, keyed by the question number shown before each "
        "question.\n\n" + numbered
    )

    answers_by_id: dict[int, dict] = {}
    last_error: str | None = None
    print(f"unit-tests: single {model} call for {len(questions)} question(s) "
          f"(image sent once) ...")
    for _ in range(max_retries + 1):
        try:
            started = time.perf_counter()
            result = client.models.generate_content(
                model=model,
                contents=[
                    types.Part.from_bytes(
                        data=candidate_bytes, mime_type="image/jpeg",
                    ),
                    types.Part.from_text(text=user_text),
                ],
                config=types.GenerateContentConfig(
                    system_instruction=UNIT_TEST_BATCH_SYSTEM_PROMPT,
                    response_mime_type="application/json",
                    temperature=0,
                ),
            )
            meta = getattr(result, "usage_metadata", None)
            record_usage(workdir, phase=6, source="gemini-vision", model=model,
                         duration_secs=time.perf_counter() - started,
                         basis="tokens",
                         input_tokens=getattr(meta, "prompt_token_count", None),
                         output_tokens=getattr(meta, "candidates_token_count", None))
            raw = (result.text or "").strip()
            obj = json.loads(raw)
            arr = obj.get("answers")
            if isinstance(arr, list):
                for entry in arr:
                    if not isinstance(entry, dict):
                        continue
                    eid = entry.get("id")
                    ans = entry.get("answer")
                    rat = entry.get("rationale", "")
                    if isinstance(ans, str):
                        ans = ans.strip().lower()
                    if (isinstance(eid, int) and ans in VALID_YES_NO
                            and isinstance(rat, str)):
                        answers_by_id[eid] = {"answer": ans, "rationale": rat}
                if answers_by_id:
                    break
            last_error = f"unexpected shape: {obj!r}"
        except Exception as exc:
            last_error = repr(exc)

    results: list[dict] = []
    for i, q in enumerate(questions):
        a = answers_by_id.get(i)
        if a is None:
            results.append({
                "panel_id": q["panel_id"],
                "question": q["question"],
                "expected_answer": q["expected_answer"],
                "actual_answer": None,
                "rationale": (f"FAILED: no answer returned for question {i}"
                              + (f" ({last_error})" if last_error else "")),
                "pass": False,
                "error": True,
                "source_file": q["source_file"],
                "line": q["line"],
            })
            continue
        passed = a["answer"] == q["expected_answer"]
        results.append({
            "panel_id": q["panel_id"],
            "question": q["question"],
            "expected_answer": q["expected_answer"],
            "actual_answer": a["answer"],
            "rationale": a["rationale"],
            "pass": passed,
            "error": False,
            "source_file": q["source_file"],
            "line": q["line"],
        })
    return results, False


# --- Codex (ChatGPT-subscription) backend for Stage B ------------------------
#
# Stage B is routed through the `codex` CLI's non-interactive `exec` mode so the
# per-question probes bill against a ChatGPT subscription instead of metered
# OpenAI API calls. Each probe is an independent `codex exec` invocation:
#
#   codex exec "<system prompt + question>" -i <candidate.jpg> \
#       --output-schema <schema.json> -o <out.json> \
#       -s read-only --skip-git-repo-check [-m <model>]
#
# Notes:
#   - In exec mode the prompt MUST precede -i (arg-ordering requirement).
#   - exec prints only the final agent message to stdout; with
#     --output-schema that message is the schema-conforming JSON, so we parse
#     stdout first and fall back to the -o file.
#   - --sandbox read-only keeps Codex from touching the repo; a yes/no vision
#     probe needs no writes.
#   - Requires `codex login` (ChatGPT account) on the host; otherwise the
#     dispatcher falls back to the metered backend with a warning.

CODEX_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string", "enum": ["yes", "no"]},
        "rationale": {"type": "string"},
    },
    "required": ["answer", "rationale"],
    "additionalProperties": False,
}


def _codex_available() -> str | None:
    """Path to the `codex` binary, or None if it is not on PATH."""
    return shutil.which("codex")


def _parse_codex_json(text: str) -> dict | None:
    """Best-effort extraction of a single JSON object from a codex final
    message. Tolerates code fences and surrounding prose."""
    if not text:
        return None
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        nl = t.find("\n")
        if nl != -1:
            t = t[nl + 1:]
        t = t.strip()
    try:
        obj = json.loads(t)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    start, end = t.find("{"), t.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(t[start:end + 1])
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None
    return None


async def _ask_unit_test_codex(*, question_text: str, image_path: Path,
                               schema_path: Path, cwd: Path,
                               codex_model: str | None,
                               extra_args: list[str],
                               max_retries: int = 1) -> dict:
    """Ask one question via `codex exec`. Returns the same shape as the
    OpenAI/Gemini probes: {"answer": "yes"|"no"|None, "rationale", "error"}."""
    prompt = (
        UNIT_TEST_SYSTEM_PROMPT
        + "\n\nThe attached image is the CANDIDATE figure. Answer ONLY from "
          "the image; do NOT run commands, read files, or use any tools.\n\n"
          "QUESTION: " + question_text
    )
    last_error: str | None = None
    for _ in range(max_retries + 1):
        out_file = cwd / f"ut_{uuid.uuid4().hex}.json"
        cmd = ["codex", "exec", prompt,
               "-i", str(image_path),
               "--output-schema", str(schema_path),
               "-o", str(out_file),
               "-s", "read-only",
               "--skip-git-repo-check"]
        if codex_model:
            cmd += ["-m", codex_model]
        cmd += extra_args
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=str(cwd),
                stdin=asyncio.subprocess.DEVNULL,  # else exec blocks on stdin
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            if proc.returncode != 0:
                tail = stderr.decode("utf-8", "replace").strip()[-400:]
                last_error = f"codex exec rc={proc.returncode}: {tail}"
                continue
            obj = _parse_codex_json(stdout.decode("utf-8", "replace"))
            if obj is None and out_file.exists():
                obj = _parse_codex_json(out_file.read_text())
            if obj is not None:
                ans = obj.get("answer")
                rat = obj.get("rationale", "")
                if isinstance(ans, str):
                    ans = ans.strip().lower()
                if ans in VALID_YES_NO and isinstance(rat, str):
                    return {"answer": ans, "rationale": rat, "error": False}
            last_error = f"unparseable codex output: {stdout[:200]!r}"
        except Exception as exc:
            last_error = repr(exc)
        finally:
            try:
                out_file.unlink()
            except OSError:
                pass
    return {
        "answer": None,
        "rationale": f"FAILED after retries: {last_error}",
        "error": True,
    }


async def _run_unit_tests_codex_async(
    *, candidate_bytes: bytes, questions: list[dict],
    max_concurrency: int, codex_model: str | None, workdir: Path,
) -> tuple[list[dict], bool]:
    """Run all questions via `codex exec` (ChatGPT subscription). Writes the
    candidate image + JSON schema to a temp dir once, then fans out one
    bounded `codex exec` subprocess per question. used_cache is always False
    (no provider-side cache is involved)."""
    started = time.perf_counter()
    extra_args = shlex.split(os.environ.get("CODEX_EXEC_EXTRA_ARGS", ""))
    with tempfile.TemporaryDirectory(prefix="verify_codex_") as td:
        tmp = Path(td)
        # prepare_input_image re-encodes to JPEG, so name the file accordingly.
        image_path = tmp / "candidate.jpg"
        image_path.write_bytes(candidate_bytes)
        schema_path = tmp / "schema.json"
        schema_path.write_text(json.dumps(CODEX_OUTPUT_SCHEMA))

        sem = asyncio.Semaphore(max_concurrency)

        async def _bounded(q: dict) -> tuple[dict, dict]:
            async with sem:
                ans = await _ask_unit_test_codex(
                    question_text=q["question"],
                    image_path=image_path,
                    schema_path=schema_path,
                    cwd=tmp,
                    codex_model=codex_model,
                    extra_args=extra_args,
                )
                return q, ans

        pairs = await asyncio.gather(*[_bounded(q) for q in questions])

    results: list[dict] = []
    for q, ans in pairs:
        passed = (ans["answer"] is not None
                  and ans["answer"] == q["expected_answer"])
        results.append({
            "panel_id": q["panel_id"],
            "question": q["question"],
            "expected_answer": q["expected_answer"],
            "actual_answer": ans["answer"],
            "rationale": ans["rationale"],
            "pass": passed,
            "error": ans["error"],
            "source_file": q["source_file"],
            "line": q["line"],
        })
    # codex exec bills against the ChatGPT subscription, not metered API — one
    # subscription record for the whole fan-out (no per-call token usage).
    record_usage(workdir, phase=6, source="codex",
                 model=codex_model or "codex (subscription default)",
                 duration_secs=time.perf_counter() - started,
                 basis="subscription")
    return results, False


# --- Gemini backend (stage A extracted from old _call_gemini) ----------------


def _stage_a_gemini(*, model: str, prompt: str,
                    reference_bytes: bytes, candidate_bytes: bytes,
                    attempt: int, workdir: Path) -> str | int:
    """Run the open-ended content audit via Gemini generate_content.
    Returns raw JSON text, or an int exit code on error."""
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
            f"  {sys.executable} -m pip install 'google-genai>=1.0'",
            file=sys.stderr,
        )
        return 2

    parts = [
        types.Part.from_text(
            text="REFERENCE — deterministic draw.io export. Helper "
                 "only: use it to disambiguate symbols you cannot "
                 "read in the candidate. The reference is NOT "
                 "authoritative — the candidate may add, remove, "
                 "or rearrange visual elements freely."
        ),
        types.Part.from_bytes(data=reference_bytes, mime_type="image/jpeg"),
        types.Part.from_text(
            text="CANDIDATE — the gpt-image-2 restyle. Audit it "
                 "against METHODS for truth and against itself for "
                 "understandability, and return JSON only."
        ),
        types.Part.from_bytes(data=candidate_bytes, mime_type="image/jpeg"),
    ]

    client = genai.Client()
    print(f"calling {model} (attempt={attempt}) ...")
    started = time.perf_counter()
    try:
        result = client.models.generate_content(
            model=model,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=prompt,
                response_mime_type="application/json",
                temperature=0.2,
            ),
        )
    except Exception as exc:
        print(f"ERROR: Gemini API call failed: {exc}", file=sys.stderr)
        return 1

    meta = getattr(result, "usage_metadata", None)
    record_usage(workdir, phase=6, source="gemini-vision", model=model,
                 duration_secs=time.perf_counter() - started, basis="tokens",
                 input_tokens=getattr(meta, "prompt_token_count", None),
                 output_tokens=getattr(meta, "candidates_token_count", None))
    return result.text or ""


# --- Backend dispatcher ------------------------------------------------------


def _call_backend(*, vlm: str, model: str, prompt: str,
                  reference_bytes: bytes, candidate_bytes: bytes,
                  reasoning_effort: str | None = None,
                  reference_path: Path, candidate_path: Path,
                  out_path: Path, attempt: int, workdir: Path,
                  unit_tests: list[dict],
                  unit_test_files: list[Path],
                  unit_tests_skipped: bool,
                  unit_test_concurrency: int,
                  unit_test_cache_ttl: str,
                  unit_test_backend: str = "auto",
                  codex_model: str | None = None) -> int:
    # Stage A — open-ended content audit. Dispatch to the selected backend;
    # both helpers return raw JSON text on success or an int exit code.
    backend = VLM_REGISTRY[vlm]["backend"]
    if backend == "openai":
        raw_or_err = _stage_a_openai(
            model=model, prompt=prompt,
            reference_bytes=reference_bytes, candidate_bytes=candidate_bytes,
            attempt=attempt, workdir=workdir,
            reasoning_effort=reasoning_effort,
        )
    elif backend == "gemini":
        raw_or_err = _stage_a_gemini(
            model=model, prompt=prompt,
            reference_bytes=reference_bytes, candidate_bytes=candidate_bytes,
            attempt=attempt, workdir=workdir,
        )
    else:
        print(f"ERROR: unknown backend {backend!r} for --audit-vlm {vlm!r}",
              file=sys.stderr)
        return 2
    if isinstance(raw_or_err, int):
        return raw_or_err
    raw = raw_or_err
    raw_path = out_path.with_name(out_path.stem + ".raw.txt")

    try:
        verdict = json.loads(raw)
    except json.JSONDecodeError as exc:
        raw_path.write_text(raw)
        print(f"ERROR: model returned non-JSON output ({exc}); raw saved to {raw_path}",
              file=sys.stderr)
        return 1

    schema_errors = _validate_verdict(verdict)
    if schema_errors:
        raw_path.write_text(raw)
        print("ERROR: model output failed schema validation:", file=sys.stderr)
        for err in schema_errors:
            print(f"  - {err}", file=sys.stderr)
        print(f"raw saved to {raw_path}", file=sys.stderr)
        return 1

    # Stage B — unit-test inspections (parallel, image cached).
    if unit_tests_skipped:
        unit_tests_block = _build_unit_tests_block(
            enabled=False, reason="--skip-unit-tests passed",
            model=model, cached=False, results=[],
        )
    elif not unit_tests:
        reason = (
            "no `unit_test_inspections_*.jsonl` discovered in workdir"
            if not unit_test_files
            else "all discovered JSONL lines were invalid; see warnings"
        )
        unit_tests_block = _build_unit_tests_block(
            enabled=False, reason=reason,
            model=model, cached=False, results=[],
        )
    else:
        # Resolve the Stage B backend independently of Stage A's --audit-vlm.
        eff_ut_backend = backend if unit_test_backend == "auto" else unit_test_backend
        if eff_ut_backend == "codex" and _codex_available() is None:
            fallback = "openai-single" if backend == "openai" else backend
            print("unit-tests: WARNING — unit-test backend 'codex' selected "
                  f"but `codex` is not on PATH; falling back to '{fallback}'. "
                  "Install the Codex CLI and run `codex login` to bill these "
                  "probes against your ChatGPT subscription instead of the "
                  "metered API.", file=sys.stderr)
            eff_ut_backend = fallback
        # The `openai*` modes need an OpenAI model id; if Stage A is on Gemini
        # the resolved model is a Gemini id, so fall back to DEFAULT_OPENAI_VLM.
        # The `gemini*` modes are the mirror: they need a Gemini model id, so if
        # Stage A is on OpenAI fall back to the default Gemini VLM.
        ut_model = model
        ut_effort = reasoning_effort
        if eff_ut_backend in ("openai", "openai-single") and backend != "openai":
            ut_model = VLM_REGISTRY[DEFAULT_OPENAI_VLM]["model"]
            ut_effort = VLM_REGISTRY[DEFAULT_OPENAI_VLM].get("reasoning_effort")
        elif eff_ut_backend in ("gemini", "gemini-single") and backend != "gemini":
            ut_model = VLM_REGISTRY["gemini-3.1-pro"]["model"]
        ut_conc = unit_test_concurrency
        ut_model_label = ut_model
        if eff_ut_backend == "codex":
            ut_model_label = codex_model or "codex (subscription default)"
            # codex exec spins up a full agent per call — heavier than an API
            # request — so don't fan out as wide unless asked explicitly.
            if unit_test_concurrency == DEFAULT_UT_CONCURRENCY:
                ut_conc = DEFAULT_CODEX_CONCURRENCY
        if eff_ut_backend in ("openai-single", "gemini-single"):
            print(f"unit-tests: answering {len(unit_tests)} question(s) in ONE "
                  f"{ut_model} call (candidate image sent once)")
        else:
            print(f"unit-tests: replaying {len(unit_tests)} question(s) against "
                  f"candidate (backend={eff_ut_backend}, concurrency={ut_conc})")
        try:
            if eff_ut_backend == "openai-single":
                ut_results, ut_cached = _run_unit_tests_openai_single(
                    model=ut_model,
                    candidate_bytes=candidate_bytes,
                    questions=unit_tests,
                    workdir=workdir,
                    reasoning_effort=ut_effort,
                )
            elif eff_ut_backend == "gemini-single":
                ut_results, ut_cached = _run_unit_tests_gemini_single(
                    model=ut_model,
                    candidate_bytes=candidate_bytes,
                    questions=unit_tests,
                    workdir=workdir,
                )
            elif eff_ut_backend == "codex":
                ut_results, ut_cached = asyncio.run(
                    _run_unit_tests_codex_async(
                        candidate_bytes=candidate_bytes,
                        questions=unit_tests,
                        max_concurrency=ut_conc,
                        codex_model=codex_model,
                        workdir=workdir,
                    )
                )
            elif eff_ut_backend == "openai":
                ut_results, ut_cached = asyncio.run(
                    _run_unit_tests_openai_async(
                        model=ut_model,
                        candidate_bytes=candidate_bytes,
                        questions=unit_tests,
                        max_concurrency=ut_conc,
                        workdir=workdir,
                        reasoning_effort=ut_effort,
                    )
                )
            else:
                ut_results, ut_cached = asyncio.run(_run_unit_tests_async(
                    model=ut_model,
                    candidate_bytes=candidate_bytes,
                    questions=unit_tests,
                    max_concurrency=ut_conc,
                    cache_ttl=unit_test_cache_ttl,
                    workdir=workdir,
                ))
            unit_tests_block = _build_unit_tests_block(
                enabled=True, reason=None, model=ut_model_label,
                cached=ut_cached, results=ut_results,
            )
            print(f"unit-tests: {unit_tests_block['n_pass']}/"
                  f"{unit_tests_block['n_total']} passed "
                  f"({unit_tests_block['n_fail']} failed, "
                  f"{unit_tests_block['n_error']} errored)")
        except Exception as exc:
            print(f"unit-tests: ERROR — stage failed ({exc!r}); "
                  f"recording empty block, audit verdict will still ship",
                  file=sys.stderr)
            unit_tests_block = _build_unit_tests_block(
                enabled=False, reason=f"stage failed: {exc!r}",
                model=model, cached=False, results=[],
            )

    # Promote failed unit tests into the issues list so the existing
    # repair loop fires uniformly (only real fails, not tool errors).
    promoted = _promote_failed_unit_tests_to_issues(
        unit_tests_block.get("results", [])
    )
    if promoted:
        verdict.setdefault("issues", []).extend(promoted)
        print(f"unit-tests: promoted {len(promoted)} failure(s) into "
              f"`issues` as severity=critical")

    has_critical = any(
        isinstance(i, dict) and i.get("severity") == "critical"
        for i in verdict.get("issues", [])
    )
    if verdict["has_wrong_content"] != has_critical:
        print(
            f"WARNING: model set has_wrong_content={verdict['has_wrong_content']} "
            f"but {'a' if has_critical else 'no'} critical issue is present "
            f"(after unit-test promotion); correcting to {has_critical}.",
            file=sys.stderr,
        )
        verdict["has_wrong_content"] = has_critical

    full_verdict = {
        "schema_version": SCHEMA_VERSION,
        "attempt": attempt,
        "model": model,
        "reference": str(reference_path),
        "candidate": str(candidate_path),
        **verdict,
        "unit_tests": unit_tests_block,
    }
    out_path.write_text(json.dumps(full_verdict, indent=2) + "\n")
    n_issues = len(verdict.get("issues", []))
    print(f"wrote {out_path}: has_wrong_content={verdict['has_wrong_content']}, "
          f"{n_issues} issue(s) "
          f"(unit_tests: {unit_tests_block['n_pass']}/"
          f"{unit_tests_block['n_total']} pass)")
    if raw_path.exists():
        raw_path.unlink()
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
