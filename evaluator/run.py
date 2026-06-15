#!/usr/bin/env python3
"""Master run script for AIDLC evaluation framework.

This is the main entry point for running AIDLC evaluations in various modes.
It dispatches to specialized runner scripts in the scripts/ directory.

Available modes:
  - full       Full evaluation (execute workflow + score outputs)
  - cli        Evaluation through a CLI AI assistant (kiro-cli, claude-code, etc.)
  - ide        Evaluation through an IDE AI assistant (cursor, cline, kiro)
  - batch      Batch evaluation across multiple models
  - compare    Generate cross-model comparison report
  - ext-test   Test extension hooks with different opt-in configurations
  - ext-report Regenerate extension test comparison report
  - trend      Generate trend report across AIDLC rules releases
  - test       Run unit tests for all packages

Usage:
    # Full pipeline evaluation
    python run.py full --vision test_cases/sci-calc/vision.md

    # CLI evaluation
    python run.py cli --cli kiro-cli --scenario sci-calc

    # IDE evaluation
    python run.py ide --ide cursor --scenario sci-calc

    # Batch evaluation across models
    python run.py batch --models all --scenario sci-calc

    # Generate comparison report
    python run.py compare --scenario sci-calc

    # Test extension hooks (all yes vs all no)
    python run.py ext-test --scenario sci-calc

    # Regenerate extension comparison report
    python run.py ext-report --runs-dir runs/sci-calc/extension-test

    # Generate trend report across releases
    python run.py trend --baseline test_cases/sci-calc/golden.yaml

    # Run tests
    python run.py test

    # Get help for a specific mode
    python run.py full --help
    python run.py cli --help
    python run.py ext-test --help
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = REPO_ROOT / "scripts"


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="run.py",
        description="AIDLC Evaluation Framework — unified entry point",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    subparsers = parser.add_subparsers(
        dest="mode",
        title="evaluation modes",
        description="Choose an evaluation mode to run",
        help="Mode-specific help available via: python run.py <mode> --help",
    )

    # Full evaluation mode
    subparsers.add_parser(
        "full",
        help="Full evaluation: execute AIDLC workflow + score outputs",
        add_help=False,
    )

    # CLI evaluation mode
    subparsers.add_parser(
        "cli",
        help="Evaluation through CLI AI assistants (kiro-cli, claude-code, etc.)",
        add_help=False,
    )

    # IDE evaluation mode
    subparsers.add_parser(
        "ide",
        help="Evaluation through IDE AI assistants (cursor, cline, kiro)",
        add_help=False,
    )

    # Batch evaluation mode
    subparsers.add_parser(
        "batch",
        help="Batch evaluation across multiple Bedrock models",
        add_help=False,
    )

    # Comparison report mode
    subparsers.add_parser(
        "compare",
        help="Generate cross-model comparison report from batch runs",
        add_help=False,
    )

    # Extension test mode
    subparsers.add_parser(
        "ext-test",
        help="Test extension hooks with different opt-in configurations",
        add_help=False,
    )

    # Extension report regeneration mode
    subparsers.add_parser(
        "ext-report",
        help="Regenerate extension test comparison report from completed runs",
        add_help=False,
    )

    # Trend report mode
    subparsers.add_parser(
        "trend",
        help="Generate trend report across AIDLC rules releases",
        add_help=False,
    )

    # Test mode
    subparsers.add_parser(
        "test",
        help="Run unit tests for all packages",
        add_help=False,
    )

    # Parse just the mode, then delegate to the appropriate script
    args, remaining = parser.parse_known_args()

    if not args.mode:
        parser.print_help()
        sys.exit(1)

    # Map modes to scripts
    mode_to_script = {
        "full": SCRIPTS_DIR / "run_evaluation.py",
        "cli": SCRIPTS_DIR / "run_cli_evaluation.py",
        "ide": SCRIPTS_DIR / "run_ide_evaluation.py",
        "batch": SCRIPTS_DIR / "run_batch_evaluation.py",
        "compare": SCRIPTS_DIR / "run_comparison_report.py",
        "ext-test": SCRIPTS_DIR / "run_extension_test.py",
        "ext-report": SCRIPTS_DIR / "regenerate_extension_report.py",
        "trend": SCRIPTS_DIR / "run_trend_report.py",
        "test": SCRIPTS_DIR / "run_evaluation.py",  # test mode is in run_evaluation.py
    }

    script = mode_to_script[args.mode]

    if not script.exists():
        print(f"Error: script not found: {script}", file=sys.stderr)
        sys.exit(1)

    # Build command to delegate to the specific script
    cmd = [sys.executable, str(script)]

    # For test mode, add --test flag
    if args.mode == "test":
        cmd.append("--test")

    # Forward all remaining arguments
    cmd.extend(remaining)

    # Execute the script
    try:
        # nosec B603 - Executing trusted framework scripts from scripts/ directory
        # nosemgrep: dangerous-subprocess-use-audit
        result = subprocess.run(cmd)
        sys.exit(result.returncode)
    except KeyboardInterrupt:
        print("\n[Interrupted]", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"Error running {script.name}: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
