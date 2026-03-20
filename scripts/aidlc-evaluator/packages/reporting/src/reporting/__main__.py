"""CLI entry point: python -m reporting <command>."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from reporting.baseline import (
    compare_run_to_baseline,
    load_baseline,
    promote,
)
from reporting.collector import collect
from reporting.render_html import write_html
from reporting.render_md import write_markdown


def cmd_generate(args: argparse.Namespace) -> None:
    if not args.run_folder.is_dir():
        print(f"Error: run folder not found: {args.run_folder}", file=sys.stderr)
        sys.exit(1)

    out_dir = args.output_dir or args.run_folder
    out_dir.mkdir(parents=True, exist_ok=True)

    data = collect(args.run_folder)

    if args.baseline and args.baseline.is_file():
        from reporting.baseline import compare, extract_baseline, load_baseline as _lb
        current = extract_baseline(data)
        golden = _lb(args.baseline)
        data.comparison = compare(current, golden)

    if args.format in ("markdown", "both"):
        md_path = out_dir / "report.md"
        write_markdown(data, md_path)
        print(f"  Markdown: {md_path}")

    if args.format in ("html", "both"):
        html_path = out_dir / "report.html"
        write_html(data, html_path)
        print(f"  HTML:     {html_path}")


def cmd_promote(args: argparse.Namespace) -> None:
    if not args.run_folder.is_dir():
        print(f"Error: run folder not found: {args.run_folder}", file=sys.stderr)
        sys.exit(1)

    golden_path = args.output
    baseline = promote(args.run_folder, golden_path)
    run_name = Path(baseline.run_folder).name
    print(f"  Promoted: {run_name}")
    print(f"  Baseline: {golden_path}")
    print(f"  Tests:    {baseline.tests_passed}/{baseline.tests_total}")
    print(f"  Contract: {baseline.contract_passed}/{baseline.contract_total}")
    print(f"  Lint:     {baseline.lint_total} ({baseline.lint_errors} errors)")
    print(f"  Quality:  {baseline.qualitative_score:.4f}")


def cmd_compare(args: argparse.Namespace) -> None:
    if not args.run_folder.is_dir():
        print(f"Error: run folder not found: {args.run_folder}", file=sys.stderr)
        sys.exit(1)
    if not args.baseline.is_file():
        print(f"Error: baseline not found: {args.baseline}", file=sys.stderr)
        sys.exit(1)

    result = compare_run_to_baseline(args.run_folder, args.baseline)

    golden_name = Path(result.golden_run).name if result.golden_run else "unknown"
    print(f"  Baseline:  {golden_name}")
    print(f"  Improved:  {result.improved}")
    print(f"  Regressed: {result.regressed}")
    print(f"  Unchanged: {result.unchanged}")
    print()

    for d in result.deltas:
        if d.direction == "regressed":
            icon = "[-]"
        elif d.direction == "improved":
            icon = "[+]"
        else:
            icon = "[ ]"
        golden_str = f"{d.golden}" if d.golden is not None else "---"
        current_str = f"{d.current}" if d.current is not None else "---"
        print(f"  {icon} {d.name:<20} {golden_str:>12} -> {current_str:>12}  ({d.direction})")

    if result.regressed > 0:
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="reporting",
        description="AIDLC evaluation reporting and baseline management",
    )
    sub = parser.add_subparsers(dest="command")

    # ── generate ───────────────────────────────────────────────
    gen = sub.add_parser("generate", help="Generate consolidated report")
    gen.add_argument("run_folder", type=Path, help="Path to the run folder")
    gen.add_argument(
        "--format", "-f", choices=["markdown", "html", "both"], default="both",
        help="Output format (default: both)",
    )
    gen.add_argument(
        "--output-dir", "-o", type=Path, default=None,
        help="Output directory (default: the run folder)",
    )
    gen.add_argument(
        "--baseline", "-b", type=Path, default=None,
        help="Path to golden.yaml for baseline comparison",
    )

    # ── promote ────────────────────────────────────────────────
    prom = sub.add_parser("promote", help="Promote a run as a golden baseline")
    prom.add_argument("run_folder", type=Path, help="Path to the run folder to promote")
    prom.add_argument(
        "--output", "-o", type=Path, required=True,
        help="Where to write golden.yaml",
    )

    # ── compare ────────────────────────────────────────────────
    comp = sub.add_parser("compare", help="Compare a run against a golden baseline")
    comp.add_argument("run_folder", type=Path, help="Path to the run folder")
    comp.add_argument(
        "--baseline", "-b", type=Path, required=True,
        help="Path to golden.yaml",
    )

    args = parser.parse_args()
    if args.command == "generate":
        cmd_generate(args)
    elif args.command == "promote":
        cmd_promote(args)
    elif args.command == "compare":
        cmd_compare(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
