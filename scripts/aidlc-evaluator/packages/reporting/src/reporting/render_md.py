"""Render a ReportData into polished GitHub-flavoured Markdown."""

from __future__ import annotations

from pathlib import Path

from reporting.collector import ReportData


def _ms_to_human(ms: int) -> str:
    secs = ms / 1000
    if secs < 60:
        return f"{secs:.0f}s"
    mins = secs / 60
    if mins < 60:
        return f"{mins:.1f}m"
    hrs = mins / 60
    return f"{hrs:.1f}h"


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}K"
    return str(n)


def _pct_bar(value: float, width: int = 20) -> str:
    filled = round(value * width)
    return "\u2588" * filled + "\u2591" * (width - filled)


def _fmt_val(v: float | int | None) -> str:
    if v is None:
        return "---"
    if isinstance(v, float):
        return f"{v:.4f}" if v < 10 else f"{v:,.0f}"
    return f"{v:,}"


def _status_icon(ok: bool) -> str:
    return "\u2705" if ok else "\u274c"


def _fmt_delta_val(delta: float, metric_name: str) -> str:
    """Format a delta value with appropriate units for the metric."""
    sign = "+" if delta > 0 else ""
    if metric_name == "Wall Clock (ms)":
        abs_ms = abs(delta)
        if abs_ms >= 60_000:
            return f"{sign}{delta / 60_000:.1f}m"
        return f"{sign}{delta / 1_000:.1f}s"
    if "Tokens" in metric_name:
        abs_t = abs(delta)
        if abs_t >= 1_000_000:
            return f"{sign}{delta / 1_000_000:.2f}M"
        if abs_t >= 1_000:
            return f"{sign}{delta / 1_000:.1f}k"
        return f"{sign}{int(delta)}"
    if isinstance(delta, float) and not delta.is_integer():
        return f"{sign}{delta:.3f}"
    return f"{sign}{int(delta)}"


def _md_delta(cmp, metric_name: str) -> str:
    """Return a short inline delta string for the verdict table."""
    if cmp is None:
        return ""
    for d in cmp.deltas:
        if d.name == metric_name and d.delta is not None and abs(d.delta) > 0.001:
            val = _fmt_delta_val(d.delta, metric_name)
            icon = "\U0001f7e2" if d.direction == "improved" else "\U0001f534" if d.direction == "regressed" else "\u26aa"
            return f" {icon} _{val} vs golden_"
    return " \u26aa _= golden_"


def render_markdown(data: ReportData) -> str:
    lines: list[str] = []
    w = lines.append

    run_name = Path(data.meta.run_folder).name if data.meta.run_folder else "unknown"
    cmp = data.comparison

    # ── Header ─────────────────────────────────────────────────
    w(f"# AIDLC Evaluation Report")
    w("")
    w(f"> **Run:** `{run_name}`")
    w(f"> **Generated:** {data.generated_at}")
    w("")

    # ── Test metadata ──────────────────────────────────────────
    w("| | |")
    w("|---|---|")
    w(f"| **Executor Model** | `{data.meta.executor_model}` |")
    w(f"| **Simulator Model** | `{data.meta.simulator_model}` |")
    if data.meta.rules_source == "git" and data.meta.rules_repo:
        w(f"| **Rules Source** | `{data.meta.rules_repo}` @ `{data.meta.rules_ref}` |")
    elif data.meta.rules_source == "local" and data.meta.rules_local_path:
        w(f"| **Rules Source** | local: `{data.meta.rules_local_path}` |")
    elif data.meta.rules_source:
        w(f"| **Rules Source** | `{data.meta.rules_source}` |")
    w("")

    # ── Verdict banner ─────────────────────────────────────────
    test_ok = data.tests and data.tests.test_ok and data.tests.failed == 0
    contract_ok = data.contracts and data.contracts.failed == 0 and data.contracts.errors == 0
    qual_score = data.qualitative.overall_score if data.qualitative else 0
    overall_ok = (test_ok is not False) and (contract_ok is not False) and qual_score >= 0.7

    w("## Verdict")
    w("")
    w(f"| Dimension | Result |")
    w(f"|-----------|--------|")
    if data.tests:
        w(f"| Unit Tests | {_status_icon(test_ok)} **{data.tests.pass_pct:.1f}%** ({data.tests.passed}/{data.tests.total}){_md_delta(cmp, 'Tests Pass %')} |")
    if data.contracts:
        w(f"| Contract Tests | {_status_icon(contract_ok)} **{data.contracts.passed}/{data.contracts.total}** passed{_md_delta(cmp, 'Contract Passed')} |")
    if data.quality:
        q_ok = data.quality.lint_errors == 0 and data.quality.security_high == 0
        w(f"| Code Quality | {_status_icon(q_ok)} lint: {data.quality.lint_total} ({data.quality.lint_errors} errors), security: {data.quality.security_total} ({data.quality.security_high} high){_md_delta(cmp, 'Lint Errors')} |")
    if data.qualitative:
        w(f"| Qualitative Score | {'🟢' if qual_score >= 0.8 else '🟡' if qual_score >= 0.6 else '🔴'} **{qual_score:.2f}**{_md_delta(cmp, 'Qualitative Score')} |")
    w(f"| Execution Time | {_ms_to_human(data.metrics.wall_clock_ms)}{_md_delta(cmp, 'Wall Clock (ms)')} |")
    w(f"| Total Tokens | {_fmt_tokens(data.metrics.total_tokens.total_tokens)}{_md_delta(cmp, 'Total Tokens')} |")
    w("")

    # ── Run Overview ───────────────────────────────────────────
    w("## Run Overview")
    w("")
    w("| Property | Value |")
    w("|----------|-------|")
    w(f"| Status | `{data.meta.status}` |")
    w(f"| Executor Model | `{data.meta.executor_model}` |")
    w(f"| Simulator Model | `{data.meta.simulator_model}` |")
    w(f"| Region | `{data.meta.aws_region}` |")
    w(f"| Wall Clock | {_ms_to_human(data.metrics.wall_clock_ms)} |")
    w(f"| Handoffs | {data.meta.total_handoffs} ({' → '.join(data.meta.node_history)}) |")
    if data.meta.started_at:
        w(f"| Started | {data.meta.started_at} |")
    if data.meta.completed_at:
        w(f"| Completed | {data.meta.completed_at} |")
    w("")

    # ── Token Usage ────────────────────────────────────────────
    w("## Token Usage")
    w("")
    w("### Unique Tokens by Agent")
    w("")
    w("| Agent | Input | Output | Total |")
    w("|-------|------:|-------:|------:|")
    w(f"| Executor | {_fmt_tokens(data.metrics.executor_tokens.input_tokens)} | {_fmt_tokens(data.metrics.executor_tokens.output_tokens)} | {_fmt_tokens(data.metrics.executor_tokens.total_tokens)} |")
    w(f"| Simulator | {_fmt_tokens(data.metrics.simulator_tokens.input_tokens)} | {_fmt_tokens(data.metrics.simulator_tokens.output_tokens)} | {_fmt_tokens(data.metrics.simulator_tokens.total_tokens)} |")
    w(f"| **Total Unique** | **{_fmt_tokens(data.metrics.total_tokens.input_tokens)}** | **{_fmt_tokens(data.metrics.total_tokens.output_tokens)}** | **{_fmt_tokens(data.metrics.total_tokens.total_tokens)}** |")
    w("")

    # Show repeated context if present
    if data.metrics.repeated_context_tokens.total_tokens > 0:
        w("### Context Repetition")
        w("")
        w("Tokens re-sent across multiple conversation turns:")
        w("")
        w("| Category | Input | Output | Total |")
        w("|----------|------:|-------:|------:|")
        w(f"| Repeated Context | {_fmt_tokens(data.metrics.repeated_context_tokens.input_tokens)} | {_fmt_tokens(data.metrics.repeated_context_tokens.output_tokens)} | {_fmt_tokens(data.metrics.repeated_context_tokens.total_tokens)} |")
        w(f"| **API Total** | **{_fmt_tokens(data.metrics.api_total_tokens.input_tokens)}** | **{_fmt_tokens(data.metrics.api_total_tokens.output_tokens)}** | **{_fmt_tokens(data.metrics.api_total_tokens.total_tokens)}** |")
        w("")
    w("")

    # ── Context Size ──────────────────────────────────────────
    ctx_total = data.metrics.context_size_total
    if ctx_total and ctx_total.sample_count > 0:
        ctx_ex = data.metrics.context_size_executor
        ctx_si = data.metrics.context_size_simulator
        w("## Context Size (Input Tokens per Invocation)")
        w("")
        w("| Agent | Min | Max | Average | Median | Samples |")
        w("|-------|----:|----:|--------:|-------:|--------:|")
        if ctx_ex and ctx_ex.sample_count > 0:
            w(f"| Executor | {_fmt_tokens(ctx_ex.min_tokens)} | {_fmt_tokens(ctx_ex.max_tokens)} | {_fmt_tokens(ctx_ex.avg_tokens)} | {_fmt_tokens(ctx_ex.median_tokens)} | {ctx_ex.sample_count} |")
        if ctx_si and ctx_si.sample_count > 0:
            w(f"| Simulator | {_fmt_tokens(ctx_si.min_tokens)} | {_fmt_tokens(ctx_si.max_tokens)} | {_fmt_tokens(ctx_si.avg_tokens)} | {_fmt_tokens(ctx_si.median_tokens)} | {ctx_si.sample_count} |")
        w(f"| **Total** | **{_fmt_tokens(ctx_total.min_tokens)}** | **{_fmt_tokens(ctx_total.max_tokens)}** | **{_fmt_tokens(ctx_total.avg_tokens)}** | **{_fmt_tokens(ctx_total.median_tokens)}** | **{ctx_total.sample_count}** |")
        w("")

    # ── Handoff Timeline ───────────────────────────────────────
    if data.metrics.handoffs:
        w("## Handoff Timeline")
        w("")
        w("| # | Agent | Duration |")
        w("|--:|-------|----------|")
        for h in data.metrics.handoffs:
            w(f"| {h.handoff} | {h.node_id} | {_ms_to_human(h.duration_ms)} |")
        w("")

    # ── Generated Artifacts ────────────────────────────────────
    art = data.metrics.artifacts
    if art.total_files > 0:
        w("## Generated Artifacts")
        w("")
        w("| Category | Count |")
        w("|----------|------:|")
        w(f"| Source files | {art.source_files} |")
        w(f"| Test files | {art.test_files} |")
        w(f"| Config files | {art.config_files} |")
        w(f"| Total files | {art.total_files} |")
        w(f"| Lines of code | {art.total_lines_of_code:,} |")
        w(f"| AIDLC docs (inception) | {art.inception_files} |")
        w(f"| AIDLC docs (construction) | {art.construction_files} |")
        w(f"| AIDLC docs total | {art.total_doc_files} |")
        w("")

    # ── Unit Tests ─────────────────────────────────────────────
    if data.tests:
        t = data.tests
        w("## Unit Tests")
        w("")
        w(f"**{_status_icon(test_ok)} {t.pass_pct:.1f}% passed** ({t.passed}/{t.total})")
        if t.failed:
            w(f" &mdash; {t.failed} failed")
        if t.coverage_pct is not None:
            w(f"")
            w(f"**Coverage:** {t.coverage_pct:.1f}%")
        w("")

    # ── Contract Tests ─────────────────────────────────────────
    if data.contracts:
        ct = data.contracts
        w("## Contract Tests (API Specification)")
        w("")
        w(f"**{_status_icon(contract_ok)} {ct.passed}/{ct.total}** endpoints validated")
        w("")
        if ct.server_error:
            w(f"> **Server error:** {ct.server_error}")
            w("")

        groups: dict[str, list] = {}
        for c in ct.cases:
            parts = c.path.strip("/").split("/")
            group = parts[2] if len(parts) >= 3 else parts[0]
            groups.setdefault(group, []).append(c)

        for group_name, cases in groups.items():
            passed_in_group = sum(1 for c in cases if c.passed)
            total_in_group = len(cases)
            icon = _status_icon(passed_in_group == total_in_group)
            w(f"### {group_name.title()} {icon} {passed_in_group}/{total_in_group}")
            w("")
            w("| Test | Method | Path | Status | Latency |")
            w("|------|--------|------|:------:|--------:|")
            for c in cases:
                mark = _status_icon(c.passed)
                status_str = str(c.actual_status) if c.actual_status else "---"
                lat = f"{c.latency_ms:.0f}ms" if c.latency_ms else "---"
                w(f"| {mark} {c.name} | {c.method} | `{c.path}` | {status_str} | {lat} |")
            w("")
            for c in cases:
                if not c.passed and (c.failures or c.error):
                    detail = "; ".join(c.failures) if c.failures else c.error
                    w(f"> **{c.name}:** {detail}")
            w("")

    # ── Code Quality ───────────────────────────────────────────
    if data.quality:
        q = data.quality
        q_ok = q.lint_errors == 0 and q.security_high == 0
        w("## Code Quality")
        w("")
        w(f"**{_status_icon(q_ok)} Lint: {q.lint_total} findings** ({q.lint_errors} errors, {q.lint_warnings} warnings)")
        w("")
        if q.lint_available and q.lint_findings:
            w(f"**Linter:** {q.lint_tool} {q.lint_version}")
            w("")
            w("| File | Line | Code | Message | Severity |")
            w("|------|-----:|------|---------|----------|")
            for f in q.lint_findings:
                sev_icon = "🔴" if f.severity == "error" else "🟡"
                w(f"| `{f.file}` | {f.line} | `{f.code}` | {f.message} | {sev_icon} {f.severity} |")
            w("")

        w("### Security")
        w("")
        sec_ok = q.security_high == 0
        w(f"**{_status_icon(sec_ok)} {q.security_total} finding(s)** ({q.security_high} high)")
        w("")
        if not q.security_available:
            w(f"*Security scanner ({q.security_tool or 'bandit'}) was not available.*")
            w("")
        if q.semgrep_available:
            w(f"*Semgrep: {q.semgrep_total} finding(s)*")
            w("")
        elif q.semgrep_tool:
            w(f"*Semgrep was not available.*")
            w("")

        w("### Code Duplication")
        w("")
        if q.duplication_available:
            dup_ok = q.duplication_blocks == 0
            w(f"**{_status_icon(dup_ok)} {q.duplication_blocks} duplicate block(s)** ({q.duplication_lines} duplicated lines)")
        else:
            w(f"*Duplication scanner ({q.duplication_tool or 'pmd-cpd'}) was not available.*")
        w("")

    # ── Qualitative Evaluation ─────────────────────────────────
    if data.qualitative:
        ql = data.qualitative
        w("## Qualitative Evaluation (Semantic Similarity)")
        w("")
        score_icon = "🟢" if ql.overall_score >= 0.8 else "🟡" if ql.overall_score >= 0.6 else "🔴"
        w(f"**Overall Score: {score_icon} {ql.overall_score:.4f}**")
        w("")

        for phase in ql.phases:
            w(f"### {phase.phase.title()} Phase")
            w("")
            w(f"| Dimension | Score |")
            w(f"|-----------|------:|")
            w(f"| Intent | {phase.avg_intent:.2f} |")
            w(f"| Design | {phase.avg_design:.2f} |")
            w(f"| Completeness | {phase.avg_completeness:.2f} |")
            w(f"| **Overall** | **{phase.avg_overall:.2f}** |")
            w("")

            w("| Document | Intent | Design | Complete | Overall |")
            w("|----------|-------:|-------:|---------:|--------:|")
            for d in phase.documents:
                name = Path(d.path).name
                w(f"| `{name}` | {d.intent:.2f} | {d.design:.2f} | {d.completeness:.2f} | {d.overall:.2f} |")
            w("")

            for d in phase.documents:
                if d.notes:
                    name = Path(d.path).name
                    short = d.notes[:200] + "..." if len(d.notes) > 200 else d.notes
                    w(f"<details><summary><code>{name}</code> — {d.overall:.2f}</summary>")
                    w(f"")
                    w(f"{d.notes}")
                    w(f"")
                    w(f"</details>")
                    w("")

        if ql.unmatched_candidate:
            w("### Unmatched Candidate Documents")
            w("")
            for p in ql.unmatched_candidate:
                w(f"- `{p}`")
            w("")

    # ── Errors ─────────────────────────────────────────────────
    errs = data.metrics.errors
    if errs and any(v > 0 for v in errs.values()):
        w("## Errors During Execution")
        w("")
        w("| Error Type | Count |")
        w("|------------|------:|")
        for k, v in errs.items():
            if v > 0:
                w(f"| {k.replace('_', ' ').title()} | {v} |")
        w("")

    # ── Baseline Comparison ──────────────────────────────────────
    if data.comparison:
        cmp = data.comparison
        w("## Baseline Comparison")
        w("")
        golden_name = Path(cmp.golden_run).name if cmp.golden_run else "unknown"
        w(f"> Compared against golden baseline: `{golden_name}`")
        if cmp.golden_promoted_at:
            w(f"> Promoted: {cmp.golden_promoted_at}")
        w("")

        improved_icon = "\U0001f7e2"   # green circle
        regressed_icon = "\U0001f534"  # red circle
        unchanged_icon = "\u26aa"      # white circle

        w(f"| | Count |")
        w(f"|---|------:|")
        w(f"| {improved_icon} Improved | {cmp.improved} |")
        w(f"| {regressed_icon} Regressed | {cmp.regressed} |")
        w(f"| {unchanged_icon} Unchanged | {cmp.unchanged} |")
        w("")

        categories_seen: set[str] = set()
        for d in cmp.deltas:
            if d.category not in categories_seen:
                categories_seen.add(d.category)
                w(f"### {d.category}")
                w("")
                w("| Metric | Golden | Current | Delta | Change |")
                w("|--------|-------:|--------:|------:|--------|")

            if d.direction == "improved":
                icon = improved_icon
            elif d.direction == "regressed":
                icon = regressed_icon
            else:
                icon = unchanged_icon

            golden_str = _fmt_val(d.golden)
            current_str = _fmt_val(d.current)
            if d.delta is not None:
                sign = "+" if d.delta > 0 else ""
                delta_str = f"{sign}{d.delta:.2f}" if isinstance(d.delta, float) and not d.delta.is_integer() else f"{sign}{int(d.delta)}"
                pct_str = f"({d.pct_change:+.1f}%)" if d.pct_change is not None and abs(d.pct_change) >= 0.1 else ""
                change_str = f"{icon} {delta_str} {pct_str}".strip()
            else:
                change_str = f"{icon}"

            w(f"| {d.name} | {golden_str} | {current_str} | {change_str} | {d.direction} |")

            # Close table when next category starts
            next_idx = cmp.deltas.index(d) + 1
            if next_idx < len(cmp.deltas) and cmp.deltas[next_idx].category != d.category:
                w("")

        w("")

    # ── Footer ─────────────────────────────────────────────────
    w("---")
    w(f"*Report generated by aidlc-reporting v0.1.0*")

    return "\n".join(lines) + "\n"


def write_markdown(data: ReportData, output_path: Path) -> None:
    md = render_markdown(data)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(md)
