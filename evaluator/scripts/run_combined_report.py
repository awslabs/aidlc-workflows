#!/usr/bin/env python3
"""Combined greenfield + brownfield comparison report (rich format).

Rolls up ALL THREE standard tasks — greenfield (graded, scored against each
version's own golden) and the two brownfield tasks (bugfix + feature, scored
pass/fail against a third-party contract) — into one report modeled on the
per-run report format (verdict table with emoji deltas, statistics, per-run
drill-downs, collapsible failure detail).

The two task families are measured DIFFERENTLY on purpose and are kept in
SEPARATE sections so the axes never blend:

  * Greenfield → GRADED metrics: cost, wall-clock, and a 0-1 qualitative
    fidelity score (vs golden), with mean ± SD, 95% CI, and Mann-Whitney U
    significance on the consumption axes.
  * Brownfield → a DETERMINISTIC RELIABILITY measure: contract pass rate
    (a run "passes" iff every contract case passes — no partial credit, no
    0-1 grade), with Fisher's exact test on pass rates and per-run detail.

Brownfield has no golden and therefore NO qualitative 0-1 score; its quality
axis IS the contract pass rate.

    uv run python run.py combined-report \
        --greenfield runs/<gf-batch> \
        --brownfield-bug runs/<bug-batch> [--brownfield-bug <rerun-batch>] \
        --brownfield-feature runs/<feat-batch> [...] \
        --out evaluation/results/COMPARISON-combined-<date>.md
"""

from __future__ import annotations

import argparse
import re
import statistics
import sys
from dataclasses import dataclass, field
from math import comb
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "packages" / "reporting" / "src"))
sys.path.insert(0, str(REPO_ROOT / "packages" / "shared" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from reporting.baseline import BaselineMetrics, extract_baseline  # noqa: E402
from reporting.collector import collect  # noqa: E402
from run_version_report import _agg, _student_t_95, mann_whitney_p  # noqa: E402,F401

# Canonical column order; at build time this is narrowed to the versions that
# actually have data, so a single-version batch (e.g. the standalone v2
# evaluator) renders one column instead of empty comparisons.
_CANONICAL_ORDER = ["v1", "v1.5", "v2"]
VERSION_ORDER = list(_CANONICAL_ORDER)
_RUN_DIR_RE = re.compile(r"^(?P<slug>v[0-9_]+(?:\.[0-9]+)?)-run(?P<num>\d+)(?P<suffix>.*)$")


def _set_version_order(*collections: dict) -> None:
    """Narrow VERSION_ORDER to versions present in the collected data."""
    present: set[str] = set()
    for c in collections:
        present.update(c.keys())
    global VERSION_ORDER  # noqa: PLW0603
    VERSION_ORDER = [v for v in _CANONICAL_ORDER if v in present] + sorted(
        v for v in present if v not in _CANONICAL_ORDER
    )


def _pairs() -> list[tuple[str, str]]:
    """Comparison pairs among present versions (v1.5-first where applicable)."""
    order = sorted(VERSION_ORDER, key=lambda v: (v != "v1.5", v))
    return [(a, b) for i, a in enumerate(order) for b in order[i + 1:]]


# --- Statistics helpers ---------------------------------------------------------


def fisher_exact_p(a_pass: int, a_tot: int, b_pass: int, b_tot: int) -> float | None:
    """Two-sided Fisher's exact test on a 2×2 pass/fail table.

    The appropriate significance test for the brownfield DETERMINISTIC measure
    (pass counts, not continuous values — Mann-Whitney doesn't apply).
    """
    if a_tot == 0 or b_tot == 0:
        return None
    n = a_tot + b_tot
    k = a_pass + b_pass

    def p_table(x: int) -> float:
        return comb(a_tot, x) * comb(b_tot, k - x) / comb(n, k)

    p_obs = p_table(a_pass)
    total = 0.0
    for x in range(max(0, k - b_tot), min(a_tot, k) + 1):
        p = p_table(x)
        if p <= p_obs + 1e-12:
            total += p
    return min(total, 1.0)


def _fmt_p(p: float | None) -> str:
    if p is None:
        return "—"
    if p < 0.001:
        return "p<0.001"
    return f"p={p:.4f}".rstrip("0").rstrip(".")


def _sig_mark(p: float | None) -> str:
    if p is None:
        return ""
    return " ✅" if p < 0.05 else " ⚪"


def _med(values: list[float]) -> float | None:
    vals = [v for v in values if v is not None]
    return statistics.median(vals) if vals else None


def _fmt(v: float | None, decimals: int = 2, unit: str = "") -> str:
    if v is None:
        return "—"
    if decimals == 0:
        return f"{int(round(v)):,}{unit}"
    return f"{v:.{decimals}f}{unit}"


def _agg_cell(values: list[float], decimals: int = 2) -> str:
    """`mean ± sd (95% CI ±h, n=N)` cell for the statistics tables."""
    a = _agg([v for v in values if v is not None])
    if a["n"] == 0:
        return "—"
    if a["n"] < 2:
        return f"{a['mean']:.{decimals}f} (n=1)"
    return (
        f"{a['mean']:.{decimals}f} ± {a['sd']:.{decimals}f} "
        f"(CI ±{a['ci95']:.{decimals}f}, n={a['n']})"
    )


# --- Greenfield collection ------------------------------------------------------


def collect_greenfield(batch_dir: Path) -> dict[str, list[tuple[str, BaselineMetrics]]]:
    """Per-version [(run_name, metrics)] from a greenfield version-batch."""
    manifest = yaml.safe_load((batch_dir / "version-batch-manifest.yaml").read_text()) or {}
    out: dict[str, list[tuple[str, BaselineMetrics]]] = {}
    for r in manifest.get("results", []):
        if r.get("status") != "passed":
            continue
        folder = Path(r["output_dir"])
        if not folder.is_dir():
            folder = batch_dir / Path(r["output_dir"]).name
        if not folder.is_dir():
            continue
        try:
            metrics = extract_baseline(collect(folder))
        except Exception as e:  # noqa: BLE001
            print(f"  [WARN] collect failed for {folder}: {e}", file=sys.stderr)
            continue
        out.setdefault(r["version"], []).append((folder.name, metrics))
    return out


# --- Brownfield collection ------------------------------------------------------

# A single brownfield run tops out around ~30M tokens / ~$25 even for the
# heaviest v2 feature run. A reading far above that means the run idled out
# without a clean session-end boundary, so its CloudWatch cost-query window
# swept CONCURRENT sessions' usage into this run's total (observed on v1
# bugfix run10: 198M tokens / $105 / 10,843s "wall" — impossible for one
# scoped bugfix). Drop such contaminated readings from the cost stats (the
# run's PASS/FAIL is unaffected — that comes from the contract oracle).
_COST_CONTAMINATION_TOKENS = 60_000_000
_COST_CONTAMINATION_USD = 60.0


@dataclass
class BrownRun:
    name: str
    version: str
    passed: bool
    cases_passed: int
    cases_total: int
    failed_cases: list[str] = field(default_factory=list)
    server_error: str | None = None
    cost: float | None = None
    cost_excluded: bool = False  # contaminated OTEL reading dropped from stats
    wall_min: float | None = None
    tokens: float | None = None


def _read_contract(run_dir: Path) -> dict | None:
    f = run_dir / "contract-test-results.yaml"
    if not f.is_file():
        return None
    try:
        return yaml.safe_load(f.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return None


def _read_metrics(run_dir: Path) -> dict:
    f = run_dir / "run-metrics.yaml"
    if not f.is_file():
        return {}
    try:
        return yaml.safe_load(f.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return {}


def _brown_run(run_dir: Path, version: str, elapsed_s: float | None) -> BrownRun | None:
    data = _read_contract(run_dir)
    if data is None:
        return None  # not scorable
    total = int(data.get("total", 0) or 0)
    passed_n = int(data.get("passed", 0) or 0)
    failed_n = int(data.get("failed", 0) or 0)
    errors = int(data.get("errors", 0) or 0)
    started = bool(data.get("server_started", True))
    ok = started and total > 0 and passed_n == total and failed_n == 0 and errors == 0
    failed_cases = [
        str(c.get("name", "?")) for c in (data.get("cases") or []) if not c.get("passed")
    ]
    m = _read_metrics(run_dir)
    cost = m.get("cost_usd")
    # total_tokens lives under tokens.total in run-metrics.yaml.
    tokens = float(((m.get("tokens") or {}).get("total") or {}).get("total_tokens", 0) or 0)
    cost_excluded = False
    if cost and (float(cost) > _COST_CONTAMINATION_USD or tokens > _COST_CONTAMINATION_TOKENS):
        cost, cost_excluded = None, True
    if cost_excluded:
        tokens = 0.0  # same contaminated query window — don't report it either
    wall = elapsed_s / 60.0 if elapsed_s else None
    if wall is None:
        ms = m.get("total_wall_clock_ms") or 0
        # skip contaminated walls too (idle-out runs record the query window)
        if ms and not cost_excluded:
            wall = float(ms) / 60000.0
    return BrownRun(
        name=run_dir.name, version=version, passed=ok,
        cases_passed=passed_n, cases_total=total, failed_cases=failed_cases,
        server_error=(data.get("server_error") or None) if not started else None,
        cost=float(cost) if cost else None, cost_excluded=cost_excluded,
        wall_min=wall, tokens=tokens or None,
    )


def _slug_to_version(slug: str) -> str:
    return slug.replace("_", ".")


def _collect_one_brown_batch(batch_dir: Path) -> dict[str, list[BrownRun]]:
    """Per-version BrownRun list from ONE batch.

    Uses the contract oracle for pass/fail (NOT the manifest's harness-
    completion ``status``, which only means the run finished, not that the fix
    was correct — the two diverged badly in the first brownfield batch).
    Also sweeps the batch dir for patched re-run folders (e.g.
    ``v1_5-run02-rerun``) that aren't manifest entries, so an individually
    re-run timeout still counts.
    """
    manifest = yaml.safe_load((batch_dir / "version-batch-manifest.yaml").read_text()) or {}
    out: dict[str, list[BrownRun]] = {}
    seen_dirs: set[str] = set()
    superseded: set[str] = set()  # base run dirs replaced by a -rerun folder

    for d in batch_dir.iterdir():
        m = _RUN_DIR_RE.match(d.name) if d.is_dir() else None
        if m and m.group("suffix"):
            superseded.add(f"{m.group('slug')}-run{m.group('num')}")

    for r in manifest.get("results", []):
        version = r.get("version")
        raw = r.get("output_dir")
        run_dir = Path(raw) if raw else None
        if run_dir is None or not run_dir.is_dir():
            run_dir = batch_dir / Path(raw).name if raw else None
        if run_dir is None or not run_dir.is_dir():
            continue
        if run_dir.name in superseded:
            continue  # its -rerun folder is authoritative
        br = _brown_run(run_dir, version, r.get("elapsed_seconds"))
        seen_dirs.add(run_dir.name)
        if br is not None:
            out.setdefault(version, []).append(br)

    # Patched re-runs living outside the manifest.
    for d in sorted(batch_dir.iterdir()):
        if not d.is_dir() or d.name in seen_dirs:
            continue
        m = _RUN_DIR_RE.match(d.name)
        if not m or not m.group("suffix"):
            continue
        br = _brown_run(d, _slug_to_version(m.group("slug")), None)
        if br is not None:
            out.setdefault(br.version, []).append(br)
    return out


def collect_brownfield(batch_dirs: list[Path]) -> dict[str, list[BrownRun]]:
    """Merge one-or-more batches for a task; a LATER batch REPLACES a version.

    Supports re-running one version into a fresh batch (e.g. v1 alone after a
    harness fix) while keeping the others from the original batch. Whole-version
    replace (not per-run merge) is deliberate — a version's runs must all come
    from ONE harness/code version to be comparable.
    """
    merged: dict[str, list[BrownRun]] = {}
    for batch_dir in batch_dirs:
        for version, runs in _collect_one_brown_batch(batch_dir).items():
            merged[version] = runs
    return merged


# --- Rendering ------------------------------------------------------------------


def render_executive_summary(
    gf: dict[str, list[tuple[str, BaselineMetrics]]],
    bug: dict[str, list[BrownRun]],
    feat: dict[str, list[BrownRun]],
) -> str:
    """Narrative summary computed FROM the data, so re-runs can't stale it.

    Structure: the thesis finding in one line, then one bullet per axis family
    (cost, speed, quality, reliability) with the numbers and significance that
    back it, then caveats. Only claims the data supports: significance marks
    come from the same tests as the body sections.
    """
    L: list[str] = ["## Executive Summary", ""]

    def gf_med(v: str, attr: str, scale: float = 1.0) -> float | None:
        return _med([getattr(m, attr, 0) * scale for _, m in gf.get(v, [])])

    def rate(runs: list[BrownRun]) -> tuple[int, int]:
        return sum(1 for r in runs if r.passed), len(runs)

    single = VERSION_ORDER[0] if len(VERSION_ORDER) == 1 else None
    bullets: list[str] = []

    if single:
        # Single-version mode (the standalone packaging): summarize the
        # version's own record per task — no cross-version comparisons.
        v = single
        if gf:
            n = len(gf.get(v, []))
            contract = gf_med(v, "contract_passed")
            q = gf_med(v, "qualitative_score")
            L += [
                f"**{v} across the three standard tasks** — greenfield build "
                f"(n={n}), brownfield bugfix, and brownfield feature.",
                "",
            ]
            bullets.append(
                f"**Greenfield**: median cost ${gf_med(v, 'cost_usd'):.2f}, "
                f"{gf_med(v, 'wall_clock_ms', 1 / 60000.0):.0f} min wall clock, "
                f"contract {_fmt(contract, 0)}/88, doc fidelity "
                f"{_fmt(q, 3)} vs the {v} golden."
            )
        for label, data in (("bugfix", bug), ("feature", feat)):
            runs = data.get(v, [])
            if not runs:
                continue
            p, t = rate(runs)
            cost = _med([r.cost for r in runs if r.cost is not None])
            wall = _med([r.wall_min for r in runs if r.wall_min is not None])
            mark = "✅" if p == t else ("🟡" if t and p / t >= 0.8 else "🔴")
            bullets.append(
                f"**Brownfield {label}**: {mark} {p}/{t} contract pass rate, "
                f"median cost {_fmt(cost, 2, ' $')}, {_fmt(wall, 0, ' min')} "
                f"wall clock."
            )
    else:
        # Multi-version mode: comparative headline + one bullet per axis
        # family, with the same significance tests as the body sections.
        if gf:
            costs = {v: gf_med(v, "cost_usd") for v in VERSION_ORDER}
            best_c = _winner(costs, False)
            q = {v: gf_med(v, "qualitative_score") for v in VERSION_ORDER}
            best_q = _winner(q, True)
            parts = []
            if best_c:
                others = " / ".join(
                    f"{v} ${costs[v]:.0f}" for v in VERSION_ORDER
                    if v != best_c and costs[v] is not None
                )
                parts.append(
                    f"**{best_c} builds the contract-passing greenfield app for "
                    f"${costs[best_c]:.0f} (median) vs {others}**"
                )
            if best_q:
                parts.append(
                    f"{'with the' if best_q == best_c else f'{best_q} has the'} "
                    f"highest doc-fidelity score ({q[best_q]:.3f})"
                )
            if parts:
                L += [", ".join(parts) + ".", ""]

            cost_sig = " · ".join(
                f"vs {b} {_fmt_p(mann_whitney_p([getattr(m, 'cost_usd', 0) for _, m in gf.get(best_c, [])], [getattr(m, 'cost_usd', 0) for _, m in gf.get(b, [])]))}"
                for b in VERSION_ORDER if b != best_c
            ) if best_c else ""
            if best_c:
                bullets.append(
                    f"**Cost — {best_c} cheapest on greenfield** "
                    f"(${costs[best_c]:.2f} median; {cost_sig})."
                )
            walls = {v: gf_med(v, "wall_clock_ms", 1 / 60000.0) for v in VERSION_ORDER}
            best_w = _winner(walls, False)
            if best_w:
                others = " / ".join(
                    f"{walls[v]:.0f}" for v in VERSION_ORDER
                    if v != best_w and walls[v] is not None
                )
                bullets.append(
                    f"**Speed — {best_w} fastest on greenfield**: "
                    f"{walls[best_w]:.0f} min median vs {others}."
                )
            if best_q:
                bullets.append(
                    f"**Quality — {best_q} scores highest on doc fidelity** "
                    f"({q[best_q]:.3f}); all versions' contract results are in "
                    f"the greenfield section below."
                )

        if bug or feat:
            segs = []
            pooled: dict[str, tuple[int, int]] = {}
            for v in VERSION_ORDER:
                pb, tb = rate(bug.get(v, []))
                pf, tf = rate(feat.get(v, []))
                if tb or tf:
                    pooled[v] = (pb + pf, tb + tf)
                    segs.append(f"{v} {pb + pf}/{tb + tf}")
            line = "**Reliability — brownfield contract pass rate**: " + " · ".join(segs) + "."
            rates = {v: (p / t if t else None) for v, (p, t) in pooled.items()}
            best_r = _winner(rates, True)
            worst_r = _winner(rates, False)
            if best_r and worst_r and best_r != worst_r:
                fp = fisher_exact_p(*pooled[best_r], *pooled[worst_r])
                if fp is not None:
                    sig = ("statistically significant" if fp < 0.05
                           else "not statistically significant")
                    line += (
                        f" The {best_r}-vs-{worst_r} gap is {sig} at this n "
                        f"(Fisher's exact, pooled {_fmt_p(fp)})."
                    )
            bullets.append(line)

    for b in bullets:
        L += [f"- {b}", ""]
    return "\n".join(L)


def _winner(cells: dict[str, float | None], higher_better: bool) -> str | None:
    """The uniquely-best version, or None on a tie (no medal for a draw)."""
    vals = {v: x for v, x in cells.items() if x is not None}
    if not vals:
        return None
    best = (max if higher_better else min)(vals.values())
    winners = [v for v, x in vals.items() if x == best]
    return winners[0] if len(winners) == 1 else None


def render_verdict(
    gf: dict[str, list[tuple[str, BaselineMetrics]]],
    bug: dict[str, list[BrownRun]],
    feat: dict[str, list[BrownRun]],
) -> str:
    """Executive verdict — one row per axis, 🥇 on the winner."""
    rows: list[tuple[str, dict[str, str], str | None]] = []

    def gf_axis(label: str, attr: str, decimals: int, higher: bool, scale: float = 1.0,
                unit: str = "") -> None:
        meds = {v: _med([getattr(m, attr, 0) * scale for _, m in gf.get(v, [])]) for v in VERSION_ORDER}
        rows.append((label, {v: _fmt(meds[v], decimals, unit) for v in VERSION_ORDER},
                     _winner(meds, higher)))

    if gf:
        gf_axis("Greenfield · cost (median)", "cost_usd", 2, False, unit=" $")
        gf_axis("Greenfield · wall clock (median)", "wall_clock_ms", 1, False,
                scale=1 / 60000.0, unit=" min")
        gf_axis("Greenfield · qualitative 0-1 (median)", "qualitative_score", 3, True)
        gf_axis("Greenfield · contract (median)", "contract_passed", 0, True)

    def brown_axis(label: str, runs_by_v: dict[str, list[BrownRun]]) -> None:
        rates: dict[str, float | None] = {}
        cells: dict[str, str] = {}
        for v in VERSION_ORDER:
            runs = runs_by_v.get(v, [])
            if not runs:
                rates[v], cells[v] = None, "—"
            else:
                p = sum(1 for r in runs if r.passed)
                rates[v] = p / len(runs)
                cells[v] = f"{p}/{len(runs)}"
        rows.append((label, cells, _winner(rates, True)))

    def brown_cost_axis(label: str, runs_by_v: dict[str, list[BrownRun]]) -> None:
        meds = {v: _med([r.cost for r in runs_by_v.get(v, [])]) for v in VERSION_ORDER}
        rows.append((label, {v: _fmt(meds[v], 2, " $") for v in VERSION_ORDER},
                     _winner(meds, False)))

    if bug:
        brown_axis("Brownfield bugfix · contract pass rate", bug)
        brown_cost_axis("Brownfield bugfix · cost (median)", bug)
    if feat:
        brown_axis("Brownfield feature · contract pass rate", feat)
        brown_cost_axis("Brownfield feature · cost (median)", feat)

    lines = [
        "## Verdict",
        "",
        "| Dimension | " + " | ".join(VERSION_ORDER) + " |",
        "|-----------|" + "---|" * len(VERSION_ORDER),
    ]
    solo = len(VERSION_ORDER) == 1  # medals/tallies are meaningless unopposed
    win_count = dict.fromkeys(VERSION_ORDER, 0)
    for label, cells, winner in rows:
        out_cells = []
        for v in VERSION_ORDER:
            is_win = (v == winner) and not solo
            if is_win:
                win_count[v] += 1
            out_cells.append(f"**{cells[v]}** 🥇" if is_win else cells[v])
        lines.append(f"| {label} | " + " | ".join(out_cells) + " |")
    if not solo:
        lines += [
            "",
            "**Axis wins:** " + " · ".join(f"{v}: {win_count[v]}" for v in VERSION_ORDER),
        ]
    lines.append("")
    return "\n".join(lines)


def render_greenfield(gf: dict[str, list[tuple[str, BaselineMetrics]]]) -> str:
    """Greenfield section: headline medians, mean±SD/CI, significance, quality,
    artifacts, and a per-run appendix."""
    L: list[str] = [
        "## Test Case 1 — Greenfield: sci-calc API (graded vs golden)",
        "",
        "Build a scientific-calculator API from scratch. Cost/wall/tokens are",
        "consumption axes; quality is a 0-1 semantic-similarity score vs each",
        "version's own golden (cross-version doc structures differ, so each is",
        "graded against its own reference).",
        "",
    ]
    counts = " · ".join(f"{v} n={len(gf.get(v, []))}" for v in VERSION_ORDER)
    L += [f"Runs: {counts}", ""]

    # Headline medians.
    axes = [
        ("Cost (USD)", "cost_usd", 2, 1.0, False),
        ("Wall clock (min)", "wall_clock_ms", 1, 1 / 60000.0, False),
        ("Total tokens (M)", "total_tokens", 1, 1e-6, False),
        ("Qualitative (0-1)", "qualitative_score", 3, 1.0, True),
        ("Contract passed", "contract_passed", 0, 1.0, True),
        ("Coverage %", "coverage_pct", 1, 1.0, True),
    ]
    L += [
        "### Headline (medians)",
        "",
        "| Metric | " + " | ".join(VERSION_ORDER) + " |",
        "|---|" + "---:|" * len(VERSION_ORDER),
    ]
    for label, attr, dec, scale, higher in axes:
        meds = {}
        for v in VERSION_ORDER:
            vals = [getattr(m, attr, 0) for _, m in gf.get(v, [])]
            vals = [x * scale for x in vals if x is not None]
            meds[v] = _med(vals)
        w = _winner(meds, higher)
        cells = [
            (f"**{_fmt(meds[v], dec)}** 🥇" if v == w else _fmt(meds[v], dec))
            for v in VERSION_ORDER
        ]
        L.append(f"| {label} | " + " | ".join(cells) + " |")
    L.append("")

    # Dispersion: mean ± SD (95% CI).
    L += [
        "### Statistics (mean ± SD, Student-t 95% CI)",
        "",
        "| Metric | " + " | ".join(VERSION_ORDER) + " |",
        "|---|" + "---|" * len(VERSION_ORDER),
    ]
    for label, attr, dec, scale, _higher in axes[:4]:
        cells = []
        for v in VERSION_ORDER:
            vals = [getattr(m, attr, 0) * scale for _, m in gf.get(v, []) if getattr(m, attr, None) is not None]
            cells.append(_agg_cell(vals, dec))
        L.append(f"| {label} | " + " | ".join(cells) + " |")
    L.append("")

    # Significance (consumption axes only — quality is each-vs-own-golden).
    # A single-version report has no pairs to test, so the block is skipped.
    if len([v for v in VERSION_ORDER if gf.get(v)]) >= 2:
        L += [
            "### Significance (exact Mann-Whitney U, two-sided)",
            "",
            "Consumption axes only; the qualitative score stays descriptive (each",
            "version is graded against its own golden).",
            "",
            "| Pair | Cost | Wall clock | Tokens |",
            "|---|---|---|---|",
        ]
        for a, b in _pairs():
            cells = []
            for attr in ("cost_usd", "wall_clock_ms", "total_tokens"):
                xa = [getattr(m, attr, 0) for _, m in gf.get(a, [])]
                xb = [getattr(m, attr, 0) for _, m in gf.get(b, [])]
                p = mann_whitney_p(xa, xb) if len(xa) > 1 and len(xb) > 1 else None
                cells.append(_fmt_p(p) + _sig_mark(p))
            L.append(f"| {a} vs {b} | " + " | ".join(cells) + " |")
        L += ["", "✅ = significant at p<0.05 · ⚪ = not significant", ""]

    # Quality detail.
    L += [
        "### Quality detail (medians)",
        "",
        "| Metric | " + " | ".join(VERSION_ORDER) + " |",
        "|---|" + "---:|" * len(VERSION_ORDER),
    ]
    qaxes = [
        ("Unit tests passed", "tests_passed", 0),
        ("Unit pass %", "tests_pass_pct", 1),
        ("Lint errors", "lint_errors", 0),
        ("Security high", "security_high", 0),
        ("Qualitative · inception", "inception_score", 3),
        ("Qualitative · construction", "construction_score", 3),
        ("Source files", "source_files", 0),
        ("Test files", "test_files", 0),
        ("Lines of code", "lines_of_code", 0),
        ("AIDLC doc files", "doc_files", 0),
    ]
    for label, attr, dec in qaxes:
        cells = []
        for v in VERSION_ORDER:
            vals = [getattr(m, attr, 0) for _, m in gf.get(v, []) if getattr(m, attr, None) is not None]
            cells.append(_fmt(_med(vals), dec))
        L.append(f"| {label} | " + " | ".join(cells) + " |")
    L.append("")

    # Per-run appendix (collapsible per version).
    L += ["### Per-run results", ""]
    for v in VERSION_ORDER:
        runs = gf.get(v, [])
        if not runs:
            continue
        L.append(f"<details><summary><b>{v}</b> — {len(runs)} runs</summary>")
        L.append("")
        L.append("| Run | Cost | Wall | Tokens | Qual | Contract | Cov % |")
        L.append("|---|---:|---:|---:|---:|---:|---:|")
        for name, m in sorted(runs):
            L.append(
                f"| `{name}` | {_fmt(m.cost_usd, 2, ' $')} "
                f"| {_fmt(m.wall_clock_ms / 60000.0, 1, ' min')} "
                f"| {_fmt(m.total_tokens / 1e6, 1, 'M')} "
                f"| {_fmt(m.qualitative_score, 3)} "
                f"| {m.contract_passed}/{m.contract_total or 88} "
                f"| {_fmt(m.coverage_pct, 1)} |"
            )
        L += ["", "</details>", ""]
    return "\n".join(L)


def _brown_task_section(title: str, oracle: str, runs_by_v: dict[str, list[BrownRun]]) -> list[str]:
    L: list[str] = [f"### {title}", "", oracle, ""]

    # Pass-rate + stats table.
    L += [
        "| Metric | " + " | ".join(VERSION_ORDER) + " |",
        "|---|" + "---|" * len(VERSION_ORDER),
    ]
    pass_cells, cost_med_cells, cost_stat_cells, wall_cells = [], [], [], []
    rates: dict[str, float | None] = {}
    for v in VERSION_ORDER:
        runs = runs_by_v.get(v, [])
        if not runs:
            for c in (pass_cells, cost_med_cells, cost_stat_cells, wall_cells):
                c.append("—")
            rates[v] = None
            continue
        p = sum(1 for r in runs if r.passed)
        rates[v] = p / len(runs)
        emoji = "✅" if p == len(runs) else ("🟡" if p / len(runs) >= 0.8 else "🔴")
        pass_cells.append(f"{emoji} **{p}/{len(runs)}**")
        costs = [r.cost for r in runs if r.cost is not None]
        cost_med_cells.append(_fmt(_med(costs), 2, " $"))
        cost_stat_cells.append(_agg_cell(costs, 2))
        walls = [r.wall_min for r in runs if r.wall_min is not None]
        wall_cells.append(_fmt(_med(walls), 0, " min"))
    L.append("| Contract pass rate | " + " | ".join(pass_cells) + " |")
    L.append("| Cost — median | " + " | ".join(cost_med_cells) + " |")
    L.append("| Cost — mean ± SD (CI) | " + " | ".join(cost_stat_cells) + " |")
    L.append("| Wall clock — median | " + " | ".join(wall_cells) + " |")
    L.append("")

    # Significance: Fisher exact on pass rates, Mann-Whitney on cost.
    # A single-version report has no pairs to test, so the block is skipped.
    if len([v for v in VERSION_ORDER if runs_by_v.get(v)]) >= 2:
        L += ["**Significance** (pass rate: Fisher's exact, two-sided · cost: Mann-Whitney U):", ""]
        L += ["| Pair | Pass rate | Cost |", "|---|---|---|"]
        for a, b in _pairs():
            ra, rb = runs_by_v.get(a, []), runs_by_v.get(b, [])
            if ra and rb:
                fp = fisher_exact_p(sum(r.passed for r in ra), len(ra),
                                    sum(r.passed for r in rb), len(rb))
            else:
                fp = None
            ca = [r.cost for r in ra if r.cost is not None]
            cb = [r.cost for r in rb if r.cost is not None]
            mp = mann_whitney_p(ca, cb) if len(ca) > 1 and len(cb) > 1 else None
            L.append(f"| {a} vs {b} | {_fmt_p(fp)}{_sig_mark(fp)} | {_fmt_p(mp)}{_sig_mark(mp)} |")
        L.append("")

    # Per-run drill-down.
    L += ["**Per-run detail:**", ""]
    for v in VERSION_ORDER:
        runs = runs_by_v.get(v, [])
        if not runs:
            continue
        p = sum(1 for r in runs if r.passed)
        L.append(f"<details><summary><b>{v}</b> — {p}/{len(runs)} passed</summary>")
        L.append("")
        L.append("| Run | Verdict | Cases | Cost | Wall | Tokens |")
        L.append("|---|---|---:|---:|---:|---:|")
        for r in sorted(runs, key=lambda x: x.name):
            verdict = "✅ PASS" if r.passed else "❌ FAIL"
            cost = "excluded*" if r.cost_excluded else _fmt(r.cost, 2, " $")
            toks = _fmt(r.tokens / 1e6 if r.tokens else None, 1, "M")
            L.append(
                f"| `{r.name}` | {verdict} | {r.cases_passed}/{r.cases_total} "
                f"| {cost} | {_fmt(r.wall_min, 0, ' min')} | {toks} |"
            )
        excluded = [r for r in runs if r.cost_excluded]
        if excluded:
            L += ["", "\\* OTEL cost reading window-contaminated (idled-out run swept "
                     "concurrent sessions) — excluded from cost stats; PASS/FAIL unaffected."]
        failures = [r for r in runs if not r.passed]
        for r in failures:
            L += ["", f"**`{r.name}` failure detail:**"]
            if r.server_error:
                L.append(f"- Server error: {r.server_error}")
            for c in r.failed_cases:
                L.append(f"- ❌ {c}")
        L += ["", "</details>", ""]
    return L


# Deterministic-measure preamble shared by both brownfield test-case sections.
_BROWN_PREAMBLE = (
    "Modify a real external codebase; scored **pass/fail** against the "
    "testbed's own third-party contract (a run passes iff **every** contract "
    "case passes — no partial credit). This is a deterministic reliability "
    "measure — brownfield has no golden, so its quality axis IS the pass rate."
)


def render_brown_bugfix(bug: dict[str, list[BrownRun]]) -> str:
    L = [
        "## Test Case 2 — Brownfield Bugfix: httpbin `/base64` (Flask)",
        "",
        _BROWN_PREAMBLE,
        "",
    ]
    L += _brown_task_section(
        "Setup & oracle",
        "Seeded pristine `psf/httpbin` (pinned `f7b02ae`); the `/base64` "
        "endpoint swallows malformed input with a bare `except:` and returns "
        "HTTP 200. Fix: return 400 on undecodable input. "
        "Oracle: 3 explicit HTTP assertions (valid→200, two malformed→400).",
        bug,
    )
    return "\n".join(L)


def render_brown_feature(feat: dict[str, list[BrownRun]]) -> str:
    L = [
        "## Test Case 3 — Brownfield Feature: RealWorld follow/unfollow (Django)",
        "",
        _BROWN_PREAMBLE,
        "",
    ]
    L += _brown_task_section(
        "Setup & oracle",
        "Seeded `c4ffein/realworld-django-ninja` (pinned `04ef47c`) with the "
        "`POST`/`DELETE /profiles/{username}/follow` routes REMOVED; "
        "implement them per the RealWorld spec. Oracle: the project's own "
        "Hurl suite (3 follow-dependent files, each run independently).",
        feat,
    )
    return "\n".join(L)


def build_combined(
    greenfield: Path | None,
    bug_batches: list[Path],
    feat_batches: list[Path],
    generated: str,
) -> str:
    gf = collect_greenfield(greenfield) if greenfield else {}
    bug = collect_brownfield(bug_batches) if bug_batches else {}
    feat = collect_brownfield(feat_batches) if feat_batches else {}
    _set_version_order(gf, bug, feat)

    header = [
        "# AIDLC Evaluation Report — Full Suite",
        "",
        f"> **Generated:** {generated}",
        f"> **Scope:** {' vs '.join(VERSION_ORDER)}, all three standard tasks",
        "> **Transport:** real `claude` CLI in a PTY (Bedrock, Opus-tier), "
        "gates driven by the harness",
        "",
        "| # | Test Case | Kind | Oracle |",
        "|---|---|---|---|",
        "| **1** | Greenfield — sci-calc API from scratch | Graded vs golden | "
        "88-case OpenAPI contract + 0-1 semantic similarity |",
        "| **2** | Brownfield bugfix — httpbin `/base64` (Flask) | Deterministic | "
        "3 HTTP assertions (third-party contract) |",
        "| **3** | Brownfield feature — RealWorld follow/unfollow (Django) | "
        "Deterministic | Project's own Hurl suite (third-party contract) |",
        "",
        "The two task families are measured differently by design — graded",
        "fidelity for greenfield, deterministic pass/fail for brownfield — and",
        "each test case is reported in its own section so the axes never blend.",
        "",
    ]
    parts = ["\n".join(header)]
    parts.append(render_executive_summary(gf, bug, feat))
    parts.append(render_verdict(gf, bug, feat))
    if gf:
        parts.append(render_greenfield(gf))
    if bug:
        parts.append(render_brown_bugfix(bug))
    if feat:
        parts.append(render_brown_feature(feat))

    prov_bug = ", ".join(f"`{b}`" for b in bug_batches) if bug_batches else "(omitted)"
    prov_feat = ", ".join(f"`{b}`" for b in feat_batches) if feat_batches else "(omitted)"
    parts.append("\n".join([
        "## Provenance",
        "",
        f"- Greenfield batch: `{greenfield}`" if greenfield else "- Greenfield: (omitted)",
        f"- Brownfield bugfix batch(es): {prov_bug}",
        f"- Brownfield feature batch(es): {prov_feat}",
        "- When multiple batches are listed for a task, a LATER batch replaces",
        "  that version's runs (e.g. a v1 re-run after a harness fix keeps",
        "  v1.5/v2 from the earlier batch). Patched `-runNN-rerun` folders",
        "  supersede their base run.",
        "- Brownfield pass/fail read from each run's `contract-test-results.yaml`",
        "  (the third-party contract oracle), NOT the manifest completion status.",
        "- Brownfield testbeds pinned to upstream commits (verified at preflight):",
        "  httpbin `f7b02ae`, realworld `04ef47c`.",
        "",
        "---",
        "*Report generated by run_combined_report.py*",
    ]))
    return "\n\n".join(parts)


# --- HTML rendering (golden-report.html template) --------------------------------
# Visual language lifted from test_cases/sci-calc-v1/golden-report.html: dark
# slate theme, stat cards, pill badges, progress bars, score rings, accordions.

_HTML_CSS = """
:root {
  --bg: #0f172a; --surface: #1e293b; --surface2: #334155;
  --text: #e2e8f0; --text2: #94a3b8; --border: #475569;
  --green: #22c55e; --green-bg: #052e16; --green-border: #166534;
  --red: #ef4444; --red-bg: #450a0a; --red-border: #991b1b;
  --yellow: #eab308; --yellow-bg: #422006; --yellow-border: #854d0e;
  --blue: #3b82f6; --blue-bg: #172554; --blue-border: #1d4ed8;
  --purple: #a855f7; --accent: #38bdf8;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--bg); color: var(--text); line-height: 1.6;
  max-width: 1100px; margin: 0 auto; padding: 2rem 1.5rem;
}
h1 { font-size: 2rem; font-weight: 700; margin-bottom: .25rem; }
h2 {
  font-size: 1.25rem; font-weight: 600; color: var(--accent);
  margin: 2.5rem 0 1rem; padding-bottom: .5rem; border-bottom: 1px solid var(--border);
}
h3 { font-size: 1.05rem; font-weight: 600; margin: 1.5rem 0 .75rem; }
.subtitle { color: var(--text2); font-size: .9rem; margin-bottom: 2rem; }
code {
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: .85em;
  background: var(--surface2); padding: .15em .4em; border-radius: 4px;
}
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 1.25rem; transition: border-color .2s;
}
.card:hover { border-color: var(--accent); }
.card-label { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--text2); margin-bottom: .5rem; }
.card-value { font-size: 1.75rem; font-weight: 700; }
.card-detail { font-size: .8rem; color: var(--text2); margin-top: .25rem; }
.badge {
  display: inline-flex; align-items: center; gap: .35rem;
  padding: .25rem .75rem; border-radius: 999px; font-size: .8rem; font-weight: 600;
}
.badge-pass { background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border); }
.badge-fail { background: var(--red-bg); color: var(--red); border: 1px solid var(--red-border); }
.badge-warn { background: var(--yellow-bg); color: var(--yellow); border: 1px solid var(--yellow-border); }
.badge-info { background: var(--blue-bg); color: var(--blue); border: 1px solid var(--blue-border); }
.progress-wrap { width: 100%; background: var(--surface2); border-radius: 6px; overflow: hidden; height: 10px; }
.progress-bar { height: 100%; border-radius: 6px; transition: width .4s ease; }
.progress-green { background: linear-gradient(90deg, #16a34a, #22c55e); }
.progress-yellow { background: linear-gradient(90deg, #ca8a04, #eab308); }
.progress-red { background: linear-gradient(90deg, #dc2626, #ef4444); }
table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: .875rem; }
th { text-align: left; padding: .6rem .75rem; background: var(--surface); color: var(--text2);
     font-weight: 600; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em;
     border-bottom: 2px solid var(--border); }
td { padding: .55rem .75rem; border-bottom: 1px solid var(--surface2); }
tr:hover td { background: var(--surface); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.win { color: var(--green); font-weight: 700; }
.pass-icon::before { content: '\\2714'; color: var(--green); margin-right: .3rem; }
.fail-icon::before { content: '\\2718'; color: var(--red); margin-right: .3rem; }
details { margin: .5rem 0; }
details summary {
  cursor: pointer; padding: .5rem .75rem; background: var(--surface);
  border-radius: 8px; font-size: .85rem; color: var(--text2);
  transition: background .2s;
}
details summary:hover { background: var(--surface2); }
details[open] summary { border-radius: 8px 8px 0 0; }
details .detail-body { background: var(--surface); padding: .75rem; border-radius: 0 0 8px 8px;
  font-size: .82rem; line-height: 1.65; color: var(--text2); }
.score-ring { display: inline-flex; align-items: center; gap: .75rem; }
.ring-container { position: relative; width: 80px; height: 80px; }
.ring-container svg { transform: rotate(-90deg); }
.ring-container circle { fill: none; stroke-width: 6; }
.ring-bg { stroke: var(--surface2); }
.ring-fg { stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
.ring-label {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 1.1rem; font-weight: 700;
}
.tc-banner {
  display: inline-flex; align-items: center; gap: .6rem; margin: 0 0 .75rem;
  padding: .3rem .9rem; border-radius: 999px; font-size: .8rem; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase;
  background: var(--blue-bg); color: var(--accent); border: 1px solid var(--blue-border);
}
.exec { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; }
.exec ul { margin: .75rem 0 0 1.25rem; }
.exec li { margin: .5rem 0; }
.footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border);
  color: var(--text2); font-size: .75rem; text-align: center; }
"""


def _esc(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _md_inline(s: str) -> str:
    """Minimal markdown-inline → HTML (bold + code) for exec-summary reuse."""
    out = _esc(s)
    out = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"`([^`]+)`", r"<code>\1</code>", out)
    return out


def _ring(pct: float, color: str = "var(--green)", size: int = 64) -> str:
    """SVG score ring (golden template's .ring-container)."""
    r = (size / 2) - 3
    circ = 2 * 3.14159 * r
    offset = circ * (1 - max(0.0, min(1.0, pct)))
    c = size / 2
    return (
        f'<div class="ring-container" style="width:{size}px;height:{size}px">'
        f'<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
        f'<circle class="ring-bg" cx="{c}" cy="{c}" r="{r:.1f}"/>'
        f'<circle class="ring-fg" cx="{c}" cy="{c}" r="{r:.1f}" '
        f'stroke="{color}" stroke-dasharray="{circ:.1f}" stroke-dashoffset="{offset:.1f}"/>'
        f'</svg><div class="ring-label" style="color:{color}">{pct * 100:.0f}%</div></div>'
    )


def _rate_badge(p: int, t: int) -> str:
    if t == 0:
        return '<span class="badge badge-info">—</span>'
    cls = "badge-pass" if p == t else ("badge-warn" if p / t >= 0.8 else "badge-fail")
    return f'<span class="badge {cls}">{p}/{t}</span>'


def _progress(pct: float) -> str:
    cls = "progress-green" if pct >= 0.999 else ("progress-yellow" if pct >= 0.8 else "progress-red")
    return (f'<div class="progress-wrap"><div class="progress-bar {cls}" '
            f'style="width:{pct * 100:.1f}%"></div></div>')


def _html_exec_summary(md_text: str) -> str:
    """Convert the (already computed) exec-summary markdown into template HTML."""
    body: list[str] = []
    bullets: list[str] = []
    for line in md_text.splitlines():
        line = line.strip()
        if not line or line.startswith("## "):
            continue
        if line.startswith("- "):
            bullets.append(f"<li>{_md_inline(line[2:])}</li>")
        else:
            if bullets:
                body.append("<ul>" + "".join(bullets) + "</ul>")
                bullets = []
            body.append(f"<p>{_md_inline(line)}</p>")
    if bullets:
        body.append("<ul>" + "".join(bullets) + "</ul>")
    return '<div class="exec">' + "".join(body) + "</div>"


def render_html(
    gf: dict[str, list[tuple[str, BaselineMetrics]]],
    bug: dict[str, list[BrownRun]],
    feat: dict[str, list[BrownRun]],
    generated: str,
    provenance: list[str],
) -> str:
    H: list[str] = []

    def gf_med(v: str, attr: str, scale: float = 1.0) -> float | None:
        return _med([getattr(m, attr, 0) * scale for _, m in gf.get(v, [])])

    def vhdr() -> str:
        return "".join(f"<th class='num'>{_esc(v)}</th>" for v in VERSION_ORDER)

    # ── Header ──
    H.append(f"<h1>AIDLC Evaluation Report — Full Suite</h1>")
    H.append(
        f'<div class="subtitle">{_esc(" vs ".join(VERSION_ORDER))} &middot; '
        f'3 standard test cases &middot; generated {_esc(generated)} &middot; '
        f'real <code>claude</code> CLI (PTY, Bedrock)</div>'
    )

    # ── Test-case overview cards ──
    H.append('<div class="card-grid">')
    if gf:
        n = " / ".join(str(len(gf.get(v, []))) for v in VERSION_ORDER)
        H.append(
            '<div class="card"><div class="card-label">Test Case 1 · Greenfield</div>'
            '<div class="card-value"><span class="badge badge-info">graded vs golden</span></div>'
            f'<div class="card-detail">sci-calc API from scratch &middot; 88-case contract &middot; n={n}</div></div>'
        )
    for num, label, data, detail in (
        (2, "Bugfix", bug, "httpbin <code>/base64</code> (Flask) &middot; 3 HTTP assertions"),
        (3, "Feature", feat, "RealWorld follow/unfollow (Django) &middot; Hurl suite"),
    ):
        if not data:
            continue
        badges = " ".join(
            f"{_esc(v)} " + _rate_badge(sum(1 for r in data.get(v, []) if r.passed), len(data.get(v, [])))
            for v in VERSION_ORDER if data.get(v)
        )
        H.append(
            f'<div class="card"><div class="card-label">Test Case {num} · Brownfield {label}</div>'
            f'<div class="card-value" style="font-size:1rem;display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">{badges}</div>'
            f'<div class="card-detail">{detail} &middot; deterministic pass/fail</div></div>'
        )
    H.append("</div>")

    # ── Executive summary (reuse the markdown generator) ──
    H.append("<h2>Executive Summary</h2>")
    H.append(_html_exec_summary(render_executive_summary(gf, bug, feat)))

    # ── Verdict ──
    solo = len(VERSION_ORDER) == 1
    H.append("<h2>Verdict</h2>")
    H.append(f"<table><tr><th>Dimension</th>{vhdr()}</tr>")

    def verdict_row(label: str, cells: dict[str, str], winner: str | None) -> None:
        tds = []
        for v in VERSION_ORDER:
            val = _esc(cells.get(v, "—"))
            if v == winner and not solo:
                tds.append(f'<td class="num win">{val} 🥇</td>')
            else:
                tds.append(f'<td class="num">{val}</td>')
        H.append(f"<tr><td>{label}</td>{''.join(tds)}</tr>")

    if gf:
        for label, attr, dec, scale, higher, unit in (
            ("TC1 Greenfield · cost (median)", "cost_usd", 2, 1.0, False, " $"),
            ("TC1 Greenfield · wall clock (median)", "wall_clock_ms", 1, 1 / 60000.0, False, " min"),
            ("TC1 Greenfield · qualitative 0-1 (median)", "qualitative_score", 3, 1.0, True, ""),
        ):
            meds = {v: gf_med(v, attr, scale) for v in VERSION_ORDER}
            verdict_row(label, {v: _fmt(meds[v], dec, unit) for v in VERSION_ORDER},
                        _winner(meds, higher))
    for num, label, data in ((2, "Bugfix", bug), (3, "Feature", feat)):
        if not data:
            continue
        rates = {}
        cells = {}
        for v in VERSION_ORDER:
            runs = data.get(v, [])
            p = sum(1 for r in runs if r.passed)
            rates[v] = (p / len(runs)) if runs else None
            cells[v] = f"{p}/{len(runs)}" if runs else "—"
        verdict_row(f"TC{num} {label} · contract pass rate", cells, _winner(rates, True))
        meds = {v: _med([r.cost for r in data.get(v, [])]) for v in VERSION_ORDER}
        verdict_row(f"TC{num} {label} · cost (median)",
                    {v: _fmt(meds[v], 2, " $") for v in VERSION_ORDER}, _winner(meds, False))
    H.append("</table>")

    # ── Test Case 1 — Greenfield ──
    if gf:
        H.append('<h2>Test Case 1 — Greenfield: sci-calc API</h2>')
        H.append('<div class="tc-banner">Graded vs golden</div>')
        H.append('<p style="color:var(--text2);font-size:.9rem;margin-bottom:1rem">'
                 'Build a scientific-calculator API from scratch. Quality is a 0-1 '
                 'semantic-similarity score vs each version&rsquo;s own golden; the '
                 '88-case OpenAPI contract validates the running server.</p>')
        # Per-version cards with qual ring.
        H.append('<div class="card-grid">')
        for v in VERSION_ORDER:
            runs = gf.get(v, [])
            if not runs:
                continue
            q = gf_med(v, "qualitative_score") or 0.0
            color = "var(--green)" if q >= 0.8 else ("var(--yellow)" if q >= 0.6 else "var(--red)")
            contract = gf_med(v, "contract_passed") or 0
            H.append(
                f'<div class="card"><div class="card-label">{_esc(v)} &middot; n={len(runs)}</div>'
                f'<div class="card-value" style="display:flex;align-items:center;gap:.75rem">'
                f'{_ring(q, color)}'
                f'<div style="font-size:.9rem;font-weight:400;color:var(--text2)">'
                f'${_fmt(gf_med(v, "cost_usd"), 2)} &middot; '
                f'{_fmt(gf_med(v, "wall_clock_ms", 1 / 60000.0), 0)} min<br>'
                f'contract {int(contract)}/88</div></div></div>'
            )
        H.append("</div>")
        # Headline + stats tables.
        axes = [
            ("Cost (USD)", "cost_usd", 2, 1.0, False),
            ("Wall clock (min)", "wall_clock_ms", 1, 1 / 60000.0, False),
            ("Total tokens (M)", "total_tokens", 1, 1e-6, False),
            ("Qualitative (0-1)", "qualitative_score", 3, 1.0, True),
            ("Contract passed", "contract_passed", 0, 1.0, True),
            ("Coverage %", "coverage_pct", 1, 1.0, True),
        ]
        H.append("<h3>Headline (medians)</h3>")
        H.append(f"<table><tr><th>Metric</th>{vhdr()}</tr>")
        for label, attr, dec, scale, higher in axes:
            meds = {}
            for v in VERSION_ORDER:
                vals = [getattr(m, attr, 0) * scale for _, m in gf.get(v, [])
                        if getattr(m, attr, None) is not None]
                meds[v] = _med(vals)
            w = _winner(meds, higher)
            tds = "".join(
                f'<td class="num win">{_fmt(meds[v], dec)} 🥇</td>' if (v == w and not solo)
                else f'<td class="num">{_fmt(meds[v], dec)}</td>'
                for v in VERSION_ORDER
            )
            H.append(f"<tr><td>{label}</td>{tds}</tr>")
        H.append("</table>")
        H.append("<h3>Statistics (mean ± SD, Student-t 95% CI)</h3>")
        H.append(f"<table><tr><th>Metric</th>{vhdr()}</tr>")
        for label, attr, dec, scale, _h in axes[:4]:
            tds = ""
            for v in VERSION_ORDER:
                vals = [getattr(m, attr, 0) * scale for _, m in gf.get(v, [])
                        if getattr(m, attr, None) is not None]
                tds += f'<td class="num">{_esc(_agg_cell(vals, dec))}</td>'
            H.append(f"<tr><td>{label}</td>{tds}</tr>")
        H.append("</table>")
        if len([v for v in VERSION_ORDER if gf.get(v)]) >= 2:
            H.append("<h3>Significance (exact Mann-Whitney U, two-sided)</h3>")
            H.append("<table><tr><th>Pair</th><th>Cost</th><th>Wall clock</th><th>Tokens</th></tr>")
            for a, b in _pairs():
                tds = ""
                for attr in ("cost_usd", "wall_clock_ms", "total_tokens"):
                    xa = [getattr(m, attr, 0) for _, m in gf.get(a, [])]
                    xb = [getattr(m, attr, 0) for _, m in gf.get(b, [])]
                    p = mann_whitney_p(xa, xb) if len(xa) > 1 and len(xb) > 1 else None
                    badge = ('<span class="badge badge-pass">' if (p is not None and p < 0.05)
                             else '<span class="badge badge-info">')
                    tds += f"<td>{badge}{_esc(_fmt_p(p))}</span></td>"
                H.append(f"<tr><td>{_esc(a)} vs {_esc(b)}</td>{tds}</tr>")
            H.append("</table>")
        # Per-run accordions.
        H.append("<h3>Per-run results</h3>")
        for v in VERSION_ORDER:
            runs = gf.get(v, [])
            if not runs:
                continue
            H.append(f"<details><summary><strong>{_esc(v)}</strong> — {len(runs)} runs</summary>")
            H.append('<div class="detail-body"><table><tr><th>Run</th>'
                     "<th class='num'>Cost</th><th class='num'>Wall</th>"
                     "<th class='num'>Tokens</th><th class='num'>Qual</th>"
                     "<th class='num'>Contract</th><th class='num'>Cov %</th></tr>")
            for name, m in sorted(runs):
                H.append(
                    f"<tr><td><code>{_esc(name)}</code></td>"
                    f"<td class='num'>{_fmt(m.cost_usd, 2, ' $')}</td>"
                    f"<td class='num'>{_fmt(m.wall_clock_ms / 60000.0, 1, ' min')}</td>"
                    f"<td class='num'>{_fmt(m.total_tokens / 1e6, 1, 'M')}</td>"
                    f"<td class='num'>{_fmt(m.qualitative_score, 3)}</td>"
                    f"<td class='num'>{m.contract_passed}/{m.contract_total or 88}</td>"
                    f"<td class='num'>{_fmt(m.coverage_pct, 1)}</td></tr>"
                )
            H.append("</table></div></details>")

    # ── Test Cases 2 & 3 — Brownfield ──
    for num, title, oracle, data in (
        (2, "Brownfield Bugfix: httpbin <code>/base64</code> (Flask)",
         "Seeded pristine <code>psf/httpbin</code> (pinned <code>f7b02ae</code>); the "
         "<code>/base64</code> endpoint swallows malformed input with a bare "
         "<code>except:</code> and returns HTTP 200. Oracle: 3 explicit HTTP "
         "assertions (valid&rarr;200, two malformed&rarr;400).", bug),
        (3, "Brownfield Feature: RealWorld follow/unfollow (Django)",
         "Seeded <code>realworld-django-ninja</code> (pinned <code>04ef47c</code>) with "
         "the follow routes REMOVED; implement per the RealWorld spec. Oracle: the "
         "project&rsquo;s own Hurl suite (3 files, each run independently).", feat),
    ):
        if not data:
            continue
        H.append(f"<h2>Test Case {num} — {title}</h2>")
        H.append('<div class="tc-banner" style="background:var(--green-bg);color:var(--green);'
                 'border-color:var(--green-border)">Deterministic pass/fail</div>')
        H.append(f'<p style="color:var(--text2);font-size:.9rem;margin-bottom:1rem">{oracle} '
                 'A run passes iff <strong>every</strong> contract case passes — no partial credit.</p>')
        # Per-version pass-rate cards with progress bars.
        H.append('<div class="card-grid">')
        for v in VERSION_ORDER:
            runs = data.get(v, [])
            if not runs:
                continue
            p = sum(1 for r in runs if r.passed)
            cost = _med([r.cost for r in runs if r.cost is not None])
            wall = _med([r.wall_min for r in runs if r.wall_min is not None])
            H.append(
                f'<div class="card"><div class="card-label">{_esc(v)}</div>'
                f'<div class="card-value">{_rate_badge(p, len(runs))}</div>'
                f'<div style="margin:.6rem 0">{_progress(p / len(runs))}</div>'
                f'<div class="card-detail">median {_fmt(cost, 2, " $")} &middot; {_fmt(wall, 0, " min")}</div></div>'
            )
        H.append("</div>")
        # Significance.
        present = [v for v in VERSION_ORDER if data.get(v)]
        if len(present) >= 2:
            H.append("<h3>Significance (pass rate: Fisher's exact · cost: Mann-Whitney U)</h3>")
            H.append("<table><tr><th>Pair</th><th>Pass rate</th><th>Cost</th></tr>")
            for a, b in _pairs():
                ra, rb = data.get(a, []), data.get(b, [])
                fp = (fisher_exact_p(sum(r.passed for r in ra), len(ra),
                                     sum(r.passed for r in rb), len(rb))
                      if ra and rb else None)
                ca = [r.cost for r in ra if r.cost is not None]
                cb = [r.cost for r in rb if r.cost is not None]
                mp = mann_whitney_p(ca, cb) if len(ca) > 1 and len(cb) > 1 else None
                cells = ""
                for p in (fp, mp):
                    badge = ('<span class="badge badge-pass">' if (p is not None and p < 0.05)
                             else '<span class="badge badge-info">')
                    cells += f"<td>{badge}{_esc(_fmt_p(p))}</span></td>"
                H.append(f"<tr><td>{_esc(a)} vs {_esc(b)}</td>{cells}</tr>")
            H.append("</table>")
        # Per-run accordions with failure detail.
        H.append("<h3>Per-run results</h3>")
        for v in VERSION_ORDER:
            runs = data.get(v, [])
            if not runs:
                continue
            p = sum(1 for r in runs if r.passed)
            H.append(f"<details><summary><strong>{_esc(v)}</strong> — {p}/{len(runs)} passed</summary>")
            H.append('<div class="detail-body"><table><tr><th></th><th>Run</th>'
                     "<th class='num'>Cases</th><th class='num'>Cost</th>"
                     "<th class='num'>Wall</th><th class='num'>Tokens</th></tr>")
            for r in sorted(runs, key=lambda x: x.name):
                icon = "pass-icon" if r.passed else "fail-icon"
                cost = "excluded*" if r.cost_excluded else _fmt(r.cost, 2, " $")
                toks = _fmt(r.tokens / 1e6 if r.tokens else None, 1, "M")
                H.append(
                    f'<tr><td class="{icon}"></td><td><code>{_esc(r.name)}</code></td>'
                    f"<td class='num'>{r.cases_passed}/{r.cases_total}</td>"
                    f"<td class='num'>{cost}</td>"
                    f"<td class='num'>{_fmt(r.wall_min, 0, ' min')}</td>"
                    f"<td class='num'>{toks}</td></tr>"
                )
            H.append("</table>")
            if any(r.cost_excluded for r in runs):
                H.append('<p style="font-size:.78rem">* OTEL cost reading window-contaminated '
                         "(idled-out run swept concurrent sessions) — excluded from cost stats; "
                         "PASS/FAIL unaffected.</p>")
            for r in runs:
                if r.passed:
                    continue
                H.append(f"<p style='margin-top:.5rem'><strong><code>{_esc(r.name)}</code> failure detail:</strong></p><ul>")
                if r.server_error:
                    H.append(f"<li>Server error: {_esc(r.server_error)}</li>")
                for c in r.failed_cases:
                    H.append(f'<li><span class="fail-icon"></span>{_esc(c)}</li>')
                H.append("</ul>")
            H.append("</div></details>")

    # ── Provenance + footer ──
    H.append("<h2>Provenance</h2><ul style='margin-left:1.25rem;font-size:.85rem;color:var(--text2)'>")
    for line in provenance:
        H.append(f"<li>{_md_inline(line)}</li>")
    H.append("</ul>")
    H.append('<div class="footer">Generated by run_combined_report.py &middot; '
             'template: golden-report.html (aidlc-reporting)</div>')

    return (
        "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
        f"<title>AIDLC Evaluation Report — Full Suite ({_esc(generated)})</title>\n"
        "<link rel='preconnect' href='https://fonts.googleapis.com'>\n"
        "<link href='https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700"
        "&family=JetBrains+Mono:wght@400;600&display=swap' rel='stylesheet'>\n"
        f"<style>{_HTML_CSS}</style>\n</head><body>\n"
        + "\n".join(H)
        + "\n</body></html>\n"
    )


def _provenance_lines(greenfield: Path | None, bug_batches: list[Path],
                      feat_batches: list[Path]) -> list[str]:
    prov_bug = ", ".join(f"`{b}`" for b in bug_batches) if bug_batches else "(omitted)"
    prov_feat = ", ".join(f"`{b}`" for b in feat_batches) if feat_batches else "(omitted)"
    return [
        f"Greenfield batch: `{greenfield}`" if greenfield else "Greenfield: (omitted)",
        f"Brownfield bugfix batch(es): {prov_bug}",
        f"Brownfield feature batch(es): {prov_feat}",
        "When multiple batches are listed for a task, a LATER batch replaces that "
        "version's runs; patched `-runNN-rerun` folders supersede their base run.",
        "Brownfield pass/fail read from each run's `contract-test-results.yaml` "
        "(the third-party contract oracle), NOT the manifest completion status.",
        "Brownfield testbeds pinned to upstream commits (verified at preflight): "
        "httpbin `f7b02ae`, realworld `04ef47c`.",
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--greenfield", type=Path, help="greenfield version-batch dir")
    ap.add_argument("--brownfield-bug", type=Path, action="append", default=[],
                    help="brownfield bugfix version-batch dir (repeatable; later wins per version)")
    ap.add_argument("--brownfield-feature", type=Path, action="append", default=[],
                    help="brownfield feature version-batch dir (repeatable; later wins per version)")
    ap.add_argument("--out", type=Path, required=True,
                    help="output path; .html renders the golden-report template, "
                         ".md renders markdown")
    ap.add_argument("--also-html", type=Path, default=None,
                    help="additionally write the HTML rendering to this path")
    ap.add_argument("--generated", default="", help="generated-at stamp (avoids Date.now in scripts)")
    args = ap.parse_args()

    if not any([args.greenfield, args.brownfield_bug, args.brownfield_feature]):
        ap.error("supply at least one of --greenfield / --brownfield-bug / --brownfield-feature")

    generated = args.generated or "(unspecified)"
    gf = collect_greenfield(args.greenfield) if args.greenfield else {}
    bug = collect_brownfield(args.brownfield_bug) if args.brownfield_bug else {}
    feat = collect_brownfield(args.brownfield_feature) if args.brownfield_feature else {}
    _set_version_order(gf, bug, feat)
    prov = _provenance_lines(args.greenfield, args.brownfield_bug, args.brownfield_feature)

    def _write(path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix.lower() in (".html", ".htm"):
            path.write_text(render_html(gf, bug, feat, generated, prov), encoding="utf-8")
        else:
            path.write_text(
                build_combined(args.greenfield, args.brownfield_bug,
                               args.brownfield_feature, generated),
                encoding="utf-8",
            )
        print(f"Wrote combined report → {path}")

    _write(args.out)
    if args.also_html:
        _write(args.also_html)


if __name__ == "__main__":
    main()
