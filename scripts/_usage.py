"""Append-only API/CLI usage ledger shared by the phase scripts.

Each paid image/vision/CLI call appends ONE single-line JSON record to
``<workdir>/metrics/api_usage.jsonl``. The TypeScript orchestrator reads the
ledger after the run, applies prices, and rolls the records into the per-stage
cost/runtime summary — so prices live in exactly one place (the TS side) and
this module only ever records raw counts.

A single short line opened in append mode is atomic on POSIX (well under
PIPE_BUF), so the parallel phase-2/3 sub-agents can record concurrently without
interleaving each other's lines. Recording is best-effort: any IO error is
swallowed, because a metrics write must never break a phase.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional, Union


def resolve_phase(default: int) -> int:
    """The phase a recording should be billed to.

    enhance.py runs both in Phase 5 and, during the Phase 6 verify-repair loop,
    as a re-enhance triggered by the Phase 6 sub-agent. The orchestrator stamps
    AUTOILLUSTRATE_PHASE per phase (and the agent's subprocesses inherit it), so
    a repair re-enhance is billed to Phase 6 rather than Phase 5. Falls back to
    the caller's natural phase when the var is unset (e.g. standalone runs).
    """
    raw = os.environ.get("AUTOILLUSTRATE_PHASE")
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    return default


def record_usage(
    workdir: Optional[Union[str, Path]],
    *,
    phase: int,
    source: str,
    model: str,
    duration_secs: float,
    basis: str,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    images: Optional[int] = None,
    size: Optional[str] = None,
    quality: Optional[str] = None,
) -> None:
    """Append one usage record to the run's ledger. Never raises.

    ``basis`` is one of ``tokens`` | ``image`` | ``subscription`` and tells the
    TS pricer how to cost the record. Only the fields relevant to ``basis`` need
    be supplied; ``None`` values are omitted from the line.
    """
    if workdir is None:  # standalone script invocation without --workdir
        return
    try:
        metrics_dir = Path(workdir) / "metrics"
        metrics_dir.mkdir(parents=True, exist_ok=True)
        record: dict[str, object] = {
            "ts": round(time.time(), 3),
            "phase": int(phase),
            "source": source,
            "model": model,
            "duration_secs": round(float(duration_secs), 3),
            "basis": basis,
        }
        if input_tokens is not None:
            record["input_tokens"] = int(input_tokens)
        if output_tokens is not None:
            record["output_tokens"] = int(output_tokens)
        if images is not None:
            record["images"] = int(images)
        if size is not None:
            record["size"] = size
        if quality is not None:
            record["quality"] = quality
        line = json.dumps(record, separators=(",", ":")) + "\n"
        with open(metrics_dir / "api_usage.jsonl", "a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        # Best-effort: metrics must never break a phase.
        pass
