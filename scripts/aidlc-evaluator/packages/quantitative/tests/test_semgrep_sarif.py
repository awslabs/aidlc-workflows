"""The scanner gate must honor SARIF severity defaults and unreadable reports."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("jq") is None,
    reason="The Ubuntu scanner workflow requires bash and jq",
)


def _run_gate(tmp_path: Path, report: str | None) -> tuple[int, str]:
    workflow_path = (
        Path(__file__).resolve().parents[5] / ".github/workflows/security-scanners.yml"
    )
    workflow = yaml.safe_load(workflow_path.read_text())
    step = next(
        step
        for step in workflow["jobs"]["semgrep"]["steps"]
        if step.get("name") == "Check for ERROR severity findings"
    )
    output = tmp_path / "github-output"
    if report is not None:
        (tmp_path / "semgrep-report_sarif.json").write_text(report)
    result = subprocess.run(
        ["bash", "-e", "-o", "pipefail", "-c", step["run"]],
        cwd=tmp_path,
        env={**os.environ, "GITHUB_OUTPUT": str(output)},
        capture_output=True,
        text=True,
    )
    return result.returncode, output.read_text() if output.exists() else ""


def _run(result_level: str | None, rule_level: str | None) -> dict:
    rule = {"id": "security-rule"}
    if rule_level is not None:
        rule["defaultConfiguration"] = {"level": rule_level}
    result = {"ruleId": "security-rule"}
    if result_level is not None:
        result["level"] = result_level
    return {"tool": {"driver": {"rules": [rule]}}, "results": [result]}


@pytest.mark.parametrize(
    ("result_level", "rule_level", "expected"),
    [
        (None, "error", 1),
        ("error", "warning", 1),
        ("warning", "error", 0),
        (None, "warning", 0),
        (None, None, 0),
    ],
)
def test_result_severity_and_rule_defaults(
    tmp_path: Path, result_level: str | None, rule_level: str | None, expected: int
) -> None:
    report = json.dumps({"runs": [_run(result_level, rule_level)]})
    status, output = _run_gate(tmp_path, report)
    assert status == 0
    assert output == f"exit_code={expected}\n"


def test_clean_report(tmp_path: Path) -> None:
    run = _run(None, "error")
    run["results"] = []
    status, output = _run_gate(tmp_path, json.dumps({"runs": [run]}))
    assert status == 0
    assert output == "exit_code=0\n"


def test_error_in_later_run(tmp_path: Path) -> None:
    report = json.dumps({"runs": [_run(None, "warning"), _run(None, "error")]})
    status, output = _run_gate(tmp_path, report)
    assert status == 0
    assert output == "exit_code=1\n"


@pytest.mark.parametrize("report", [None, "{invalid json"])
def test_unreadable_report_cannot_pass(tmp_path: Path, report: str | None) -> None:
    status, output = _run_gate(tmp_path, report)
    assert status != 0
    assert output == ""
