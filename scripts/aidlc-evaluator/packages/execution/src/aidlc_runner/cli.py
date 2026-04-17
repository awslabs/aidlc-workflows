"""Command-line interface for AIDLC Runner."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from aidlc_runner.config import default_config_path, load_config
from aidlc_runner.runner import run


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aidlc-runner",
        description="Run the AIDLC workflow with two Strands agents (executor + human simulator).",
    )
    parser.add_argument(
        "--vision",
        required=True,
        type=Path,
        help="Path to the vision/constraints markdown file.",
    )
    parser.add_argument(
        "--tech-env",
        type=Path,
        default=None,
        help="Path to the technical environment markdown file (optional).",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to YAML config file. Defaults to bundled config/default.yaml.",
    )
    parser.add_argument(
        "--aws-profile",
        default=None,
        help="Override AWS profile name.",
    )
    parser.add_argument(
        "--aws-region",
        default=None,
        help="Override AWS region.",
    )
    parser.add_argument(
        "--executor-model",
        default=None,
        help="Override model ID for the AIDLC executor agent.",
    )
    parser.add_argument(
        "--simulator-model",
        default=None,
        help="Override model ID for the human simulator agent.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Override run output directory.",
    )
    parser.add_argument(
        "--rules-path",
        type=Path,
        default=None,
        help="Path to local AIDLC rules directory (overrides git clone).",
    )
    parser.add_argument(
        "--rules-ref",
        default=None,
        help="Git ref (branch/tag/commit) for AIDLC rules repo.",
    )
    parser.add_argument(
        "--no-exec",
        action="store_true",
        default=False,
        help="Disable in-workflow command execution (run_command tool not available).",
    )
    parser.add_argument(
        "--no-post-tests",
        action="store_true",
        default=False,
        help="Disable post-run test execution.",
    )
    return parser


def _build_cli_overrides(args: argparse.Namespace) -> dict:
    """Convert parsed CLI args into a nested dict for config merging."""
    overrides: dict = {}

    if args.aws_profile is not None:
        overrides.setdefault("aws", {})["profile"] = args.aws_profile
    if args.aws_region is not None:
        overrides.setdefault("aws", {})["region"] = args.aws_region

    if args.executor_model is not None:
        overrides.setdefault("models", {}).setdefault("executor", {})[
            "model_id"
        ] = args.executor_model
    if args.simulator_model is not None:
        overrides.setdefault("models", {}).setdefault("simulator", {})[
            "model_id"
        ] = args.simulator_model

    if args.output_dir is not None:
        overrides.setdefault("runs", {})["output_dir"] = str(args.output_dir)

    if args.rules_path is not None:
        overrides.setdefault("aidlc", {})["rules_source"] = "local"
        overrides["aidlc"]["rules_local_path"] = str(args.rules_path)

    if args.rules_ref is not None:
        overrides.setdefault("aidlc", {})["rules_ref"] = args.rules_ref

    if args.no_exec:
        overrides.setdefault("execution", {})["enabled"] = False
    if args.no_post_tests:
        overrides.setdefault("execution", {})["post_run_tests"] = False

    return overrides


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    # Validate vision file exists
    if not args.vision.exists():
        print(f"Error: Vision file not found: {args.vision}", file=sys.stderr)
        sys.exit(1)

    # Validate tech-env file exists if provided
    if args.tech_env is not None and not args.tech_env.exists():
        print(f"Error: Technical environment file not found: {args.tech_env}", file=sys.stderr)
        sys.exit(1)

    # Resolve config path
    config_path = args.config if args.config else default_config_path()

    # Load config with CLI overrides
    cli_overrides = _build_cli_overrides(args)
    config = load_config(config_path=config_path, cli_overrides=cli_overrides)

    # Run the workflow
    run(config=config, vision_path=args.vision, tech_env_path=args.tech_env)
