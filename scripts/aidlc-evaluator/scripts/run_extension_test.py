#!/usr/bin/env python3
"""Extension Hook Test Runner — test AIDLC evaluations with different extension opt-in configurations.

This script tests the progressive loading of AIDLC rules extensions by running
evaluations with different opt-in answers. It runs multiple evaluations and
generates a comparison report showing the impact of different extension configurations.

The extension hook feature (feat/extension_hook_question_split branch) adds opt-in
questions for rules extensions like security-baseline.opt-in.md.

Usage:
    # Run standard comparison (all yes vs all no)
    python run_extension_test.py --scenario sci-calc

    # Run with custom configurations
    python run_extension_test.py --scenario sci-calc \
        --configs baseline,security-only,performance-only

    # Use specific rules branch
    python run_extension_test.py --scenario sci-calc \
        --rules-ref feat/extension_hook_question_split

    # Compare specific extension sets
    python run_extension_test.py --scenario sci-calc \
        --extensions security,performance,observability

Reference:
    - Extension hook feature: https://github.com/awslabs/aidlc-workflows/tree/feat/extension_hook_question_split
    - Opt-in example: https://github.com/awslabs/aidlc-workflows/blob/feat/extension_hook_question_split/aidlc-rules/aws-aidlc-rule-details/extensions/security/baseline/security-baseline.opt-in.md
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = REPO_ROOT / "config"
DEFAULT_CONFIG = CONFIG_DIR / "default.yaml"
TEST_CASES_DIR = REPO_ROOT / "test_cases"
SCRIPTS_DIR = REPO_ROOT / "scripts"

# Add shared and reporting packages to path
sys.path.insert(0, str(REPO_ROOT / "packages" / "shared" / "src"))
sys.path.insert(0, str(REPO_ROOT / "packages" / "reporting" / "src"))
from shared.scenario import resolve_scenario  # noqa: E402
from reporting.baseline import BaselineMetrics, extract_baseline  # noqa: E402
from reporting.collector import collect  # noqa: E402

# Default extension configurations to test
DEFAULT_CONFIGS = {
    "all-extensions": {
        "name": "All Extensions Enabled",
        "description": "All extension opt-ins answered YES",
        "opt_in_default": "yes",
    },
    "no-extensions": {
        "name": "No Extensions",
        "description": "All extension opt-ins answered NO (baseline only)",
        "opt_in_default": "no",
    },
}


def run_evaluation_with_config(
    config_name: str,
    config_spec: dict,
    vision: Path,
    tech_env: Path | None,
    golden: Path,
    openapi: Path,
    baseline: Path | None,
    base_config: Path,
    runs_dir: Path,
    profile: str,
    region: str,
    rules_ref: str,
    executor_model: str | None,
    scorer_model: str,
) -> dict:
    """Run evaluation with a specific extension configuration.

    Args:
        config_name: Short name for this config (e.g., "all-extensions")
        config_spec: Configuration specification with opt-in settings
        vision: Path to vision markdown
        tech_env: Optional path to tech-env markdown
        golden: Path to golden aidlc-docs directory
        openapi: Path to OpenAPI spec
        baseline: Optional path to golden.yaml baseline
        base_config: Path to base config YAML
        runs_dir: Base directory for run outputs
        profile: AWS profile name
        region: AWS region
        rules_ref: Git ref for AIDLC rules (should include extension hook support)
        executor_model: Optional executor model override
        scorer_model: Bedrock model ID for scoring

    Returns:
        dict: Summary of the run with status and metrics
    """
    print(f"\n{'=' * 70}")
    print(f"  Configuration: {config_spec['name']}")
    print(f"  Description: {config_spec['description']}")
    print(f"  Opt-in Default: {config_spec.get('opt_in_default', 'N/A')}")
    print(f"{'=' * 70}\n")

    # Build command to run evaluation
    cmd = [
        sys.executable, str(SCRIPTS_DIR / "run_evaluation.py"),
        "--config", str(base_config),
        "--vision", str(vision),
        "--golden", str(golden),
        "--openapi", str(openapi),
        "--scorer-model", scorer_model,
        "--rules-ref", rules_ref,
        "--report-format", "both",
        "--output-dir", str(runs_dir),
    ]
    if profile:
        cmd += ["--profile", profile]
    if region:
        cmd += ["--region", region]

    if tech_env and tech_env.is_file():
        cmd += ["--tech-env", str(tech_env)]
    if baseline and baseline.is_file():
        cmd += ["--baseline", str(baseline)]
    if executor_model:
        cmd += ["--executor-model", executor_model]

    # NOTE: Extension opt-in configuration mechanism
    # ===============================================
    # The extension hook feature is still under development. Once the
    # mechanism for controlling opt-in answers is finalized, we'll add
    # the appropriate flags or environment variables here.
    #
    # Possible approaches:
    # 1. Environment variable: AIDLC_EXTENSION_OPT_IN=yes|no|auto
    # 2. Config file field: aidlc.extension_opt_in_default
    # 3. CLI flag: --extension-opt-in yes|no|prompt
    # 4. Answer file: --extension-answers answers.yaml
    #
    # For now, document the configuration in run metadata.

    # Note existing runs so we can find the new one after execution
    existing_runs = set()
    if runs_dir.is_dir():
        existing_runs = {d.name for d in runs_dir.iterdir() if d.is_dir()}

    # Log to temp location, will move to run folder after
    runs_dir.mkdir(parents=True, exist_ok=True)
    log_dir = runs_dir / ".extension-test-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{config_name}.log"

    # Run evaluation
    start = time.monotonic()
    started_at = datetime.now(UTC).isoformat(timespec="seconds")
    with open(log_path, "w", encoding="utf-8") as log_file:
        # nosec B603 - Executing trusted run_evaluation.py with extension config
        # nosemgrep: dangerous-subprocess-use-audit
        result = subprocess.run(
            cmd,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

    elapsed_s = time.monotonic() - start
    elapsed_min = elapsed_s / 60

    status = "success" if result.returncode == 0 else "failed"
    print(f"  [{status.upper()}] {config_name} — {elapsed_min:.1f} min (exit code {result.returncode})")

    # Find the new run folder (timestamped dir that didn't exist before)
    run_folder: Path | None = None
    if runs_dir.is_dir():
        new_dirs = [
            d for d in runs_dir.iterdir()
            if d.is_dir() and d.name not in existing_runs and d.name[0:1].isdigit()
        ]
        if new_dirs:
            run_folder = sorted(new_dirs, reverse=True)[0]

    # Rename run folder to include config name
    if run_folder:
        output_dir = runs_dir / f"{run_folder.name}-ext-{config_name}"
        if output_dir.exists():
            shutil.rmtree(output_dir)
        run_folder.rename(output_dir)
        print(f"  Output: {output_dir}")

        # Move log into the run folder
        shutil.move(str(log_path), str(output_dir / "extension-test.log"))

        # Write configuration metadata to the run folder
        timestamp = run_folder.name.split('-')[0]
        config_meta = {
            "extension_test_config": config_name,
            "extension_config_spec": config_spec,
            "rules_ref": rules_ref,
            "run_timestamp": timestamp,
        }
        with open(output_dir / "extension-test-config.yaml", "w", encoding="utf-8") as f:
            yaml.safe_dump(config_meta, f, default_flow_style=False, sort_keys=False)
    else:
        print(f"  [WARN] No run folder found after execution")
        # Create a placeholder directory for the log
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
        output_dir = runs_dir / f"{timestamp}-ext-{config_name}-failed"
        output_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(log_path), str(output_dir / "extension-test.log"))
        print(f"  Log saved to: {output_dir}")

    # Clean up temp log dir if empty
    if log_dir.exists() and not any(log_dir.iterdir()):
        log_dir.rmdir()

    # Return summary
    return {
        "config_name": config_name,
        "config_display_name": config_spec["name"],
        "config_description": config_spec["description"],
        "started_at": started_at,
        "elapsed_seconds": round(elapsed_s, 1),
        "exit_code": result.returncode,
        "status": status,
        "output_dir": str(output_dir),
    }


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


def generate_extension_comparison(
    runs_dir: Path,
    results: list[dict],
    scenario_name: str,
) -> None:
    """Generate a detailed comparison report for extension test runs.

    Args:
        runs_dir: Base directory containing all test runs
        results: List of run summaries
        scenario_name: Name of the test scenario
    """
    comparison_dir = runs_dir / "extension-comparison"
    comparison_dir.mkdir(parents=True, exist_ok=True)

    # Write extension test summary
    summary = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "scenario": scenario_name,
        "total_runs": len(results),
        "runs": results,
    }

    summary_path = comparison_dir / "extension-test-summary.yaml"
    with open(summary_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(summary, f, default_flow_style=False, sort_keys=False)

    print(f"\n  Extension test summary: {summary_path}")

    # Load metrics from each run (regardless of status - we want to compare quality)
    config_metrics: dict[str, BaselineMetrics] = {}
    for result in results:
        run_folder = Path(result["output_dir"])
        if not run_folder.is_dir():
            continue
        print(f"  Loading metrics: {result['config_name']} (status: {result['status']})...")
        metrics = load_config_metrics(run_folder)
        if metrics:
            config_metrics[result['config_name']] = metrics

    # Generate detailed metrics comparison report
    report_lines = [
        "# Extension Hook Test Report",
        "",
        f"**Scenario:** {scenario_name}",
        f"**Generated:** {summary['generated_at']}",
        "",
        "## Test Configurations",
        "",
    ]

    # Configuration summary
    for result in results:
        status_icon = "✅" if result["status"] == "success" else "❌"
        report_lines.extend([
            f"### {status_icon} {result['config_display_name']}",
            "",
            f"- **Config ID:** `{result['config_name']}`",
            f"- **Description:** {result['config_description']}",
            f"- **Status:** {result['status'].upper()}",
            f"- **Duration:** {result.get('elapsed_seconds', 0) / 60:.1f} minutes",
            f"- **Output:** `{result['output_dir']}`",
            "",
        ])

    # Detailed metrics comparison (if we have metrics)
    if config_metrics:
        report_lines.extend([
            "",
            "## Detailed Metrics Comparison",
            "",
        ])

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
            # (display_name, attr_name, higher_is_better)
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
                    val = metrics.wall_clock_ms / 60000 if metrics.wall_clock_ms else None
                else:
                    val = getattr(metrics, attr, None)
                row += f" {format_num(val)} |"
            report_lines.append(row)

        report_lines.append("")

    # Next steps
    report_lines.extend([
        "",
        "## Next Steps",
        "",
        "1. Review the individual run reports in each output directory",
        "2. Compare qualitative scores between configurations",
        "3. Examine differences in generated artifacts",
        "4. Analyze the impact of extension opt-ins on output quality",
        "",
    ])

    report_path = comparison_dir / "extension-test-report.md"
    report_path.write_text("\n".join(report_lines), encoding="utf-8")
    print(f"  Extension test report: {report_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="run_extension_test",
        description="Test AIDLC evaluation with different extension opt-in configurations",
    )

    # Scenario and test configuration
    parser.add_argument(
        "--scenario", type=str, default="sci-calc",
        help="Scenario name or path to test case directory (default: sci-calc)",
    )
    parser.add_argument(
        "--configs", type=str, default=None,
        help='Comma-separated config names to test (default: "all-extensions,no-extensions")',
    )
    parser.add_argument(
        "--list-configs", action="store_true",
        help="List available extension configurations and exit",
    )

    # Rules configuration
    parser.add_argument(
        "--rules-ref", default="feat/extension_hook_question_split",
        help="Git ref for AIDLC rules with extension hook support (default: feat/extension_hook_question_split)",
    )

    # Base configuration
    parser.add_argument(
        "--config", type=Path, default=DEFAULT_CONFIG,
        help="Base config YAML (default: config/default.yaml)",
    )
    parser.add_argument(
        "--profile", default=None,
        help="AWS profile (default: from config YAML)",
    )
    parser.add_argument(
        "--region", default=None,
        help="AWS region (default: from config YAML)",
    )
    parser.add_argument(
        "--executor-model", default=None,
        help="Override executor model ID",
    )
    parser.add_argument(
        "--scorer-model", default=None,
        help="Bedrock model for scoring (default: from config YAML)",
    )

    # Scenario overrides
    parser.add_argument("--vision", type=Path, default=None)
    parser.add_argument("--tech-env", type=Path, default=None)
    parser.add_argument("--golden", type=Path, default=None)
    parser.add_argument("--openapi", type=Path, default=None)
    parser.add_argument("--baseline", type=Path, default=None)

    # Output configuration
    parser.add_argument(
        "--runs-dir", type=Path, default=None,
        help="Base directory for run outputs (default: runs/<scenario>/extension-test)",
    )

    args = parser.parse_args()

    # List configs mode
    if args.list_configs:
        print("Available extension test configurations:\n")
        for name, spec in DEFAULT_CONFIGS.items():
            print(f"  {name:20s}  {spec['name']}")
            print(f"  {' ' * 20}  {spec['description']}")
            print()
        sys.exit(0)

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

    # Route runs under runs/<scenario>/extension-test/
    if args.runs_dir is None:
        args.runs_dir = REPO_ROOT / "runs" / scenario.name / "extension-test"

    # Load base config for defaults
    base_cfg = {}
    if args.config and args.config.exists():
        with open(args.config, encoding="utf-8") as f:
            base_cfg = yaml.safe_load(f) or {}

    if args.profile is None:
        args.profile = base_cfg.get("aws", {}).get("profile")
    if args.region is None:
        args.region = base_cfg.get("aws", {}).get("region")

    if args.scorer_model is None:
        args.scorer_model = base_cfg.get("models", {}).get("scorer", {}).get("model_id")
        if args.scorer_model is None:
            parser.error("--scorer-model is required (or set models.scorer.model_id in config YAML)")

    # Select configurations to test
    if args.configs:
        selected = [c.strip() for c in args.configs.split(",")]
        configs = {k: v for k, v in DEFAULT_CONFIGS.items() if k in selected}
        missing = set(selected) - set(configs.keys())
        if missing:
            parser.error(f"Unknown configs: {', '.join(missing)}. Use --list-configs to see available options.")
    else:
        configs = DEFAULT_CONFIGS

    # Print test plan
    print("Extension Hook Test Plan")
    print(f"  Scenario:     {scenario.name}")
    print(f"  Rules Ref:    {args.rules_ref}")
    print(f"  Profile:      {args.profile}")
    print(f"  Region:       {args.region}")
    print(f"  Scorer:       {args.scorer_model}")
    print(f"  Configs:      {', '.join(configs.keys())}")
    print(f"  Vision:       {args.vision}")
    print(f"  Golden:       {args.golden}")

    # Run each configuration
    test_start = time.monotonic()
    test_started_at = datetime.now(UTC).isoformat(timespec="seconds")
    results: list[dict] = []

    for config_name, config_spec in configs.items():
        try:
            summary = run_evaluation_with_config(
                config_name=config_name,
                config_spec=config_spec,
                vision=args.vision,
                tech_env=args.tech_env,
                golden=args.golden,
                openapi=args.openapi,
                baseline=args.baseline,
                base_config=args.config,
                runs_dir=args.runs_dir,
                profile=args.profile,
                region=args.region,
                rules_ref=args.rules_ref,
                executor_model=args.executor_model,
                scorer_model=args.scorer_model,
            )
            results.append(summary)
        except Exception as e:
            print(f"\n[ERROR] Failed to run config {config_name}: {e}", file=sys.stderr)
            results.append({
                "config_name": config_name,
                "config_display_name": config_spec["name"],
                "config_description": config_spec["description"],
                "status": "error",
                "error": str(e),
            })

    test_elapsed = time.monotonic() - test_start

    # Generate comparison report
    generate_extension_comparison(args.runs_dir, results, scenario.name)

    # Print final summary
    print(f"\n{'=' * 70}")
    print(f"  Extension Test Complete")
    print(f"{'=' * 70}")
    print(f"  Total time: {test_elapsed / 60:.1f} min")
    print(f"  Configurations tested: {len(results)}")
    for r in results:
        marker = "PASS" if r.get("status") == "success" else "FAIL"
        duration = r.get("elapsed_seconds", 0) / 60
        print(f"    [{marker}] {r['config_display_name']:30s}  {duration:.1f} min")
    print(f"\n  Results: {args.runs_dir}")

    # Exit with error if any config failed
    failed = sum(1 for r in results if r.get("status") != "success")
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
