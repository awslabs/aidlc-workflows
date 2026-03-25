"""Tests for the scanner orchestrator."""

from pathlib import Path
from unittest.mock import patch

from quantitative.models import ToolResult
from quantitative.scanner import scan_workspace, write_report, _detect_project

import yaml


class TestDetectProject:
    def test_python_at_root(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname = 'x'\n")
        result = _detect_project(tmp_path)
        assert result is not None
        assert result[0] == "python"
        assert result[1] == tmp_path

    def test_python_nested(self, tmp_path):
        nested = tmp_path / "app"
        nested.mkdir()
        (nested / "package.json").write_text("{}")
        result = _detect_project(tmp_path)
        assert result is not None
        assert result[0] == "node"
        assert result[1] == nested

    def test_empty_workspace(self, tmp_path):
        assert _detect_project(tmp_path) is None

    def test_skips_venv(self, tmp_path):
        venv = tmp_path / ".venv"
        venv.mkdir()
        (venv / "pyproject.toml").write_text("[project]\nname='x'\n")
        assert _detect_project(tmp_path) is None

    def test_skips_node_modules(self, tmp_path):
        nm = tmp_path / "node_modules"
        nm.mkdir()
        (nm / "package.json").write_text("{}")
        assert _detect_project(tmp_path) is None


class TestScanWorkspace:
    def test_no_project(self, tmp_path):
        assert scan_workspace(tmp_path) is None

    def test_python_project(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        (tmp_path / "src").mkdir()

        mock_lint = ToolResult(tool="ruff", version="0.8.0", available=True, exit_code=0, findings=[])
        mock_sec = ToolResult(tool="bandit", version="1.7.0", available=True, exit_code=0, findings=[])

        with (
            patch("quantitative.scanner.run_ruff", return_value=mock_lint),
            patch("quantitative.scanner.run_bandit", return_value=mock_sec),
        ):
            report = scan_workspace(tmp_path)

        assert report is not None
        assert report.project_type == "python"
        assert report.lint.tool == "ruff"
        assert report.security.tool == "bandit"
        assert report.summary["lint_total"] == 0
        assert report.summary["security_total"] == 0


class TestWriteReport:
    def test_roundtrip(self, tmp_path):
        mock_lint = ToolResult(tool="ruff", version="0.8.0", available=True, exit_code=0, findings=[])
        mock_sec = ToolResult(tool="bandit", version="1.7.0", available=True, exit_code=0, findings=[])

        with (
            patch("quantitative.scanner.run_ruff", return_value=mock_lint),
            patch("quantitative.scanner.run_bandit", return_value=mock_sec),
        ):
            (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
            report = scan_workspace(tmp_path)

        out = tmp_path / "quality-report.yaml"
        write_report(report, out)

        with open(out) as f:
            data = yaml.safe_load(f)

        assert data["project_type"] == "python"
        assert data["lint"]["tool"] == "ruff"
        assert data["security"]["tool"] == "bandit"
        assert data["summary"]["lint_total"] == 0
