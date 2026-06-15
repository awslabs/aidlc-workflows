#!/usr/bin/env python3
"""Aggregate stability metrics across a batch of claude-code runs.

Scans every recent claude-code run folder, parses report.md for unit-test %,
contract pass count, and qualitative score, and prints per-run rows plus
mean / stddev / min / max. Distinguishes runs that produced no report (a hard
failure — adapter or Bedrock died) from runs that completed but scored low.

Usage:
    python scripts/stability_aggregate.py [--since-minutes N] [--n N]
"""

from __future__ import annotations

import argparse
import re
import statistics
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNS = REPO_ROOT / "runs"

_UNIT_RE = re.compile(r"Unit Tests \|.*?([\d.]+)%.*?\((\d+)/(\d+)\)")
_CONTRACT_RE = re.compile(r"Contract Tests \|.*?(\d+)/(\d+)")
_QUAL_RE = re.compile(r"Qualitative Score \|.*?([\d.]+)")
_TIME_RE = re.compile(r"Execution Time \|.*?([\d.]+)m")


def parse_report(report: Path) -> dict | None:
    text = report.read_text(encoding="utf-8", errors="replace")
    u = _UNIT_RE.search(text)
    c = _CONTRACT_RE.search(text)
    q = _QUAL_RE.search(text)
    t = _TIME_RE.search(text)
    if not (u and c and q):
        return None
    return {
        "unit_pct": float(u.group(1)),
        "unit": f"{u.group(2)}/{u.group(3)}",
        "contract_pass": int(c.group(1)),
        "contract_total": int(c.group(2)),
        "qual": float(q.group(1)),
        "minutes": float(t.group(1)) if t else None,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--since-minutes",
        type=int,
        default=720,
        help="Only consider run folders modified within this window (default 12h)",
    )
    ap.add_argument("--n", type=int, default=None, help="Cap to the N most recent claude-code runs")
    args = ap.parse_args()

    cutoff = datetime.now(UTC) - timedelta(minutes=args.since_minutes)
    folders = sorted(
        (
            p
            for p in RUNS.glob("*claude-code")
            if datetime.fromtimestamp(p.stat().st_mtime, UTC) >= cutoff
        ),
        key=lambda p: p.stat().st_mtime,
    )
    if args.n:
        folders = folders[-args.n :]

    completed, failed = [], []
    print(f"{'run':<48} {'unit%':>7} {'contract':>10} {'qual':>6} {'min':>6}")
    print("-" * 82)
    for f in folders:
        report = f / "report.md"
        rec = parse_report(report) if report.is_file() else None
        if rec is None:
            failed.append(f.name)
            print(f"{f.name:<48} {'—':>7} {'NO REPORT':>10} {'—':>6} {'—':>6}")
            continue
        completed.append(rec)
        print(
            f"{f.name:<48} {rec['unit_pct']:>6.1f}% "
            f"{rec['contract_pass']:>4}/{rec['contract_total']:<5} "
            f"{rec['qual']:>6.2f} {rec['minutes'] or 0:>6.1f}"
        )

    print("-" * 82)
    n_total = len(folders)
    n_ok = len(completed)
    print(f"\nRuns found: {n_total}   completed-with-report: {n_ok}   hard failures: {len(failed)}")
    if failed:
        print("  HARD FAILURES (no report — adapter/Bedrock died):")
        for name in failed:
            print(f"    - {name}")

    def summarize(label: str, vals: list[float], fmt: str = ".2f") -> None:
        if not vals:
            return
        mean = statistics.mean(vals)
        sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
        print(
            f"  {label:<14} mean={mean:{fmt}}  stddev={sd:{fmt}}  "
            f"min={min(vals):{fmt}}  max={max(vals):{fmt}}  (n={len(vals)})"
        )

    if completed:
        print("\nStability across completed runs:")
        summarize("unit %", [r["unit_pct"] for r in completed], ".1f")
        summarize("contract pass", [float(r["contract_pass"]) for r in completed], ".1f")
        summarize("qualitative", [r["qual"] for r in completed])
        mins = [r["minutes"] for r in completed if r["minutes"] is not None]
        summarize("minutes", mins, ".1f")

    # Reliability = fraction that completed end-to-end with a report at all.
    if n_total:
        print(f"\nReliability (produced report): {n_ok}/{n_total} = {100 * n_ok / n_total:.1f}%")


if __name__ == "__main__":
    main()
