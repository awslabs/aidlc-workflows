"""Render a ReportData into a self-contained HTML report with modern styling."""

from __future__ import annotations

import html as html_mod
from pathlib import Path

from reporting.collector import ReportData

CSS = """
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

/* ── Cards ── */
.card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 1.25rem; transition: border-color .2s;
}
.card:hover { border-color: var(--accent); }
.card-label { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--text2); margin-bottom: .5rem; }
.card-value { font-size: 1.75rem; font-weight: 700; }
.card-detail { font-size: .8rem; color: var(--text2); margin-top: .25rem; }

/* ── Badges ── */
.badge {
  display: inline-flex; align-items: center; gap: .35rem;
  padding: .25rem .75rem; border-radius: 999px; font-size: .8rem; font-weight: 600;
}
.badge-pass { background: var(--green-bg); color: var(--green); border: 1px solid var(--green-border); }
.badge-fail { background: var(--red-bg); color: var(--red); border: 1px solid var(--red-border); }
.badge-warn { background: var(--yellow-bg); color: var(--yellow); border: 1px solid var(--yellow-border); }
.badge-info { background: var(--blue-bg); color: var(--blue); border: 1px solid var(--blue-border); }

/* ── Progress bar ── */
.progress-wrap { width: 100%; background: var(--surface2); border-radius: 6px; overflow: hidden; height: 10px; }
.progress-bar { height: 100%; border-radius: 6px; transition: width .4s ease; }
.progress-green { background: linear-gradient(90deg, #16a34a, #22c55e); }
.progress-yellow { background: linear-gradient(90deg, #ca8a04, #eab308); }
.progress-red { background: linear-gradient(90deg, #dc2626, #ef4444); }

/* ── Tables ── */
table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: .875rem; }
th { text-align: left; padding: .6rem .75rem; background: var(--surface); color: var(--text2);
     font-weight: 600; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em;
     border-bottom: 2px solid var(--border); }
td { padding: .55rem .75rem; border-bottom: 1px solid var(--surface2); }
tr:hover td { background: var(--surface); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.pass-icon::before { content: '\\2714'; color: var(--green); margin-right: .3rem; }
.fail-icon::before { content: '\\2718'; color: var(--red); margin-right: .3rem; }

/* ── Accordion ── */
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

/* ── Score ring ── */
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

/* ── Phase bar chart ── */
.phase-bars { display: flex; gap: 2rem; margin: 1rem 0; }
.phase-bar-group { flex: 1; }
.phase-bar-title { font-size: .8rem; font-weight: 600; margin-bottom: .5rem; text-transform: capitalize; }
.bar-row { display: flex; align-items: center; gap: .5rem; margin: .35rem 0; }
.bar-row-label { width: 80px; font-size: .75rem; color: var(--text2); text-align: right; }
.bar-track { flex: 1; height: 8px; background: var(--surface2); border-radius: 4px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; }
.bar-val { width: 35px; font-size: .75rem; font-weight: 600; }

.footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border);
  color: var(--text2); font-size: .75rem; text-align: center; }

/* ── Comparison ── */
.cmp-summary { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; }
.cmp-stat { text-align: center; }
.cmp-stat-val { font-size: 1.75rem; font-weight: 700; }
.cmp-stat-label { font-size: .75rem; color: var(--text2); text-transform: uppercase; letter-spacing: .05em; }
.delta-improved { color: var(--green); }
.delta-regressed { color: var(--red); }
.delta-unchanged { color: var(--text2); }
.delta-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: .4rem; vertical-align: middle; }
.dot-improved { background: var(--green); }
.dot-regressed { background: var(--red); }
.dot-unchanged { background: var(--text2); }
"""


def _esc(s: str) -> str:
    return html_mod.escape(str(s))


def _ms_to_human(ms: int) -> str:
    secs = ms / 1000
    if secs < 60:
        return f"{secs:.0f}s"
    mins = secs / 60
    if mins < 60:
        return f"{mins:.1f}m"
    return f"{mins / 60:.1f}h"


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}K"
    return str(n)


def _score_color(score: float) -> str:
    if score >= 0.8:
        return "var(--green)"
    if score >= 0.6:
        return "var(--yellow)"
    return "var(--red)"


def _progress_class(ratio: float) -> str:
    if ratio >= 0.9:
        return "progress-green"
    if ratio >= 0.7:
        return "progress-yellow"
    return "progress-red"


def _fmt_val_html(v: float | int | None) -> str:
    if v is None:
        return "---"
    if isinstance(v, float):
        return f"{v:.4f}" if v < 10 else f"{v:,.0f}"
    return f"{v:,}"


def _score_ring(score: float, size: int = 80) -> str:
    r = (size - 6) / 2
    circ = 2 * 3.14159 * r
    offset = circ * (1 - score)
    color = _score_color(score)
    return f"""<div class="ring-container" style="width:{size}px;height:{size}px">
  <svg width="{size}" height="{size}" viewBox="0 0 {size} {size}">
    <circle class="ring-bg" cx="{size//2}" cy="{size//2}" r="{r}"/>
    <circle class="ring-fg" cx="{size//2}" cy="{size//2}" r="{r}"
      stroke="{color}" stroke-dasharray="{circ:.1f}" stroke-dashoffset="{offset:.1f}"/>
  </svg>
  <div class="ring-label" style="color:{color}">{score:.0%}</div>
</div>"""


def _badge(label: str, cls: str) -> str:
    return f'<span class="badge badge-{cls}">{_esc(label)}</span>'


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


def _delta_tag(cmp, metric_name: str) -> str:
    """Return an HTML snippet showing the delta vs golden for a named metric."""
    if cmp is None:
        return ""
    for d in cmp.deltas:
        if d.name == metric_name and d.delta is not None and abs(d.delta) > 0.001:
            val = _fmt_delta_val(d.delta, metric_name)
            cls = f"delta-{d.direction}"
            return f' <span class="{cls}" style="font-size:.7rem;font-weight:600">{val} vs golden</span>'
    return ' <span class="delta-unchanged" style="font-size:.7rem">= golden</span>'


def render_html(data: ReportData) -> str:
    out: list[str] = []
    w = out.append

    run_name = Path(data.meta.run_folder).name if data.meta.run_folder else "unknown"
    cmp = data.comparison

    w("<!DOCTYPE html>")
    w(f'<html lang="en"><head><meta charset="utf-8">')
    w(f'<meta name="viewport" content="width=device-width,initial-scale=1">')
    w(f"<title>AIDLC Report — {_esc(run_name)}</title>")
    w(f"<link rel='preconnect' href='https://fonts.googleapis.com'>")
    w(f"<link href='https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap' rel='stylesheet'>")
    w(f"<style>{CSS}</style>")
    w("</head><body>")

    # ── Header ─────────────────────────────────────────────────
    w(f"<h1>AIDLC Evaluation Report</h1>")
    w(f'<div class="subtitle"><code>{_esc(run_name)}</code> &middot; {_esc(data.generated_at)}</div>')

    # ── Test metadata ──────────────────────────────────────────
    w('<table style="margin-bottom:1.5rem">')
    w(f'<tr><td><strong>Executor Model</strong></td><td><code>{_esc(data.meta.executor_model)}</code></td></tr>')
    w(f'<tr><td><strong>Simulator Model</strong></td><td><code>{_esc(data.meta.simulator_model)}</code></td></tr>')
    if data.meta.rules_source == "git" and data.meta.rules_repo:
        w(f'<tr><td><strong>Rules Source</strong></td><td><code>{_esc(data.meta.rules_repo)}</code> @ <code>{_esc(data.meta.rules_ref)}</code></td></tr>')
    elif data.meta.rules_source == "local" and data.meta.rules_local_path:
        w(f'<tr><td><strong>Rules Source</strong></td><td>local: <code>{_esc(data.meta.rules_local_path)}</code></td></tr>')
    elif data.meta.rules_source:
        w(f'<tr><td><strong>Rules Source</strong></td><td><code>{_esc(data.meta.rules_source)}</code></td></tr>')
    w('</table>')

    # ── Verdict Cards ──────────────────────────────────────────
    test_ok = data.tests and data.tests.test_ok and data.tests.failed == 0
    contract_ok = data.contracts and data.contracts.failed == 0 and data.contracts.errors == 0
    qual_score = data.qualitative.overall_score if data.qualitative else 0

    w('<div class="card-grid">')

    if data.tests:
        t = data.tests
        cls = "pass" if test_ok else "fail"
        w(f'<div class="card"><div class="card-label">Unit Tests</div>')
        w(f'<div class="card-value">{_badge(f"{t.pass_pct:.1f}% ({t.passed}/{t.total})", cls)}{_delta_tag(cmp, "Tests Pass %")}</div>')
        if t.coverage_pct is not None:
            w(f'<div class="card-detail">Coverage: {t.coverage_pct:.1f}%{_delta_tag(cmp, "Coverage %")}</div>')
        w("</div>")

    if data.contracts:
        ct = data.contracts
        cls = "pass" if contract_ok else "fail"
        w(f'<div class="card"><div class="card-label">Contract Tests</div>')
        w(f'<div class="card-value">{_badge(f"{ct.passed}/{ct.total}", cls)}{_delta_tag(cmp, "Contract Passed")}</div>')
        w(f'<div class="card-detail">API endpoints validated</div>')
        w("</div>")

    if data.quality:
        q = data.quality
        q_ok = q.lint_errors == 0 and q.security_high == 0
        cls = "pass" if q_ok else "warn"
        w(f'<div class="card"><div class="card-label">Code Quality</div>')
        w(f'<div class="card-value">{_badge(f"{q.lint_total} lint / {q.security_total} security", cls)}{_delta_tag(cmp, "Lint Errors")}</div>')
        w(f'<div class="card-detail">{q.lint_errors} errors, {q.security_high} high severity</div>')
        w("</div>")

    if data.qualitative:
        w(f'<div class="card"><div class="card-label">Qualitative Score</div>')
        w(f'<div class="card-value" style="display:flex;align-items:center;gap:.75rem">')
        w(_score_ring(qual_score, 64))
        w(f'{_delta_tag(cmp, "Qualitative Score")}')
        w(f"</div></div>")

    # Timing + tokens
    w(f'<div class="card"><div class="card-label">Execution Time</div>')
    w(f'<div class="card-value">{_ms_to_human(data.metrics.wall_clock_ms)}{_delta_tag(cmp, "Wall Clock (ms)")}</div>')
    w(f'<div class="card-detail">{data.meta.total_handoffs} handoffs</div>')
    w("</div>")

    w(f'<div class="card"><div class="card-label">Total Tokens</div>')
    w(f'<div class="card-value">{_fmt_tokens(data.metrics.total_tokens.total_tokens)}{_delta_tag(cmp, "Total Tokens")}</div>')
    w(f'<div class="card-detail">in: {_fmt_tokens(data.metrics.total_tokens.input_tokens)} / out: {_fmt_tokens(data.metrics.total_tokens.output_tokens)}</div>')
    w("</div>")

    w("</div>")  # card-grid

    # ── Run Overview ───────────────────────────────────────────
    w("<h2>Run Overview</h2>")
    w("<table>")
    rows = [
        ("Status", f"<code>{_esc(data.meta.status)}</code>"),
        ("Executor", f"<code>{_esc(data.meta.executor_model)}</code>"),
        ("Simulator", f"<code>{_esc(data.meta.simulator_model)}</code>"),
        ("Region", f"<code>{_esc(data.meta.aws_region)}</code>"),
        ("Handoffs", f"{data.meta.total_handoffs} ({' &rarr; '.join(_esc(n) for n in data.meta.node_history)})"),
    ]
    for label, val in rows:
        w(f"<tr><td><strong>{label}</strong></td><td>{val}</td></tr>")
    w("</table>")

    # ── Handoff Timeline ───────────────────────────────────────
    if data.metrics.handoffs:
        total_ms = data.metrics.wall_clock_ms or 1
        w("<h2>Handoff Timeline</h2>")
        w('<div style="display:flex;gap:2px;height:32px;border-radius:8px;overflow:hidden;margin-bottom:1rem">')
        colors = {"executor": "var(--blue)", "simulator": "var(--purple)"}
        for h in data.metrics.handoffs:
            pct = max(h.duration_ms / total_ms * 100, 2)
            col = colors.get(h.node_id, "var(--accent)")
            w(f'<div style="width:{pct:.1f}%;background:{col};display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:600;min-width:30px" title="{_esc(h.node_id)} #{h.handoff}: {_ms_to_human(h.duration_ms)}">{_esc(h.node_id[0].upper())}{h.handoff}</div>')
        w("</div>")
        w("<table><tr><th>#</th><th>Agent</th><th>Duration</th><th>% of Total</th></tr>")
        for h in data.metrics.handoffs:
            pct = h.duration_ms / total_ms * 100
            w(f'<tr><td class="num">{h.handoff}</td><td>{_esc(h.node_id)}</td>'
              f'<td>{_ms_to_human(h.duration_ms)}</td><td class="num">{pct:.1f}%</td></tr>')
        w("</table>")

    # ── Token Breakdown ────────────────────────────────────────
    w("<h2>Token Usage</h2>")
    w("<h3>Unique Tokens by Agent</h3>")
    w("<table><tr><th>Agent</th><th class='num'>Input</th><th class='num'>Output</th><th class='num'>Total</th></tr>")
    for name, tok in [("Executor", data.metrics.executor_tokens), ("Simulator", data.metrics.simulator_tokens), ("<strong>Total Unique</strong>", data.metrics.total_tokens)]:
        w(f"<tr><td>{name}</td><td class='num'>{_fmt_tokens(tok.input_tokens)}</td>"
          f"<td class='num'>{_fmt_tokens(tok.output_tokens)}</td><td class='num'>{_fmt_tokens(tok.total_tokens)}</td></tr>")
    w("</table>")

    # Show repeated context if present
    if data.metrics.repeated_context_tokens.total_tokens > 0:
        w("<h3>Context Repetition</h3>")
        w("<p>Tokens re-sent across multiple conversation turns:</p>")
        w("<table><tr><th>Category</th><th class='num'>Input</th><th class='num'>Output</th><th class='num'>Total</th></tr>")
        w(f"<tr><td>Repeated Context</td><td class='num'>{_fmt_tokens(data.metrics.repeated_context_tokens.input_tokens)}</td>"
          f"<td class='num'>{_fmt_tokens(data.metrics.repeated_context_tokens.output_tokens)}</td>"
          f"<td class='num'>{_fmt_tokens(data.metrics.repeated_context_tokens.total_tokens)}</td></tr>")
        w(f"<tr><td><strong>API Total</strong></td><td class='num'><strong>{_fmt_tokens(data.metrics.api_total_tokens.input_tokens)}</strong></td>"
          f"<td class='num'><strong>{_fmt_tokens(data.metrics.api_total_tokens.output_tokens)}</strong></td>"
          f"<td class='num'><strong>{_fmt_tokens(data.metrics.api_total_tokens.total_tokens)}</strong></td></tr>")
        w("</table>")

    # ── Context Size ──────────────────────────────────────────
    ctx_total = data.metrics.context_size_total
    if ctx_total and ctx_total.sample_count > 0:
        ctx_ex = data.metrics.context_size_executor
        ctx_si = data.metrics.context_size_simulator
        w("<h2>Context Size (Input Tokens per Invocation)</h2>")
        w("<table><tr><th>Agent</th><th class='num'>Min</th><th class='num'>Max</th>"
          "<th class='num'>Average</th><th class='num'>Median</th><th class='num'>Samples</th></tr>")
        if ctx_ex and ctx_ex.sample_count > 0:
            w(f"<tr><td>Executor</td><td class='num'>{_fmt_tokens(ctx_ex.min_tokens)}</td>"
              f"<td class='num'>{_fmt_tokens(ctx_ex.max_tokens)}</td><td class='num'>{_fmt_tokens(ctx_ex.avg_tokens)}</td>"
              f"<td class='num'>{_fmt_tokens(ctx_ex.median_tokens)}</td><td class='num'>{ctx_ex.sample_count}</td></tr>")
        if ctx_si and ctx_si.sample_count > 0:
            w(f"<tr><td>Simulator</td><td class='num'>{_fmt_tokens(ctx_si.min_tokens)}</td>"
              f"<td class='num'>{_fmt_tokens(ctx_si.max_tokens)}</td><td class='num'>{_fmt_tokens(ctx_si.avg_tokens)}</td>"
              f"<td class='num'>{_fmt_tokens(ctx_si.median_tokens)}</td><td class='num'>{ctx_si.sample_count}</td></tr>")
        w(f"<tr><td><strong>Total</strong></td><td class='num'><strong>{_fmt_tokens(ctx_total.min_tokens)}</strong></td>"
          f"<td class='num'><strong>{_fmt_tokens(ctx_total.max_tokens)}</strong></td>"
          f"<td class='num'><strong>{_fmt_tokens(ctx_total.avg_tokens)}</strong></td>"
          f"<td class='num'><strong>{_fmt_tokens(ctx_total.median_tokens)}</strong></td>"
          f"<td class='num'><strong>{ctx_total.sample_count}</strong></td></tr>")
        w("</table>")

    # ── Unit Tests ─────────────────────────────────────────────
    if data.tests:
        t = data.tests
        w("<h2>Unit Tests</h2>")
        ratio = t.passed / t.total if t.total else 0
        w(f'<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">')
        w(f'{_badge(f"{t.pass_pct:.1f}% passed ({t.passed}/{t.total})", "pass" if test_ok else "fail")}')
        if t.coverage_pct is not None:
            cov_cls = "pass" if t.coverage_pct >= 90 else "warn" if t.coverage_pct >= 70 else "fail"
            w(f'{_badge(f"{t.coverage_pct:.1f}% coverage", cov_cls)}')
        w("</div>")
        w(f'<div class="progress-wrap"><div class="progress-bar {_progress_class(ratio)}" style="width:{ratio*100:.1f}%"></div></div>')

    # ── Contract Tests ─────────────────────────────────────────
    if data.contracts:
        ct = data.contracts
        w("<h2>Contract Tests</h2>")
        ratio = ct.passed / ct.total if ct.total else 0
        w(f'<div style="display:flex;align-items:center;gap:1rem;margin-bottom:1rem">')
        w(f'{_badge(f"{ct.passed}/{ct.total} passed", "pass" if contract_ok else "fail")}')
        if ct.failed:
            w(f'{_badge(f"{ct.failed} failed", "fail")}')
        if ct.errors:
            w(f'{_badge(f"{ct.errors} errors", "fail")}')
        w("</div>")
        w(f'<div class="progress-wrap"><div class="progress-bar {_progress_class(ratio)}" style="width:{ratio*100:.1f}%"></div></div>')

        groups: dict[str, list] = {}
        for c in ct.cases:
            parts = c.path.strip("/").split("/")
            group = parts[2] if len(parts) >= 3 else parts[0]
            groups.setdefault(group, []).append(c)

        for group_name, cases in groups.items():
            passed_g = sum(1 for c in cases if c.passed)
            total_g = len(cases)
            ok_g = passed_g == total_g
            w(f"<h3>{_esc(group_name.title())} {_badge(f'{passed_g}/{total_g}', 'pass' if ok_g else 'fail')}</h3>")
            w("<table><tr><th></th><th>Test</th><th>Method</th><th>Path</th><th class='num'>Status</th><th class='num'>Latency</th></tr>")
            for c in cases:
                icon_cls = "pass-icon" if c.passed else "fail-icon"
                status_str = str(c.actual_status) if c.actual_status else "---"
                lat = f"{c.latency_ms:.0f}ms" if c.latency_ms else "---"
                w(f'<tr><td class="{icon_cls}"></td><td>{_esc(c.name)}</td><td>{c.method}</td>'
                  f'<td><code>{_esc(c.path)}</code></td><td class="num">{status_str}</td><td class="num">{lat}</td></tr>')
            w("</table>")

    # ── Code Quality ───────────────────────────────────────────
    if data.quality:
        q = data.quality
        w("<h2>Code Quality</h2>")
        q_ok = q.lint_errors == 0 and q.security_high == 0
        w(f'<div style="margin-bottom:1rem">')
        w(f'{_badge(f"{q.lint_errors} lint errors", "pass" if q.lint_errors == 0 else "fail")}')
        w(f'{_badge(f"{q.lint_warnings} warnings", "warn" if q.lint_warnings else "pass")}')
        w(f'{_badge(f"{q.security_total} security findings", "pass" if q.security_high == 0 else "fail")}')
        if q.lint_available:
            w(f'{_badge(f"{_esc(q.lint_tool)} {_esc(q.lint_version)}", "info")}')
        if q.semgrep_available:
            w(f'{_badge("semgrep", "info")}')
        w("</div>")

        if q.lint_findings:
            w("<h3>Lint Findings</h3>")
            w("<table><tr><th>File</th><th class='num'>Line</th><th>Code</th><th>Message</th><th>Severity</th></tr>")
            for f in q.lint_findings:
                sev_cls = "fail" if f.severity == "error" else "warn"
                w(f'<tr><td><code>{_esc(f.file)}</code></td><td class="num">{f.line}</td>'
                  f'<td><code>{_esc(f.code)}</code></td><td>{_esc(f.message)}</td>'
                  f'<td>{_badge(f.severity, sev_cls)}</td></tr>')
            w("</table>")

        if q.duplication_available:
            dup_ok = q.duplication_blocks == 0
            w("<h3>Code Duplication</h3>")
            w(f'<div style="margin-bottom:1rem">')
            w(f'{_badge(f"{q.duplication_blocks} duplicate blocks", "pass" if dup_ok else "warn")}')
            w(f'{_badge(f"{q.duplication_lines} duplicated lines", "info")}')
            w("</div>")

    # ── Qualitative Evaluation ─────────────────────────────────
    if data.qualitative:
        ql = data.qualitative
        w("<h2>Qualitative Evaluation</h2>")
        w(f'<div class="score-ring" style="margin-bottom:1.5rem">')
        w(_score_ring(ql.overall_score))
        w(f'<div><div style="font-size:1.5rem;font-weight:700">Overall Score</div>'
          f'<div style="color:var(--text2);font-size:.85rem">Semantic similarity to golden baseline</div></div>')
        w("</div>")

        if ql.phases:
            w('<div class="phase-bars">')
            for phase in ql.phases:
                w(f'<div class="phase-bar-group"><div class="phase-bar-title">{_esc(phase.phase)}</div>')
                for dim, val in [("Intent", phase.avg_intent), ("Design", phase.avg_design),
                                 ("Complete", phase.avg_completeness), ("Overall", phase.avg_overall)]:
                    col = _score_color(val)
                    w(f'<div class="bar-row"><div class="bar-row-label">{dim}</div>'
                      f'<div class="bar-track"><div class="bar-fill" style="width:{val*100:.0f}%;background:{col}"></div></div>'
                      f'<div class="bar-val" style="color:{col}">{val:.2f}</div></div>')
                w("</div>")
            w("</div>")

        for phase in ql.phases:
            w(f"<h3>{_esc(phase.phase.title())} Phase — Documents</h3>")
            w("<table><tr><th>Document</th><th class='num'>Intent</th><th class='num'>Design</th>"
              "<th class='num'>Completeness</th><th class='num'>Overall</th></tr>")
            for d in phase.documents:
                name = Path(d.path).name
                w(f'<tr><td><code>{_esc(name)}</code></td>'
                  f'<td class="num" style="color:{_score_color(d.intent)}">{d.intent:.2f}</td>'
                  f'<td class="num" style="color:{_score_color(d.design)}">{d.design:.2f}</td>'
                  f'<td class="num" style="color:{_score_color(d.completeness)}">{d.completeness:.2f}</td>'
                  f'<td class="num" style="color:{_score_color(d.overall)}"><strong>{d.overall:.2f}</strong></td></tr>')
            w("</table>")

            for d in phase.documents:
                if d.notes:
                    name = Path(d.path).name
                    w(f'<details><summary><code>{_esc(name)}</code> &mdash; {d.overall:.2f}</summary>')
                    w(f'<div class="detail-body">{_esc(d.notes)}</div></details>')

    # ── Artifacts ──────────────────────────────────────────────
    art = data.metrics.artifacts
    if art.total_files > 0:
        w("<h2>Generated Artifacts</h2>")
        w('<div class="card-grid">')
        for label, val in [("Source Files", art.source_files), ("Test Files", art.test_files),
                           ("Config Files", art.config_files), ("Total Files", art.total_files),
                           ("Lines of Code", f"{art.total_lines_of_code:,}"),
                           ("AIDLC Docs", art.total_doc_files)]:
            w(f'<div class="card"><div class="card-label">{label}</div><div class="card-value">{val}</div></div>')
        w("</div>")

    # ── Baseline Comparison ──────────────────────────────────────
    if data.comparison:
        cmp = data.comparison
        golden_name = Path(cmp.golden_run).name if cmp.golden_run else "unknown"

        w("<h2>Baseline Comparison</h2>")
        w(f'<div style="color:var(--text2);font-size:.85rem;margin-bottom:1rem">'
          f'vs golden <code>{_esc(golden_name)}</code>')
        if cmp.golden_promoted_at:
            w(f' &middot; promoted {_esc(cmp.golden_promoted_at)}')
        w("</div>")

        w('<div class="cmp-summary">')
        w(f'<div class="cmp-stat"><div class="cmp-stat-val delta-improved">{cmp.improved}</div><div class="cmp-stat-label">Improved</div></div>')
        w(f'<div class="cmp-stat"><div class="cmp-stat-val delta-regressed">{cmp.regressed}</div><div class="cmp-stat-label">Regressed</div></div>')
        w(f'<div class="cmp-stat"><div class="cmp-stat-val delta-unchanged">{cmp.unchanged}</div><div class="cmp-stat-label">Unchanged</div></div>')
        w("</div>")

        current_cat = ""
        for d in cmp.deltas:
            if d.category != current_cat:
                if current_cat:
                    w("</table>")
                current_cat = d.category
                w(f"<h3>{_esc(d.category)}</h3>")
                w("<table><tr><th></th><th>Metric</th><th class='num'>Golden</th>"
                  "<th class='num'>Current</th><th class='num'>Delta</th><th>Change</th></tr>")

            dot_cls = f"dot-{d.direction}"
            delta_cls = f"delta-{d.direction}"
            golden_str = _fmt_val_html(d.golden)
            current_str = _fmt_val_html(d.current)
            if d.delta is not None:
                sign = "+" if d.delta > 0 else ""
                if isinstance(d.delta, float) and not d.delta.is_integer():
                    delta_str = f"{sign}{d.delta:.4f}"
                else:
                    delta_str = f"{sign}{int(d.delta)}"
                pct_str = f" ({d.pct_change:+.1f}%)" if d.pct_change is not None and abs(d.pct_change) >= 0.1 else ""
            else:
                delta_str = "---"
                pct_str = ""

            w(f'<tr><td><span class="delta-dot {dot_cls}"></span></td>'
              f'<td>{_esc(d.name)}</td>'
              f'<td class="num">{golden_str}</td>'
              f'<td class="num">{current_str}</td>'
              f'<td class="num {delta_cls}">{delta_str}{pct_str}</td>'
              f'<td class="{delta_cls}">{d.direction}</td></tr>')

        if current_cat:
            w("</table>")

    # ── Footer ─────────────────────────────────────────────────
    w(f'<div class="footer">Generated by aidlc-reporting v0.1.0</div>')
    w("</body></html>")

    return "\n".join(out)


def write_html(data: ReportData, output_path: Path) -> None:
    html_str = render_html(data)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html_str)
