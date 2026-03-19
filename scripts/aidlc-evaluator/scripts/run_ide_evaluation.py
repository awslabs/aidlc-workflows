#!/usr/bin/env python3
"""Run AIDLC evaluation through an IDE adapter.

Usage:
    # List available adapters
    python run_ide_evaluation.py --list

    # Run evaluation through Cursor
    python run_ide_evaluation.py --ide cursor \
        --vision test_cases/sci-calc/vision.md \
        --golden test_cases/sci-calc/golden-aidlc-docs

    # Check prerequisites for an IDE
    python run_ide_evaluation.py --ide kiro --check-only
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGES = REPO_ROOT / "packages"
TEST_CASES_DIR = REPO_ROOT / "test_cases"

# Add ide-harness and shared packages to path
sys.path.insert(0, str(PACKAGES / "ide-harness" / "src"))
sys.path.insert(0, str(PACKAGES / "shared" / "src"))

from ide_harness.registry import get_adapter, list_adapters  # noqa: E402
from ide_harness.orchestrator import run_ide_evaluation  # noqa: E402
from shared.scenario import resolve_scenario  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="run_ide_evaluation",
        description="Run AIDLC evaluation through an IDE AI assistant",
    )
    parser.add_argument(
        "--ide", type=str,
        help="IDE adapter name (e.g., cursor, cline, kiro)",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List available IDE adapters and exit",
    )
    parser.add_argument(
        "--check-only", action="store_true",
        help="Only check IDE prerequisites, don't run evaluation",
    )
    parser.add_argument(
        "--scenario", type=str, default="sci-calc",
        help="Scenario name or path to test case directory (default: sci-calc)",
    )
    parser.add_argument("--vision", type=Path, default=None)
    parser.add_argument("--tech-env", type=Path, default=None)
    parser.add_argument("--golden", type=Path, default=None)
    parser.add_argument("--openapi", type=Path, default=None)
    parser.add_argument("--baseline", type=Path, default=None)
    parser.add_argument("--rules", type=Path, default=None, help="Path to AIDLC rules directory")
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--profile", default=None, help="AWS profile (default: from config YAML)")
    parser.add_argument("--region", default=None, help="AWS region (default: from config YAML)")
    parser.add_argument("--scorer-model", default="us.anthropic.claude-sonnet-4-5-20250929-v1:0")

    # Sandbox
    sandbox_group = parser.add_mutually_exclusive_group()
    sandbox_group.add_argument(
        "--sandbox", action="store_true", default=True,
        help="Run generated code in a Docker sandbox (default)",
    )
    sandbox_group.add_argument(
        "--no-sandbox", action="store_false", dest="sandbox",
        help="Run generated code directly on the host (no isolation)",
    )

    args = parser.parse_args()

    if args.list:
        print("Available IDE adapters:")
        for name in list_adapters():
            try:
                adapter = get_adapter(name)
                ok, msg = adapter.check_prerequisites()
                status = "ready" if ok else "not ready"
                print(f"  {name:15s}  [{status}] {msg}")
            except Exception as e:
                print(f"  {name:15s}  [error] {e}")
        sys.exit(0)

    if not args.ide:
        parser.error("--ide is required (use --list to see available adapters)")

    adapter = get_adapter(args.ide)

    if args.check_only:
        ok, msg = adapter.check_prerequisites()
        print(f"{adapter.name}: {'OK' if ok else 'FAIL'} — {msg}")
        sys.exit(0 if ok else 1)

    # Resolve scenario and apply defaults
    scenario = resolve_scenario(args.scenario, TEST_CASES_DIR)
    if args.vision is None:
        args.vision = scenario.vision_path
    if args.tech_env is None:
        args.tech_env = scenario.tech_env_path
    if args.golden is None:
        args.golden = scenario.golden_aidlc_docs_path
    if args.openapi is None:
        args.openapi = scenario.openapi_path
    if args.baseline is None:
        candidate = scenario.golden_baseline_path
        if candidate.is_file():
            args.baseline = candidate

    output_dir = args.output_dir or REPO_ROOT / "runs" / scenario.name / f"ide-{args.ide.lower()}"
    rules_path = args.rules or REPO_ROOT / "aidlc-rules"

    result, eval_rc = run_ide_evaluation(
        adapter=adapter,
        vision_path=args.vision,
        output_dir=output_dir,
        golden_docs=args.golden,
        rules_path=rules_path,
        tech_env_path=args.tech_env,
        openapi_path=args.openapi,
        baseline_path=args.baseline,
        profile=args.profile,
        region=args.region,
        scorer_model=args.scorer_model,
        use_sandbox=args.sandbox,
    )

    if not result.success:
        print(f"\n[FAILED] {adapter.name}: {result.error}")
        sys.exit(1)

    print(f"\n[DONE] {adapter.name} evaluation complete.")
    print(f"  Output: {result.output_dir}")
    sys.exit(eval_rc)


if __name__ == "__main__":
    main()
