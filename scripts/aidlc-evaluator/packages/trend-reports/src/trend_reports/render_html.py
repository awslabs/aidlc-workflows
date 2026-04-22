"""Self-contained HTML trend report renderer (tables only, no JavaScript)."""

from __future__ import annotations

from html import escape

from .collector import compute_deltas
from .models import RunType, TrendData
from .sparkline import (
    format_delta,
    format_number,
    format_pct,
    format_seconds_as_minutes,
)


def render_trend_html(trend: TrendData) -> str:
    """Render the full trend report as a self-contained HTML string."""
    parts = [
        _html_header("AIDLC Rules Trend Report"),
        _render_html_hero(trend),
        _render_infra_failure_banner_html(trend),
        _render_nav(),
        _render_html_section_a(trend),
        _render_html_section_b(trend),
        _render_html_section_c(trend),
        _render_html_section_d(trend),
        _render_html_section_e(trend),
        _render_html_section_f(trend),
        _render_html_section_g(trend),
        _render_html_section_h(trend),
        _html_footer(),
    ]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# HTML chrome
# ---------------------------------------------------------------------------

_CSS = """\
:root {
    /* AWS Cloudscape-aligned palette */
    --aws-squid-ink: #000716;
    --aws-orange: #ec7211;
    --aws-blue-600: #0972d3;

    /* Status colors */
    --green-bg: #f2fcf3; --green-text: #037f0c; --green-border: #29ad32;
    --yellow-bg: #fff8e1; --yellow-text: #8d6605; --yellow-border: #d4a017;
    --red-bg: #fff3f0; --red-text: #d91515; --red-border: #eb5f5f;
    --blue-bg: #f0f6ff; --blue-text: #0972d3;

    /* Neutral grays */
    --gray-50: #fafafa; --gray-100: #f2f3f3; --gray-200: #e9ebed;
    --gray-300: #d1d5db; --gray-500: #5f6b7a; --gray-700: #414d5c;
    --gray-900: #000716;

    --radius: 8px;
}
* { box-sizing: border-box; }
body {
    font-family: 'Amazon Ember', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    max-width: 1200px; margin: 0 auto; padding: 24px;
    color: var(--gray-900); background: #fff; line-height: 1.6;
}
h1 { font-size: 28px; margin: 0 0 4px 0; }
h2 {
    font-size: 20px; margin: 40px 0 12px 0; padding-bottom: 8px;
    border-bottom: 2px solid var(--gray-200); color: var(--gray-900);
}
h3 { font-size: 16px; margin: 24px 0 8px 0; color: var(--gray-700); }

/* Hero header */
.hero {
    margin-bottom: 32px; padding: 20px 24px;
    background: var(--aws-squid-ink); color: #fff; border-radius: var(--radius);
}
.hero h1 { font-size: 28px; color: #fff; }
.hero .meta { color: #a8b4c4; font-size: 14px; margin-top: 4px; }

/* Navigation */
.nav {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 28px;
    padding: 12px 16px; background: var(--aws-squid-ink); border-radius: var(--radius);
    border: none;
}
.nav a {
    font-size: 13px; color: #d5dbdb; text-decoration: none;
    padding: 4px 10px; border-radius: 4px; transition: background 0.15s;
}
.nav a:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }

/* Summary cards */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin: 16px 0 24px 0; }
.card {
    padding: 14px 16px; border-radius: var(--radius);
    border: 1px solid var(--gray-200); background: #fff;
}
.card .label { font-size: 12px; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.5px; }
.card .value { font-size: 24px; font-weight: 700; margin: 4px 0 2px 0; }
.card .detail { font-size: 12px; color: var(--gray-500); }
.card.good { border-left: 4px solid var(--green-border); }
.card.warn { border-left: 4px solid var(--yellow-border); }
.card.bad  { border-left: 4px solid #d91515; }

/* Tables */
table {
    border-collapse: collapse; width: 100%; margin: 12px 0 24px 0;
    font-size: 14px; border-radius: var(--radius); overflow: hidden;
    border: 1px solid var(--gray-200);
}
th {
    background: var(--gray-100); font-weight: 600; text-align: left;
    padding: 10px 14px; border-bottom: 2px solid var(--gray-200);
    font-size: 13px; color: var(--gray-700); text-transform: uppercase;
    letter-spacing: 0.3px;
}
td { padding: 9px 14px; border-bottom: 1px solid var(--gray-100); }
tr:hover td { background: var(--gray-50); }
td:first-child { font-weight: 500; }

/* Score cells */
.s-green  { background: var(--green-bg); color: var(--green-text); font-weight: 600; }
.s-yellow { background: var(--yellow-bg); color: var(--yellow-text); font-weight: 500; }
.s-red    { background: var(--red-bg); color: var(--red-text); font-weight: 600; }
.d-pos    { color: var(--green-text); font-weight: 500; }
.d-neg    { color: var(--red-text); font-weight: 500; }
.na       { color: var(--gray-500); font-style: italic; }

/* Badges */
.badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.3px;
}
.badge-pass { background: var(--green-bg); color: var(--green-text); }
.badge-fail { background: var(--red-bg); color: var(--red-text); }
.badge-warn { background: var(--yellow-bg); color: var(--yellow-text); }

/* Mini bar chart (CSS only) */
.bar-cell { position: relative; }
.bar {
    display: inline-block; height: 16px; border-radius: 2px;
    background: linear-gradient(90deg, #ec7211, #ff9900);
    vertical-align: middle; margin-right: 6px;
    min-width: 2px;
}

/* Two-column split layout */
.split {
    display: grid; grid-template-columns: 1fr 2fr;
    gap: 24px; align-items: start; margin: 4px 0 24px 0;
}
.split-desc {
    font-size: 14px; color: var(--gray-500); line-height: 1.7;
    padding-top: 4px;
}
.split-desc p { margin: 0 0 8px 0; }
.split table { margin-top: 0; }

/* Blockquote callouts */
.callout {
    padding: 12px 16px; margin: 12px 0;
    border-left: 4px solid var(--yellow-border); background: var(--yellow-bg);
    border-radius: 0 var(--radius) var(--radius) 0; font-size: 14px;
}
.callout.info { border-left-color: var(--aws-blue-600); background: var(--blue-bg); }

/* Section description */
.section-desc { color: var(--gray-500); font-size: 14px; margin: 0 0 12px 0; }

/* Infra failure banner */
.infra-banner {
    padding: 16px 20px; margin: 0 0 24px 0;
    background: var(--red-bg); border: 2px solid var(--red-border);
    border-radius: var(--radius); color: var(--red-text);
}
.infra-banner h3 { margin: 0 0 8px 0; color: var(--red-text); font-size: 16px; }
.infra-banner ul { margin: 4px 0 0 0; padding-left: 20px; }
.badge-infra { background: var(--red-bg); color: var(--red-text); border: 1px solid var(--red-border); }

/* Responsive */
@media (max-width: 768px) {
    body { padding: 12px; }
    .cards { grid-template-columns: repeat(2, 1fr); }
    .split { grid-template-columns: 1fr; }
    table { font-size: 13px; }
    th, td { padding: 6px 8px; }
}
"""


def _html_header(title: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{escape(title)}</title>
<style>{_CSS}</style>
</head>
<body>
"""


def _html_footer() -> str:
    return "</body>\n</html>"


def _render_html_hero(trend: TrendData) -> str:
    n = len(trend.runs)
    first = trend.runs[0].label if trend.runs else "—"
    last = trend.runs[-1].label if trend.runs else "—"
    return (
        '<div class="hero">\n'
        f"  <h1>AIDLC Rules Trend Report</h1>\n"
        f'  <div class="meta">{n} releases ({first} through {last}) · '
        f"{escape(trend.repo)} · {escape(trend.generated_at)}</div>\n"
        "</div>\n"
    )


def _render_nav() -> str:
    links = [
        ("A. Summary", "a-executive-summary"),
        ("B. Correctness", "b-functional-correctness"),
        ("C. Qualitative", "c-qualitative-evaluation"),
        ("D. Efficiency", "d-efficiency-cost-metrics"),
        ("E. Quality", "e-code-quality"),
        ("F. Stability", "f-stability-reliability"),
        ("G. Deltas", "g-version-over-version-deltas"),
        ("H. Pre-Release", "h-pre-release-data-points"),
    ]
    items = " ".join(f'<a href="#{anchor}">{label}</a>' for label, anchor in links)
    return f'<nav class="nav">{items}</nav>\n'


def _render_infra_failure_banner_html(trend: TrendData) -> str:
    """Render a prominent warning banner if any runs have infra failures."""
    infra_runs = [r for r in trend.runs if r.infra_failure.is_infra_failure]
    if not infra_runs:
        return ""

    items = []
    for r in infra_runs:
        reasons = ", ".join(reason.value for reason in r.infra_failure.reasons)
        items.append(f"<li><strong>{escape(r.label)}</strong>: {escape(reasons)}</li>")

    return (
        '<div class="infra-banner">\n'
        "  <h3>Infrastructure Failure Detected</h3>\n"
        "  <p>The following runs experienced infrastructure failures. "
        "Their results are unreliable and have been excluded from regression checks.</p>\n"
        f"  <ul>{''.join(items)}</ul>\n"
        "</div>\n"
    )


# ---------------------------------------------------------------------------
# Section A — Executive Summary
# ---------------------------------------------------------------------------


def _render_html_section_a(trend: TrendData) -> str:
    runs = trend.runs
    bl = trend.baseline
    latest = runs[-1] if runs else None
    if not latest:
        return '<h2 id="a-executive-summary">A. Executive Summary</h2>\n<p>No data available.</p>\n'

    # Summary cards
    qual_status = (
        "good"
        if latest.qualitative.overall_score >= 0.90
        else ("warn" if latest.qualitative.overall_score >= 0.80 else "bad")
    )
    contract_status = (
        "good"
        if latest.contract_tests.pass_rate >= 1.0
        else ("warn" if latest.contract_tests.pass_rate >= 0.95 else "bad")
    )
    unit_pass_rate = (
        latest.unit_tests.passed / latest.unit_tests.total if latest.unit_tests.total > 0 else 0.0
    )
    bl_unit_pass_rate = (
        bl.unit_tests_passed / bl.unit_tests_total if bl.unit_tests_total > 0 else 0.0
    )
    test_status = "good" if unit_pass_rate >= 1.0 else ("warn" if unit_pass_rate >= 0.95 else "bad")
    lint_status = "good" if latest.code_quality.lint_findings == 0 else "warn"

    cards = (
        '<div class="cards">\n'
        f'  <div class="card good">'
        f'<div class="label">Qualitative Score</div>'
        f'<div class="value">{latest.qualitative.overall_score:.3f}</div>'
        f'<div class="detail">Golden: {bl.qualitative_overall:.3f}</div></div>\n'
        f'  <div class="card {contract_status}">'
        f'<div class="label">Contract Tests</div>'
        f'<div class="value">{latest.contract_tests.passed}/{latest.contract_tests.total}</div>'
        f'<div class="detail">{format_pct(latest.contract_tests.pass_rate)} pass rate</div></div>\n'
        f'  <div class="card {test_status}">'
        f'<div class="label">Unit Tests</div>'
        f'<div class="value">{format_pct(unit_pass_rate)}</div>'
        f'<div class="detail">{latest.unit_tests.passed}/{latest.unit_tests.total} passed</div></div>\n'
        f'  <div class="card {lint_status}">'
        f'<div class="label">Lint Findings</div>'
        f'<div class="value">{latest.code_quality.lint_findings}</div>'
        f'<div class="detail">Golden: {bl.lint_findings}</div></div>\n'
        f'  <div class="card good">'
        f'<div class="label">Execution Time</div>'
        f'<div class="value">{format_seconds_as_minutes(latest.metrics.execution_time_seconds)}</div>'
        f'<div class="detail">Golden: {format_seconds_as_minutes(bl.execution_time_seconds) if bl.execution_time_seconds else "—"}</div></div>\n'
        f'  <div class="card good">'
        f'<div class="label">Total Tokens</div>'
        f'<div class="value">{format_number(latest.metrics.total_tokens)}</div>'
        f'<div class="detail">Golden: {format_number(bl.total_tokens) if bl.total_tokens else "—"}</div></div>\n'
        "</div>\n"
    )

    # Detail table
    rows = [
        (
            "Unit test pass rate",
            f"{format_pct(bl.unit_tests_passed / bl.unit_tests_total)} ({bl.unit_tests_passed}/{bl.unit_tests_total})"
            if bl.unit_tests_total
            else _bl(bl.unit_tests_passed),
            f"{format_pct(unit_pass_rate)} ({latest.unit_tests.passed}/{latest.unit_tests.total})"
            if latest.unit_tests.total
            else "0",
            "="
            if bl.unit_tests_total and unit_pass_rate == bl_unit_pass_rate
            else (
                f"{(unit_pass_rate - bl_unit_pass_rate) * 100:+.1f}%"
                if bl.unit_tests_total
                else "—"
            ),
        ),
        (
            "Contract tests",
            f"{bl.contract_tests_passed}/{bl.contract_tests_total}"
            if bl.contract_tests_total
            else "—",
            f"{latest.contract_tests.passed}/{latest.contract_tests.total}",
            _fmt_int_delta(latest.contract_tests.passed, bl.contract_tests_passed),
        ),
        (
            "Lint findings",
            str(bl.lint_findings),
            str(latest.code_quality.lint_findings),
            _fmt_int_delta(latest.code_quality.lint_findings, bl.lint_findings),
        ),
        (
            "Qualitative score",
            f"{bl.qualitative_overall:.3f}" if bl.qualitative_overall else "—",
            f"{latest.qualitative.overall_score:.3f}",
            f"{latest.qualitative.overall_score - bl.qualitative_overall:+.3f}"
            if bl.qualitative_overall
            else "—",
        ),
        (
            "Execution time",
            format_seconds_as_minutes(bl.execution_time_seconds)
            if bl.execution_time_seconds
            else "—",
            format_seconds_as_minutes(latest.metrics.execution_time_seconds),
            _fmt_time_delta(latest.metrics.execution_time_seconds, bl.execution_time_seconds),
        ),
        (
            "Total tokens",
            format_number(bl.total_tokens) if bl.total_tokens else "—",
            format_number(latest.metrics.total_tokens),
            _fmt_token_delta_html(latest.metrics.total_tokens, bl.total_tokens),
        ),
    ]

    # Metrics where lower values are better — a negative delta is good (green)
    lower_is_better = {"lint findings", "execution time", "total tokens"}

    table_rows = []
    table_styles = []
    for label, golden, latest_val, vs in rows:
        table_rows.append([label, golden, latest_val, vs])
        # Color the delta column based on metric direction
        delta_cls = ""
        if vs not in ("=", "—") and (
            vs.startswith("+") or vs.startswith("-") or vs.startswith("−")
        ):
            is_negative = vs.startswith("-") or vs.startswith("−")
            if label.lower() in lower_is_better:
                delta_cls = "d-pos" if is_negative else "d-neg"
            else:
                delta_cls = "d-neg" if is_negative else "d-pos"
        table_styles.append(["", "", "", delta_cls])

    metric_guide = (
        '<p class="section-desc">High-level snapshot comparing the latest release against the '
        "golden baseline (the reference evaluation used as the quality target).</p>\n"
        "<table>\n<thead>\n<tr>\n  <th>Metric</th>\n  <th>What it measures</th>\n</tr>\n</thead>\n<tbody>\n"
        "<tr><td><strong>Unit test pass rate</strong></td><td>Percentage of generated unit tests that pass. Higher means more reliable code generation.</td></tr>\n"
        "<tr><td><strong>Contract tests</strong></td><td>API compliance checks against the OpenAPI spec (passed/total). 88/88 = full compliance.</td></tr>\n"
        "<tr><td><strong>Lint findings</strong></td><td>Static analysis warnings in generated code. Lower is better &mdash; 0 means clean code.</td></tr>\n"
        "<tr><td><strong>Qualitative score</strong></td><td>AI-graded documentation quality on a 0&ndash;1 scale (higher is better).</td></tr>\n"
        "<tr><td><strong>Execution time</strong></td><td>Wall-clock time for the full evaluation run. Lower means faster generation.</td></tr>\n"
        "<tr><td><strong>Total tokens</strong></td><td>Total LLM tokens consumed (input + output). Lower means more cost-efficient.</td></tr>\n"
        "</tbody>\n</table>\n"
    )

    html = (
        '<h2 id="a-executive-summary">A. Executive Summary</h2>\n'
        + cards
        + metric_guide
        + _html_table(
            ["Metric", "Golden", f"Latest ({escape(latest.label)})", "vs Golden"],
            table_rows,
            table_styles,
        )
    )
    return html


# ---------------------------------------------------------------------------
# Section B
# ---------------------------------------------------------------------------


def _render_html_section_b(trend: TrendData) -> str:
    parts = ['<h2 id="b-functional-correctness">B. Functional Correctness</h2>\n']
    parts.append(
        '<p class="section-desc">Measures whether the code generated by each rules version actually works correctly. '
        "This is the most fundamental quality gate &mdash; code that doesn&rsquo;t pass its own tests is broken.</p>\n"
    )

    # B.1 Unit tests with bar chart
    parts.append("<h3>B.1 Unit Tests</h3>\n")
    parts.append('<div class="split">\n<div class="split-desc">\n')
    parts.append(
        "<p>Unit tests validate individual functions and components in isolation. "
        "The AIDLC rules instruct the AI to generate both source code and test suites.</p>\n"
        "<p><strong>Pass/Total</strong> = tests that passed out of total generated. "
        "<strong>Rate</strong> = pass percentage (100% = all tests passing). "
        "<strong>Failures</strong> = tests that ran but produced wrong results.</p>\n"
    )
    parts.append("</div>\n<div>\n")

    rows = []
    styles = []
    for r in trend.runs:
        rate = r.unit_tests.passed / r.unit_tests.total if r.unit_tests.total > 0 else 0.0
        cls = _score_class(rate)
        fail_cls = "d-neg" if r.unit_tests.failed > 0 else ""
        rows.append(
            [
                r.label,
                f"{r.unit_tests.passed}/{r.unit_tests.total}",
                format_pct(rate),
                str(r.unit_tests.failed),
            ]
        )
        styles.append(["", "", cls, fail_cls])
    parts.append(_html_table(["Version", "Pass/Total", "Rate", "Failures"], rows, styles))
    parts.append("</div>\n</div>\n")

    # B.2 Contract tests
    parts.append("<h3>B.2 Contract Tests (API Compliance)</h3>\n")
    parts.append('<div class="split">\n<div class="split-desc">\n')
    parts.append(
        "<p>Contract tests verify that the generated API implementation matches its "
        "OpenAPI specification. Each test sends a request to an endpoint and checks that "
        "the HTTP status code and response shape match the spec.</p>\n"
        "<p>88 endpoints are tested per version. "
        "<strong>Pass/Total</strong> = endpoints that returned the expected status code. "
        "<strong>Rate</strong> = pass percentage (100% = full spec compliance).</p>\n"
        "<p><strong>Failures</strong> lists the specific endpoints that deviated from the spec.</p>\n"
    )
    parts.append("</div>\n<div>\n")

    rows = []
    styles = []
    for r in trend.runs:
        rate = r.contract_tests.pass_rate
        cls = _score_class(rate)
        fail_cls = "d-neg" if r.contract_tests.failed > 0 else ""
        rows.append(
            [
                r.label,
                f"{r.contract_tests.passed}/{r.contract_tests.total}",
                format_pct(rate),
                str(r.contract_tests.failed),
            ]
        )
        styles.append(["", "", cls, fail_cls])
    parts.append(_html_table(["Version", "Pass/Total", "Rate", "Failures"], rows, styles))
    parts.append("</div>\n</div>\n")

    for r in trend.runs:
        if r.contract_tests.failures:
            parts.append(f'<div class="callout"><strong>{escape(r.label)} failures:</strong><ul>\n')
            for f in r.contract_tests.failures:
                parts.append(
                    f"<li><code>{escape(f.method)} {escape(f.endpoint)}</code> — "
                    f"expected {f.expected_status}, got {f.actual_status} "
                    f"({escape(f.description)})</li>\n"
                )
            parts.append("</ul></div>\n")

    return "".join(parts)


# ---------------------------------------------------------------------------
# Section C
# ---------------------------------------------------------------------------


def _render_html_section_c(trend: TrendData) -> str:
    parts = ['<h2 id="c-qualitative-evaluation">C. Qualitative Evaluation</h2>\n']
    parts.append(
        '<p class="section-desc">Measures the quality of generated documentation by comparing it against '
        "human-authored reference documents. An AI evaluator scores each document on completeness, accuracy, "
        "and clarity, producing a 0&ndash;1 score (1.0 = perfect match to reference quality).</p>\n"
    )

    # C.1 Overall
    parts.append("<h3>C.1 Overall Score</h3>\n")
    parts.append('<div class="split">\n<div class="split-desc">\n')
    parts.append(
        "<p>The weighted average across all evaluated documents. "
        "This is the single best indicator of how well the rules produce documentation.</p>\n"
        "<p>Scores above 0.90 are considered strong; below 0.70 signals significant gaps.</p>\n"
    )
    bl_score = trend.baseline.qualitative_overall
    if bl_score:
        parts.append(f"<p>Golden baseline: <strong>{bl_score:.3f}</strong></p>\n")
    parts.append("</div>\n<div>\n")

    rows = []
    styles = []
    for r in trend.runs:
        s = r.qualitative.overall_score
        delta = s - bl_score if bl_score else 0
        rows.append([r.label, f"{s:.3f}", f"{delta:+.3f}" if bl_score else "—"])
        styles.append(["", _score_class(s), _delta_class(delta)])
    parts.append(_html_table(["Version", "Overall", "vs Golden"], rows, styles))
    parts.append("</div>\n</div>\n")

    # C.2 Phase breakdown
    parts.append("<h3>C.2 Phase Breakdown</h3>\n")
    parts.append('<div class="split">\n<div class="split-desc">\n')
    parts.append(
        "<p>Documents are grouped by SDLC phase. "
        "<strong>Inception</strong> covers early-stage design artifacts (requirements, architecture plans, "
        "component designs) &mdash; these are generated first and set the foundation.</p>\n"
        "<p><strong>Construction</strong> covers build-time artifacts (build instructions, test instructions, "
        "build-and-test summaries) &mdash; these depend on inception outputs being correct.</p>\n"
        "<p>A drop in inception quality often cascades into construction.</p>\n"
    )
    parts.append("</div>\n<div>\n")
    rows = []
    styles = []
    for r in trend.runs:
        inc = r.qualitative.inception_score
        con = r.qualitative.construction_score
        rows.append([r.label, f"{inc:.3f}", f"{con:.3f}"])
        styles.append(["", _score_class(inc), _score_class(con)])
    parts.append(_html_table(["Version", "Inception", "Construction"], rows, styles))
    parts.append("</div>\n</div>\n")

    # C.3 Per-document heatmap
    parts.append("<h3>C.3 Per-Document Heatmap</h3>\n")
    parts.append(
        '<p class="section-desc">Individual quality scores for each generated document across all versions. '
        "This reveals which specific documents are consistently strong, improving, or problematic. "
        "Documents scoring below 0.70 (red) are the top candidates for rules improvements.</p>\n"
    )
    all_docs, labels, matrix = _build_heatmap(trend)
    header = ["Document"] + labels
    rows = []
    styles = []
    for i, doc in enumerate(all_docs):
        row = [f"<code>{escape(doc)}</code>"]
        row_styles = [""]
        for score in matrix[i]:
            if score < 0:
                row.append('<span class="na">—</span>')
                row_styles.append("")
            else:
                row.append(f"{score:.2f}")
                row_styles.append(_score_class(score))
        rows.append(row)
        styles.append(row_styles)
    parts.append(_html_table(header, rows, styles))
    parts.append(
        '<p class="section-desc">'
        '<span class="badge badge-pass">green &ge; 0.90</span> '
        '<span class="badge badge-warn">yellow 0.70–0.89</span> '
        '<span class="badge badge-fail">red &lt; 0.70</span></p>\n'
    )

    # C.4 Coverage
    parts.append("<h3>C.4 Document Coverage</h3>\n")
    parts.append(
        '<p class="section-desc">Tracks whether the generated output includes the same set of documents as the reference. '
        "<strong>Unmatched Ref</strong> = reference documents the AI failed to generate (missing output). "
        "<strong>Unmatched Candidate</strong> = extra documents the AI generated that don&rsquo;t exist in the reference "
        "(unexpected output). Ideally both columns are 0, meaning the AI produced exactly the expected set of documents.</p>\n"
    )
    rows = []
    styles = []
    for r in trend.runs:
        ref_n = len(r.qualitative.unmatched_reference_docs)
        cand_n = len(r.qualitative.unmatched_candidate_docs)
        rows.append([r.label, str(ref_n), str(cand_n)])
        styles.append(
            [
                "",
                "d-neg" if ref_n > 0 else "",
                "d-neg" if cand_n > 0 else "",
            ]
        )
    parts.append(_html_table(["Version", "Unmatched Ref", "Unmatched Candidate"], rows, styles))

    return "".join(parts)


# ---------------------------------------------------------------------------
# Section D
# ---------------------------------------------------------------------------


def _render_html_section_d(trend: TrendData) -> str:
    parts = ['<h2 id="d-efficiency-cost-metrics">D. Efficiency &amp; Cost Metrics</h2>\n']
    parts.append(
        '<p class="section-desc">Tracks the computational resources consumed by each evaluation run. '
        "These metrics directly affect cost (tokens) and developer wait time (execution time). "
        "Lower values are generally better, as long as quality metrics remain stable.</p>\n"
    )

    # D.1 Token consumption with bars
    parts.append("<h3>D.1 Token Consumption</h3>\n")
    parts.append('<div class="split">\n<div class="split-desc">\n')
    parts.append(
        "<p>Total LLM tokens consumed during the run, broken down by agent. "
        "<strong>Total</strong> = all tokens across all agents (input + output).</p>\n"
        "<p><strong>Executor</strong> = the agent that generates code and documents. "
        "<strong>Simulator</strong> = the agent that simulates user interactions for testing.</p>\n"
        "<p>Token count is the primary cost driver &mdash; each token represents a unit of "
        "LLM usage billed by the provider.</p>\n"
    )
    parts.append("</div>\n<div>\n")
    max_tok = max((r.metrics.total_tokens for r in trend.runs), default=1)
    rows = []
    styles = []
    for r in trend.runs:
        pct = r.metrics.total_tokens / max_tok * 100 if max_tok else 0
        agent_map = {a.agent_name: format_number(a.total_tokens) for a in r.metrics.agent_tokens}
        bar_html = f'<span class="bar" style="width:{pct:.0f}%"></span>'
        rows.append(
            [
                r.label,
                bar_html,
                format_number(r.metrics.total_tokens),
                agent_map.get("executor", "—"),
                agent_map.get("simulator", "—"),
            ]
        )
        styles.append(["", "bar-cell", "", "", ""])
    parts.append(_html_table(["Version", "", "Total", "Executor", "Simulator"], rows, styles))
    parts.append("</div>\n</div>\n")

    # D.2 Execution time with bars
    parts.append("<h3>D.2 Execution Time</h3>\n")
    parts.append('<div class="split">\n<div class="split-desc">\n')
    parts.append(
        "<p>Wall-clock duration of the full evaluation pipeline, broken down by handoff. "
        "Each <strong>handoff</strong> (H1, H2, H3) represents a sequential phase.</p>\n"
        "<p>H1 is typically code generation (the longest phase), H2 is build/test execution, "
        "and H3 is result collection and reporting.</p>\n"
        "<p><strong>Wall Clock</strong> is the total end-to-end time.</p>\n"
    )
    parts.append("</div>\n<div>\n")
    max_time = max((r.metrics.execution_time_seconds for r in trend.runs), default=1)
    rows = []
    styles = []
    for r in trend.runs:
        pct = r.metrics.execution_time_seconds / max_time * 100 if max_time else 0
        bar_html = f'<span class="bar" style="width:{pct:.0f}%"></span>'
        handoff_strs = [
            f"H{h.handoff_number}: {format_seconds_as_minutes(h.duration_seconds)}"
            for h in r.metrics.handoffs
        ]
        rows.append(
            [
                r.label,
                bar_html,
                format_seconds_as_minutes(r.metrics.execution_time_seconds),
                " · ".join(handoff_strs) if handoff_strs else "—",
            ]
        )
        styles.append(["", "bar-cell", "", ""])
    parts.append(_html_table(["Version", "", "Wall Clock", "Handoff Breakdown"], rows, styles))
    parts.append("</div>\n</div>\n")

    # D.3 Context window
    parts.append("<h3>D.3 Context Window Pressure</h3>\n")
    parts.append('<div class="split">\n<div class="split-desc">\n')
    parts.append(
        "<p>Measures how much of the LLM&rsquo;s context window is being used across API calls. "
        "<strong>Max</strong> = the largest single context seen during the run (approaching the "
        "model&rsquo;s limit risks truncation or degraded output).</p>\n"
        "<p><strong>Avg</strong> = the mean context size across all API calls. "
        "<strong>Median</strong> = the midpoint context size (less affected by outliers than avg).</p>\n"
        "<p>High context pressure can indicate overly verbose prompts or accumulated conversation history.</p>\n"
    )
    parts.append("</div>\n<div>\n")
    rows = [
        [
            r.label,
            format_number(r.metrics.max_context_tokens),
            format_number(r.metrics.avg_context_tokens),
            format_number(r.metrics.median_context_tokens),
        ]
        for r in trend.runs
    ]
    parts.append(_html_table(["Version", "Max", "Avg", "Median"], rows))
    parts.append("</div>\n</div>\n")

    return "".join(parts)


# ---------------------------------------------------------------------------
# Section E
# ---------------------------------------------------------------------------


def _render_html_section_e(trend: TrendData) -> str:
    parts = ['<h2 id="e-code-quality">E. Code Quality</h2>\n']
    parts.append(
        '<p class="section-desc">Static analysis of the generated codebase. These metrics reflect the cleanliness and '
        "maintainability of the AI-generated code, independent of whether it passes tests.</p>\n"
        "<table>\n<thead>\n<tr>\n  <th>Metric</th>\n  <th>What it measures</th>\n</tr>\n</thead>\n<tbody>\n"
        "<tr><td><strong>Lint Findings</strong></td><td>Warnings from static analysis (style violations, unused variables, etc.). 0 = clean.</td></tr>\n"
        "<tr><td><strong>Security Findings</strong></td><td>Vulnerabilities detected by security scanners (SQL injection, XSS, etc.). N/A if no scanner was configured.</td></tr>\n"
        "<tr><td><strong>Source Files</strong></td><td>Number of non-test source files in the generated project.</td></tr>\n"
        "<tr><td><strong>LOC</strong></td><td>Total lines of code across all source files. Large swings may indicate generated boilerplate or missing modules.</td></tr>\n"
        "</tbody>\n</table>\n"
    )
    rows = [
        [
            r.label,
            str(r.code_quality.lint_findings),
            str(r.code_quality.security_findings)
            if r.code_quality.security_scanner_available
            else '<span class="na">N/A</span>',
            str(r.code_quality.source_file_count),
            format_number(r.code_quality.total_lines_of_code),
        ]
        for r in trend.runs
    ]
    parts.append(
        _html_table(["Version", "Lint Findings", "Security Findings", "Source Files", "LOC"], rows)
    )
    return "".join(parts)


# ---------------------------------------------------------------------------
# Section F
# ---------------------------------------------------------------------------


def _render_html_section_f(trend: TrendData) -> str:
    parts = ['<h2 id="f-stability-reliability">F. Stability &amp; Reliability</h2>\n']
    parts.append(
        '<p class="section-desc">Tracks whether the evaluation pipeline itself ran smoothly, independent of output quality.</p>\n'
        "<table>\n<thead>\n<tr>\n  <th>Metric</th>\n  <th>What it measures</th>\n</tr>\n</thead>\n<tbody>\n"
        "<tr><td><strong>Infra Failure</strong></td><td>Whether infrastructure issues (Bedrock outage, throttling) invalidated the run.</td></tr>\n"
        "<tr><td><strong>Total Errors</strong></td><td>Sum of all runtime error events. 0 = clean run.</td></tr>\n"
        "<tr><td><strong>Throttle</strong></td><td>Bedrock API throttle (rate limit) events.</td></tr>\n"
        "<tr><td><strong>Svc Unavail</strong></td><td>Bedrock service unavailable events.</td></tr>\n"
        "<tr><td><strong>Model Error</strong></td><td>Bedrock model error events.</td></tr>\n"
        "<tr><td><strong>Handoffs</strong></td><td>Number of sequential pipeline phases completed. Typically 3.</td></tr>\n"
        "<tr><td><strong>Server Startup</strong></td><td>Whether the generated application server started successfully.</td></tr>\n"
        "</tbody>\n</table>\n"
    )
    rows = []
    styles = []
    for r in trend.runs:
        ok = r.metrics.server_startup_success
        infra_html = (
            '<span class="badge badge-infra">INFRA FAIL</span>'
            if r.infra_failure.is_infra_failure
            else '<span class="badge badge-pass">OK</span>'
        )
        err_cls = "d-neg" if r.metrics.error_count > 0 else ""
        throttle_cls = "d-neg" if r.metrics.throttle_events > 0 else ""
        svc_cls = "d-neg" if r.metrics.service_unavailable_events > 0 else ""
        model_cls = "d-neg" if r.metrics.model_error_events > 0 else ""
        ok_html = (
            '<span class="badge badge-pass">PASS</span>'
            if ok
            else '<span class="badge badge-fail">FAIL</span>'
        )
        rows.append(
            [
                r.label,
                infra_html,
                str(r.metrics.error_count),
                str(r.metrics.throttle_events),
                str(r.metrics.service_unavailable_events),
                str(r.metrics.model_error_events),
                str(r.metrics.num_handoffs),
                ok_html,
            ]
        )
        styles.append(["", "", err_cls, throttle_cls, svc_cls, model_cls, "", ""])
    parts.append(
        _html_table(
            [
                "Version",
                "Infra Status",
                "Total Errors",
                "Throttle",
                "Svc Unavail",
                "Model Error",
                "Handoffs",
                "Server Startup",
            ],
            rows,
            styles,
        )
    )
    return "".join(parts)


# ---------------------------------------------------------------------------
# Section G
# ---------------------------------------------------------------------------


def _render_html_section_g(trend: TrendData) -> str:
    parts = ['<h2 id="g-version-over-version-deltas">G. Version-over-Version Deltas</h2>\n']
    deltas = compute_deltas(trend.runs)
    if not deltas:
        parts.append("<p>Not enough data points.</p>\n")
        return "".join(parts)

    parts.append(
        '<p class="section-desc">Each row shows the change from one release to the next, making it easy to spot '
        "which specific version introduced an improvement or regression. "
        "Positive values (+) indicate an increase; negative (&minus;) indicate a decrease. "
        "For <strong>Unit Tests</strong> and <strong>Contract</strong>, positive is better (more tests passing). "
        "For <strong>Qualitative</strong>, positive is better (higher quality score). "
        "For <strong>Tokens</strong> and <strong>Time</strong>, negative is better (more efficient).</p>\n"
    )

    rows = []
    styles = []
    for d in deltas:
        tok_str = _fmt_signed_number(d.token_delta)
        time_str = f"{format_delta(d.time_delta_seconds, precision=0)}s"
        rows.append(
            [
                f"{d.from_label} &rarr; {d.to_label}",
                format_delta(d.unit_tests_delta),
                format_delta(d.contract_tests_delta),
                format_delta(d.qualitative_delta, precision=3),
                tok_str,
                time_str,
            ]
        )
        styles.append(
            [
                "",
                _delta_class(d.unit_tests_delta),
                _delta_class(d.contract_tests_delta),
                _delta_class(d.qualitative_delta),
                _delta_class(-d.token_delta),
                _delta_class(-d.time_delta_seconds),
            ]
        )
    parts.append(
        _html_table(
            ["Transition", "Unit Tests", "Contract", "Qualitative", "Tokens", "Time"],
            rows,
            styles,
        )
    )
    return "".join(parts)


# ---------------------------------------------------------------------------
# Section H
# ---------------------------------------------------------------------------


def _render_html_section_h(trend: TrendData) -> str:
    pre_release = [r for r in trend.runs if r.run_type in (RunType.MAIN, RunType.PR)]

    html = (
        '<h2 id="h-pre-release-data-points">H. Pre-Release Data Points</h2>\n'
        '<p class="section-desc">Evaluation results from non-release sources &mdash; the <code>main</code> branch '
        "and open pull requests. These represent in-progress work that hasn&rsquo;t been tagged as a release yet. "
        "Use this data to preview whether upcoming changes will improve or regress metrics before they ship.</p>\n"
    )
    if not pre_release:
        return html + '<p class="section-desc">No pre-release data available.</p>\n'

    rows = [
        [
            r.label,
            f"{format_pct(r.unit_tests.passed / r.unit_tests.total)} ({r.unit_tests.passed}/{r.unit_tests.total})"
            if r.unit_tests.total > 0
            else "0",
            f"{r.contract_tests.passed}/{r.contract_tests.total}",
            f"{r.qualitative.overall_score:.3f}",
            format_number(r.metrics.total_tokens),
        ]
        for r in pre_release
    ]
    return html + _html_table(["Source", "Unit Tests", "Contract", "Qualitative", "Tokens"], rows)


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------


def _score_class(score: float) -> str:
    if score >= 0.90:
        return "s-green"
    if score >= 0.70:
        return "s-yellow"
    return "s-red"


def _delta_class(delta: float) -> str:
    if delta > 0:
        return "d-pos"
    if delta < 0:
        return "d-neg"
    return ""


def _html_table(
    headers: list[str],
    rows: list[list[str]],
    cell_styles: list[list[str]] | None = None,
) -> str:
    lines = ["<table>\n<thead>\n<tr>"]
    for h in headers:
        lines.append(f"  <th>{h}</th>")
    lines.append("</tr>\n</thead>\n<tbody>")
    for i, row in enumerate(rows):
        lines.append("<tr>")
        for j, cell in enumerate(row):
            cls = ""
            if cell_styles and i < len(cell_styles) and j < len(cell_styles[i]):
                cls_name = cell_styles[i][j]
                if cls_name:
                    cls = f' class="{cls_name}"'
            lines.append(f"  <td{cls}>{cell}</td>")
        lines.append("</tr>")
    lines.append("</tbody>\n</table>\n")
    return "\n".join(lines)


def _build_heatmap(
    trend: TrendData,
) -> tuple[list[str], list[str], list[list[float]]]:
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


def _bl(val: int | float) -> str:
    """Format a baseline value, returning '—' only when truly zero/missing."""
    if val is None:
        return "—"
    return str(val)


def _fmt_int_delta(current: int, baseline: int) -> str:
    if baseline is None:
        return "—"
    delta = current - baseline
    if delta == 0:
        return "="
    return f"{delta:+d}"


def _fmt_time_delta(current_s: float, baseline_s: float) -> str:
    if not baseline_s:
        return "—"
    delta_m = (current_s - baseline_s) / 60
    return f"{delta_m:+.1f}m"


def _fmt_token_delta_html(current: int, baseline: int) -> str:
    if not baseline:
        return "—"
    delta = current - baseline
    return _fmt_signed_number(delta)


def _fmt_signed_number(n: int) -> str:
    sign = "+" if n >= 0 else ""
    abs_n = abs(n)
    if abs_n >= 1_000_000:
        return f"{sign}{n / 1_000_000:.2f}M"
    if abs_n >= 1_000:
        return f"{sign}{n / 1_000:.1f}K"
    return f"{sign}{n}"
