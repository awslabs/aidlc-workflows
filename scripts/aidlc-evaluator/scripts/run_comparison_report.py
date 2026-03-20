#!/usr/bin/env python3
"""Cross-model comparison report — aggregate results from batch runs and golden baseline.

Scans model-specific run directories, loads their evaluation metrics, and produces
a comparison matrix in both Markdown and YAML formats.

Usage:
    # Compare all model runs found under runs/
    python run_comparison_report.py

    # Specify runs directory and baseline
    python run_comparison_report.py --runs-dir ./runs --baseline test_cases/sci-calc/golden.yaml

    # Compare specific models
    python run_comparison_report.py --models nova-pro,sonnet-4-5
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
TEST_CASES_DIR = REPO_ROOT / "test_cases"

# Add reporting and shared packages to path
sys.path.insert(0, str(REPO_ROOT / "packages" / "reporting" / "src"))
sys.path.insert(0, str(REPO_ROOT / "packages" / "shared" / "src"))

from reporting.baseline import BaselineMetrics, load_baseline  # noqa: E402
from reporting.collector import collect  # noqa: E402
from reporting.baseline import extract_baseline  # noqa: E402
from shared.scenario import resolve_scenario  # noqa: E402


def _extract_model_suffix(dirname: str) -> str | None:
    """Extract the model name suffix from a batch run folder name.

    Batch folders are named <timestamp>-<rules_slug>-<model>, e.g.
    '20260225T190020-aidlc-workflows_main-nova-pro'.  The model suffix
    is everything after the rules slug, which itself follows the first
    timestamp segment.  We match known config stems against the end of
    the directory name.
    """
    config_dir = Path(__file__).resolve().parent.parent / "config"
    if config_dir.is_dir():
        # Try longest names first so "mistral-large-3" matches before "large-3"
        stems = sorted(
            (p.stem for p in config_dir.glob("*.yaml") if p.stem != "default"),
            key=len, reverse=True,
        )
        for stem in stems:
            if dirname.endswith(f"-{stem}"):
                return stem
    return None


def find_model_runs(runs_dir: Path) -> dict[str, Path]:
    """Find model-specific run directories.

    Supports three layouts:
    - runs/<timestamp>-<slug>-<model>/  (batch runner output, current)
    - runs/<model-name>/  (legacy batch runner or direct --output-dir)
    - runs/<model-name>/<timestamp-uuid>/  (legacy nested batch output)
    """
    models = {}
    if not runs_dir.is_dir():
        return models

    for entry in sorted(runs_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue

        # Current format: timestamped dir with model suffix
        if entry.name[0:1].isdigit() and (entry / "run-meta.yaml").is_file():
            model = _extract_model_suffix(entry.name)
            if model:
                # Keep the most recent run per model (sorted order = latest last)
                models[model] = entry
                continue

        # Legacy: direct output with run-meta.yaml
        if (entry / "run-meta.yaml").is_file():
            models[entry.name] = entry
            continue

        # Legacy: nested timestamped subdirectories
        sub_runs = sorted(
            (d for d in entry.iterdir() if d.is_dir() and (d / "run-meta.yaml").is_file()),
            reverse=True,
        )
        if sub_runs:
            models[entry.name] = sub_runs[0]

    return models


def load_model_metrics(run_folder: Path) -> BaselineMetrics | None:
    """Load evaluation metrics from a run folder."""
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


def generate_comparison_markdown(
    model_metrics: dict[str, BaselineMetrics],
    golden: BaselineMetrics | None,
) -> str:
    """Generate a Markdown comparison matrix."""
    lines: list[str] = []
    lines.append("# Cross-Model Comparison Report")
    lines.append("")
    lines.append(f"Generated: {datetime.now(UTC).isoformat(timespec='seconds')}")
    lines.append("")

    # Build column list: golden first (if present), then alphabetical models
    columns: list[tuple[str, BaselineMetrics]] = []
    if golden:
        golden_label = f"Golden ({golden.executor_model.split('.')[-1]})" if golden.executor_model else "Golden"
        columns.append((golden_label, golden))
    for name in sorted(model_metrics.keys()):
        columns.append((name, model_metrics[name]))

    if not columns:
        lines.append("No model runs found.")
        return "\n".join(lines)

    # Header
    header = "| Metric |"
    separator = "|--------|"
    for col_name, _ in columns:
        header += f" {col_name} |"
        separator += "--------|"
    lines.append(header)
    lines.append(separator)

    # Metric rows
    metric_rows: list[tuple[str, str, str, bool]] = [
        # (display_name, category, attr_name, higher_is_better)
        ("**Unit Tests**", "", "", True),
        ("Pass %", "unit", "tests_pass_pct", True),
        ("Passed", "unit", "tests_passed", True),
        ("Failed", "unit", "tests_failed", False),
        ("Total", "unit", "tests_total", True),
        ("Coverage %", "unit", "coverage_pct", True),
        ("**Contract Tests**", "", "", True),
        ("Passed", "contract", "contract_passed", True),
        ("Failed", "contract", "contract_failed", False),
        ("Total", "contract", "contract_total", True),
        ("**Code Quality**", "", "", True),
        ("Lint Errors", "quality", "lint_errors", False),
        ("Lint Warnings", "quality", "lint_warnings", False),
        ("Lint Total", "quality", "lint_total", False),
        ("Security Findings", "quality", "security_total", False),
        ("Security High", "quality", "security_high", False),
        ("Duplication Blocks", "quality", "duplication_blocks", False),
        ("**Qualitative**", "", "", True),
        ("Overall Score", "qual", "qualitative_score", True),
        ("Inception Score", "qual", "inception_score", True),
        ("Construction Score", "qual", "construction_score", True),
        ("**Artifacts**", "", "", True),
        ("Source Files", "art", "source_files", True),
        ("Test Files", "art", "test_files", True),
        ("Total Files", "art", "total_files", True),
        ("Lines of Code", "art", "lines_of_code", True),
        ("Doc Files", "art", "doc_files", True),
        ("**Execution**", "", "", True),
        ("Total Tokens", "exec", "total_tokens", False),
        ("Executor Tokens", "exec", "executor_total_tokens", False),
        ("Simulator Tokens", "exec", "simulator_total_tokens", False),
        ("Wall Clock (min)", "exec", "wall_clock_min", False),
        ("Handoffs", "exec", "handoffs", False),
        ("**Context Size**", "", "", True),
        ("Max Tokens", "ctx", "context_size_max", False),
        ("Avg Tokens", "ctx", "context_size_avg", False),
        ("Median Tokens", "ctx", "context_size_median", False),
    ]

    for display_name, category, attr, higher_is_better in metric_rows:
        if not attr:
            # Section header row
            row = f"| {display_name} |"
            for _ in columns:
                row += " |"
            lines.append(row)
            continue

        row = f"| {display_name} |"
        golden_val = None
        if golden and attr != "wall_clock_min":
            golden_val = getattr(golden, attr, None)
        elif golden and attr == "wall_clock_min":
            golden_val = golden.wall_clock_ms / 60000 if golden.wall_clock_ms else None

        for col_name, metrics in columns:
            if attr == "wall_clock_min":
                val = metrics.wall_clock_ms / 60000 if metrics.wall_clock_ms else None
            else:
                val = getattr(metrics, attr, None)

            formatted = format_num(val)

            # Add delta indicator vs golden (skip for golden column itself)
            if golden and col_name != "Golden (Opus 4.6)" and val is not None and golden_val is not None:
                delta = float(val) - float(golden_val)
                if abs(delta) > 0.001:
                    if higher_is_better:
                        indicator = " ^" if delta > 0 else " v"
                    else:
                        indicator = " v" if delta > 0 else " ^"
                    formatted += indicator

            row += f" {formatted} |"
        lines.append(row)

    # Legend
    lines.append("")
    lines.append("**Legend:** ^ = better than golden, v = worse than golden")
    lines.append("")

    return "\n".join(lines)


def generate_comparison_yaml(
    model_metrics: dict[str, BaselineMetrics],
    golden: BaselineMetrics | None,
) -> dict:
    """Generate structured YAML comparison data."""
    result: dict = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "models": {},
    }

    if golden:
        result["golden"] = {
            "executor_model": golden.executor_model,
            "run_folder": golden.run_folder,
        }

    for name, metrics in sorted(model_metrics.items()):
        result["models"][name] = {
            "executor_model": metrics.executor_model,
            "simulator_model": metrics.simulator_model,
            "run_folder": metrics.run_folder,
            "unit_tests": {
                "passed": metrics.tests_passed,
                "failed": metrics.tests_failed,
                "total": metrics.tests_total,
                "pass_pct": metrics.tests_pass_pct,
                "coverage_pct": metrics.coverage_pct,
            },
            "contract_tests": {
                "passed": metrics.contract_passed,
                "failed": metrics.contract_failed,
                "total": metrics.contract_total,
            },
            "code_quality": {
                "lint_errors": metrics.lint_errors,
                "lint_warnings": metrics.lint_warnings,
                "lint_total": metrics.lint_total,
                "security_total": metrics.security_total,
                "security_high": metrics.security_high,
                "duplication_blocks": metrics.duplication_blocks,
            },
            "qualitative": {
                "overall_score": metrics.qualitative_score,
                "inception_score": metrics.inception_score,
                "construction_score": metrics.construction_score,
            },
            "artifacts": {
                "source_files": metrics.source_files,
                "test_files": metrics.test_files,
                "total_files": metrics.total_files,
                "lines_of_code": metrics.lines_of_code,
                "doc_files": metrics.doc_files,
            },
            "execution": {
                "total_tokens": metrics.total_tokens,
                "input_tokens": metrics.input_tokens,
                "output_tokens": metrics.output_tokens,
                "executor_total_tokens": metrics.executor_total_tokens,
                "simulator_total_tokens": metrics.simulator_total_tokens,
                "wall_clock_ms": metrics.wall_clock_ms,
                "handoffs": metrics.handoffs,
            },
            "context_size": {
                "max_tokens": metrics.context_size_max,
                "avg_tokens": metrics.context_size_avg,
                "median_tokens": metrics.context_size_median,
            },
        }

    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="run_comparison_report",
        description="Generate cross-model comparison report from batch evaluation runs",
    )
    parser.add_argument(
        "--scenario", type=str, default="sci-calc",
        help="Scenario name or path to test case directory (default: sci-calc)",
    )
    parser.add_argument(
        "--runs-dir", type=Path, default=None,
        help="Directory containing model run folders (default: runs/<scenario>/)",
    )
    parser.add_argument(
        "--baseline", type=Path, default=None,
        help="Path to golden.yaml baseline (default: from scenario)",
    )
    parser.add_argument(
        "--models", type=str, default=None,
        help="Comma-separated model names to include (default: all found)",
    )
    parser.add_argument(
        "--output", type=Path, default=None,
        help="Output directory for reports (default: <runs-dir>/comparison/)",
    )

    args = parser.parse_args()

    # Resolve scenario and apply defaults
    scenario = resolve_scenario(args.scenario, TEST_CASES_DIR)
    if args.runs_dir is None:
        args.runs_dir = REPO_ROOT / "runs" / scenario.name
    if args.baseline is None:
        args.baseline = scenario.golden_baseline_path

    # Load golden baseline
    golden: BaselineMetrics | None = None
    if args.baseline and args.baseline.is_file():
        golden = load_baseline(args.baseline)
        print(f"Loaded golden baseline: {args.baseline}")
        print(f"  Model: {golden.executor_model}")
    else:
        print("No golden baseline found — comparison will be model-to-model only.")

    # Discover model runs
    all_runs = find_model_runs(args.runs_dir)
    if not all_runs:
        print(f"No model runs found in {args.runs_dir}")
        sys.exit(1)

    # Filter to selected models
    if args.models:
        selected = {m.strip() for m in args.models.split(",")}
        runs = {k: v for k, v in all_runs.items() if k in selected}
        missing = selected - set(runs.keys())
        if missing:
            print(f"Warning: runs not found for: {', '.join(missing)}", file=sys.stderr)
    else:
        runs = all_runs

    print(f"\nFound {len(runs)} model run(s):")
    for name, path in runs.items():
        print(f"  {name:20s}  {path}")

    # Collect metrics from each run
    model_metrics: dict[str, BaselineMetrics] = {}
    for name, run_folder in runs.items():
        print(f"\nCollecting metrics: {name}...")
        metrics = load_model_metrics(run_folder)
        if metrics:
            model_metrics[name] = metrics
        else:
            print(f"  [SKIP] Could not load metrics for {name}")

    if not model_metrics:
        print("No valid model metrics collected.")
        sys.exit(1)

    # Generate reports
    output_dir = args.output or args.runs_dir / "comparison"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Markdown report
    md_content = generate_comparison_markdown(model_metrics, golden)
    md_path = output_dir / "comparison-report.md"
    md_path.write_text(md_content, encoding="utf-8")
    print(f"\nMarkdown report: {md_path}")

    # YAML data
    yaml_data = generate_comparison_yaml(model_metrics, golden)
    yaml_path = output_dir / "comparison-data.yaml"
    with open(yaml_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(yaml_data, f, default_flow_style=False, sort_keys=False)
    print(f"YAML data: {yaml_path}")

    # Print summary to stdout
    print(f"\n{md_content}")


if __name__ == "__main__":
    main()
