"""Command-line interface for AI-DLC interactive capability."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from aidlc_interactive.detection import detection_report
from aidlc_interactive.models import InteractionType, ResultStatus
from aidlc_interactive.onboarding import apply_setup, doctor, setup_plan
from aidlc_interactive.service import interact

_CI_ENVIRONMENT_KEYS = (
    "CI",
    "BUILDKITE",
    "CIRCLECI",
    "CODEBUILD_BUILD_ID",
    "CONTINUOUS_INTEGRATION",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "JENKINS_URL",
    "TEAMCITY_VERSION",
    "TF_BUILD",
)


def _is_ci() -> bool:
    return any(os.environ.get(key) for key in _CI_ENVIRONMENT_KEYS)


def _emit(value: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(value, indent=2, sort_keys=True))
        return
    for key, item in value.items():
        print(f"{key}: {item}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aidlc-interactive",
        description="Agent-agnostic interactive questionnaires and reviews for AI-DLC",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    detect = subparsers.add_parser("detect", help="Detect supported agents and providers")
    detect.add_argument("--json", action="store_true")

    diagnostics = subparsers.add_parser("doctor", help="Validate configuration and availability")
    diagnostics.add_argument("--workspace", type=Path, default=Path.cwd())
    diagnostics.add_argument("--json", action="store_true")

    setup = subparsers.add_parser("setup", help="Configure provider and install agent skills")
    setup.add_argument("--workspace", type=Path, default=Path.cwd())
    setup.add_argument(
        "--agents",
        nargs="+",
        choices=("kiro", "claude-code", "codex"),
        default=["kiro", "claude-code", "codex"],
    )
    setup.add_argument("--provider", default="plannotator")
    setup.add_argument("--dry-run", action="store_true")
    setup.add_argument("--yes", action="store_true", help="Confirm the displayed writes")
    setup.add_argument("--json", action="store_true")

    for command, interaction_type in (
        ("questionnaire", InteractionType.QUESTIONNAIRE),
        ("review", InteractionType.REVIEW),
    ):
        operation = subparsers.add_parser(command, help=f"Open an interactive {command}")
        operation.set_defaults(interaction_type=interaction_type)
        operation.add_argument("--workspace", type=Path, required=True)
        operation.add_argument("--artifact", type=Path, required=True)
        operation.add_argument("--json", action="store_true")
        operation.add_argument(
            "--allow-non-tty",
            action="store_true",
            help="Allow provider invocation when stdin/stdout are not terminals",
        )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "detect":
            _emit(detection_report(), args.json)
            return 0
        if args.command == "doctor":
            report = doctor(args.workspace)
            _emit(report, args.json)
            return 0 if report["healthy"] else 1
        if args.command == "setup":
            plan = setup_plan(args.workspace, args.agents, args.provider)
            if args.dry_run:
                _emit({**plan, "applied": False}, args.json)
                return 0
            if not args.yes:
                _emit({**plan, "applied": False, "confirmation_required": True}, args.json)
                if not sys.stdin.isatty():
                    return 2
                answer = input("Apply these changes? [y/N] ").strip().casefold()
                if answer not in {"y", "yes"}:
                    return 2
            _emit(apply_setup(args.workspace, args.agents, args.provider), args.json)
            return 0
        if _is_ci():
            interactive_session = False
        elif args.allow_non_tty:
            interactive_session = True
        else:
            interactive_session = None
        result = interact(
            args.workspace,
            args.artifact,
            args.interaction_type,
            interactive_session=interactive_session,
        )
        _emit(result.to_dict(), args.json)
        if result.status is ResultStatus.COMPLETED:
            return 0
        if result.status is ResultStatus.FALLBACK_REQUIRED:
            return 2
        return 1
    except (FileExistsError, OSError, UnicodeError, ValueError) as exc:
        _emit(
            {
                "schema_version": 1,
                "status": "failed",
                "reason_code": type(exc).__name__,
                "message": str(exc),
            },
            getattr(args, "json", False),
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
