"""Tests for the Hurl-suite runner (graceful degradation without the binary)."""

from pathlib import Path

from contracttest import hurl_runner
from contracttest.hurl_runner import HurlResults, run_hurl_suite


def test_missing_binary_is_not_a_contract_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(hurl_runner, "hurl_available", lambda: False)
    f = tmp_path / "profiles.hurl"
    f.write_text("GET {{host}}/api/tags\nHTTP 200\n", encoding="utf-8")
    r = run_hurl_suite([f], "http://localhost:8000")
    assert r.hurl_available is False
    assert r.error  # explicit tooling error
    assert r.all_passed is False  # never a false pass


def test_no_files(monkeypatch):
    monkeypatch.setattr(hurl_runner, "hurl_available", lambda: True)
    r = run_hurl_suite([], "http://localhost:8000")
    assert r.error == "no .hurl files provided"


def test_all_passed_requires_data():
    # A default HurlResults (no runs) must not report all_passed.
    assert HurlResults().all_passed is False
