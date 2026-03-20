#!/usr/bin/env python3
"""Batch evaluation runner — run the AIDLC evaluation for multiple models sequentially.

Reads per-model config files from config/ and invokes run_evaluation.py for
each selected model.  The base config (config/default.yaml) provides AWS
credentials, swarm parameters, scorer model, and other defaults; per-model
configs override the executor model ID.

After each run, the timestamped run folder is renamed to append the model
name as a suffix (e.g., runs/20260225T190020-aidlc-workflows_main-nova-pro/).

Usage:
    # Run all configured models
    python run_batch_evaluation.py --models all

    # Run specific models (names match config file stems in config/)
    python run_batch_evaluation.py --models nova-pro,sonnet-4-5

    # List available model configs
    python run_batch_evaluation.py --list

    # Override AWS profile
    python run_batch_evaluation.py --models all --profile my-aws-profile
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

# Add shared package to path
sys.path.insert(0, str(REPO_ROOT / "packages" / "shared" / "src"))
from shared.scenario import resolve_scenario  # noqa: E402

# Exclude the default config — it's the baseline config, not a model-under-test
EXCLUDE_CONFIGS = {"default"}


def discover_models() -> dict[str, dict]:
    """Find all per-model config files and extract model IDs."""
    models = {}
    for config_path in sorted(CONFIG_DIR.glob("*.yaml")):
        name = config_path.stem
        if name in EXCLUDE_CONFIGS:
            continue
        with open(config_path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        model_id = data.get("models", {}).get("executor", {}).get("model_id")
        if model_id:
            models[name] = {
                "config_path": config_path,
                "model_id": model_id,
            }
    return models


def _find_latest_timestamped_run(runs_dir: Path) -> Path | None:
    """Find the most recent timestamped run folder under runs/.

    Only considers directories with names starting with a digit (YYYYMMDD...)
    to avoid matching model-specific directories (nova-pro, sonnet-4-5, etc.).
    """
    if not runs_dir.is_dir():
        return None
    folders = sorted(
        (d for d in runs_dir.iterdir()
         if d.is_dir() and not d.name.startswith(".") and d.name[0:1].isdigit()),
        reverse=True,
    )
    return folders[0] if folders else None


def run_model(
    name: str,
    model_id: str,
    config_path: Path,
    base_config: Path,
    runs_dir: Path,
    profile: str,
    region: str,
    vision: Path,
    tech_env: Path | None,
    golden: Path,
    openapi: Path,
    baseline: Path | None,
    scorer_model: str,
    use_sandbox: bool = True,
) -> dict:
    """Run the full evaluation pipeline for a single model.

    Args:
        name: Model config name (e.g., "nova-pro").
        model_id: Bedrock model ID extracted from the per-model config.
        config_path: Path to the per-model config file.
        base_config: Path to the base config (default.yaml) passed to run_evaluation.py.
        runs_dir: Base directory for run outputs.
        profile: AWS profile name.
        region: AWS region.
        vision: Path to vision markdown file.
        tech_env: Optional path to tech-env markdown file.
        golden: Path to golden aidlc-docs directory.
        openapi: Path to OpenAPI spec.
        baseline: Optional path to golden.yaml baseline.
        scorer_model: Bedrock model ID for qualitative scoring.

    Runs without --output-dir so the framework creates a timestamped folder
    under runs/. After the run, the folder is renamed to append the model
    name as a suffix (e.g., runs/20260225T190020-aidlc-workflows_main-nova-pro/).
    """
    # Snapshot for legacy fallback (in case runner doesn't write sentinel)
    existing_runs = set()
    if runs_dir.is_dir():
        existing_runs = {d.name for d in runs_dir.iterdir() if d.is_dir()}

    cmd = [
        sys.executable, str(REPO_ROOT / "scripts" / "run_evaluation.py"),
        "--config", str(base_config),
        "--vision", str(vision),
        "--golden", str(golden),
        "--openapi", str(openapi),
        "--executor-model", model_id,
        "--scorer-model", scorer_model,
        "--report-format", "both",
    ]
    if profile:
        cmd += ["--profile", profile]
    if region:
        cmd += ["--region", region]
    if tech_env and tech_env.is_file():
        cmd += ["--tech-env", str(tech_env)]
    if baseline and baseline.is_file():
        cmd += ["--baseline", str(baseline)]
    if use_sandbox:
        cmd.append("--sandbox")
    else:
        cmd.append("--no-sandbox")

    # Log to a temp location, move with the run folder later
    log_dir = runs_dir / ".batch-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{name}.log"

    print(f"\n{'=' * 70}")
    print(f"  Model: {name}")
    print(f"  Bedrock ID: {model_id}")
    print(f"  Config: {config_path}")
    print(f"  Log: {log_path}")
    print(f"{'=' * 70}\n")

    start = time.monotonic()
    started_at = datetime.now(UTC).isoformat(timespec="seconds")

    with open(log_path, "w", encoding="utf-8") as log_file:
        # nosec B603 - Executing trusted run_evaluation.py script with validated model config
        # nosemgrep: dangerous-subprocess-use-audit
        result = subprocess.run(
            cmd,
            stdout=log_file,
            stderr=subprocess.STDOUT,
        )

    elapsed_s = time.monotonic() - start
    elapsed_min = elapsed_s / 60

    status = "success" if result.returncode == 0 else "failed"
    print(f"  [{status.upper()}] {name} — {elapsed_min:.1f} min (exit code {result.returncode})")

    # Find the new run folder — prefer sentinel file over directory-diff.
    _sentinel_name = ".last_run_folder"
    sentinel = runs_dir / _sentinel_name
    run_folder: Path | None = None
    if sentinel.is_file():
        try:
            candidate = Path(sentinel.read_text(encoding="utf-8").strip())
            sentinel.unlink(missing_ok=True)
            if candidate.is_dir():
                run_folder = candidate
        except OSError:
            pass

    # Legacy fallback: before/after directory diff
    if run_folder is None and runs_dir.is_dir():
        new_dirs = [
            d for d in runs_dir.iterdir()
            if d.is_dir() and d.name not in existing_runs and d.name[0:1].isdigit()
        ]
        if new_dirs:
            run_folder = sorted(new_dirs, reverse=True)[0]

    # Rename run folder to append model name as suffix
    if run_folder:
        model_dir = runs_dir / f"{run_folder.name}-{name}"
        if model_dir.exists():
            shutil.rmtree(model_dir)
        run_folder.rename(model_dir)
        print(f"  Run folder: {model_dir}")
        # Move log into the run folder
        shutil.move(str(log_path), str(model_dir / "batch-run.log"))
    else:
        print(f"  [WARN] No run folder found after execution")
        model_dir = runs_dir / name
        model_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(log_path), str(model_dir / "batch-run.log"))

    # Write batch-level summary for this model
    summary = {
        "model_name": name,
        "model_id": model_id,
        "config_file": str(config_path),
        "started_at": started_at,
        "elapsed_seconds": round(elapsed_s, 1),
        "exit_code": result.returncode,
        "status": status,
        "output_dir": str(model_dir),
    }
    summary_path = model_dir / "batch-summary.yaml"
    with open(summary_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(summary, f, default_flow_style=False, sort_keys=False)

    return summary


def _load_base_config(config_path: Path) -> dict:
    """Load the base config YAML and return its contents as a dict."""
    if config_path.is_file():
        with open(config_path, encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="run_batch_evaluation",
        description="Run AIDLC evaluation across multiple Bedrock models",
    )
    parser.add_argument(
        "--models", type=str, default=None,
        help='Comma-separated model names (config file stems), or "all"',
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List available model configs and exit",
    )
    parser.add_argument(
        "--config", type=Path, default=DEFAULT_CONFIG,
        help="Base config YAML providing AWS, swarm, and scorer defaults (default: config/default.yaml)",
    )
    parser.add_argument(
        "--profile", default=None,
        help="AWS profile (default: from base config YAML)",
    )
    parser.add_argument(
        "--region", default=None,
        help="AWS region (default: from base config YAML)",
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
    parser.add_argument(
        "--scorer-model", default=None,
        help="Bedrock model for qualitative scoring (default: from base config YAML)",
    )
    parser.add_argument(
        "--runs-dir", type=Path, default=REPO_ROOT / "runs",
        help="Base directory for run outputs (default: ./runs)",
    )

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

    # Route runs under runs/<scenario>/
    if args.runs_dir == REPO_ROOT / "runs":
        args.runs_dir = REPO_ROOT / "runs" / scenario.name

    available = discover_models()

    if args.list:
        print("Available model configs:")
        for name, info in available.items():
            print(f"  {name:20s}  {info['model_id']}")
        sys.exit(0)

    if not args.models:
        parser.error("--models is required (use --list to see available configs)")

    # ── Resolve defaults from base config YAML ────────────────────────
    base_cfg = _load_base_config(args.config)

    if args.profile is None:
        args.profile = base_cfg.get("aws", {}).get("profile")
    if args.region is None:
        args.region = base_cfg.get("aws", {}).get("region")
    if args.scorer_model is None:
        args.scorer_model = (
            base_cfg.get("models", {}).get("scorer", {}).get("model_id")
        )
        if args.scorer_model is None:
            parser.error(
                "--scorer-model is required (or set models.scorer.model_id in base config YAML)"
            )

    # ── Select models ─────────────────────────────────────────────────
    if args.models == "all":
        selected = list(available.keys())
    else:
        selected = [m.strip() for m in args.models.split(",")]
        for name in selected:
            if name not in available:
                parser.error(
                    f"Unknown model '{name}'. Available: {', '.join(available.keys())}"
                )

    batch_start = time.monotonic()
    batch_started_at = datetime.now(UTC).isoformat(timespec="seconds")
    results: list[dict] = []

    print(f"AIDLC Batch Evaluation")
    print(f"  Scenario: {scenario.name}")
    print(f"  Models:  {', '.join(selected)}")
    print(f"  Config:  {args.config}")
    print(f"  Profile: {args.profile}")
    print(f"  Region:  {args.region}")
    print(f"  Scorer:  {args.scorer_model}")
    print(f"  Vision:  {args.vision}")
    print(f"  Baseline: {args.baseline}")

    for name in selected:
        model_info = available[name]
        summary = run_model(
            name=name,
            model_id=model_info["model_id"],
            config_path=model_info["config_path"],
            base_config=args.config,
            runs_dir=args.runs_dir,
            profile=args.profile,
            region=args.region,
            vision=args.vision,
            tech_env=args.tech_env,
            golden=args.golden,
            openapi=args.openapi,
            baseline=args.baseline,
            scorer_model=args.scorer_model,
            use_sandbox=args.sandbox,
        )
        results.append(summary)

    batch_elapsed = time.monotonic() - batch_start

    # Write batch-level summary
    batch_summary = {
        "started_at": batch_started_at,
        "total_elapsed_seconds": round(batch_elapsed, 1),
        "base_config": str(args.config),
        "profile": args.profile,
        "region": args.region,
        "scorer_model": args.scorer_model,
        "models_run": len(results),
        "models_passed": sum(1 for r in results if r["status"] == "success"),
        "models_failed": sum(1 for r in results if r["status"] == "failed"),
        "results": results,
    }
    batch_summary_path = args.runs_dir / "batch-summary.yaml"
    args.runs_dir.mkdir(parents=True, exist_ok=True)
    with open(batch_summary_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(batch_summary, f, default_flow_style=False, sort_keys=False)

    # Clean up temp log dir
    log_dir = args.runs_dir / ".batch-logs"
    if log_dir.is_dir() and not any(log_dir.iterdir()):
        log_dir.rmdir()

    # Print final summary
    print(f"\n{'=' * 70}")
    print(f"  Batch Evaluation Complete")
    print(f"{'=' * 70}")
    print(f"  Total time: {batch_elapsed / 60:.1f} min")
    print(f"  Models run: {len(results)}")
    for r in results:
        marker = "PASS" if r["status"] == "success" else "FAIL"
        print(f"    [{marker}] {r['model_name']:20s}  {r['elapsed_seconds'] / 60:.1f} min")
    print(f"  Batch summary: {batch_summary_path}")
    print(f"\n  Run 'python run_comparison_report.py' to generate cross-model comparison.\n")

    failed = sum(1 for r in results if r["status"] == "failed")
    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
