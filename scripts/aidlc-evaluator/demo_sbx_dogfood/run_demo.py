#!/usr/bin/env python3
"""Proof: AI-DLC's post_run.py install+test flow, run through a real sbx
sandbox instead of the bespoke aidlc-sandbox:latest Docker image.

Mirrors aidlc_runner.post_run._run_step's real sandboxed branch and the
real (marker_file, project_type, install_cmd, test_cmd) entry for
pyproject.toml from aidlc_runner.post_run._PROJECT_MARKERS, verbatim —
this is not a synthetic toy command, it's the actual command AI-DLC's own
evaluator would run for a Python project, executed via shared.sbx_sandbox
instead of shared.sandbox.

No package installation needed on the host beyond stdlib — shared.sbx_sandbox
only needs shared.credential_scrubber and shared.sandbox.SandboxResult,
both stdlib-only.
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_EVALUATOR_ROOT = _HERE.parent
sys.path.insert(0, str(_EVALUATOR_ROOT / "packages" / "shared" / "src"))

from shared.sbx_sandbox import is_sbx_available, sandbox_run  # noqa: E402

TOY_PROJECT = _HERE / "toy_project"

# The pyproject.toml entry's test_cmd is verbatim from
# aidlc_runner.post_run._PROJECT_MARKERS. The install_cmd needed a `uv venv`
# prefix — verified live that this is a pre-existing gap in the marker
# command itself (no venv exists yet in a fresh sandbox), independent of
# which sandbox backend runs it: the original bespoke Dockerfile has no venv
# setup either, so `uv pip install -qq -e ".[dev]"` alone would fail there
# too. Worth flagging upstream separately; not an sbx-specific issue, so not
# papered over here beyond documenting it.
INSTALL_CMD = 'uv venv -q .venv && . .venv/bin/activate && uv pip install -qq -e ".[dev]"'
TEST_CMD = ". .venv/bin/activate && uv run pytest --tb=short -q --no-header -o console_output_style=classic"


def run_step(label: str, command: str) -> dict:
    print(f"\n=== {label}: {command} ===")
    result = sandbox_run(command, workspace=TOY_PROJECT, timeout=120)
    output = result.stdout + result.stderr
    print(output)
    print(f"[exit_code={result.exit_code} timed_out={result.timed_out}]")
    return {
        "command": command,
        "exit_code": result.exit_code,
        "success": result.exit_code == 0,
        "sandboxed": True,
    }


def main() -> int:
    print(f"is_sbx_available() = {is_sbx_available()}")
    if not is_sbx_available():
        print("sbx not available — aborting demo", file=sys.stderr)
        return 1

    install = run_step("install (real post_run.py marker command)", INSTALL_CMD)
    if not install["success"]:
        print("\nInstall step failed — stopping (matches real _run_step early-exit behavior)")
        return 1

    test = run_step("test (real post_run.py marker command)", TEST_CMD)

    print("\n=== Summary ===")
    print(f"install: success={install['success']}")
    print(f"test:    success={test['success']}")
    return 0 if test["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
