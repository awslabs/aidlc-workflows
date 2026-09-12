"""Tests for the local OTLP receiver (_otel_local.py)."""

from __future__ import annotations

import json
import urllib.request

from cli_harness.adapters._otel_local import LocalOtelReceiver

TOKENS = "claude_code.token.usage"
COST = "claude_code.cost.usage"


def _payload(metrics: list[dict]) -> bytes:
    return json.dumps(
        {"resourceMetrics": [{"scopeMetrics": [{"metrics": metrics}]}]}
    ).encode()


def _sum_metric(name: str, points: list[dict], temporality=1) -> dict:
    return {
        "name": name,
        "sum": {"aggregationTemporality": temporality, "dataPoints": points},
    }


def _point(value, attrs: dict | None = None, t: int = 1) -> dict:
    p: dict = {"timeUnixNano": str(t)}
    if isinstance(value, int):
        p["asInt"] = str(value)
    else:
        p["asDouble"] = value
    if attrs:
        p["attributes"] = [
            {"key": k, "value": {"stringValue": v}} for k, v in attrs.items()
        ]
    return p


def _post(endpoint: str, body: bytes, path: str = "/v1/metrics") -> int:
    req = urllib.request.Request(
        endpoint + path, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status


class TestReceiverLifecycle:
    def test_start_returns_localhost_endpoint(self):
        r = LocalOtelReceiver()
        endpoint = r.start()
        try:
            assert endpoint is not None and endpoint.startswith("http://127.0.0.1:")
        finally:
            r.stop()

    def test_empty_summary_before_any_export(self):
        r = LocalOtelReceiver()
        r.start()
        try:
            assert r.summary() == {}
        finally:
            r.stop()

    def test_env_overrides_point_at_receiver(self):
        r = LocalOtelReceiver()
        env = r.env_overrides("http://127.0.0.1:9999")
        assert env["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://127.0.0.1:9999"
        assert env["OTEL_EXPORTER_OTLP_PROTOCOL"] == "http/json"
        assert env["CLAUDE_CODE_ENABLE_TELEMETRY"] == "1"
        # user-level collector config must not leak into the child
        assert env["OTEL_EXPORTER_OTLP_HEADERS"] == ""


class TestIngestion:
    def _receiver(self):
        r = LocalOtelReceiver()
        endpoint = r.start()
        assert endpoint
        return r, endpoint

    def test_delta_token_points_accumulate(self):
        r, endpoint = self._receiver()
        try:
            body = _payload(
                [
                    _sum_metric(
                        TOKENS,
                        [
                            _point(100, {"type": "input"}, t=1),
                            _point(50, {"type": "output"}, t=1),
                        ],
                    )
                ]
            )
            assert _post(endpoint, body) == 200
            # second delta export adds
            body2 = _payload(
                [_sum_metric(TOKENS, [_point(20, {"type": "input"}, t=2)])]
            )
            _post(endpoint, body2)
            s = r.summary()
            assert s["input_tokens"] == 120
            assert s["output_tokens"] == 50
            assert s["total_tokens"] == 170
            assert s["source"] == "otel-local"
        finally:
            r.stop()

    def test_cumulative_streams_keep_latest_not_sum(self):
        r, endpoint = self._receiver()
        try:
            for t, v in [(1, 100), (2, 250), (3, 400)]:
                _post(
                    endpoint,
                    _payload(
                        [_sum_metric(TOKENS, [_point(v, {"type": "input"}, t=t)], 2)]
                    ),
                )
            assert r.summary()["input_tokens"] == 400  # not 750
        finally:
            r.stop()

    def test_cache_types_and_cost(self):
        r, endpoint = self._receiver()
        try:
            body = _payload(
                [
                    _sum_metric(
                        TOKENS,
                        [
                            _point(10, {"type": "input"}),
                            _point(5, {"type": "output"}),
                            _point(1000, {"type": "cacheRead"}),
                            _point(200, {"type": "cacheCreation"}),
                        ],
                    ),
                    _sum_metric(COST, [_point(1.25)]),
                ]
            )
            _post(endpoint, body)
            s = r.summary()
            assert s["cache_read_tokens"] == 1000
            assert s["cache_write_tokens"] == 200
            assert s["total_tokens"] == 15  # in+out only, cache excluded
            assert s["cost_usd"] == 1.25
        finally:
            r.stop()

    def test_irrelevant_metrics_and_garbage_ignored(self):
        r, endpoint = self._receiver()
        try:
            _post(endpoint, _payload([_sum_metric("some.other.metric", [_point(9)])]))
            assert _post(endpoint, b"not json at all") == 200  # ack'd, not crashed
            assert r.summary() == {}
        finally:
            r.stop()

    def test_distinct_attr_streams_summed_per_type(self):
        # same type from two different models: values add
        r, endpoint = self._receiver()
        try:
            body = _payload(
                [
                    _sum_metric(
                        TOKENS,
                        [
                            _point(100, {"type": "input", "model": "opus"}),
                            _point(40, {"type": "input", "model": "haiku"}),
                        ],
                    )
                ]
            )
            _post(endpoint, body)
            assert r.summary()["input_tokens"] == 140
        finally:
            r.stop()
