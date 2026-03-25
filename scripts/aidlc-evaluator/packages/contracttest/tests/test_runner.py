"""Tests for contract test runner logic.

These tests validate the body matching and case execution without
requiring a real server.
"""

from pathlib import Path
from unittest.mock import patch, MagicMock

import httpx

from contracttest.runner import _match_body, _run_case, ContractTestResults, write_results
from contracttest.spec import TestCase

import yaml


class TestMatchBody:
    def test_exact_match(self):
        expected = {"status": "ok", "result": 42}
        actual = {"status": "ok", "result": 42, "extra": "ignored"}
        assert _match_body(expected, actual) == []

    def test_missing_key(self):
        expected = {"status": "ok", "result": 42}
        actual = {"status": "ok"}
        failures = _match_body(expected, actual)
        assert len(failures) == 1
        assert "missing key 'result'" in failures[0]

    def test_wrong_value(self):
        expected = {"status": "ok"}
        actual = {"status": "error"}
        failures = _match_body(expected, actual)
        assert len(failures) == 1
        assert "'status'" in failures[0]

    def test_nested_match(self):
        expected = {"error": {"code": "DOMAIN_ERROR"}}
        actual = {"error": {"code": "DOMAIN_ERROR", "message": "sqrt of negative"}}
        assert _match_body(expected, actual) == []

    def test_nested_mismatch(self):
        expected = {"error": {"code": "DOMAIN_ERROR"}}
        actual = {"error": {"code": "OVERFLOW"}}
        failures = _match_body(expected, actual)
        assert len(failures) == 1
        assert "error.code" in failures[0]

    def test_float_tolerance(self):
        expected = {"result": 3.0}
        actual = {"result": 3.0000000001}
        assert _match_body(expected, actual) == []

    def test_float_mismatch(self):
        expected = {"result": 3.0}
        actual = {"result": 5.0}
        failures = _match_body(expected, actual)
        assert len(failures) == 1


class TestRunCase:
    def test_get_success(self):
        case = TestCase(name="health", method="GET", path="/health",
                        expected_status=200, expected_body={"status": "ok"})
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "ok", "version": "0.1.0"}

        client = MagicMock()
        client.get.return_value = mock_resp

        result = _run_case(client, "http://localhost:8000", case)
        assert result.passed
        assert result.actual_status == 200
        assert result.failures == []
        assert result.latency_ms is not None

    def test_wrong_status(self):
        case = TestCase(name="not found", method="GET", path="/missing",
                        expected_status=404)
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {}

        client = MagicMock()
        client.get.return_value = mock_resp

        result = _run_case(client, "http://localhost:8000", case)
        assert not result.passed
        assert any("status" in f for f in result.failures)

    def test_post_body_mismatch(self):
        case = TestCase(name="add", method="POST", path="/api/v1/arithmetic/add",
                        expected_status=200, body={"a": 1, "b": 2},
                        expected_body={"status": "ok", "result": 3})
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"status": "ok", "result": 99}

        client = MagicMock()
        client.post.return_value = mock_resp

        result = _run_case(client, "http://localhost:8000", case)
        assert not result.passed
        assert any("result" in f for f in result.failures)

    def test_connection_error(self):
        case = TestCase(name="health", method="GET", path="/health",
                        expected_status=200)
        client = MagicMock()
        client.get.side_effect = httpx.ConnectError("refused")

        result = _run_case(client, "http://localhost:9999", case)
        assert not result.passed
        assert result.error is not None


class TestWriteResults:
    def test_roundtrip(self, tmp_path):
        results = ContractTestResults(
            total=3, passed=2, failed=1, errors=0,
            server_started=True,
        )
        out = tmp_path / "results.yaml"
        write_results(results, out)

        with open(out) as f:
            data = yaml.safe_load(f)
        assert data["total"] == 3
        assert data["passed"] == 2
        assert data["failed"] == 1
        assert data["server_started"] is True
