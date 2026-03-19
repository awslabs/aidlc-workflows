"""Run orchestration — invoke an IDE adapter then run the evaluation pipeline."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import yaml

from ide_harness.adapter import AdapterConfig, AdapterResult, IDEAdapter
from ide_harness.normalizer import normalize_output


REPO_ROOT = Path(__file__).resolve().parents[4]  # packages/ide-harness/src/ide_harness -> repo root


def run_ide_evaluation(
    adapter: IDEAdapter,
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
    timeout_seconds: int = 7200,
    use_sandbox: bool = True,
) -> tuple[AdapterResult, int]:
    """Run the full IDE evaluation pipeline.

    Steps:
    1. Check adapter prerequisites
    2. Run the adapter to generate AIDLC outputs
    3. Normalize the output to the expected run folder layout
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
        timeout_seconds=timeout_seconds,
    )

    print(f"\nRunning {adapter.name} adapter...")
    result = adapter.run(config)

    if not result.success:
        print(f"[FAILED] {adapter.name}: {result.error}", file=sys.stderr)
        return result, 1

    print(f"[OK] {adapter.name} completed in {result.elapsed_seconds:.0f}s")

    # 3. Verify aidlc-docs were produced
    aidlc_docs = result.aidlc_docs_dir or output_dir / "aidlc-docs"
    if not aidlc_docs.is_dir():
        print(f"[ERROR] No aidlc-docs directory found at {aidlc_docs}", file=sys.stderr)
        result.success = False
        result.error = "No aidlc-docs produced"
        return result, 1

    doc_files = [f for f in aidlc_docs.rglob("*.md")
                 if f.name not in ("aidlc-state.md", "audit.md")]
    if not doc_files:
        print(f"[WARN] aidlc-docs exists but contains no substantive documents")

    # 4. Run evaluation pipeline (stages 2-6)
    eval_cmd = [
        sys.executable, str(REPO_ROOT / "run_evaluation.py"),
        "--evaluate-only", str(aidlc_docs),
        "--golden", str(golden_docs),
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
    if use_sandbox:
        eval_cmd.append("--sandbox")
    else:
        eval_cmd.append("--no-sandbox")

    print(f"\nRunning evaluation pipeline on {adapter.name} output...")
    # nosec B603 - Executing trusted framework evaluation script with validated args
    # nosemgrep: dangerous-subprocess-use-audit
    eval_result = subprocess.run(eval_cmd)

    return result, eval_result.returncode
