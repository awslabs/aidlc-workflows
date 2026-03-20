"""Tests for analyzer JSON parsers.

These tests mock subprocess.run to avoid requiring ruff/bandit/eslint
to be installed, and verify the parsing logic handles real tool output.
"""

import json
from pathlib import Path
from unittest.mock import patch, MagicMock

from quantitative.analyzers import run_ruff, run_bandit, run_eslint, run_npm_audit


def _mock_run(stdout="", stderr="", returncode=0):
    result = MagicMock()
    result.stdout = stdout
    result.stderr = stderr
    result.returncode = returncode
    return result


# ---------------------------------------------------------------------------
# ruff
# ---------------------------------------------------------------------------

class TestRuff:
    def test_not_installed(self):
        with patch("quantitative.analyzers.shutil.which", return_value=None):
            result = run_ruff(Path("."))
        assert not result.available
        assert "ruff not found" in result.error

    def test_clean_output(self):
        with (
            patch("quantitative.analyzers.shutil.which", return_value="/usr/bin/ruff"),
            patch("quantitative.analyzers._tool_version", return_value="0.8.0"),
            patch("quantitative.analyzers._run_tool", return_value=_mock_run(stdout="[]")),
        ):
            result = run_ruff(Path("."))
        assert result.available
        assert len(result.findings) == 0

    def test_findings_parsed(self):
        items = [
            {
                "filename": "app.py",
                "location": {"row": 10, "column": 5},
                "code": "E501",
                "message": "Line too long",
            },
            {
                "filename": "utils.py",
                "location": {"row": 3, "column": 1},
                "code": "W291",
                "message": "Trailing whitespace",
            },
        ]
        with (
            patch("quantitative.analyzers.shutil.which", return_value="/usr/bin/ruff"),
            patch("quantitative.analyzers._tool_version", return_value="0.8.0"),
            patch("quantitative.analyzers._run_tool",
                  return_value=_mock_run(stdout=json.dumps(items), returncode=1)),
        ):
            result = run_ruff(Path("."))
        assert len(result.findings) == 2
        assert result.findings[0].code == "E501"
        assert result.findings[0].severity == "error"
        assert result.findings[1].code == "W291"
        assert result.findings[1].severity == "warning"


# ---------------------------------------------------------------------------
# bandit
# ---------------------------------------------------------------------------

class TestBandit:
    def test_not_installed(self):
        with patch("quantitative.analyzers.shutil.which", return_value=None):
            result = run_bandit(Path("."))
        assert not result.available

    def test_clean_output(self):
        with (
            patch("quantitative.analyzers.shutil.which", return_value="/usr/bin/bandit"),
            patch("quantitative.analyzers._tool_version", return_value="1.7.0"),
            patch("quantitative.analyzers._run_tool",
                  return_value=_mock_run(stdout=json.dumps({"results": []}))),
        ):
            result = run_bandit(Path("."))
        assert result.available
        assert len(result.findings) == 0

    def test_findings_parsed(self):
        data = {
            "results": [
                {
                    "filename": "app.py",
                    "line_number": 42,
                    "test_id": "B608",
                    "issue_text": "Possible SQL injection",
                    "issue_severity": "HIGH",
                    "issue_confidence": "MEDIUM",
                    "issue_cwe": {"id": 89, "link": "https://cwe.mitre.org/data/definitions/89.html"},
                },
            ]
        }
        with (
            patch("quantitative.analyzers.shutil.which", return_value="/usr/bin/bandit"),
            patch("quantitative.analyzers._tool_version", return_value="1.7.0"),
            patch("quantitative.analyzers._run_tool",
                  return_value=_mock_run(stdout=json.dumps(data), returncode=1)),
        ):
            result = run_bandit(Path("."))
        assert len(result.findings) == 1
        f = result.findings[0]
        assert f.code == "B608"
        assert f.severity == "high"
        assert f.cwe == "CWE-89"


# ---------------------------------------------------------------------------
# eslint
# ---------------------------------------------------------------------------

class TestEslint:
    def test_not_installed(self):
        with patch("quantitative.analyzers.shutil.which", return_value=None):
            result = run_eslint(Path("."))
        assert not result.available

    def test_findings_parsed(self):
        items = [
            {
                "filePath": "/app/index.js",
                "messages": [
                    {"severity": 2, "ruleId": "no-unused-vars", "message": "'x' is unused", "line": 5, "column": 1},
                    {"severity": 1, "ruleId": "semi", "message": "Missing semicolon", "line": 10, "column": 20},
                ],
            }
        ]
        with (
            patch("quantitative.analyzers.shutil.which", return_value="/usr/bin/eslint"),
            patch("quantitative.analyzers._tool_version", return_value="8.0.0"),
            patch("quantitative.analyzers._run_tool",
                  return_value=_mock_run(stdout=json.dumps(items), returncode=1)),
        ):
            result = run_eslint(Path("."))
        assert len(result.findings) == 2
        assert result.findings[0].severity == "error"
        assert result.findings[1].severity == "warning"


# ---------------------------------------------------------------------------
# npm audit
# ---------------------------------------------------------------------------

class TestNpmAudit:
    def test_not_installed(self):
        with patch("quantitative.analyzers.shutil.which", return_value=None):
            result = run_npm_audit(Path("."))
        assert not result.available

    def test_no_lockfile(self, tmp_path):
        with (
            patch("quantitative.analyzers.shutil.which", return_value="/usr/bin/npm"),
            patch("quantitative.analyzers._tool_version", return_value="10.0.0"),
        ):
            result = run_npm_audit(tmp_path)
        assert result.available
        assert result.error == "no package-lock.json found"
