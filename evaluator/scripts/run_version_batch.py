#!/usr/bin/env python3
"""Cross-version batch evaluation: v1 vs v1.5 vs v2 through the real claude CLI.

Runs each enabled version (from config/versions.yaml) N times via the
claude-cli adapter, each in its own unique output folder, under a bounded
thread pool so at most --max-parallel runs execute at once. Each version is
scored against its OWN golden scenario (goldens differ by version).

Writes runs/<batch-id>/version-batch-manifest.yaml mapping every run folder to
its version + run index + exit status, plus per-run logs. Feed the batch dir
to `run.py version-report` for the aggregated cross-version comparison.

    uv run python run.py version-batch [--versions v1.5,v2] [--runs 3]
                                       [--max-parallel 3] [--scope mvp]
"""

from __future__ import annotations

import argparse
import concurrent.futures
import subprocess
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent   # evaluator/
FRAMEWORK_ROOT = REPO_ROOT.parent                     # the AIDLC repo
SCRIPTS_DIR = REPO_ROOT / "scripts"
TEST_CASES_DIR = REPO_ROOT / "test_cases"
RUNS_DIR = REPO_ROOT / "runs"
VERSIONS_CONFIG = REPO_ROOT / "config" / "versions.yaml"

_print_lock = threading.Lock()


def _log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def load_versions(path: Path) -> tuple[dict, dict]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    return data.get("versions", {}), data.get("defaults", {})


def resolve_dist(raw: str | None) -> Path | None:
    """Resolve a claude_dist path (relative paths resolve from FRAMEWORK_ROOT)."""
    if not raw:
        return None
    p = Path(raw)
    if not p.is_absolute():
        p = (REPO_ROOT / raw).resolve()
    return p if p.is_dir() else None


def scenario_inputs(scenario: str) -> dict | None:
    """Resolve a scenario's input paths.

    Greenfield (default): vision/tech-env/openapi/golden/baseline under
    test_cases/<scenario>/. Brownfield: a scenario dir carrying a
    ``scenario.yaml`` with ``kind: brownfield`` (e.g.
    ``brownfield/httpbin``) — returns seed_repo/task + the contract oracle
    (contract_openapi for a bugfix, contract_hurl for a feature).
    """
    base = TEST_CASES_DIR / scenario
    if not base.is_dir():
        return None
    sy = base / "scenario.yaml"
    if sy.is_file():
        meta = yaml.safe_load(sy.read_text(encoding="utf-8")) or {}
        if meta.get("kind") == "brownfield":
            # Repeatability preflight: the pinned upstream_commit must match the
            # frozen snapshot's UPSTREAM_COMMIT source-of-truth. A mismatch means
            # the seed was re-vendored without updating the pin (or vice versa) —
            # abort rather than silently score against unexpected code.
            pin = (meta.get("upstream_commit") or "").strip()
            upstream_file = base / "UPSTREAM_COMMIT"
            if pin and upstream_file.is_file():
                actual = upstream_file.read_text(encoding="utf-8").strip()
                if actual != pin:
                    raise SystemExit(
                        f"[{scenario}] upstream_commit pin ({pin}) does not match "
                        f"UPSTREAM_COMMIT ({actual}) — the brownfield seed is not at "
                        f"its pinned commit. Re-vendor the seed or fix the pin."
                    )
            out: dict = {
                "brownfield": True,
                "seed_repo": base / meta["seed_repo"],
                "task": base / meta["task"],
                "tech_env": base / meta["tech_env"] if meta.get("tech_env") else None,
                "upstream_commit": pin or None,
            }
            if meta.get("contract_hurl"):
                out["contract_hurl"] = base / meta["contract_hurl"]
            if meta.get("contract_openapi"):
                out["openapi"] = base / meta["contract_openapi"]
            return out
    return {
        "vision": base / "vision.md",
        "tech_env": base / "tech-env.md",
        "openapi": base / "openapi.yaml",
        "golden": base / "golden-aidlc-docs",
        "baseline": base / "golden.yaml",
    }


def run_one(
    version: str,
    run_idx: int,
    spec: dict,
    batch_dir: Path,
    scope: str,
    profile: str | None,
    region: str | None,
    timeout_seconds: int | None,
    capture_tokens_otel: bool,
    scenario_override: str | None = None,
) -> dict:
    """Execute a single version run via run_cli_evaluation.py in its own folder.

    ``scenario_override`` (from --scenario) runs the whole version matrix
    against one chosen scenario (e.g. a brownfield task like brownfield/httpbin)
    instead of each version's own default. v1's own scenario stays a separate
    key only because v1 needs its rules_path transport — the scenario *inputs*
    (seed/task/contract) come from the override.
    """
    scenario = scenario_override or spec["scenario"]
    inputs = scenario_inputs(scenario)
    slug = version.replace(".", "_")
    out_dir = batch_dir / f"{slug}-run{run_idx:02d}"
    log_path = batch_dir / f"{slug}-run{run_idx:02d}.log"

    if inputs is None:
        return {"version": version, "run": run_idx, "status": "error",
                "error": f"scenario '{scenario}' not found", "output_dir": str(out_dir)}

    # Per-version scope override wins over the batch default. Use "adaptive"
    # (omits --scope) for engines that auto-detect and run only the necessary
    # stages — e.g. the v2-odyssey adaptive branch; don't force it to a mode.
    effective_scope = spec.get("scope", scope)
    cmd = [
        sys.executable, str(SCRIPTS_DIR / "run_cli_evaluation.py"),
        "--cli", "claude-cli",
        "--output-dir", str(out_dir),   # unique per run — avoids the .last_run_folder race
        "--scope", effective_scope,
    ]
    if inputs.get("brownfield"):
        cmd += ["--seed-repo", str(inputs["seed_repo"]), "--task", str(inputs["task"])]
        if inputs.get("tech_env"):
            cmd += ["--tech-env", str(inputs["tech_env"])]
        if inputs.get("contract_hurl"):
            cmd += ["--contract-hurl-dir", str(inputs["contract_hurl"])]
        elif inputs.get("openapi"):
            cmd += ["--openapi", str(inputs["openapi"])]
    else:
        cmd += [
            "--vision", str(inputs["vision"]),
            "--tech-env", str(inputs["tech_env"]),
            "--openapi", str(inputs["openapi"]),
            "--golden", str(inputs["golden"]),
            "--baseline", str(inputs["baseline"]),
        ]

    # Version transport: v1.5/v2 install a .claude dist and drive /aidlc; v1
    # (legacy) installs core-workflow.md + rule-details from --rules-path and
    # self-drives from the monolith prompt.
    dist = resolve_dist(spec.get("claude_dist"))
    rules_path = spec.get("rules_path")
    # v1's rules_path is a repo root; run_cli_evaluation copies <root>/aidlc-rules.
    rules_ok = rules_path and (Path(rules_path) / "aidlc-rules").is_dir()
    if dist is not None:
        cmd += ["--claude-dist", str(dist)]
    elif rules_ok:
        cmd += ["--rules-path", str(rules_path)]
    else:
        return {"version": version, "run": run_idx, "status": "skipped",
                "error": f"no claude_dist, and rules_path lacks aidlc-rules/: {rules_path}",
                "output_dir": str(out_dir)}
    if profile:
        cmd += ["--profile", profile]
    if region:
        cmd += ["--region", region]
    # Per-version timeout override wins over the batch default; v2 needs a long
    # ceiling (full 32-stage MVP + reviewer sub-agents), v1/v1.5 far less.
    effective_timeout = spec.get("timeout_seconds", timeout_seconds)
    if effective_timeout:
        cmd += ["--timeout-seconds", str(effective_timeout)]
    if capture_tokens_otel:
        cmd += ["--capture-tokens-otel"]

    _log(f"  ▶ {version} run {run_idx}: starting (scope={effective_scope}) → {out_dir.name}")
    started = datetime.now(UTC)
    with open(log_path, "w", encoding="utf-8") as lf:
        proc = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, check=False)
    elapsed = (datetime.now(UTC) - started).total_seconds()
    status = "passed" if proc.returncode == 0 else "failed"
    _log(f"  ✓ {version} run {run_idx}: {status} ({elapsed:.0f}s, exit {proc.returncode})")
    return {
        "version": version, "run": run_idx, "status": status,
        "exit_code": proc.returncode, "elapsed_seconds": round(elapsed, 1),
        "output_dir": str(out_dir), "log": str(log_path),
        "scenario": scenario, "claude_dist": str(dist),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Cross-version batch via the claude CLI")
    ap.add_argument("--versions", default=None,
                    help="Comma-separated subset (e.g. v1.5,v2). Default: all enabled in versions.yaml")
    ap.add_argument("--runs", type=int, default=None, help="Runs per version (default: versions.yaml)")
    ap.add_argument("--max-parallel", type=int, default=None,
                    help="Max concurrent runs (default: versions.yaml). Mind Bedrock throttling.")
    ap.add_argument("--scope", default=None, help="AIDLC scope (default: versions.yaml)")
    ap.add_argument("--timeout-seconds", type=int, default=None,
                    help="Per-run wall-clock ceiling (default: versions.yaml "
                    "defaults.timeout_seconds, else run_cli_evaluation's default). A version's "
                    "own timeout_seconds in versions.yaml overrides this.")
    ap.add_argument("--capture-tokens-otel", action="store_true",
                    help="Enable per-run OTEL token capture (CloudWatch by session.id) for "
                    "every run. OFF by default. Requires OTEL config in ~/.claude/settings.json.")
    ap.add_argument("--scenario", default=None,
                    help="Run the whole version matrix against ONE scenario "
                    "(e.g. brownfield/httpbin) instead of each version's own "
                    "default. Used for the brownfield task batches.")
    ap.add_argument("--config", type=Path, default=VERSIONS_CONFIG)
    ap.add_argument("--profile", default=None)
    ap.add_argument("--region", default=None)
    ap.add_argument("--report/--no-report", dest="report", default=True, action="store_true")
    ap.add_argument("--no-report", dest="report", action="store_false")
    args = ap.parse_args()

    versions, defaults = load_versions(args.config)
    runs_per = args.runs or defaults.get("runs_per_version", 3)
    max_parallel = args.max_parallel or defaults.get("max_parallel", 3)
    scope = args.scope or defaults.get("scope", "mvp")
    timeout_seconds = args.timeout_seconds or defaults.get("timeout_seconds")

    # Select versions: explicit subset, else all enabled.
    if args.versions:
        wanted = [v.strip() for v in args.versions.split(",")]
        selected = {v: versions[v] for v in wanted if v in versions}
        missing = [v for v in wanted if v not in versions]
        if missing:
            _log(f"WARNING: unknown versions ignored: {missing}")
    else:
        selected = {v: s for v, s in versions.items() if s.get("enabled")}

    if not selected:
        _log("No versions selected. Enable some in versions.yaml or pass --versions.")
        sys.exit(1)

    # Self-describing batch dir: embed the task so `ls runs/` reads as a
    # history ("...-greenfield-version-batch", "...-brownfield-httpbin-
    # version-batch") instead of opaque timestamps. A --scenario override
    # names the batch after that task; otherwise all selected versions run
    # their own default (greenfield) scenario. The "-version-batch" suffix is
    # load-bearing: run_v2_suite.sh globs `runs/*-version-batch`.
    task_label = (args.scenario or "greenfield").strip("/").replace("/", "-")
    batch_id = (
        datetime.now(UTC).strftime("%Y%m%dT%H%M%S") + f"-{task_label}-version-batch"
    )
    batch_dir = RUNS_DIR / batch_id
    batch_dir.mkdir(parents=True, exist_ok=True)

    # Per-version run counts: an explicit --runs flag wins everywhere;
    # otherwise a version's own `runs:` in versions.yaml overrides
    # defaults.runs_per_version — used for asymmetric designs (more runs of
    # the cheap versions, fewer of the expensive ones) since statistical
    # power needs differ by effect size.
    def runs_for(spec: dict) -> int:
        if args.runs is not None:
            return args.runs
        return int(spec.get("runs", runs_per))

    counts = {v: runs_for(s) for v, s in selected.items()}
    _log(f"Cross-version batch: {counts} runs, max_parallel={max_parallel}")
    _log(f"Batch dir: {batch_dir}\n")

    jobs = [
        (v, i, spec)
        for v, spec in selected.items()
        for i in range(1, runs_for(spec) + 1)
    ]
    results: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_parallel) as pool:
        futs = {
            pool.submit(run_one, v, i, spec, batch_dir, scope, args.profile, args.region,
                        timeout_seconds, args.capture_tokens_otel, args.scenario): (v, i)
            for (v, i, spec) in jobs
        }
        for fut in concurrent.futures.as_completed(futs):
            try:
                results.append(fut.result())
            except Exception as e:  # noqa: BLE001 — record, never abort the batch
                v, i = futs[fut]
                results.append({"version": v, "run": i, "status": "error", "error": str(e)})

    results.sort(key=lambda r: (r["version"], r["run"]))
    manifest = {
        "batch_id": batch_id,
        "task": task_label,
        "scenario": args.scenario or "per-version default (greenfield)",
        "created_at": datetime.now(UTC).isoformat(),
        "runs_per_version": runs_per,
        "runs_by_version": counts,
        "max_parallel": max_parallel,
        "scope": scope,
        "versions": list(selected),
        "results": results,
    }
    manifest_path = batch_dir / "version-batch-manifest.yaml"
    manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")

    passed = sum(1 for r in results if r["status"] == "passed")
    _log(f"\nBatch complete: {passed}/{len(results)} runs passed. Manifest: {manifest_path}")

    if args.report:
        _log("\nGenerating cross-version report...")
        rep = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "run_version_report.py"), "--batch-dir", str(batch_dir)],
            check=False,
        )
        if rep.returncode != 0:
            _log("Report generation failed (runs are preserved; rerun `run.py version-report`).")

    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
