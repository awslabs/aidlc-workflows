#!/usr/bin/env python3
"""Run AIDLC evaluation through a CLI adapter.

Usage:
    # List available adapters
    python run_cli_evaluation.py --list

    # Run evaluation through kiro-cli
    python run_cli_evaluation.py --cli kiro-cli \
        --vision test_cases/sci-calc-v2/vision.md \
        --golden test_cases/sci-calc-v2/golden-aidlc-docs

    # Check prerequisites for a CLI tool
    python run_cli_evaluation.py --cli kiro-cli --check-only

    # Override rules ref (branch/tag/commit)
    python run_cli_evaluation.py --cli claude-cli --rules-ref v0.2.0

    # Use local rules directory instead of git clone
    python run_cli_evaluation.py --cli claude-cli --rules-path /path/to/rules
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

from cli_harness.orchestrator import run_cli_evaluation  # noqa: E402
from cli_harness.registry import get_adapter, list_adapters  # noqa: E402

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
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%S") + f"-{os.getpid()}"
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
                "git",
                "clone",
                "--branch",
                rules_ref,
                "--depth",
                "1",
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
        "--cli",
        type=str,
        default="kiro-cli",
        help="CLI adapter name (default: kiro-cli; e.g., kiro-cli, claude-cli)",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List available CLI adapters and exit",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Only check CLI prerequisites, don't run evaluation",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=REPO_ROOT / "config" / "default.yaml",
        help="Path to YAML config file (default: config/default.yaml)",
    )
    parser.add_argument(
        "--vision", type=Path, default=REPO_ROOT / "test_cases" / "sci-calc-v2" / "vision.md"
    )
    parser.add_argument(
        # No static default: greenfield falls back to the scenario's tech-env
        # below; brownfield gets None unless explicitly passed (the sci-calc
        # default otherwise leaks a WRONG stack pin into brownfield prompts).
        "--tech-env", type=Path, default=None
    )
    parser.add_argument(
        "--golden",
        type=Path,
        default=REPO_ROOT / "test_cases" / "sci-calc-v2" / "golden-aidlc-docs",
    )
    parser.add_argument(
        "--openapi", type=Path, default=REPO_ROOT / "test_cases" / "sci-calc-v2" / "openapi.yaml"
    )
    parser.add_argument(
        "--baseline", type=Path, default=REPO_ROOT / "test_cases" / "sci-calc-v2" / "golden.yaml"
    )
    # ── Brownfield mode (FR-1.2) ──────────────────────────────────────
    parser.add_argument(
        "--seed-repo", type=Path, default=None,
        help="Brownfield: existing codebase to seed into the workspace before "
        "the model runs (the model modifies it per --task, not build-from-vision).",
    )
    parser.add_argument(
        "--task", type=Path, default=None,
        help="Brownfield: task.md describing the modification (used in place of "
        "--vision when --seed-repo is set).",
    )
    parser.add_argument(
        "--contract-hurl-dir", type=Path, default=None,
        help="Brownfield feature: dir of .hurl files to score against (instead "
        "of --openapi). Boots the app via framework auto-detection.",
    )
    parser.add_argument(
        "--rules-ref",
        default=None,
        help="Git ref (branch/tag/commit) for AIDLC rules (overrides config value)",
    )
    parser.add_argument(
        "--rules-path",
        type=Path,
        default=None,
        help="Path to local AIDLC rules directory (overrides git clone)",
    )
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=None,
        help="Max wall-clock seconds for the adapter run before it stops (default: "
        "config aidlc.timeout_seconds, else 14400 = 4h). v2's full 32-stage MVP with "
        "per-unit reviewer sub-agents needs well over 2h; raise this for full runs.",
    )
    parser.add_argument("--profile", default=None, help="AWS profile (default: from config YAML)")
    parser.add_argument("--region", default=None, help="AWS region (default: from config YAML)")
    parser.add_argument(
        "--scorer-model", default=None, help="Bedrock model for scoring (default: from config YAML)"
    )
    parser.add_argument(
        "--model", default=None, help="Model to use with the CLI adapter (e.g., claude-sonnet-4)"
    )
    parser.add_argument(
        "--kiro-dist",
        type=Path,
        default=None,
        help=(
            "Path to the .kiro/ distribution directory (e.g. dist/kiro/.kiro). When "
            "set, the kiro adapter copies it into the workspace so Kiro picks up the "
            "/aidlc skill, agents, hooks, and tools natively and drives the forwarding "
            "loop. Defaults to dist/kiro/.kiro relative to the repo root. Requires bun."
        ),
    )
    parser.add_argument(
        "--claude-dist",
        type=Path,
        default=None,
        help=(
            "Path to the claude .claude/ distribution directory "
            "(e.g. dist/claude/.claude). When set, the claude-cli "
            "adapter copies it into the workspace and drives the /aidlc skill. "
            "Defaults to dist/claude/.claude relative to the git root. "
            "Requires bun on PATH."
        ),
    )
    parser.add_argument(
        "--codex-dist",
        type=Path,
        default=None,
        help=(
            "Path to the codex distribution directory (e.g. dist/codex). When set, "
            "the codex-cli adapter copies its .codex/ + .agents/ + AGENTS.md into the "
            "workspace, git-inits it, writes a scratch CODEX_HOME, and drives the "
            "/aidlc skill via `codex exec`. Defaults to dist/codex relative to the git "
            "root. Requires codex >= 0.139.0 and bun on PATH."
        ),
    )
    parser.add_argument(
        "--scope",
        default="mvp",
        help="Scope for the /aidlc skill (e.g. mvp, poc, feature). Shared by the "
        "claude-cli, kiro-cli, and codex-cli adapters. Default: mvp",
    )
    parser.add_argument(
        "--no-test-run",
        action="store_true",
        help="Disable --test-run; gates surface to the human simulator instead of auto-approving.",
    )
    parser.add_argument(
        "--capture-tokens-otel",
        action="store_true",
        help="Enable per-run OpenTelemetry export so token usage reaches the KW "
        "telemetry collector (ALB -> CloudWatch), then query it by session.id after "
        "the run for exact token counts. OFF by default (runs stay telemetry-isolated). "
        "Requires OTEL_* config in ~/.claude/settings.json + aws CLI access. claude-cli only.",
    )
    parser.add_argument(
        "--bundle",
        action="append",
        default=[],
        help="Extension bundle to overlay onto the installed harness (repeatable). "
        "A bundle NAME resolves to dist/claude/extensions/<name>/.claude; an absolute "
        "path is used as-is. claude-cli only. Lets the eval exercise an extension "
        "(e.g. --bundle test-pro --scope enterprise).",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
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
        args.scorer_model = cfg_data.get("models", {}).get("scorer", {}).get("model_id")
        if args.scorer_model is None:
            parser.error(
                "--scorer-model is required (or set models.scorer.model_id in config YAML)"
            )

    # ── Resolve AIDLC rules config ────────────────────────────────────────
    aidlc_cfg = cfg_data.get("aidlc", {})
    # Timeout: CLI flag wins, then config aidlc.timeout_seconds, else 4h. v2's
    # full MVP with per-unit reviewer sub-agents runs well past the old 2h.
    if args.timeout_seconds is None:
        args.timeout_seconds = int(aidlc_cfg.get("timeout_seconds", 14400))
    rules_source = aidlc_cfg.get("rules_source", "git")
    rules_repo = aidlc_cfg.get("rules_repo", "https://github.com/awslabs/aidlc-workflows.git")
    rules_ref = args.rules_ref or aidlc_cfg.get("rules_ref", "main")

    if args.rules_path:
        rules_source = "local"
        rules_local_path = str(Path(args.rules_path).resolve())
    else:
        rules_local_path = aidlc_cfg.get("rules_local_path")

    # Resolve all paths relative to cwd so they work from any directory.
    # Brownfield (--seed-repo): there is no vision/golden/baseline; the task.md
    # is the prompt and the contract (openapi or hurl-dir) is the oracle. Null
    # the greenfield-only defaults so they don't wrongly resolve to sci-calc.
    brownfield = bool(args.seed_repo)
    tech_env_path = Path(args.tech_env).resolve() if args.tech_env else None
    if tech_env_path is None and not brownfield:
        tech_env_path = REPO_ROOT / "test_cases" / "sci-calc-v2" / "tech-env.md"
    if brownfield:
        vision_path = Path(args.task).resolve()  # task.md carries the H1 intent
        golden_docs = None
        baseline_path = None
        openapi_path = Path(args.openapi).resolve() if args.openapi else None
    else:
        vision_path = Path(args.vision).resolve()
        golden_docs = Path(args.golden).resolve()
        openapi_path = Path(args.openapi).resolve()
        baseline_path = Path(args.baseline).resolve()
    slug = _rules_slug(rules_source, rules_repo, rules_ref, rules_local_path)
    output_dir = (
        Path(args.output_dir).resolve() if args.output_dir else _default_output_dir(args.cli, slug)
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

    # Resolve kiro_dist_path — explicit arg, then auto-detect from git root.
    # GIT_ROOT is the repository root (evaluator/ sits one level below it).
    git_root = REPO_ROOT.parent
    kiro_dist_path: Path | None = None
    if args.kiro_dist:
        kiro_dist_path = Path(args.kiro_dist).resolve()
    else:
        candidate = git_root / "dist" / "kiro" / ".kiro"
        if candidate.is_dir():
            kiro_dist_path = candidate

    if kiro_dist_path:
        print(
            f"  Kiro distribution: {kiro_dist_path} "
            f"(scope={args.scope}, test_run={not args.no_test_run})"
        )
    else:
        print("  Kiro distribution: not found — using v1 steering-file mode")

    # Resolve claude_dist_path — explicit arg, then auto-detect from git root.
    # An explicit --rules-path means the caller wants v1 legacy mode, so do
    # NOT auto-detect a dist in that case (auto-detect would silently flip the
    # claude-cli adapter into v2 mode and run the wrong framework).
    claude_dist_path: Path | None = None
    if args.claude_dist:
        claude_dist_path = Path(args.claude_dist).resolve()
    elif not args.rules_path:
        candidate = git_root / "dist" / "claude" / ".claude"
        if candidate.is_dir():
            claude_dist_path = candidate

    if claude_dist_path:
        print(
            f"  Claude distribution: {claude_dist_path} "
            f"(scope={args.scope}, test_run={not args.no_test_run})"
        )
    elif args.rules_path:
        print(f"  v1 legacy mode: rules from {args.rules_path} (no dist, monolith prompt)")
    else:
        print("  Claude distribution: not found — using v1 monolith prompt")

    # Resolve codex_dist_path — explicit arg, then auto-detect from git root.
    codex_dist_path: Path | None = None
    if args.codex_dist:
        codex_dist_path = Path(args.codex_dist).resolve()
    else:
        candidate = git_root / "dist" / "codex"
        if candidate.is_dir():
            codex_dist_path = candidate

    if codex_dist_path:
        print(
            f"  Codex distribution: {codex_dist_path} "
            f"(scope={args.scope}, test_run={not args.no_test_run})"
        )
    else:
        print("  Codex distribution: not found")

    # Resolve --bundle entries: a NAME -> dist/<harness>/extensions/<name>/ (the
    # bundle delta root; the adapter picks the .claude/.kiro/.codex+.agents subtree
    # from within it). An absolute/existing path is used as-is. <harness> is the
    # CLI name minus the "-cli" suffix (claude-cli -> claude, etc.).
    harness = args.cli.removesuffix("-cli")
    bundle_paths: list[Path] = []
    for b in args.bundle:
        p = Path(b)
        if p.is_absolute() or p.exists():
            bundle_paths.append(p.resolve())
        else:
            bundle_paths.append((git_root / "dist" / harness / "extensions" / b).resolve())
    for bp in bundle_paths:
        print(f"  Bundle overlay: {bp}")

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
        kiro_dist_path=kiro_dist_path,
        claude_dist_path=claude_dist_path,
        codex_dist_path=codex_dist_path,
        scope=args.scope,
        test_run=not args.no_test_run,
        bundle_paths=bundle_paths,
        timeout_seconds=args.timeout_seconds,
        capture_tokens_otel=args.capture_tokens_otel,
        seed_repo_path=args.seed_repo.resolve() if args.seed_repo else None,
        task_path=args.task.resolve() if args.task else None,
        contract_hurl_dir=args.contract_hurl_dir.resolve() if args.contract_hurl_dir else None,
    )

    if not result.success:
        print(f"\n[FAILED] {adapter.name}: {result.error}")
        sys.exit(1)

    print(f"\n[DONE] {adapter.name} evaluation complete.")
    print(f"  Output: {result.output_dir}")
    sys.exit(eval_rc)


if __name__ == "__main__":
    main()
