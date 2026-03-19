#!/usr/bin/env python3
"""Run AIDLC evaluation through a CLI adapter.

Usage:
    # List available adapters
    python run_cli_evaluation.py --list

    # Run evaluation through kiro-cli
    python run_cli_evaluation.py --cli kiro-cli \
        --vision test_cases/sci-calc/vision.md \
        --golden test_cases/sci-calc/golden-aidlc-docs

    # Check prerequisites for a CLI tool
    python run_cli_evaluation.py --cli kiro-cli --check-only

    # Override rules ref (branch/tag/commit)
    python run_cli_evaluation.py --cli claude-code --rules-ref v0.2.0

    # Use local rules directory instead of git clone
    python run_cli_evaluation.py --cli claude-code --rules-path /path/to/rules
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import stat
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGES = REPO_ROOT / "packages"

# Add cli-harness to path
sys.path.insert(0, str(PACKAGES / "cli-harness" / "src"))

from cli_harness.registry import get_adapter, list_adapters  # noqa: E402
from cli_harness.orchestrator import run_cli_evaluation  # noqa: E402

_SLUG_MAX_LEN = 80


def _rules_slug(
    rules_source: str,
    rules_repo: str,
    rules_ref: str,
    rules_local_path: str | None,
) -> str:
    """Derive a filesystem-safe slug from the AIDLC rules configuration.

    Mirrors packages/execution/src/aidlc_runner/runner.py:_rules_slug().
    """
    if rules_source == "local" and rules_local_path:
        raw = f"local_{Path(rules_local_path).name}"
    else:
        path = urlparse(rules_repo).path.rstrip("/")
        repo_name = Path(path).stem  # strips .git suffix
        raw = f"{repo_name}_{rules_ref}"
    slug = raw.replace(" ", "-")
    slug = re.sub(r"[^a-zA-Z0-9._-]", "", slug)
    return slug[:_SLUG_MAX_LEN]


def _default_output_dir(cli_name: str, slug: str) -> Path:
    """Generate a timestamped output directory matching the normal run pattern.

    Format: runs/{timestamp}-{rules_slug}-{cli_name}
    Example: runs/20260227T160245-aidlc-workflows_main-kiro-cli
    """
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
    return REPO_ROOT / "runs" / f"{ts}-{slug}-{cli_name.lower()}"


def _setup_rules(
    output_dir: Path,
    *,
    rules_source: str = "git",
    rules_repo: str = "https://github.com/awslabs/aidlc-workflows.git",
    rules_ref: str = "main",
    rules_local_path: str | None = None,
) -> Path:
    """Download or copy AIDLC rules into the output directory.

    Mirrors the pattern from packages/execution/src/aidlc_runner/runner.py:setup_rules().
    """
    rules_dest = output_dir / "aidlc-rules"

    if rules_source == "local" and rules_local_path:
        local_path = Path(rules_local_path)
        if not local_path.exists():
            raise FileNotFoundError(f"Local rules path not found: {local_path}")
        shutil.copytree(local_path / "aidlc-rules", rules_dest)
    else:
        # Git clone (shallow, single branch)
        print(f"  Cloning AIDLC rules from {rules_repo} (ref: {rules_ref})...")
        # nosec B603, B607 - Git clone of trusted AIDLC rules repository
        # nosemgrep: dangerous-subprocess-use-audit
        result = subprocess.run(
            [
                "git", "clone",
                "--branch", rules_ref,
                "--depth", "1",
                rules_repo,
                str(rules_dest / "_repo"),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Failed to clone AIDLC rules repo:\n{result.stderr}")

        # Move aidlc-rules content up from _repo/aidlc-rules/ to rules_dest/
        repo_rules = rules_dest / "_repo" / "aidlc-rules"
        if repo_rules.exists():
            for item in repo_rules.iterdir():
                shutil.move(str(item), str(rules_dest / item.name))

        # Clean up the full repo clone (force-remove read-only git pack files)
        def _force_remove_readonly(func, path, _exc_info):
            os.chmod(path, stat.S_IWRITE)
            func(path)

        # onexc was added in Python 3.12; fall back to onerror on older versions
        if sys.version_info >= (3, 12):
            shutil.rmtree(rules_dest / "_repo", onexc=_force_remove_readonly)
        else:
            shutil.rmtree(rules_dest / "_repo", onerror=_force_remove_readonly)

    return rules_dest


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="run_cli_evaluation",
        description="Run AIDLC evaluation through a CLI AI assistant",
    )
    parser.add_argument(
        "--cli", type=str,
        help="CLI adapter name (e.g., kiro-cli)",
    )
    parser.add_argument(
        "--list", action="store_true",
        help="List available CLI adapters and exit",
    )
    parser.add_argument(
        "--check-only", action="store_true",
        help="Only check CLI prerequisites, don't run evaluation",
    )
    parser.add_argument(
        "--config", type=Path,
        default=REPO_ROOT / "config" / "default.yaml",
        help="Path to YAML config file (default: config/default.yaml)",
    )
    parser.add_argument("--vision", type=Path, default=REPO_ROOT / "test_cases" / "sci-calc" / "vision.md")
    parser.add_argument("--tech-env", type=Path, default=REPO_ROOT / "test_cases" / "sci-calc" / "tech-env.md")
    parser.add_argument("--golden", type=Path, default=REPO_ROOT / "test_cases" / "sci-calc" / "golden-aidlc-docs")
    parser.add_argument("--openapi", type=Path, default=REPO_ROOT / "test_cases" / "sci-calc" / "openapi.yaml")
    parser.add_argument("--baseline", type=Path, default=REPO_ROOT / "test_cases" / "sci-calc" / "golden.yaml")
    parser.add_argument(
        "--rules-ref", default=None,
        help="Git ref (branch/tag/commit) for AIDLC rules (overrides config value)",
    )
    parser.add_argument(
        "--rules-path", type=Path, default=None,
        help="Path to local AIDLC rules directory (overrides git clone)",
    )
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--profile", default=None, help="AWS profile (default: from config YAML)")
    parser.add_argument("--region", default=None, help="AWS region (default: from config YAML)")
    parser.add_argument("--scorer-model", default=None, help="Bedrock model for scoring (default: from config YAML)")
    parser.add_argument("--model", default=None, help="Model to use with the CLI adapter (e.g., claude-sonnet-4)")
    parser.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable verbose logging output",
    )

    args = parser.parse_args()

    if args.verbose:
        import logging
        logging.basicConfig(
            level=logging.DEBUG,
            format="%(asctime)s %(name)s %(levelname)s: %(message)s",
        )

    if args.list:
        print("Available CLI adapters:")
        for name in list_adapters():
            try:
                adapter = get_adapter(name)
                ok, msg = adapter.check_prerequisites()
                status = "ready" if ok else "not ready"
                print(f"  {name:15s}  [{status}] {msg}")
            except Exception as e:
                print(f"  {name:15s}  [error] {e}")
        sys.exit(0)

    if not args.cli:
        parser.error("--cli is required (use --list to see available adapters)")

    adapter = get_adapter(args.cli)
    adapter.verbose = args.verbose

    if args.check_only:
        ok, msg = adapter.check_prerequisites()
        print(f"{adapter.name}: {'OK' if ok else 'FAIL'} — {msg}")
        sys.exit(0 if ok else 1)

    # ── Resolve defaults from config YAML when not provided on CLI ──────
    cfg_data: dict = {}
    if args.config and args.config.exists():
        with open(args.config, encoding="utf-8") as f:
            cfg_data = yaml.safe_load(f) or {}

    if args.profile is None:
        args.profile = cfg_data.get("aws", {}).get("profile")
    if args.region is None:
        args.region = cfg_data.get("aws", {}).get("region")
    if args.scorer_model is None:
        args.scorer_model = (
            cfg_data.get("models", {}).get("scorer", {}).get("model_id")
        )
        if args.scorer_model is None:
            parser.error(
                "--scorer-model is required (or set models.scorer.model_id in config YAML)"
            )

    # ── Resolve AIDLC rules config ────────────────────────────────────────
    aidlc_cfg = cfg_data.get("aidlc", {})
    rules_source = aidlc_cfg.get("rules_source", "git")
    rules_repo = aidlc_cfg.get("rules_repo", "https://github.com/awslabs/aidlc-workflows.git")
    rules_ref = args.rules_ref or aidlc_cfg.get("rules_ref", "main")

    if args.rules_path:
        rules_source = "local"
        rules_local_path = str(Path(args.rules_path).resolve())
    else:
        rules_local_path = aidlc_cfg.get("rules_local_path")

    # Resolve all paths relative to cwd so they work from any directory
    vision_path = Path(args.vision).resolve()
    tech_env_path = Path(args.tech_env).resolve()
    golden_docs = Path(args.golden).resolve()
    openapi_path = Path(args.openapi).resolve()
    baseline_path = Path(args.baseline).resolve()
    slug = _rules_slug(rules_source, rules_repo, rules_ref, rules_local_path)
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else _default_output_dir(args.cli, slug)
    )

    # ── Setup AIDLC rules (git clone or local copy) ─────────────────────
    output_dir.mkdir(parents=True, exist_ok=True)

    rules_path = _setup_rules(
        output_dir,
        rules_source=rules_source,
        rules_repo=rules_repo,
        rules_ref=rules_ref,
        rules_local_path=rules_local_path,
    )

    result, eval_rc = run_cli_evaluation(
        adapter=adapter,
        vision_path=vision_path,
        output_dir=output_dir,
        golden_docs=golden_docs,
        rules_path=rules_path,
        tech_env_path=tech_env_path,
        openapi_path=openapi_path,
        baseline_path=baseline_path,
        profile=args.profile,
        region=args.region,
        scorer_model=args.scorer_model,
        model=args.model,
        rules_source=rules_source,
        rules_ref=rules_ref,
        rules_repo=rules_repo,
    )

    if not result.success:
        print(f"\n[FAILED] {adapter.name}: {result.error}")
        sys.exit(1)

    print(f"\n[DONE] {adapter.name} evaluation complete.")
    print(f"  Output: {result.output_dir}")
    sys.exit(eval_rc)


if __name__ == "__main__":
    main()
