"""Per-run token capture via OpenTelemetry -> CloudWatch (the KW collector).

Claude Code >= 2.1.x no longer writes a local ``message.usage`` transcript
(see _claude_tokens.py's fallback), so per-run token attribution moved to the
telemetry pipeline: Claude Code exports OTEL metrics, the KW collector lands
them in CloudWatch namespace ``KWTelemetry`` as ``claude_code.token.usage``
dimensioned by ``session.id`` (and ``type`` = input/output/cacheRead/
cacheCreation). We spawn ``claude`` with a known ``--session-id``, so after the
run we sum that session's token metric straight from CloudWatch.

Two halves:

* ``otel_env_overrides()`` — the ``OTEL_*`` / ``CLAUDE_CODE_ENABLE_TELEMETRY``
  vars to inject into the child env so a ``--setting-sources project`` run
  actually exports (project isolation otherwise drops the user-level OTEL
  config). Read from ``~/.claude/settings.json``; returns ``{}`` when telemetry
  isn't configured, so callers no-op cleanly off-telemetry machines.
* ``query_session_tokens()`` — CloudWatch ``get-metric-statistics`` for the
  session, summed across token types, via the ``aws`` CLI (same auth path the
  budget hook uses: profile ``sandbox26``, region ``us-west-2`` from
  ``kw-telemetry.json``).

Everything fails open: any missing config / CLI error / no datapoints returns
an empty dict, and the caller reports tokens as unavailable.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
_TELEMETRY_CFG_PATH = Path.home() / ".claude" / "kw-telemetry.json"

_NAMESPACE = "KWTelemetry"
_TOKEN_METRIC = "claude_code.token.usage"
_COST_METRIC = "claude_code.cost.usage"
# The metric's per-type dimension is published as `type` in the KW collector's
# EMF declarations (values: input, output, cacheRead, cacheCreation).

# One-shot guard so a batch of N runs logs the auth-failure diagnosis ONCE,
# not once per run per query. Reset per process.
_auth_warned = False


def _run_aws_json(cmd: list[str], *, default):
    """Run an aws-CLI JSON command; return parsed stdout or ``default``.

    Distinguishes an AUTH/permission failure (AccessDenied, expired token, no
    credentials) from a benign empty result and logs it ONCE per process. This
    is the failure that silently zeroed cost/tokens across the 2026-08-03
    overnight batch: the aws subprocess fell back to an expired file-credential
    token whose identity lacked cloudwatch:GetMetricStatistics, and the empty
    result was indistinguishable from "no datapoints". Surfacing it means a
    recurrence is diagnosable from the run log instead of showing up as $0.
    """
    global _auth_warned
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return default
    if out.returncode != 0:
        err = (out.stderr or "").lower()
        if not _auth_warned and any(
            marker in err
            for marker in (
                "accessdenied",
                "not authorized",
                "expiredtoken",
                "credentials",
                "unabletolocatecredentials",
                "unable to locate credentials",
            )
        ):
            _auth_warned = True
            print(
                "  [otel-tokens] AWS auth/permission failure querying CloudWatch — "
                "tokens/cost will read 0, NOT because the session lacked data. "
                "The metrics are still in CloudWatch; backfill later or grant the "
                "querying identity cloudwatch:ListMetrics + GetMetricStatistics. "
                f"stderr: {(out.stderr or '').strip()[:200]}",
                file=sys.stderr,
            )
        return default
    try:
        return json.loads(out.stdout or "null")
    except json.JSONDecodeError:
        return default


def _load_settings_env() -> dict:
    """The ``env`` block of ~/.claude/settings.json, or {} if absent/malformed."""
    try:
        data = json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    env = data.get("env")
    return env if isinstance(env, dict) else {}


def telemetry_configured() -> bool:
    """True if the user's settings carry an OTEL exporter endpoint to export to."""
    env = _load_settings_env()
    return bool(env.get("OTEL_EXPORTER_OTLP_ENDPOINT"))


def otel_env_overrides() -> dict:
    """Env vars to enable per-run OTEL metric export, or {} if not configured.

    Copies the ``OTEL_*`` and ``CLAUDE_CODE_*`` telemetry keys from the user's
    settings ``env`` block, forces telemetry on, and pins a SHORT metric export
    interval so the run's tokens flush to the collector before the process
    exits (the default 60s interval can drop the tail of a short run). Does not
    touch ``CLAUDE_CODE_USE_BEDROCK`` semantics beyond copying it through.
    """
    env = _load_settings_env()
    if not env.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return {}
    keys = [k for k in env if k.startswith("OTEL_") or k.startswith("CLAUDE_CODE_")]
    overrides = {k: str(env[k]) for k in keys}
    overrides["CLAUDE_CODE_ENABLE_TELEMETRY"] = "1"
    overrides["OTEL_METRICS_EXPORTER"] = env.get("OTEL_METRICS_EXPORTER", "otlp")
    overrides["OTEL_METRICS_INCLUDE_SESSION_ID"] = "1"
    # Flush metrics every 5s so a short run's token counts land before exit.
    overrides["OTEL_METRIC_EXPORT_INTERVAL"] = "5000"
    return overrides


def _telemetry_cfg() -> dict:
    try:
        return json.loads(_TELEMETRY_CFG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def query_session_tokens(
    session_id: str,
    start_epoch: float,
    end_epoch: float,
    *,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    settle_seconds: float = 20.0,
) -> dict:
    """Sum a session's token usage from CloudWatch, by token type.

    Waits ``settle_seconds`` first so the collector's final export + EMF
    ingestion catches up (metrics land a few seconds after the run ends).
    Queries ``claude_code.token.usage`` for each token type dimensioned by
    ``session.id``, over [start, end] padded generously.

    Returns a dict shaped for ``normalize_output``'s ``token_usage`` param
    (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    total_tokens, plus ``source: otel-cloudwatch``), or {} on any failure /
    no datapoints.
    """
    cfg = _telemetry_cfg()
    profile = aws_profile or cfg.get("aws_profile")
    region = aws_region or cfg.get("aws_region") or "us-west-2"

    if settle_seconds > 0:
        time.sleep(settle_seconds)

    # Pad the window: 5 min before start (clock skew) to 5 min after end.
    start_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start_epoch - 300))
    end_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end_epoch + 300))

    # CloudWatch get-metric-statistics only returns data for an EXACT dimension
    # set. The collector publishes token.usage across several stream shapes per
    # session:
    #   * a SPARSE rollup ('OTelLib','session.id') carrying the session's TOTAL
    #     token count across all types/models — always present, lands first;
    #   * RICH per-(model x token_type) streams (17/18 dims) split by `type`
    #     (input/output/cacheRead/cacheCreation) — richer, but can lag ingest or
    #     be absent for small sessions.
    # Enumerate the session's streams, prefer the per-type split when available,
    # and always fall back to the rollup total so a run is never scored as 0
    # just because the per-type breakdown hasn't landed.
    streams = _list_session_streams(session_id, profile, region)
    if not streams:
        return {}
    per_type: dict[str, int] = {}
    rollup_total: int | None = None
    for dims in streams:
        names = {d["Name"] for d in dims}
        ttype = next((d["Value"] for d in dims if d["Name"] == "type"), None)
        val = _get_metric_sum_for_dims(dims, start_iso, end_iso, profile, region)
        if val is None:
            continue
        if ttype is not None:
            per_type[ttype] = per_type.get(ttype, 0) + val
        elif names == {"OTelLib", "session.id"}:
            rollup_total = (rollup_total or 0) + val

    # Cost ($) is published as a per-session rollup on claude_code.cost.usage and
    # is the ROBUST cross-version axis: it's always emitted (unlike the per-type
    # token split, which the collector does NOT publish for PTY-driven sessions),
    # and it already weights input/output/cache-read/cache-write at real prices.
    # The raw token total, by contrast, is dominated by cache-read and conflates
    # billable with cached tokens — so cost is the fair "how much did it consume"
    # number for the <=50% criterion.
    cost_usd = _query_session_cost(session_id, start_iso, end_iso, profile, region)

    if per_type:
        inp = per_type.get("input", 0)
        out = per_type.get("output", 0)
        cache_read = per_type.get("cacheRead", 0)
        cache_write = per_type.get("cacheCreation", 0)
        return {
            "input_tokens": inp,
            "output_tokens": out,
            "cache_read_tokens": cache_read,
            "cache_write_tokens": cache_write,
            "total_tokens": inp + out,
            "cost_usd": cost_usd,
            "source": "otel-cloudwatch",
        }
    if rollup_total is not None:
        # Only the sparse rollup landed: a single all-types total (no in/out
        # split, includes cache tokens). cost_usd is the reliable comparison.
        return {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_write_tokens": 0,
            "total_tokens": rollup_total,
            "cost_usd": cost_usd,
            "source": "otel-cloudwatch-rollup",
        }
    return {}


def _list_session_streams(
    session_id: str, profile: str | None, region: str
) -> list[list[dict]]:
    """Return the full dimension set of each token.usage stream for a session.

    Each element is a CloudWatch ``Dimensions`` list (``[{"Name":..,"Value":..}]``)
    suitable for passing straight to get-metric-statistics.
    """
    cmd = [
        "aws", "cloudwatch", "list-metrics",
        "--namespace", _NAMESPACE,
        "--metric-name", _TOKEN_METRIC,
        "--dimensions", f"Name=session.id,Value={session_id}",
        "--output", "json",
    ]
    if region:
        cmd += ["--region", region]
    if profile:
        cmd += ["--profile", profile]
    data = _run_aws_json(cmd, default={})
    if not isinstance(data, dict):
        return []
    return [m["Dimensions"] for m in data.get("Metrics", []) if m.get("Dimensions")]


def _get_metric_sum_for_dims(
    dims: list[dict],
    start_iso: str,
    end_iso: str,
    profile: str | None,
    region: str,
) -> int | None:
    """Sum token.usage over [start,end] for one EXACT dimension set, or None."""
    cmd = [
        "aws", "cloudwatch", "get-metric-statistics",
        "--namespace", _NAMESPACE,
        "--metric-name", _TOKEN_METRIC,
        "--dimensions", *[f"Name={d['Name']},Value={d['Value']}" for d in dims],
        "--start-time", start_iso,
        "--end-time", end_iso,
        "--period", "86400",
        "--statistics", "Sum",
        "--query", "Datapoints[].Sum",
        "--output", "json",
    ]
    if region:
        cmd += ["--region", region]
    if profile:
        cmd += ["--profile", profile]
    points = _run_aws_json(cmd, default=None)
    if not points:
        return None
    return int(sum(float(p) for p in points))


def _query_session_cost(
    session_id: str,
    start_iso: str,
    end_iso: str,
    profile: str | None,
    region: str,
) -> float | None:
    """Sum claude_code.cost.usage ($) for a session via its rollup stream, or None.

    Cost is published on the sparse ('OTelLib','session.id') rollup, same shape
    as the token rollup. Returns dollars, or None if the metric isn't present.
    """
    dims = [
        {"Name": "OTelLib", "Value": "com.anthropic.claude_code"},
        {"Name": "session.id", "Value": session_id},
    ]
    cmd = [
        "aws", "cloudwatch", "get-metric-statistics",
        "--namespace", _NAMESPACE,
        "--metric-name", _COST_METRIC,
        "--dimensions", *[f"Name={d['Name']},Value={d['Value']}" for d in dims],
        "--start-time", start_iso,
        "--end-time", end_iso,
        "--period", "86400",
        "--statistics", "Sum",
        "--query", "Datapoints[].Sum",
        "--output", "json",
    ]
    if region:
        cmd += ["--region", region]
    if profile:
        cmd += ["--profile", profile]
    points = _run_aws_json(cmd, default=None)
    if not points:
        return None
    return round(sum(float(p) for p in points), 4)


def capture_run_tokens_otel(
    session_id: str,
    start_epoch: float,
    end_epoch: float,
    *,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    settle_seconds: float = 20.0,
) -> dict:
    """Convenience wrapper: query this run's session tokens from CloudWatch.

    Returns {} if telemetry isn't configured (so the caller falls back to the
    transcript path or reports N/A).
    """
    if not telemetry_configured():
        return {}
    return query_session_tokens(
        session_id,
        start_epoch,
        end_epoch,
        aws_profile=aws_profile,
        aws_region=aws_region,
        settle_seconds=settle_seconds,
    )
