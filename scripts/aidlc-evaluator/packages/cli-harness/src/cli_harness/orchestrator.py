"""Run orchestration — invoke a CLI adapter then run the evaluation pipeline."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import yaml

from cli_harness.adapter import AdapterConfig, AdapterResult, CLIAdapter
from cli_harness.normalizer import normalize_output, _count_workspace_files, _count_doc_files


REPO_ROOT = Path(__file__).resolve().parents[4]  # packages/cli-harness/src/cli_harness -> repo root

# Input files that adapters copy into workspace for the CLI tool to read.
# These should be cleaned out after the run so workspace only has generated code.
_WORKSPACE_INPUT_FILES = {"vision.md", "tech-env.md"}
_WORKSPACE_INPUT_DIRS = {"aidlc-rules", ".kiro"}


def _normalize_run_folder(
    output_dir: Path,
    *,
    vision_path: Path,
    tech_env_path: Path | None,
    adapter_name: str,
    profile: str,
    region: str,
    rules_source: str,
    rules_ref: str,
    rules_repo: str,
) -> None:
    """Normalize the run folder layout to match the execution pipeline.

    After the adapter runs, the workspace contains input files (vision.md,
    tech-env.md, aidlc-rules/) mixed with generated code. This function:

    1. Copies vision.md and tech-env.md to the run root (like the execution runner).
    2. Removes input files and adapter scaffolding from workspace/.
    3. Enriches run-meta.yaml with rules config and relative paths.
    4. Recounts workspace files and updates run-metrics.yaml artifacts section.
    """
    workspace = output_dir / "workspace"

    # 1. Copy input docs to run root (matching execution runner layout)
    if vision_path.is_file():
        shutil.copy2(vision_path, output_dir / "vision.md")
    if tech_env_path and tech_env_path.is_file():
        shutil.copy2(tech_env_path, output_dir / "tech-env.md")

    # 2. Remove input files from workspace so it only has generated code
    if workspace.is_dir():
        for name in _WORKSPACE_INPUT_FILES:
            p = workspace / name
            if p.is_file():
                p.unlink()
        for name in _WORKSPACE_INPUT_DIRS:
            p = workspace / name
            if p.is_dir():
                shutil.rmtree(p)

    # 3. Enrich run-meta.yaml with rules config and relative run_folder
    meta_path = output_dir / "run-meta.yaml"
    if meta_path.exists():
        with open(meta_path, encoding="utf-8") as f:
            meta = yaml.safe_load(f) or {}
    else:
        meta = {}

    # Use relative path like the normal run
    try:
        meta["run_folder"] = str(output_dir.relative_to(Path.cwd()))
    except ValueError:
        meta["run_folder"] = str(output_dir)

    # Add rules config fields that the normal run includes
    config_section = meta.get("config", {})
    config_section["aws_profile"] = profile
    config_section["rules_source"] = rules_source
    config_section["rules_ref"] = rules_ref
    config_section["rules_repo"] = rules_repo
    meta["config"] = config_section

    with open(meta_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(meta, f, default_flow_style=False, sort_keys=False)

    # 4. Recount workspace files (now that inputs are removed) and update metrics
    metrics_path = output_dir / "run-metrics.yaml"
    if metrics_path.exists():
        with open(metrics_path, encoding="utf-8") as f:
            metrics = yaml.safe_load(f) or {}

        dst_docs = output_dir / "aidlc-docs"
        metrics.setdefault("artifacts", {})["workspace"] = _count_workspace_files(workspace)
        if dst_docs.is_dir():
            metrics["artifacts"]["aidlc_docs"] = _count_doc_files(dst_docs)

        with open(metrics_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(metrics, f, default_flow_style=False, sort_keys=False)


def run_cli_evaluation(
    adapter: CLIAdapter,
    vision_path: Path,
    output_dir: Path,
    golden_docs: Path,
    rules_path: Path,
    tech_env_path: Path | None = None,
    openapi_path: Path | None = None,
    baseline_path: Path | None = None,
    profile: str | None = None,
    region: str | None = None,
    scorer_model: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    report_format: str = "both",
    prompt_template: str | None = None,
    model: str | None = None,
    timeout_seconds: int = 7200,
    rules_source: str = "git",
    rules_ref: str = "main",
    rules_repo: str = "https://github.com/awslabs/aidlc-workflows.git",
) -> tuple[AdapterResult, int]:
    """Run the full CLI evaluation pipeline.

    Steps:
    1. Check adapter prerequisites
    2. Run the adapter to generate AIDLC outputs
    3. Normalize the run folder layout (clean workspace, copy inputs to root)
    4. Invoke run_evaluation.py --evaluate-only to score the output

    Returns:
        (adapter_result, eval_exit_code)
    """
    # 1. Check prerequisites
    ok, msg = adapter.check_prerequisites()
    if not ok:
        print(f"[ERROR] {adapter.name} prerequisites not met: {msg}", file=sys.stderr)
        return AdapterResult(
            success=False,
            output_dir=output_dir,
            error=f"Prerequisites not met: {msg}",
        ), 1

    print(f"[OK] {adapter.name} prerequisites met: {msg}")

    # 2. Run the adapter
    config = AdapterConfig(
        vision_path=vision_path,
        tech_env_path=tech_env_path,
        rules_path=rules_path,
        output_dir=output_dir,
        prompt_template=prompt_template,
        model=model,
        aws_profile=profile,
        timeout_seconds=timeout_seconds,
    )

    print(f"\nRunning {adapter.name} adapter...")
    result = adapter.run(config)

    if not result.success:
        print(f"[FAILED] {adapter.name}: {result.error}", file=sys.stderr)
        return result, 1

    print(f"[OK] {adapter.name} completed in {result.elapsed_seconds:.0f}s")

    # 3. Normalize run folder layout to match the execution pipeline
    _normalize_run_folder(
        output_dir,
        vision_path=vision_path,
        tech_env_path=tech_env_path,
        adapter_name=adapter.name,
        profile=profile,
        region=region,
        rules_source=rules_source,
        rules_ref=rules_ref,
        rules_repo=rules_repo,
    )

    # 4. Verify aidlc-docs were produced
    aidlc_docs = result.aidlc_docs_dir or output_dir / "aidlc-docs"
    if not aidlc_docs.is_dir():
        print(f"[ERROR] No aidlc-docs directory found at {aidlc_docs}", file=sys.stderr)
        result.success = False
        result.error = "No aidlc-docs produced"
        return result, 1

    doc_files = [f for f in aidlc_docs.rglob("*.md")
                 if f.name not in ("aidlc-state.md", "audit.md")]
    if not doc_files:
        print("[WARN] aidlc-docs exists but contains no substantive documents")

    # 5. Run evaluation pipeline (stages 2-6)
    eval_cmd = [
        sys.executable, str(REPO_ROOT / "run_evaluation.py"),
        "--evaluate-only", str(aidlc_docs),
        "--golden", str(golden_docs),
        "--results", str(output_dir / "qualitative-comparison.yaml"),
        "--scorer-model", scorer_model,
        "--report-format", report_format,
    ]
    if profile:
        eval_cmd += ["--profile", profile]
    if region:
        eval_cmd += ["--region", region]
    if openapi_path and openapi_path.is_file():
        eval_cmd += ["--openapi", str(openapi_path)]
    if baseline_path and baseline_path.is_file():
        eval_cmd += ["--baseline", str(baseline_path)]

    print(f"\nRunning evaluation pipeline on {adapter.name} output...")
    # nosec B603 - Executing trusted framework evaluation script with validated args
    # nosemgrep: dangerous-subprocess-use-audit
    eval_result = subprocess.run(eval_cmd)

    return result, eval_result.returncode
