#!/usr/bin/env python3
"""Cross-version comparison report from a version-batch.

Reads a version-batch manifest, collects BaselineMetrics from every run
folder, aggregates per version (median + mean across the N runs, since
model/CLI nondeterminism makes single runs noisy), and emits a version-keyed
comparison — the v1 vs v1.5 vs v2 view for the AIDLC thesis (time, tokens,
quality). Each version is scored against its own golden, so the qualitative
columns are within-version fidelity, not cross-version doc-structure diffs.

    uv run python run.py version-report --batch-dir runs/<batch-id>
"""

from __future__ import annotations

import argparse
import itertools
import statistics
import sys
from datetime import UTC, datetime
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "packages" / "reporting" / "src"))
sys.path.insert(0, str(REPO_ROOT / "packages" / "shared" / "src"))

from reporting.baseline import BaselineMetrics, extract_baseline  # noqa: E402
from reporting.collector import collect  # noqa: E402

# (label, category, attribute, decimals, higher_is_better) — the axes that
# matter for the thesis first, then supporting quality/artifact metrics.
_METRIC_ROWS = [
    ("Wall clock (min)", "Cost", "wall_clock_ms", 1, False),
    # Cost (USD) is the robust consumption axis: claude_code.cost.usage is always
    # emitted and already weights in/out/cache at real prices. The raw token
    # total is dominated by cache-read and the per-type split isn't published for
    # PTY-driven sessions, so cost is the fair "how much did it use" number.
    ("Cost (USD)", "Cost", "cost_usd", 4, False),
    ("Total tokens", "Cost", "total_tokens", 0, False),
    ("Input tokens", "Cost", "input_tokens", 0, False),
    ("Output tokens", "Cost", "output_tokens", 0, False),
    ("Unit tests passed", "Quality", "tests_passed", 0, True),
    ("Unit pass %", "Quality", "tests_pass_pct", 1, True),
    ("Coverage %", "Quality", "coverage_pct", 1, True),
    ("Contract passed", "Quality", "contract_passed", 0, True),
    ("Lint errors", "Quality", "lint_errors", 0, False),
    ("Security high", "Quality", "security_high", 0, False),
    ("Qualitative (overall)", "Quality", "qualitative_score", 3, True),
    ("Source files", "Artifacts", "source_files", 0, True),
    ("Lines of code", "Artifacts", "lines_of_code", 0, True),
    ("Doc files", "Artifacts", "doc_files", 0, True),
]


def _attr(m: BaselineMetrics, name: str) -> float:
    return float(getattr(m, name, 0) or 0)


# Consumption axes get pairwise significance tests; quality scores stay
# descriptive (each version is scored against its OWN golden, so cross-version
# inference on them is conceptually shaky regardless of n).
_STAT_ATTRS = [
    ("Wall clock", "wall_clock_ms"),
    ("Cost (USD)", "cost_usd"),
    ("Total tokens", "total_tokens"),
]


def _midranks(pooled: list[float]) -> list[float]:
    order = sorted(range(len(pooled)), key=lambda i: pooled[i])
    ranks = [0.0] * len(pooled)
    i = 0
    while i < len(pooled):
        j = i
        while j + 1 < len(pooled) and pooled[order[j + 1]] == pooled[order[i]]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = avg_rank
        i = j + 1
    return ranks


def mann_whitney_p(x: list[float], y: list[float], max_exact: int = 300_000) -> float | None:
    """Two-sided Mann-Whitney U p-value, exact by permutation of midranks.

    Exact enumeration is feasible at these sample sizes (n=10 vs 10 →
    C(20,10)=184,756 arrangements); ties are handled by midranks, which makes
    the enumeration an exact permutation test on the rank sum. Falls back to
    the normal approximation with tie correction if the arrangement count
    exceeds max_exact. Returns None when either group is empty or all pooled
    values are identical (no test possible).
    """
    from math import comb, erf, sqrt

    n1, n2 = len(x), len(y)
    if n1 == 0 or n2 == 0:
        return None
    pooled = list(x) + list(y)
    if min(pooled) == max(pooled):
        return None
    ranks = _midranks(pooled)
    w_obs = sum(ranks[:n1])
    mean_w = n1 * (n1 + n2 + 1) / 2
    total = comb(n1 + n2, n1)
    if total <= max_exact:
        threshold = abs(w_obs - mean_w) - 1e-9
        count = sum(
            1 for combo in itertools.combinations(ranks, n1)
            if abs(sum(combo) - mean_w) >= threshold
        )
        return count / total
    # Normal approximation with tie correction (large n only).
    n = n1 + n2
    tie_counts: dict[float, int] = {}
    for r in ranks:
        tie_counts[r] = tie_counts.get(r, 0) + 1
    tie_term = sum(t**3 - t for t in tie_counts.values())
    var_w = n1 * n2 / 12 * ((n + 1) - tie_term / (n * (n - 1)))
    if var_w <= 0:
        return None
    z = (abs(w_obs - mean_w) - 0.5) / sqrt(var_w)
    return max(0.0, min(1.0, 2 * (1 - 0.5 * (1 + erf(z / sqrt(2))))))


def collect_version_runs(batch_dir: Path) -> dict[str, list[BaselineMetrics]]:
    """Group each passed run's metrics by version, per the batch manifest."""
    manifest = yaml.safe_load((batch_dir / "version-batch-manifest.yaml").read_text())
    by_version: dict[str, list[BaselineMetrics]] = {}
    for r in manifest.get("results", []):
        if r.get("status") != "passed":
            continue
        folder = Path(r["output_dir"])
        if not folder.is_dir():
            # Manifests carry absolute paths from the machine that ran the
            # batch; when a batch is copied elsewhere, resolve by folder name
            # inside the batch dir instead.
            folder = batch_dir / Path(r["output_dir"]).name
        if not folder.is_dir():
            continue
        try:
            metrics = extract_baseline(collect(folder))
        except Exception as e:  # noqa: BLE001
            print(f"  [WARN] collect failed for {folder}: {e}", file=sys.stderr)
            continue
        by_version.setdefault(r["version"], []).append(metrics)
    return by_version


def _student_t_95(n: int) -> float:
    """Two-sided t critical value at 95% for n-1 degrees of freedom.

    Table for small n (where the normal approx z=1.96 understates the interval);
    converges to 1.96 for large n. FR-1.3 asks for a 95% CI, and at n=3-10 the
    t-distribution is the honest choice — using z would report intervals that
    are too tight.
    """
    table = {
        1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447,
        7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 12: 2.179, 15: 2.131,
        20: 2.086, 30: 2.042, 60: 2.000,
    }
    df = max(1, n - 1)
    if df in table:
        return table[df]
    # nearest lower key, floor at 1.96
    keys = sorted(table)
    for k in reversed(keys):
        if k <= df:
            return table[k]
    return 1.96


def _agg(values: list[float]) -> dict:
    """Aggregate a metric's per-run values: median, mean, SD, and 95% CI.

    SD is the sample standard deviation (n-1); the 95% CI is mean ± t*·SD/√n
    using the Student-t critical value for n-1 df (honest for small n). n<2
    yields sd=0 and a zero-width CI (undefined dispersion from one point).
    """
    vals = [v for v in values if v is not None]
    if not vals:
        return {"median": 0.0, "mean": 0.0, "sd": 0.0, "ci95": 0.0, "n": 0}
    mean = statistics.mean(vals)
    if len(vals) < 2:
        return {"median": statistics.median(vals), "mean": mean,
                "sd": 0.0, "ci95": 0.0, "n": len(vals)}
    sd = statistics.stdev(vals)
    half = _student_t_95(len(vals)) * sd / (len(vals) ** 0.5)
    return {"median": statistics.median(vals), "mean": mean,
            "sd": sd, "ci95": half, "n": len(vals)}


def _fmt(val: float, decimals: int, attr: str) -> str:
    if attr == "wall_clock_ms":
        return f"{val / 60000:.1f}"  # ms → minutes
    if decimals == 0:
        return f"{int(round(val)):,}"
    return f"{val:.{decimals}f}"


def build_report(batch_dir: Path, by_version: dict[str, list[BaselineMetrics]]) -> tuple[str, dict]:
    versions = sorted(by_version)
    # Precompute aggregates: version → attr → {median, mean, n}
    agg: dict[str, dict[str, dict]] = {}
    for v in versions:
        runs = by_version[v]
        agg[v] = {attr: _agg([_attr(m, attr) for m in runs]) for _, _, attr, _, _ in _METRIC_ROWS}

    lines: list[str] = []
    lines.append("# AIDLC Cross-Version Comparison")
    lines.append("")
    lines.append(f"_Generated {datetime.now(UTC).isoformat(timespec='seconds')} from `{batch_dir.name}`._")
    lines.append("")
    lines.append("Each version scored against its own golden scenario (structures differ).")
    lines.append("Values are the **median across N runs** (mean ± 95% CI in parentheses; "
                 "CI uses the Student-t critical value for n-1 df, honest for small n). "
                 "Wall clock and tokens are real per-run measurements from the claude CLI.")
    lines.append("")
    header = "| Metric | Category | " + " | ".join(f"{v} (n={len(by_version[v])})" for v in versions) + " |"
    sep = "|" + "---|" * (len(versions) + 2)
    lines.append(header)
    lines.append(sep)
    last_cat = None
    for label, cat, attr, dec, _ in _METRIC_ROWS:
        cat_cell = cat if cat != last_cat else ""
        last_cat = cat
        cells = []
        for v in versions:
            a = agg[v][attr]
            if not a["n"]:
                cells.append("—")
            elif a["n"] < 2:
                cells.append(f"{_fmt(a['median'], dec, attr)} ({_fmt(a['mean'], dec, attr)})")
            else:
                cells.append(
                    f"{_fmt(a['median'], dec, attr)} "
                    f"({_fmt(a['mean'], dec, attr)} ± {_fmt(a['ci95'], dec, attr)})"
                )
        lines.append(f"| {label} | {cat_cell} | " + " | ".join(cells) + " |")

    # Pairwise significance on the consumption axes, when any version has n>1.
    # Exact Mann-Whitney U (permutation over midranks), two-sided. With n=1
    # everywhere this section is skipped — no inference from single runs.
    stats_data: dict[str, dict[str, dict]] = {}
    if any(len(by_version[v]) > 1 for v in versions) and len(versions) > 1:
        lines.append("")
        lines.append("## Statistical comparison (Mann-Whitney U, two-sided)")
        lines.append("")
        lines.append("Exact permutation p-values on the consumption axes. Medians with "
                     "[min–max] ranges. Quality scores are within-version fidelity "
                     "(each vs its own golden) and are reported descriptively only.")
        lines.append("")
        for label, attr in _STAT_ATTRS:
            lines.append(f"### {label}")
            lines.append("")
            lines.append("| Pair | Medians | Ranges | p-value |")
            lines.append("|---|---|---|---|")
            for va, vb in itertools.combinations(versions, 2):
                xa = [_attr(m, attr) for m in by_version[va]]
                xb = [_attr(m, attr) for m in by_version[vb]]
                dec = {"cost_usd": 2, "total_tokens": 0}.get(attr, 1)
                p = mann_whitney_p(xa, xb)
                p_txt = "—" if p is None else (f"{p:.4f}" + (" *" if p < 0.05 else ""))
                med = (f"{_fmt(statistics.median(xa), dec, attr)} vs "
                       f"{_fmt(statistics.median(xb), dec, attr)}")
                rng = (f"[{_fmt(min(xa), dec, attr)}–{_fmt(max(xa), dec, attr)}] vs "
                       f"[{_fmt(min(xb), dec, attr)}–{_fmt(max(xb), dec, attr)}]")
                lines.append(f"| {va} vs {vb} | {med} | {rng} | {p_txt} |")
                stats_data.setdefault(attr, {})[f"{va} vs {vb}"] = {
                    "p_value": p,
                    "n": [len(xa), len(xb)],
                    "medians": [statistics.median(xa), statistics.median(xb)],
                }
            lines.append("")
        lines.append("_* p < 0.05. Minimum achievable p depends on n: two non-overlapping "
                     "groups of n=5 reach p=0.008; n=10 vs 5 reaches p≈0.0003._")

        # Mean ± SD ± 95% CI on the consumption axes (FR-1.3 literal ask).
        # The Mann-Whitney table above is the significance test; this table is
        # the parametric summary (mean/SD/CI) FR-1.3 requests explicitly.
        lines.append("")
        lines.append("## Mean / SD / 95% CI (consumption axes)")
        lines.append("")
        lines.append("Parametric summary per FR-1.3. CI half-width is t·SD/√n (Student-t, "
                     "n-1 df). Non-overlapping CIs between two versions indicate a "
                     "significant mean difference at ~95%.")
        lines.append("")
        for label, attr in _STAT_ATTRS:
            dec = {"cost_usd": 2, "total_tokens": 0}.get(attr, 1)
            lines.append(f"### {label}")
            lines.append("")
            lines.append("| Version | Mean | SD | 95% CI |")
            lines.append("|---|---|---|---|")
            for v in versions:
                a = agg[v][attr]
                if not a["n"]:
                    lines.append(f"| {v} | — | — | — |")
                elif a["n"] < 2:
                    lines.append(f"| {v} | {_fmt(a['mean'], dec, attr)} | n/a (n=1) | n/a (n=1) |")
                else:
                    lo, hi = a["mean"] - a["ci95"], a["mean"] + a["ci95"]
                    lines.append(
                        f"| {v} | {_fmt(a['mean'], dec, attr)} | {_fmt(a['sd'], dec, attr)} | "
                        f"[{_fmt(lo, dec, attr)}, {_fmt(hi, dec, attr)}] |"
                    )
            lines.append("")

    data = {
        "batch_dir": str(batch_dir),
        "generated_at": datetime.now(UTC).isoformat(),
        "versions": {
            v: {
                "runs": len(by_version[v]),
                "metrics": {attr: agg[v][attr] for _, _, attr, _, _ in _METRIC_ROWS},
            }
            for v in versions
        },
        "significance": stats_data,
    }
    return "\n".join(lines) + "\n", data


def main() -> None:
    ap = argparse.ArgumentParser(description="Cross-version comparison report")
    ap.add_argument("--batch-dir", type=Path, required=True)
    args = ap.parse_args()

    manifest = args.batch_dir / "version-batch-manifest.yaml"
    if not manifest.is_file():
        print(f"No version-batch-manifest.yaml in {args.batch_dir}", file=sys.stderr)
        sys.exit(1)

    by_version = collect_version_runs(args.batch_dir)
    if not by_version:
        print("No passed runs with collectable metrics found.", file=sys.stderr)
        sys.exit(1)

    md, data = build_report(args.batch_dir, by_version)
    out_dir = args.batch_dir / "version-comparison"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "version-comparison.md").write_text(md, encoding="utf-8")
    (out_dir / "version-comparison.yaml").write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    print(f"Wrote {out_dir / 'version-comparison.md'}")
    print("\n" + md)


if __name__ == "__main__":
    main()
