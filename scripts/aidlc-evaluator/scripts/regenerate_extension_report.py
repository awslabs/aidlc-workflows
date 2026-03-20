#!/usr/bin/env python3
"""Regenerate extension comparison report from completed extension test runs."""

import argparse
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent

# Add packages to path
sys.path.insert(0, str(REPO_ROOT / "packages" / "shared" / "src"))
sys.path.insert(0, str(REPO_ROOT / "packages" / "reporting" / "src"))

from reporting.baseline import BaselineMetrics, extract_baseline  # noqa: E402
from reporting.collector import collect  # noqa: E402


def load_config_metrics(run_folder: Path) -> BaselineMetrics | None:
    """Load evaluation metrics from an extension test run folder."""
    try:
        data = collect(run_folder)
        return extract_baseline(data)
    except Exception as e:
        print(f"  [WARN] Failed to collect metrics from {run_folder}: {e}", file=sys.stderr)
        return None


def format_num(val: float | int | None, decimals: int = 1) -> str:
    """Format a number for display."""
    if val is None:
        return "—"
    if isinstance(val, float):
        return f"{val:.{decimals}f}"
    return str(val)


def main():
    parser = argparse.ArgumentParser(
        description="Regenerate extension comparison report from completed runs"
    )
    parser.add_argument(
        "--runs-dir",
        type=Path,
        required=True,
        help="Extension test runs directory (e.g., runs/sci-calc/extension-test/)",
    )
    args = parser.parse_args()

    comparison_dir = args.runs_dir / "extension-comparison"
    summary_path = comparison_dir / "extension-test-summary.yaml"

    if not summary_path.exists():
        print(f"Error: {summary_path} not found", file=sys.stderr)
        print("Make sure you're pointing to the extension test runs directory", file=sys.stderr)
        sys.exit(1)

    # Load existing summary
    with open(summary_path, encoding="utf-8") as f:
        summary = yaml.safe_load(f)

    results = summary.get("runs", [])
    scenario_name = summary.get("scenario", "unknown")

    print(f"Found {len(results)} extension test runs")

    # Load metrics from each run (regardless of status - we want to compare quality)
    config_metrics: dict[str, BaselineMetrics] = {}
    for result in results:
        run_folder = Path(result["output_dir"])
        if not run_folder.is_dir():
            print(f"  Skipping {result['config_name']} (folder not found)")
            continue
        print(f"  Loading metrics: {result['config_name']} (status: {result['status']})...")
        metrics = load_config_metrics(run_folder)
        if metrics:
            config_metrics[result["config_name"]] = metrics
        else:
            print(f"    Failed to load metrics for {result['config_name']}")

    if not config_metrics:
        print("No metrics loaded, cannot generate report", file=sys.stderr)
        sys.exit(1)

    # Generate detailed metrics comparison report
    report_lines = [
        "# Extension Hook Test Report",
        "",
        f"**Scenario:** {scenario_name}",
        f"**Generated:** {summary.get('generated_at', 'unknown')}",
        f"**Regenerated:** {yaml.safe_dump({'now': None}).split(':')[1].strip()}",
        "",
        "## Test Configurations",
        "",
    ]

    # Configuration summary
    for result in results:
        status_icon = "✅" if result["status"] == "success" else "❌"
        report_lines.extend(
            [
                f"### {status_icon} {result['config_display_name']}",
                "",
                f"- **Config ID:** `{result['config_name']}`",
                f"- **Description:** {result['config_description']}",
                f"- **Status:** {result['status'].upper()}",
                f"- **Duration:** {result.get('elapsed_seconds', 0) / 60:.1f} minutes",
                f"- **Output:** `{result['output_dir']}`",
                "",
            ]
        )

    # Detailed metrics comparison
    if config_metrics:
        report_lines.extend(
            [
                "",
                "## Detailed Metrics Comparison",
                "",
            ]
        )

        # Build columns (sorted by config name)
        columns = sorted(config_metrics.items())

        # Header
        header = "| Metric |"
        separator = "|--------|"
        for config_name, _ in columns:
            header += f" {config_name} |"
            separator += "---------|"
        report_lines.append(header)
        report_lines.append(separator)

        # Metric rows
        metric_rows: list[tuple[str, str, bool]] = [
            ("**Unit Tests**", "", True),
            ("Pass %", "tests_pass_pct", True),
            ("Passed", "tests_passed", True),
            ("Failed", "tests_failed", False),
            ("Total", "tests_total", True),
            ("Coverage %", "coverage_pct", True),
            ("**Contract Tests**", "", True),
            ("Passed", "contract_passed", True),
            ("Failed", "contract_failed", False),
            ("Total", "contract_total", True),
            ("**Code Quality**", "", True),
            ("Lint Errors", "lint_errors", False),
            ("Lint Warnings", "lint_warnings", False),
            ("Lint Total", "lint_total", False),
            ("Security Findings", "security_total", False),
            ("Security High", "security_high", False),
            ("Duplication Blocks", "duplication_blocks", False),
            ("**Qualitative**", "", True),
            ("Overall Score", "qualitative_score", True),
            ("Inception Score", "inception_score", True),
            ("Construction Score", "construction_score", True),
            ("**Artifacts**", "", True),
            ("Source Files", "source_files", True),
            ("Test Files", "test_files", True),
            ("Total Files", "total_files", True),
            ("Lines of Code", "lines_of_code", True),
            ("Doc Files", "doc_files", True),
            ("**Execution**", "", True),
            ("Total Tokens", "total_tokens", False),
            ("Executor Tokens", "executor_total_tokens", False),
            ("Simulator Tokens", "simulator_total_tokens", False),
            ("Wall Clock (min)", "wall_clock_min", False),
            ("Handoffs", "handoffs", False),
            ("**Context Size**", "", True),
            ("Max Tokens", "context_size_max", False),
            ("Avg Tokens", "context_size_avg", False),
            ("Median Tokens", "context_size_median", False),
        ]

        for display_name, attr, higher_is_better in metric_rows:
            if not attr:
                # Section header row
                row = f"| {display_name} |"
                for _ in columns:
                    row += " |"
                report_lines.append(row)
                continue

            row = f"| {display_name} |"
            for config_name, metrics in columns:
                if attr == "wall_clock_min":
                    val = (
                        metrics.wall_clock_ms / 60000 if metrics.wall_clock_ms else None
                    )
                else:
                    val = getattr(metrics, attr, None)
                row += f" {format_num(val)} |"
            report_lines.append(row)

        report_lines.append("")

    # Next steps
    report_lines.extend(
        [
            "",
            "## Next Steps",
            "",
            "1. Review the individual run reports in each output directory",
            "2. Compare qualitative scores between configurations",
            "3. Examine differences in generated artifacts",
            "4. Analyze the impact of extension opt-ins on output quality",
            "",
        ]
    )

    report_path = comparison_dir / "extension-test-report.md"
    report_path.write_text("\n".join(report_lines), encoding="utf-8")
    print(f"\n✅ Extension test report regenerated: {report_path}")


if __name__ == "__main__":
    main()
