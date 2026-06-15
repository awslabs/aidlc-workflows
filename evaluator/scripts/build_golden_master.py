#!/usr/bin/env python3
"""Golden master builder — run the AIDLC workflow N times, evaluate each run,
then synthesise the best golden document set.

Usage:
    python scripts/build_golden_master.py \
        --scenario sci-calc-v2 \
        --runs 20 \
        --profile sandbox26 \
        --rules-path /path/to/aidlc-workflows-v2

Phases:
  1. EXECUTE   — run aidlc-runner N times sequentially
  2. EVALUATE  — for each run: quantitative, contract tests, qualitative vs proxy golden
  3. RANK      — score each run; for each document slot find the best version
  4. SYNTHESISE — copy best-per-slot docs into test_cases/<scenario>/golden-aidlc-docs/
  5. REPORT    — write a summary of which run won each slot and overall scores
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGES = REPO_ROOT / "packages"
TEST_CASES_DIR = REPO_ROOT / "test_cases"
sys.path.insert(0, str(PACKAGES / "shared" / "src"))
sys.path.insert(0, str(PACKAGES / "qualitative" / "src"))

from shared.io import atomic_yaml_dump  # noqa: E402
from shared.scenario import resolve_scenario  # noqa: E402

# ── helpers ──────────────────────────────────────────────────────────────────


def ts() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def log(msg: str) -> None:
    print(f"[{ts()}] {msg}", flush=True)


def run_cmd(cmd: list[str], label: str, env: dict | None = None, timeout: int = 7200) -> int:
    """Run a subprocess, stream output, return exit code."""
    print(f"\n{'=' * 60}", flush=True)
    print(f"  {label}", flush=True)
    print(f"{'=' * 60}\n", flush=True)
    result = subprocess.run(cmd, env=env or os.environ.copy(), timeout=timeout)
    return result.returncode


def read_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    with open(path) as f:
        return yaml.safe_load(f) or {}


# ── phase 1: execute ─────────────────────────────────────────────────────────


def execute_run(run_idx: int, scenario, args: argparse.Namespace, output_dir: Path) -> Path | None:
    """Run aidlc-runner for one iteration. Returns run folder path or None on failure."""
    log(f"Run {run_idx:02d}/{args.runs} — starting execution")

    cmd = [
        sys.executable,
        "-m",
        "aidlc_runner",
        "--vision",
        str(scenario.vision_path),
        "--tech-env",
        str(scenario.tech_env_path),
        "--output-dir",
        str(output_dir),
    ]
    if args.profile:
        cmd += ["--aws-profile", args.profile]
    if args.rules_path:
        cmd += ["--rules-path", args.rules_path]
    if args.executor_model:
        cmd += ["--executor-model", args.executor_model]

    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            [
                str(PACKAGES / "execution" / "src"),
                str(PACKAGES / "shared" / "src"),
            ]
        ),
    }

    # Snapshot existing run folders so we can find the new one
    before = {d for d in output_dir.iterdir() if d.is_dir()} if output_dir.exists() else set()

    try:
        subprocess.run(cmd, env=env, timeout=7200)
    except subprocess.TimeoutExpired:
        log(f"Run {run_idx:02d} TIMED OUT after 2h")
        return None

    # Find new run folder via sentinel
    sentinel = output_dir / ".last_run_folder"
    run_folder = None
    if sentinel.is_file():
        run_folder = Path(sentinel.read_text().strip())
        sentinel.unlink(missing_ok=True)
    if run_folder is None or not run_folder.is_dir():
        after = {d for d in output_dir.iterdir() if d.is_dir()}
        new = sorted(after - before, reverse=True)
        run_folder = new[0] if new else None

    if run_folder is None:
        log(f"Run {run_idx:02d} FAILED — no run folder found")
        return None

    log(f"Run {run_idx:02d} complete — {run_folder.name}")
    return run_folder


# ── phase 2: evaluate ────────────────────────────────────────────────────────


def evaluate_run(run_folder: Path, scenario, args: argparse.Namespace, proxy_golden: Path) -> dict:
    """Run quality + contract + qualitative evaluation. Returns summary dict."""
    log(f"  Evaluating {run_folder.name}")
    scores: dict = {"run_folder": str(run_folder), "run_name": run_folder.name}

    # Post-run tests (already in test-results.yaml from execution)
    test_data = read_yaml(run_folder / "test-results.yaml")
    parsed = test_data.get("test", {}).get("parsed_results", {})
    scores["unit_tests_passed"] = parsed.get("passed", 0) or 0
    scores["unit_tests_total"] = parsed.get("total", 0) or 0
    scores["unit_tests_ok"] = test_data.get("test", {}).get("success", False)

    # Quantitative
    quality_path = run_folder / "quality-report.yaml"
    env_quant = {**os.environ, "PYTHONPATH": str(PACKAGES / "quantitative" / "src")}
    workspace = run_folder / "workspace"
    if workspace.is_dir():
        subprocess.run(
            [
                sys.executable,
                "-m",
                "quantitative",
                "analyze",
                str(workspace),
                "--output",
                str(quality_path),
            ],
            env=env_quant,
            capture_output=True,
        )
    quality_data = read_yaml(quality_path)
    summary = quality_data.get("summary", {})
    scores["lint_errors"] = summary.get("lint_errors", 0)
    scores["security_high"] = summary.get("security_high", 0)

    # Contract tests
    contract_path = run_folder / "contract-test-results.yaml"
    if workspace.is_dir() and scenario.openapi_path.is_file():
        env_ct = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                [
                    str(PACKAGES / "contracttest" / "src"),
                    str(PACKAGES / "shared" / "src"),
                ]
            ),
        }
        subprocess.run(
            [
                sys.executable,
                "-m",
                "contracttest",
                "run",
                str(workspace),
                "--openapi",
                str(scenario.openapi_path),
                "--output",
                str(contract_path),
                "--no-sandbox",
            ],
            env=env_ct,
            capture_output=True,
        )
    contract_data = read_yaml(contract_path)
    scores["contract_passed"] = contract_data.get("passed", 0) or 0
    scores["contract_total"] = contract_data.get("total", 0) or 0
    scores["contract_ok"] = contract_data.get("passed", 0) == contract_data.get("total", 0) > 0

    # Qualitative vs proxy golden
    qual_path = run_folder / "qualitative-comparison.yaml"
    aidlc_docs = run_folder / "aidlc-docs"
    if aidlc_docs.is_dir() and proxy_golden.is_dir():
        env_qual = {**os.environ, "PYTHONPATH": str(PACKAGES / "qualitative" / "src")}
        subprocess.run(
            [
                sys.executable,
                "-m",
                "qualitative",
                "compare",
                "--reference",
                str(proxy_golden),
                "--candidate",
                str(aidlc_docs),
                "--model-id",
                args.scorer_model,
                "--output",
                str(qual_path),
                *(["--profile", args.profile] if args.profile else []),
            ],
            env=env_qual,
            capture_output=True,
        )
    qual_data = read_yaml(qual_path)
    scores["qualitative_overall"] = qual_data.get("overall_score", 0.0)
    scores["qualitative_phases"] = {
        p["phase"]: p["avg_overall"] for p in qual_data.get("phases", [])
    }
    # Per-document scores keyed by stripped path
    scores["document_scores"] = {}
    for phase in qual_data.get("phases", []):
        for doc in phase.get("documents", []):
            scores["document_scores"][doc["path"]] = doc["overall"]

    # Composite score: 40% qualitative + 30% contract + 20% unit tests + 10% quality
    unit_pct = scores["unit_tests_passed"] / max(scores["unit_tests_total"], 1)
    contract_pct = (
        scores["contract_passed"] / max(scores["contract_total"], 1)
        if scores["contract_total"] > 0
        else 0.0
    )
    quality_penalty = min(scores["lint_errors"] * 0.05 + scores["security_high"] * 0.2, 0.3)
    scores["composite"] = (
        scores["qualitative_overall"] * 0.40
        + contract_pct * 0.30
        + unit_pct * 0.20
        + (1.0 - quality_penalty) * 0.10
    )

    log(
        f"    composite={scores['composite']:.4f}  qual={scores['qualitative_overall']:.4f}"
        f"  contract={scores['contract_passed']}/{scores['contract_total']}"
        f"  units={scores['unit_tests_passed']}/{scores['unit_tests_total']}"
    )

    return scores


# ── phase 3: rank and select ──────────────────────────────────────────────────


def select_best(all_scores: list[dict], run_folders: list[Path]) -> tuple[Path, dict[str, Path]]:
    """Return (best_overall_run, {doc_path: best_run_folder}) ."""

    # Best single run by composite score
    best_run_scores = max(all_scores, key=lambda s: s["composite"])
    best_run_folder = next(f for f in run_folders if f.name == best_run_scores["run_name"])
    log(f"Best single run: {best_run_folder.name} (composite={best_run_scores['composite']:.4f})")

    # Best-per-document: for each doc slot find the run with the highest score
    all_doc_paths: set[str] = set()
    for s in all_scores:
        all_doc_paths.update(s["document_scores"].keys())

    best_per_doc: dict[str, Path] = {}
    for doc_path in sorted(all_doc_paths):
        best_score = -1.0
        best_folder = best_run_folder  # default to best overall
        for s in all_scores:
            score = s["document_scores"].get(doc_path, 0.0)
            if score > best_score:
                best_score = score
                best_folder = next(f for f in run_folders if f.name == s["run_name"])
        best_per_doc[doc_path] = best_folder
        log(f"  {doc_path}: best={best_folder.name} score={best_score:.4f}")

    return best_run_folder, best_per_doc


# ── phase 4: synthesise ───────────────────────────────────────────────────────


def synthesise_golden(
    best_per_doc: dict[str, Path],
    best_run_folder: Path,
    scenario,
) -> None:
    """Assemble the golden-aidlc-docs/ from best-per-slot candidates."""
    golden_dir = scenario.path / "golden-aidlc-docs"
    if golden_dir.exists():
        shutil.rmtree(golden_dir)
    golden_dir.mkdir()

    from qualitative.document import _INTENT_PREFIX, _SKIP_FILES

    # Collect all aidlc-docs md files from best_per_doc runs
    copied: set[str] = set()

    for stripped_path, run_folder in best_per_doc.items():
        # Find the actual file — it will be under intent-NNN-<slug>/stripped_path
        aidlc_docs = run_folder / "aidlc-docs"
        # Try direct match first (if golden already uses stripped paths)
        candidates = list(aidlc_docs.rglob(Path(stripped_path).name))
        source = None
        for c in candidates:
            rel = c.relative_to(aidlc_docs).as_posix()
            if _INTENT_PREFIX.sub("", rel) == stripped_path:
                source = c
                break
        if source is None or not source.exists():
            log(f"  WARN: could not find source for {stripped_path} in {run_folder.name}")
            continue

        dest = golden_dir / stripped_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, dest)
        copied.add(stripped_path)

    # Also copy any non-scored files (state, workflow, intent.md etc.) from
    # the best overall run that weren't in the scored set
    best_docs = best_run_folder / "aidlc-docs"
    for md_file in sorted(best_docs.rglob("*.md")):
        if md_file.name in _SKIP_FILES:
            continue
        rel = md_file.relative_to(best_docs).as_posix()
        stripped = _INTENT_PREFIX.sub("", rel)
        if stripped not in copied:
            dest = golden_dir / stripped
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(md_file, dest)
            copied.add(stripped)

    log(f"Synthesised golden with {len(copied)} documents in {golden_dir}")


# ── phase 5: summary report ───────────────────────────────────────────────────


def write_summary(
    all_scores: list[dict],
    best_per_doc: dict[str, Path],
    best_run_folder: Path,
    scenario,
    output_path: Path,
) -> None:
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scenario": scenario.name,
        "total_runs": len(all_scores),
        "best_run": best_run_folder.name,
        "runs": sorted(all_scores, key=lambda s: s["composite"], reverse=True),
        "best_per_document": {doc: folder.name for doc, folder in sorted(best_per_doc.items())},
    }
    atomic_yaml_dump(summary, output_path)
    log(f"Summary written to {output_path}")

    print(f"\n{'=' * 60}")
    print("  Golden Master Build Complete")
    print(f"{'=' * 60}")
    print(f"  Runs completed : {len(all_scores)}")
    print(f"  Best single run: {best_run_folder.name}")
    top3 = sorted(all_scores, key=lambda s: s["composite"], reverse=True)[:3]
    for i, s in enumerate(top3, 1):
        print(
            f"  #{i} {s['run_name']}: composite={s['composite']:.4f}  "
            f"qual={s['qualitative_overall']:.4f}  "
            f"contract={s['contract_passed']}/{s['contract_total']}  "
            f"units={s['unit_tests_passed']}/{s['unit_tests_total']}"
        )
    print(f"  Golden docs    : {scenario.path / 'golden-aidlc-docs'}")
    print(f"  Summary        : {output_path}")


# ── CLI ───────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="build_golden_master",
        description="Run AIDLC N times and synthesise a golden-master document set.",
    )
    p.add_argument("--scenario", default="sci-calc-v2", help="Scenario name or path")
    p.add_argument("--runs", type=int, default=20, help="Number of runs (default: 20)")
    p.add_argument("--profile", default=None, help="AWS profile")
    p.add_argument("--rules-path", default=None, help="Local rules path (skips git clone)")
    p.add_argument("--executor-model", default=None, help="Override executor model ID")
    p.add_argument(
        "--scorer-model",
        default="global.anthropic.claude-opus-4-6-v1",
        help="Bedrock model for qualitative scoring",
    )
    p.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Where to write run folders (default: runs/<scenario>/)",
    )
    p.add_argument(
        "--resume-from", type=int, default=1, help="Resume from run N (skip already-completed runs)"
    )
    return p


def main() -> None:
    args = build_parser().parse_args()

    scenario = resolve_scenario(args.scenario, TEST_CASES_DIR)
    log(f"Scenario: {scenario.name} — {scenario.description}")

    output_dir = args.output_dir or (REPO_ROOT / "runs" / scenario.name)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Proxy golden: use the current sci-calc golden (v2 restructured) as baseline scorer
    proxy_golden = TEST_CASES_DIR / "sci-calc-v2" / "golden-aidlc-docs"
    if not proxy_golden.is_dir():
        log("WARN: proxy golden not found — qualitative scoring will score 0")

    all_scores: list[dict] = []
    run_folders: list[Path] = []

    # Resume: collect already-completed runs
    if args.resume_from > 1:
        existing = sorted(d for d in output_dir.iterdir() if d.is_dir() and d.name[0].isdigit())
        for folder in existing[: args.resume_from - 1]:
            log(f"Resuming — evaluating existing run {folder.name}")
            scores = evaluate_run(folder, scenario, args, proxy_golden)
            all_scores.append(scores)
            run_folders.append(folder)

    # Execute remaining runs
    for i in range(args.resume_from, args.runs + 1):
        run_folder = execute_run(i, scenario, args, output_dir)
        if run_folder is None:
            log(f"Run {i:02d} failed — skipping evaluation")
            continue
        run_folders.append(run_folder)
        scores = evaluate_run(run_folder, scenario, args, proxy_golden)
        all_scores.append(scores)

        # Checkpoint after each run
        checkpoint_path = output_dir / "golden_build_progress.yaml"
        atomic_yaml_dump({"completed": len(all_scores), "scores": all_scores}, checkpoint_path)

    if not all_scores:
        log("No successful runs — cannot build golden master")
        sys.exit(1)

    log(f"\nAll {len(all_scores)} runs complete. Selecting best docs...")
    best_run_folder, best_per_doc = select_best(all_scores, run_folders)

    log("Synthesising golden-aidlc-docs...")
    synthesise_golden(best_per_doc, best_run_folder, scenario)

    summary_path = output_dir / "golden_build_summary.yaml"
    write_summary(all_scores, best_per_doc, best_run_folder, scenario, summary_path)


if __name__ == "__main__":
    main()
