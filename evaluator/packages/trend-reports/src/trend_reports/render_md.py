"""Markdown trend report renderer."""

from __future__ import annotations

from .collector import compute_deltas
from .models import TrendData
from .sparkline import (
    format_delta,
    format_number,
    format_pct,
    format_seconds_as_minutes,
    sparkline,
    trend_arrow,
)


def render_trend_markdown(trend: TrendData) -> str:
    """Render the full trend report as Markdown."""
    sections = [
        _render_header(trend),
        _render_infra_failure_banner(trend),
        _render_toc(),
        _render_section_a(trend),
        _render_section_b(trend),
        _render_section_c(trend),
        _render_section_d(trend),
        _render_section_e(trend),
        _render_section_f(trend),
        _render_section_g(trend),
        _render_section_h(trend),
    ]
    return "\n".join(sections) + "\n"


# ---------------------------------------------------------------------------
# Header & TOC
# ---------------------------------------------------------------------------


def _render_header(trend: TrendData) -> str:
    n = len(trend.runs)
    first = trend.runs[0].label if trend.runs else "—"
    last = trend.runs[-1].label if trend.runs else "—"
    return (
        f"# AIDLC Rules Trend Report\n\n"
        f"> **{n} releases** compared ({first} through {last})  \n"
        f"> **Repository:** `{trend.repo}`  \n"
        f"> **Generated:** {trend.generated_at}\n"
    )


def _render_infra_failure_banner(trend: TrendData) -> str:
    """Render a prominent warning banner if any runs have infra failures."""
    infra_runs = [r for r in trend.runs if r.infra_failure.is_infra_failure]
    if not infra_runs:
        return ""

    lines = [
        "> **WARNING: Infrastructure Failure Detected**",
        ">",
        (
            "> The following runs experienced infrastructure failures. "
            "Their results are unreliable and have been excluded from regression checks."
        ),
        ">",
    ]
    for r in infra_runs:
        reasons = ", ".join(reason.value for reason in r.infra_failure.reasons)
        lines.append(f"> - **{r.label}**: {reasons}")
    lines.append("")
    return "\n".join(lines) + "\n"


def _render_toc() -> str:
    return (
        "## Contents\n\n"
        "- [A. Executive Summary](#a-executive-summary)\n"
        "- [B. Functional Correctness](#b-functional-correctness)\n"
        "- [C. Qualitative Evaluation](#c-qualitative-evaluation)\n"
        "- [D. Efficiency & Cost](#d-efficiency--cost-metrics)\n"
        "- [E. Code Quality](#e-code-quality)\n"
        "- [F. Stability & Reliability](#f-stability--reliability)\n"
        "- [G. Version-over-Version Deltas](#g-version-over-version-deltas)\n"
        "- [H. Pre-Release Data Points](#h-pre-release-data-points)\n"
    )


# ---------------------------------------------------------------------------
# Section A — Executive Summary
# ---------------------------------------------------------------------------


def _render_section_a(trend: TrendData) -> str:
    runs = trend.runs
    bl = trend.baseline
    latest = runs[-1] if runs else None
    if latest is None:
        return "---\n\n## A. Executive Summary\n\nNo data available.\n"

    def _spark(extractor):
        vals = [extractor(r) for r in runs]
        return f"`{sparkline(vals)}` {trend_arrow(vals)}"

    def _bl_str(val, fmt=str):
        return fmt(val) if val else "—"

    rows = [
        [
            "Unit tests passed",
            _bl_str(bl.unit_tests_passed),
            str(latest.unit_tests.passed),
            _fmt_vs(latest.unit_tests.passed, bl.unit_tests_passed),
            _spark(lambda r: r.unit_tests.passed),
        ],
        [
            "Contract tests",
            f"{bl.contract_tests_passed}/{bl.contract_tests_total}"
            if bl.contract_tests_total
            else "—",
            f"{latest.contract_tests.passed}/{latest.contract_tests.total}",
            _fmt_vs(latest.contract_tests.passed, bl.contract_tests_passed),
            _spark(lambda r: r.contract_tests.passed),
        ],
        [
            "Lint findings",
            str(bl.lint_findings),
            str(latest.code_quality.lint_findings),
            _fmt_vs(latest.code_quality.lint_findings, bl.lint_findings, lower_is_better=True),
            _spark(lambda r: r.code_quality.lint_findings),
        ],
        [
            "Qualitative score",
            f"{bl.qualitative_overall:.3f}" if bl.qualitative_overall else "—",
            f"{latest.qualitative.overall_score:.3f}",
            f"{latest.qualitative.overall_score - bl.qualitative_overall:+.3f}"
            if bl.qualitative_overall
            else "—",
            _spark(lambda r: r.qualitative.overall_score),
        ],
        [
            "Execution time",
            format_seconds_as_minutes(bl.execution_time_seconds)
            if bl.execution_time_seconds
            else "—",
            format_seconds_as_minutes(latest.metrics.execution_time_seconds),
            _fmt_time_vs(latest.metrics.execution_time_seconds, bl.execution_time_seconds),
            _spark(lambda r: r.metrics.execution_time_seconds),
        ],
        [
            "Total tokens",
            format_number(bl.total_tokens) if bl.total_tokens else "—",
            format_number(latest.metrics.total_tokens),
            _fmt_token_vs(latest.metrics.total_tokens, bl.total_tokens),
            _spark(lambda r: r.metrics.total_tokens),
        ],
    ]

    return (
        "---\n\n"
        f"## A. Executive Summary\n\n"
        f"Latest release: **{latest.label}**\n\n"
        "High-level snapshot comparing the latest release against the golden baseline "
        "(the reference evaluation used as the quality target).\n\n"
        "| Metric | What it measures |\n"
        "| --- | --- |\n"
        "| **Unit tests passed** | Number of generated unit tests that pass. Higher means the rules produce broader, more complete test suites. |\n"
        "| **Contract tests** | API compliance checks against the OpenAPI spec (passed/total). 88/88 = full compliance. |\n"
        "| **Lint findings** | Static analysis warnings in generated code. Lower is better — 0 means clean code. |\n"
        "| **Qualitative score** | AI-graded quality of generated documentation on a 0–1 scale (higher is better). |\n"
        "| **Execution time** | Wall-clock time for the full evaluation run. Lower means faster generation. |\n"
        "| **Total tokens** | Total LLM tokens consumed (input + output). Lower means more cost-efficient. |\n\n"
        + _md_table(
            ["Metric", "Golden", f"Latest ({latest.label})", "vs Golden", "Trend"],
            rows,
        )
    )


# ---------------------------------------------------------------------------
# Section B — Functional Correctness
# ---------------------------------------------------------------------------


def _render_section_b(trend: TrendData) -> str:
    parts = ["---\n\n## B. Functional Correctness\n"]

    parts.append(
        "Measures whether the code generated by each rules version actually works correctly. "
        "This is the most fundamental quality gate — code that doesn't pass its own tests is broken.\n"
    )

    # B.1 Unit tests
    parts.append("### B.1 Unit Tests\n")
    parts.append(
        "Unit tests validate individual functions and components in isolation. "
        "The AIDLC rules instruct the AI to generate both source code and test suites. "
        "**Passed** = tests that ran and succeeded. "
        "**Failed** = tests that ran but produced wrong results. "
        "**Total** = passed + failed + errors + skipped. "
        "All versions currently show 0 failures — the variance is in how many "
        "tests the rules produce, which reflects test suite breadth and coverage.\n\n"
    )
    rows = [
        [r.label, str(r.unit_tests.passed), str(r.unit_tests.failed), str(r.unit_tests.total)]
        for r in trend.runs
    ]
    parts.append(_md_table(["Version", "Passed", "Failed", "Total"], rows))

    # B.2 Contract tests
    parts.append("\n### B.2 Contract Tests (API Compliance)\n")
    parts.append(
        "Contract tests verify that the generated API implementation matches its OpenAPI specification. "
        "Each test sends a request to an endpoint and checks that the HTTP status code and response "
        "shape match the spec. 88 endpoints are tested per version. "
        "**Pass/Total** = endpoints that returned the expected status code. "
        "**Rate** = pass percentage (100% = full spec compliance). "
        "**Failures** lists the specific endpoints that deviated from the spec.\n\n"
    )
    rows = [
        [
            r.label,
            f"{r.contract_tests.passed}/{r.contract_tests.total}",
            format_pct(r.contract_tests.pass_rate),
            str(r.contract_tests.failed),
        ]
        for r in trend.runs
    ]
    parts.append(_md_table(["Version", "Pass/Total", "Rate", "Failures"], rows))

    for r in trend.runs:
        if r.contract_tests.failures:
            parts.append(f"\n> **{r.label} failures:**\n")
            for f in r.contract_tests.failures:
                parts.append(
                    f"> - `{f.method} {f.endpoint}` — expected {f.expected_status}, "
                    f"got {f.actual_status} ({f.description})\n"
                )

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Section C — Qualitative Evaluation
# ---------------------------------------------------------------------------


def _render_section_c(trend: TrendData) -> str:
    parts = ["---\n\n## C. Qualitative Evaluation\n"]

    parts.append(
        "Measures the quality of generated documentation by comparing it against "
        "human-authored reference documents. An AI evaluator scores each document on "
        "completeness, accuracy, and clarity, producing a 0–1 score (1.0 = perfect match "
        "to reference quality).\n"
    )

    # C.1 Overall
    parts.append("### C.1 Overall Score\n")
    parts.append(
        "The weighted average across all evaluated documents. "
        "This is the single best indicator of how well the rules produce documentation. "
        "Scores above 0.90 are considered strong; below 0.70 signals significant gaps.\n\n"
    )
    bl_score = trend.baseline.qualitative_overall
    if bl_score:
        parts.append(f"Golden baseline: **{bl_score:.3f}**\n\n")
    rows = [
        [
            r.label,
            f"{r.qualitative.overall_score:.3f}",
            f"{r.qualitative.overall_score - bl_score:+.3f}" if bl_score else "—",
        ]
        for r in trend.runs
    ]
    parts.append(_md_table(["Version", "Overall", "vs Golden"], rows))

    # C.2 Phase breakdown
    parts.append("\n### C.2 Phase Breakdown\n")
    parts.append(
        "Documents are grouped by SDLC phase. "
        "**Inception** covers early-stage design artifacts (requirements, architecture plans, "
        "component designs) — these are generated first and set the foundation. "
        "**Construction** covers build-time artifacts (build instructions, test instructions, "
        "build-and-test summaries) — these depend on inception outputs being correct. "
        "A drop in inception quality often cascades into construction.\n\n"
    )
    rows = [
        [r.label, f"{r.qualitative.inception_score:.3f}", f"{r.qualitative.construction_score:.3f}"]
        for r in trend.runs
    ]
    parts.append(_md_table(["Version", "Inception", "Construction"], rows))

    # C.3 Per-document heatmap
    parts.append("\n### C.3 Per-Document Heatmap\n")
    parts.append(
        "Individual quality scores for each generated document across all versions. "
        "This reveals which specific documents are consistently strong, improving, or "
        "problematic. Documents scoring below 0.70 (bold/red) are the top candidates for "
        "rules improvements.\n\n"
    )
    all_docs, labels, matrix = _build_heatmap_matrix(trend)
    header = ["Document"] + labels
    rows = []
    for i, doc in enumerate(all_docs):
        row = [f"`{doc}`"]
        for score in matrix[i]:
            if score < 0:
                row.append("—")
            elif score >= 0.90:
                row.append(f"{score:.2f}")
            elif score >= 0.70:
                row.append(f"*{score:.2f}*")
            else:
                row.append(f"**{score:.2f}**")
        rows.append(row)
    parts.append(_md_table(header, rows))
    parts.append(
        "\n> **Legend:** plain = green (>= 0.90) · *italic* = yellow (0.70–0.89) · **bold** = red (< 0.70)\n"
    )

    # C.4 Document coverage
    parts.append("\n### C.4 Document Coverage\n")
    parts.append(
        "Tracks whether the generated output includes the same set of documents as the reference. "
        "**Unmatched Ref** = reference documents the AI failed to generate (missing output). "
        "**Unmatched Candidate** = extra documents the AI generated that don't exist in the reference "
        "(unexpected output). Ideally both columns are 0, meaning the AI produced exactly the expected "
        "set of documents.\n\n"
    )
    rows = [
        [
            r.label,
            str(len(r.qualitative.unmatched_reference_docs)),
            str(len(r.qualitative.unmatched_candidate_docs)),
        ]
        for r in trend.runs
    ]
    parts.append(_md_table(["Version", "Unmatched Ref", "Unmatched Candidate"], rows))

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Section D — Efficiency & Cost
# ---------------------------------------------------------------------------


def _render_section_d(trend: TrendData) -> str:
    parts = ["---\n\n## D. Efficiency & Cost Metrics\n"]
    parts.append(
        "Tracks the computational resources consumed by each evaluation run. "
        "These metrics directly affect cost (tokens) and developer wait time (execution time). "
        "Lower values are generally better, as long as quality metrics remain stable.\n"
    )

    # D.1 Token consumption
    parts.append("### D.1 Token Consumption\n")
    parts.append(
        "Total LLM tokens consumed during the run, broken down by agent. "
        "**Total** = all tokens across all agents (input + output). "
        "**Executor** = the agent that generates code and documents. "
        "**Simulator** = the agent that simulates user interactions for testing. "
        "Token count is the primary cost driver — each token represents a unit of LLM usage billed by the provider.\n\n"
    )
    rows = []
    for r in trend.runs:
        agent_cols = {a.agent_name: format_number(a.total_tokens) for a in r.metrics.agent_tokens}
        rows.append(
            [
                r.label,
                format_number(r.metrics.total_tokens),
                agent_cols.get("executor", "—"),
                agent_cols.get("simulator", "—"),
            ]
        )
    parts.append(_md_table(["Version", "Total", "Executor", "Simulator"], rows))

    # D.2 Execution time
    parts.append("\n### D.2 Execution Time\n")
    parts.append(
        "Wall-clock duration of the full evaluation pipeline, broken down by handoff. "
        "Each **handoff** (H1, H2, H3) represents a sequential phase of the pipeline: "
        "H1 is typically code generation (the longest phase), H2 is build/test execution, "
        "and H3 is result collection and reporting. "
        "**Wall Clock** is the total end-to-end time.\n\n"
    )
    rows = []
    for r in trend.runs:
        handoff_strs = [
            f"H{h.handoff_number}: {format_seconds_as_minutes(h.duration_seconds)}"
            for h in r.metrics.handoffs
        ]
        rows.append(
            [
                r.label,
                format_seconds_as_minutes(r.metrics.execution_time_seconds),
                " · ".join(handoff_strs) if handoff_strs else "—",
            ]
        )
    parts.append(_md_table(["Version", "Wall Clock", "Handoff Breakdown"], rows))

    # D.3 Context window
    parts.append("\n### D.3 Context Window Pressure\n")
    parts.append(
        "Measures how much of the LLM's context window is being used across API calls. "
        "**Max** = the largest single context seen during the run (approaching the model's limit "
        "risks truncation or degraded output). "
        "**Avg** = the mean context size across all API calls. "
        "**Median** = the midpoint context size (less affected by outliers than avg). "
        "High context pressure can indicate overly verbose prompts or accumulated conversation history.\n\n"
    )
    rows = [
        [
            r.label,
            format_number(r.metrics.max_context_tokens),
            format_number(r.metrics.avg_context_tokens),
            format_number(r.metrics.median_context_tokens),
        ]
        for r in trend.runs
    ]
    parts.append(_md_table(["Version", "Max", "Avg", "Median"], rows))

    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Section E — Code Quality
# ---------------------------------------------------------------------------


def _render_section_e(trend: TrendData) -> str:
    parts = ["---\n\n## E. Code Quality\n"]
    parts.append(
        "Static analysis of the generated codebase. These metrics reflect the cleanliness and "
        "maintainability of the AI-generated code, independent of whether it passes tests.\n\n"
        "| Metric | What it measures |\n"
        "| --- | --- |\n"
        "| **Lint Findings** | Warnings from static analysis (style violations, unused variables, etc.). 0 = clean. |\n"
        "| **Security Findings** | Vulnerabilities detected by security scanners (SQL injection, XSS, etc.). N/A if no scanner was configured. |\n"
        "| **Source Files** | Number of non-test source files in the generated project. |\n"
        "| **LOC** | Total lines of code across all source files. Large swings may indicate generated boilerplate or missing modules. |\n\n"
    )
    rows = [
        [
            r.label,
            str(r.code_quality.lint_findings),
            str(r.code_quality.security_findings)
            if r.code_quality.security_scanner_available
            else "N/A",
            str(r.code_quality.source_file_count),
            format_number(r.code_quality.total_lines_of_code),
        ]
        for r in trend.runs
    ]
    parts.append(
        _md_table(
            ["Version", "Lint Findings", "Security Findings", "Source Files", "LOC"],
            rows,
        )
    )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Section F — Stability & Reliability
# ---------------------------------------------------------------------------


def _render_section_f(trend: TrendData) -> str:
    parts = ["---\n\n## F. Stability & Reliability\n"]
    parts.append(
        "Tracks whether the evaluation pipeline itself ran smoothly, independent of output quality.\n\n"
        "| Metric | What it measures |\n"
        "| --- | --- |\n"
        "| **Infra Failure** | Whether infrastructure issues (Bedrock outage, throttling) invalidated the run. |\n"
        "| **Total Errors** | Sum of all runtime error events. |\n"
        "| **Throttle** | Bedrock API throttle (rate limit) events. |\n"
        "| **Svc Unavail** | Bedrock service unavailable events. |\n"
        "| **Model Error** | Bedrock model error events. |\n"
        "| **Handoffs** | Number of sequential pipeline phases completed. Typically 3 (generate, build/test, report). A different count may indicate an early abort or retry. |\n"
        "| **Server Startup** | Whether the generated application server started successfully. A failure here means the generated code couldn't even boot, preventing contract tests from running. |\n\n"
    )
    rows = [
        [
            r.label,
            "**YES**" if r.infra_failure.is_infra_failure else "No",
            str(r.metrics.error_count),
            str(r.metrics.throttle_events),
            str(r.metrics.service_unavailable_events),
            str(r.metrics.model_error_events),
            str(r.metrics.num_handoffs),
            "Yes" if r.metrics.server_startup_success else "**No**",
        ]
        for r in trend.runs
    ]
    parts.append(
        _md_table(
            [
                "Version",
                "Infra Failure",
                "Total Errors",
                "Throttle",
                "Svc Unavail",
                "Model Error",
                "Handoffs",
                "Server Startup",
            ],
            rows,
        )
    )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Section G — Version-over-Version Deltas
# ---------------------------------------------------------------------------


def _render_section_g(trend: TrendData) -> str:
    parts = ["---\n\n## G. Version-over-Version Deltas\n"]
    deltas = compute_deltas(trend.runs)
    if not deltas:
        parts.append("Not enough data points to compute deltas.\n")
        return "\n".join(parts)

    parts.append(
        "Each row shows the change from one release to the next, making it easy to spot "
        "which specific version introduced an improvement or regression. "
        "Positive values (+) indicate an increase; negative (-) indicate a decrease. "
        "For **Unit Tests** and **Contract**, positive is better (more tests passing). "
        "For **Qualitative**, positive is better (higher quality score). "
        "For **Tokens** and **Time**, negative is better (more efficient).\n\n"
    )

    rows = [
        [
            f"{d.from_label} -> {d.to_label}",
            format_delta(d.unit_tests_delta),
            format_delta(d.contract_tests_delta),
            format_delta(d.qualitative_delta, precision=3),
            format_delta(d.token_delta)
            if abs(d.token_delta) < 1000
            else _fmt_token_delta(d.token_delta),
            f"{format_delta(d.time_delta_seconds, precision=0)}s",
        ]
        for d in deltas
    ]
    parts.append(
        _md_table(
            ["Transition", "Unit Tests", "Contract", "Qualitative", "Tokens", "Time"],
            rows,
        )
    )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Section H — Pre-Release Data Points
# ---------------------------------------------------------------------------


def _render_section_h(trend: TrendData) -> str:
    from .models import RunType

    pre_release = [r for r in trend.runs if r.run_type in (RunType.MAIN, RunType.PR)]

    parts = ["---\n\n## H. Pre-Release Data Points\n"]
    parts.append(
        "Evaluation results from non-release sources — the `main` branch and open pull requests. "
        "These represent in-progress work that hasn't been tagged as a release yet. "
        "Use this data to preview whether upcoming changes will improve or regress metrics "
        "before they ship.\n"
    )

    if not pre_release:
        parts.append(
            "\nNo pre-release data available. Data from `main` and "
            "pull request evaluations will appear here when available.\n"
        )
        return "\n".join(parts)

    rows = [
        [
            r.label,
            str(r.unit_tests.passed),
            f"{r.contract_tests.passed}/{r.contract_tests.total}",
            f"{r.qualitative.overall_score:.3f}",
            format_number(r.metrics.total_tokens),
        ]
        for r in pre_release
    ]
    parts.append(
        _md_table(
            ["Source", "Unit Tests", "Contract", "Qualitative", "Tokens"],
            rows,
        )
    )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def _md_table(headers: list[str], rows: list[list[str]]) -> str:
    """Render a Markdown table with right-aligned numeric columns."""
    if not rows:
        return ""

    # Compute column widths for alignment
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            if i < len(widths):
                widths[i] = max(widths[i], len(cell))

    # Build header
    header_line = "| " + " | ".join(h.ljust(widths[i]) for i, h in enumerate(headers)) + " |"
    sep_line = "| " + " | ".join("-" * widths[i] for i in range(len(headers))) + " |"

    lines = [header_line, sep_line]
    for row in rows:
        cells = []
        for i, cell in enumerate(row):
            w = widths[i] if i < len(widths) else len(cell)
            cells.append(cell.ljust(w))
        lines.append("| " + " | ".join(cells) + " |")

    return "\n".join(lines) + "\n"


def _build_heatmap_matrix(
    trend: TrendData,
) -> tuple[list[str], list[str], list[list[float]]]:
    """Build a document x version score matrix for the heatmap."""
    all_docs = sorted(
        {ds.document_name for run in trend.runs for ds in run.qualitative.document_scores}
    )
    labels = [r.label for r in trend.runs]

    matrix: list[list[float]] = []
    for doc in all_docs:
        row: list[float] = []
        for run in trend.runs:
            score = next(
                (
                    ds.overall_score
                    for ds in run.qualitative.document_scores
                    if ds.document_name == doc
                ),
                -1.0,
            )
            row.append(score)
        matrix.append(row)

    return all_docs, labels, matrix


def _fmt_vs(current: int, baseline: int, lower_is_better: bool = False) -> str:
    """Format a current vs baseline comparison."""
    if not baseline:
        return "—"
    delta = current - baseline
    if delta == 0:
        return "="
    display_delta = -delta if lower_is_better else delta
    return format_delta(display_delta)


def _fmt_time_vs(current_s: float, baseline_s: float) -> str:
    if not baseline_s:
        return "—"
    delta_s = current_s - baseline_s
    delta_m = delta_s / 60
    return f"{delta_m:+.1f}m"


def _fmt_token_vs(current: int, baseline: int) -> str:
    if not baseline:
        return "—"
    delta = current - baseline
    return _fmt_token_delta(delta)


def _fmt_token_delta(delta: int) -> str:
    """Format a token delta with sign and human-readable units."""
    sign = "+" if delta >= 0 else ""
    abs_d = abs(delta)
    if abs_d >= 1_000_000:
        return f"{sign}{delta / 1_000_000:.2f}M"
    if abs_d >= 1_000:
        return f"{sign}{delta / 1_000:.1f}K"
    return f"{sign}{delta}"
