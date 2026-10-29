"""Tests for CLI entry point and format resolution."""

from __future__ import annotations

from unittest.mock import patch

import pytest
from trend_reports.__main__ import _resolve_formats
from trend_reports.models import TrendReportError


class TestResolveFormats:
    def test_both(self):
        assert _resolve_formats("both") == {"md", "html"}

    def test_all(self):
        assert _resolve_formats("all") == {"md", "html", "yaml"}

    def test_md(self):
        assert _resolve_formats("md") == {"md"}

    def test_html(self):
        assert _resolve_formats("html") == {"html"}

    def test_yaml(self):
        assert _resolve_formats("yaml") == {"yaml"}


class TestCmdTrendLocalBundle:
    def test_missing_local_bundle_raises(self, tmp_path):
        """Local bundle path that does not exist should raise TrendReportError."""
        from trend_reports.__main__ import cmd_trend

        fake_zip = tmp_path / "nonexistent.zip"
        dummy_zip = tmp_path / "dummy.zip"
        dummy_zip.write_bytes(b"fake")

        with (
            patch(
                "trend_reports.fetcher.check_gh_available",
            ),
            patch(
                "trend_reports.fetcher.fetch_release_list",
                return_value=[{"tagName": "v0.1.0", "publishedAt": "2026-01-01"}],
            ),
            patch(
                "trend_reports.fetcher.fetch_release_bundle",
                return_value=dummy_zip,
            ),
        ):
            with pytest.raises(TrendReportError, match="Local bundle not found"):
                cmd_trend(
                    baseline=str(tmp_path / "golden.yaml"),
                    fmt="md",
                    output_dir=str(tmp_path / "out"),
                    repo="test/repo",
                    cache_prefix="report-",
                    gate=False,
                    tags=["v0.1.0"],
                    local_bundles=[str(fake_zip)],
                )


class TestCmdTrendLocalRunDir:
    def test_missing_local_run_dir_raises(self, tmp_path):
        """Local run dir path that does not exist should raise TrendReportError."""
        from trend_reports.__main__ import cmd_trend

        fake_dir = tmp_path / "nonexistent"
        dummy_zip = tmp_path / "dummy.zip"
        dummy_zip.write_bytes(b"fake")

        with (
            patch(
                "trend_reports.fetcher.check_gh_available",
            ),
            patch(
                "trend_reports.fetcher.fetch_release_list",
                return_value=[{"tagName": "v0.1.0", "publishedAt": "2026-01-01"}],
            ),
            patch(
                "trend_reports.fetcher.fetch_release_bundle",
                return_value=dummy_zip,
            ),
        ):
            with pytest.raises(TrendReportError, match="Local run directory not found"):
                cmd_trend(
                    baseline=str(tmp_path / "golden.yaml"),
                    fmt="md",
                    output_dir=str(tmp_path / "out"),
                    repo="test/repo",
                    cache_prefix="report-",
                    gate=False,
                    tags=["v0.1.0"],
                    local_run_dirs=[str(fake_dir)],
                )
