"""Self-contained per-run token capture: a local OTLP/HTTP metrics receiver.

Claude Code >= 2.1.x no longer writes usage to the local transcript, and the
CloudWatch path (_otel_tokens.py) needs a full telemetry stack (collector,
CloudWatch, an authorized AWS identity). This module removes that dependency:
the adapter starts a tiny OTLP receiver on 127.0.0.1 for the duration of the
run and points the child ``claude`` at it:

    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>
    OTEL_EXPORTER_OTLP_PROTOCOL=http/json     (stdlib-parseable, no protobuf)

Claude Code POSTs OTLP JSON to /v1/metrics; we track the two metrics that
matter — ``claude_code.token.usage`` (attribute ``type``: input / output /
cacheRead / cacheCreation) and ``claude_code.cost.usage`` (USD) — and sum them
at the end of the run. Zero external dependencies, zero configuration.

OTLP sums arrive with either DELTA or CUMULATIVE aggregation temporality; a
cumulative stream re-reports its running total every export, so summing its
datapoints would overcount. We therefore keep per-stream state (keyed by
metric name + attribute set): cumulative streams keep the LATEST value, delta
streams accumulate. ``summary()`` folds the streams into the token_usage dict
shape ``normalize_output`` expects.

Everything fails open: if the port can't bind or the child never exports,
``summary()`` returns {} and the caller falls back to other sources.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_TOKEN_METRIC = "claude_code.token.usage"
_COST_METRIC = "claude_code.cost.usage"

# OTLP AggregationTemporality enum values (proto3 JSON may carry the int or
# the enum name string).
_DELTA = {1, "AGGREGATION_TEMPORALITY_DELTA"}


def _attr_str(value: dict) -> str:
    """Render an OTLP AnyValue as a plain string (best effort)."""
    for k in ("stringValue", "intValue", "doubleValue", "boolValue"):
        if k in value:
            return str(value[k])
    return ""


def _point_value(point: dict) -> float:
    """Numeric value of an OTLP NumberDataPoint (asInt is an int64 string)."""
    if "asInt" in point:
        return float(int(point["asInt"]))
    return float(point.get("asDouble", 0) or 0)


class LocalOtelReceiver:
    """In-process OTLP/HTTP metrics sink for one evaluation run."""

    def __init__(self) -> None:
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        # (metric, frozenset(attrs)) -> {"value": float, "time": int, "delta": bool}
        self._streams: dict[tuple[str, frozenset], dict] = {}
        self.requests_seen = 0

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> str | None:
        """Bind on an ephemeral localhost port; return the endpoint URL.

        Returns None (and stays inert) if binding fails — callers treat that
        as "local capture unavailable" and fall back.
        """
        receiver = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib API
                length = int(self.headers.get("Content-Length", 0) or 0)
                body = self.rfile.read(length) if length else b""
                if self.path.rstrip("/").endswith("/v1/metrics"):
                    receiver._ingest(body, self.headers.get("Content-Type", ""))
                # Always ack; an exporter that gets errors will spam retries
                # into the run. Partial-success body is valid OTLP.
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args) -> None:  # silence request logging
                pass

        try:
            self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        except OSError:
            return None
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="otel-local-receiver", daemon=True
        )
        self._thread.start()
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def env_overrides(self, endpoint: str) -> dict:
        """Child env enabling metric export to this receiver.

        http/json keeps the payload stdlib-parseable; the 5s export interval
        flushes a short run's tail before exit (default is 60s).
        """
        return {
            "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
            "OTEL_METRICS_EXPORTER": "otlp",
            "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
            "OTEL_EXPORTER_OTLP_ENDPOINT": endpoint,
            # Explicitly clear inherited exporters/headers so a user-level
            # collector config can't hijack or double-export this run.
            "OTEL_EXPORTER_OTLP_HEADERS": "",
            "OTEL_LOGS_EXPORTER": "none",
            "OTEL_TRACES_EXPORTER": "none",
            "OTEL_METRIC_EXPORT_INTERVAL": "5000",
            "OTEL_METRICS_INCLUDE_SESSION_ID": "1",
        }

    # -- ingest ------------------------------------------------------------

    def _ingest(self, body: bytes, content_type: str) -> None:
        if "json" not in content_type.lower():
            return  # http/protobuf (misconfig) — ack'd but unparseable here
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        with self._lock:
            self.requests_seen += 1
            for rm in data.get("resourceMetrics", []):
                for sm in rm.get("scopeMetrics", []):
                    for metric in sm.get("metrics", []):
                        name = metric.get("name", "")
                        if name not in (_TOKEN_METRIC, _COST_METRIC):
                            continue
                        sum_block = metric.get("sum", {})
                        is_delta = sum_block.get("aggregationTemporality") in _DELTA
                        for point in sum_block.get("dataPoints", []):
                            self._record(name, point, is_delta)

    def _record(self, metric: str, point: dict, is_delta: bool) -> None:
        attrs = frozenset(
            (a.get("key", ""), _attr_str(a.get("value", {})))
            for a in point.get("attributes", [])
        )
        t = int(point.get("timeUnixNano", 0) or 0)
        value = _point_value(point)
        stream = self._streams.get((metric, attrs))
        if stream is None:
            self._streams[(metric, attrs)] = {"value": value, "time": t, "delta": is_delta}
        elif is_delta:
            stream["value"] += value
            stream["time"] = max(stream["time"], t)
        elif t >= stream["time"]:  # cumulative: latest report wins
            stream["value"] = value
            stream["time"] = t

    # -- results -----------------------------------------------------------

    def summary(self) -> dict:
        """Fold captured streams into normalize_output's token_usage shape.

        Returns {} if no token datapoints arrived (telemetry off / export
        failed), so callers can fall back to other capture paths.
        """
        with self._lock:
            per_type: dict[str, int] = {}
            cost = 0.0
            for (metric, attrs), stream in self._streams.items():
                if metric == _COST_METRIC:
                    cost += stream["value"]
                    continue
                ttype = next((v for k, v in attrs if k == "type"), "")
                per_type[ttype] = per_type.get(ttype, 0) + int(stream["value"])
        if not per_type:
            return {}
        inp = per_type.get("input", 0)
        out = per_type.get("output", 0)
        return {
            "input_tokens": inp,
            "output_tokens": out,
            "cache_read_tokens": per_type.get("cacheRead", 0),
            "cache_write_tokens": per_type.get("cacheCreation", 0),
            "total_tokens": inp + out,
            "cost_usd": cost or None,
            "source": "otel-local",
        }
