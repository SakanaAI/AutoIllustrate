#!/usr/bin/env python3
"""Check a panel generator honours the Phase 4 compose contract.

Compose imports the generator and calls `build_params(bypass_warnings=True)`,
then reads `page_w`/`page_h` for layout. A valid `.drawio` proves neither, so
the orchestrator runs this gate after each panel and the panel agent runs it as
a self-test. Exit 0 + `OK:` on success; non-zero + a `CONTRACT:` line (and a
machine-readable `MISSING:page_w,page_h` for omitted keys) on failure.

Usage: check_params_contract.py <generate_PANEL.py>
"""

import importlib.util
import sys


def fail(msg: str) -> None:
    print(f"CONTRACT: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <generate_PANEL.py>", file=sys.stderr)
        return 2
    generator = sys.argv[1]

    spec = importlib.util.spec_from_file_location("panelgen", generator)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["panelgen"] = mod  # let dataclasses resolve string annotations
    spec.loader.exec_module(mod)

    # Mirror compose.py:_get_params exactly.
    if hasattr(mod, "build_params"):
        try:
            params = mod.build_params(bypass_warnings=True)
        except TypeError as exc:
            if "bypass_warnings" in str(exc):
                fail("build_params() must accept `bypass_warnings` — keep the template "
                     "signature: def build_params(bypass_warnings: bool = False) -> dict")
            raise
    elif hasattr(mod, "params"):
        params = mod.params
    else:
        fail(f"{generator} exposes neither build_params() nor module-level params")

    missing = [k for k in ("page_w", "page_h") if k not in params]
    if missing:
        print("MISSING:" + ",".join(missing), file=sys.stderr)
        fail(f"build_params() omits {' / '.join(missing)} — compose needs them for layout")

    print(f"OK: build_params() returns page_w={params['page_w']} page_h={params['page_h']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
