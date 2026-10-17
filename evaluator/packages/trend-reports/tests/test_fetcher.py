"""Tests for data retrieval via the gh CLI.

All tests mock subprocess.run to avoid requiring the gh CLI or network access.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest
from trend_reports.fetcher import (
    check_gh_available,
    fetch_artifact_bundle,
    fetch_prerelease_bundles,
    fetch_release_bundle,
    fetch_release_bundles,
    fetch_release_list,
    fetch_workflow_runs,
)
from trend_reports.models import FetchError


def _mock_run(stdout="", stderr="", returncode=0):
    result = MagicMock()
    result.stdout = stdout
    result.stderr = stderr
    result.returncode = returncode
    return result


class TestCheckGhAvailable:
    def test_gh_not_installed(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            side_effect=FileNotFoundError,
        ):
            with pytest.raises(FetchError, match="gh CLI not found"):
                check_gh_available()

    def test_gh_version_error(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=1, stderr="some error"),
        ):
            with pytest.raises(FetchError, match="gh CLI returned an error"):
                check_gh_available()

    def test_gh_not_authenticated(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            side_effect=[
                _mock_run(returncode=0),  # gh version succeeds
                _mock_run(returncode=1, stderr="not logged in"),  # auth fails
            ],
        ):
            with pytest.raises(FetchError, match="not authenticated"):
                check_gh_available()

    def test_success(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            side_effect=[
                _mock_run(returncode=0),  # gh version
                _mock_run(returncode=0),  # gh auth status
            ],
        ):
            check_gh_available()  # Should not raise


class TestFetchReleaseList:
    def test_success(self):
        releases = [
            {"tagName": "v0.1.1", "publishedAt": "2026-02-01"},
            {"tagName": "v0.1.0", "publishedAt": "2026-01-01"},
        ]
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(stdout=json.dumps(releases)),
        ):
            result = fetch_release_list("owner/repo")
        # Should be sorted by publishedAt ascending
        assert result[0]["tagName"] == "v0.1.0"
        assert result[1]["tagName"] == "v0.1.1"

    def test_error_raises(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=1, stderr="API error"),
        ):
            with pytest.raises(FetchError, match="Failed to list releases"):
                fetch_release_list("owner/repo")

    def test_empty_list(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(stdout="[]"),
        ):
            result = fetch_release_list("owner/repo")
        assert result == []


class TestFetchReleaseBundle:
    def test_success(self, tmp_path):
        tag_dir = tmp_path / "v0.1.0"
        tag_dir.mkdir()
        (tag_dir / "report-v0.1.0.zip").write_bytes(b"fake")

        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=0),
        ):
            result = fetch_release_bundle("owner/repo", "v0.1.0", tmp_path)
        assert result is not None
        assert result.name == "report-v0.1.0.zip"

    def test_no_assets_match(self, tmp_path):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=1, stderr="no assets match the pattern"),
        ):
            result = fetch_release_bundle("owner/repo", "v0.1.0", tmp_path)
        assert result is None

    def test_no_zip_on_disk(self, tmp_path):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=0),
        ):
            result = fetch_release_bundle("owner/repo", "v0.1.0", tmp_path)
        assert result is None

    def test_other_error_raises(self, tmp_path):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=1, stderr="network timeout"),
        ):
            with pytest.raises(FetchError, match="Failed to download report"):
                fetch_release_bundle("owner/repo", "v0.1.0", tmp_path)


class TestFetchWorkflowRuns:
    def test_success_filters_non_success(self):
        runs = [
            {"databaseId": 1, "conclusion": "success", "headBranch": "main"},
            {"databaseId": 2, "conclusion": "failure", "headBranch": "main"},
            {"databaseId": 3, "conclusion": "success", "headBranch": "main"},
        ]
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(stdout=json.dumps(runs)),
        ):
            result = fetch_workflow_runs("owner/repo")
        assert len(result) == 2
        assert all(r["conclusion"] == "success" for r in result)

    def test_with_branch_filter(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(stdout="[]"),
        ) as mock:
            fetch_workflow_runs("owner/repo", branch="main")
        cmd = mock.call_args[0][0]
        assert "--branch" in cmd
        assert "main" in cmd

    def test_with_event_filter(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(stdout="[]"),
        ) as mock:
            fetch_workflow_runs("owner/repo", event="pull_request")
        cmd = mock.call_args[0][0]
        assert "--event" in cmd
        assert "pull_request" in cmd

    def test_error_raises(self):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=1, stderr="API error"),
        ):
            with pytest.raises(FetchError, match="Failed to list workflow runs"):
                fetch_workflow_runs("owner/repo")


class TestFetchArtifactBundle:
    def test_success(self, tmp_path):
        artifact_dir = tmp_path / "report-main"
        artifact_dir.mkdir(parents=True)
        (artifact_dir / "report-main.zip").write_bytes(b"fake")

        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=0),
        ):
            result = fetch_artifact_bundle("owner/repo", 123, "report-main", tmp_path)
        assert result is not None
        assert result.name == "report-main.zip"

    def test_no_artifact(self, tmp_path):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=1, stderr="no artifact found"),
        ):
            result = fetch_artifact_bundle("owner/repo", 123, "report-main", tmp_path)
        assert result is None

    def test_no_zip_in_download(self, tmp_path):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=0),
        ):
            result = fetch_artifact_bundle("owner/repo", 123, "report-main", tmp_path)
        assert result is None

    def test_other_error_raises(self, tmp_path):
        with patch(
            "trend_reports.fetcher.subprocess.run",
            return_value=_mock_run(returncode=1, stderr="server error"),
        ):
            with pytest.raises(FetchError, match="Failed to download artifact"):
                fetch_artifact_bundle("owner/repo", 123, "report-main", tmp_path)


class TestFetchPrereleaseBundles:
    def test_no_runs_returns_empty(self, tmp_path):
        with patch(
            "trend_reports.fetcher.fetch_workflow_runs",
            return_value=[],
        ):
            result = fetch_prerelease_bundles("owner/repo", work_dir=tmp_path)
        assert result == []

    def test_fetch_error_returns_empty(self, tmp_path):
        with patch(
            "trend_reports.fetcher.fetch_workflow_runs",
            side_effect=FetchError("fail"),
        ):
            result = fetch_prerelease_bundles("owner/repo", work_dir=tmp_path)
        assert result == []

    def test_main_artifact_found(self, tmp_path):
        main_zip = tmp_path / "report-main" / "report-main.zip"
        main_zip.parent.mkdir(parents=True)
        main_zip.write_bytes(b"fake")

        with (
            patch(
                "trend_reports.fetcher.fetch_workflow_runs",
                side_effect=[
                    [{"databaseId": 1, "headBranch": "main"}],  # main runs
                    [],  # PR runs
                ],
            ),
            patch(
                "trend_reports.fetcher.fetch_artifact_bundle",
                return_value=main_zip,
            ),
        ):
            result = fetch_prerelease_bundles("owner/repo", work_dir=tmp_path)
        assert len(result) == 1
        assert result[0] == main_zip


class TestFetchReleaseBundles:
    def test_no_bundles_raises(self, tmp_path):
        with (
            patch(
                "trend_reports.fetcher.fetch_release_list",
                return_value=[{"tagName": "v0.1.0", "publishedAt": "2026-01-01"}],
            ),
            patch("trend_reports.fetcher.fetch_release_bundle", return_value=None),
        ):
            with pytest.raises(FetchError, match="No report bundles found"):
                fetch_release_bundles("owner/repo", work_dir=tmp_path)

    def test_specific_tags_filter(self, tmp_path):
        fake_zip = tmp_path / "report.zip"
        fake_zip.write_bytes(b"fake")

        with (
            patch(
                "trend_reports.fetcher.fetch_release_list",
                return_value=[
                    {"tagName": "v0.1.0", "publishedAt": "2026-01-01"},
                    {"tagName": "v0.1.1", "publishedAt": "2026-02-01"},
                ],
            ),
            patch("trend_reports.fetcher.fetch_release_bundle", return_value=fake_zip),
        ):
            result = fetch_release_bundles("owner/repo", tags=["v0.1.1"], work_dir=tmp_path)
        assert len(result) == 1
