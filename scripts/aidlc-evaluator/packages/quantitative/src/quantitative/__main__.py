"""CLI entry point: python -m quantitative analyze <workspace>."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from quantitative.scanner import print_report, scan_workspace, write_report


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="quantitative",
        description="Run lint and security analysis on generated code",
    )
    sub = parser.add_subparsers(dest="command")

    analyze = sub.add_parser("analyze", help="Analyze a workspace directory")
    analyze.add_argument("workspace", type=Path, help="Path to workspace directory")
    analyze.add_argument(
        "--output", "-o", type=Path, default=None,
        help="Write quality-report.yaml to this path",
    )
    analyze.add_argument(
        "--pmd-path", type=str, default=None,
        help="Path to PMD executable for duplication analysis (default: search PATH)",
    )

    args = parser.parse_args()
    if args.command != "analyze":
        parser.print_help()
        sys.exit(1)

    if not args.workspace.is_dir():
        print(f"Error: workspace not found: {args.workspace}", file=sys.stderr)
        sys.exit(1)

    report = scan_workspace(args.workspace, pmd_path=args.pmd_path)
    if report is None:
        print("No recognizable project found in workspace.", file=sys.stderr)
        sys.exit(1)

    print_report(report)
    if args.output:
        write_report(report, args.output)
        print(f"\nResults written to: {args.output}")


if __name__ == "__main__":
    main()
