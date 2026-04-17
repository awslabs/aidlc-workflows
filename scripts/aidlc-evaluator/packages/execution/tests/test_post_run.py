"""Tests for post-run evaluation — project detection, output parsing, result files."""

from __future__ import annotations

from pathlib import Path

import yaml

from aidlc_runner.config import RunnerConfig
from aidlc_runner.post_run import (
    _parse_cargo,
    _parse_go,
    _parse_jest,
    _parse_pytest,
    _truncate,
    detect_project,
    parse_test_output,
    run_post_evaluation,
)


# ---------------------------------------------------------------------------
# Project detection
# ---------------------------------------------------------------------------


class TestDetectProject:
    def test_pyproject_toml(self, tmp_path: Path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "python"
        assert "uv" in info.install_cmd
        assert "pytest" in info.test_cmd
        assert info.project_root == tmp_path

    def test_package_json(self, tmp_path: Path):
        (tmp_path / "package.json").write_text('{"name": "x"}')
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "node"
        assert "npm install" in info.install_cmd

    def test_cargo_toml(self, tmp_path: Path):
        (tmp_path / "Cargo.toml").write_text("[package]\nname='x'\n")
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "rust"

    def test_go_mod(self, tmp_path: Path):
        (tmp_path / "go.mod").write_text("module example.com/x\n")
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "go"

    def test_setup_py(self, tmp_path: Path):
        (tmp_path / "setup.py").write_text("from setuptools import setup\nsetup()")
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "python-legacy"

    def test_no_markers(self, tmp_path: Path):
        (tmp_path / "README.md").write_text("# Hello")
        info = detect_project(tmp_path)
        assert info is None

    def test_priority_pyproject_over_package_json(self, tmp_path: Path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        (tmp_path / "package.json").write_text('{"name": "x"}')
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "python"

    def test_empty_directory(self, tmp_path: Path):
        info = detect_project(tmp_path)
        assert info is None

    def test_subdirectory_detection(self, tmp_path: Path):
        """Detect project in workspace/my-app/ when workspace/ has no markers."""
        subdir = tmp_path / "my-app"
        subdir.mkdir()
        (subdir / "pyproject.toml").write_text("[project]\nname='x'\n")
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "python"
        assert info.project_root == subdir

    def test_subdirectory_not_checked_when_root_has_marker(self, tmp_path: Path):
        """Root marker takes priority over subdirectory marker."""
        (tmp_path / "package.json").write_text('{"name": "root"}')
        subdir = tmp_path / "sub"
        subdir.mkdir()
        (subdir / "pyproject.toml").write_text("[project]\nname='sub'\n")
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "node"
        assert info.project_root == tmp_path

    def test_hidden_subdirectories_skipped(self, tmp_path: Path):
        """Dot-prefixed directories like .cache should not be searched."""
        hidden = tmp_path / ".cache"
        hidden.mkdir()
        (hidden / "pyproject.toml").write_text("[project]\nname='x'\n")
        info = detect_project(tmp_path)
        assert info is None

    def test_vendor_directories_skipped(self, tmp_path: Path):
        """Vendor dirs like .venv and node_modules should not be searched."""
        for vendor in (".venv", "node_modules", "__pycache__"):
            d = tmp_path / vendor
            d.mkdir(exist_ok=True)
            (d / "pyproject.toml").write_text("[project]\nname='x'\n")
        info = detect_project(tmp_path)
        assert info is None

    def test_deeply_nested_project(self, tmp_path: Path):
        """Detect project inside workspace/sci-calc/app/ (2 levels deep)."""
        nested = tmp_path / "sci-calc" / "app"
        nested.mkdir(parents=True)
        (nested / "pyproject.toml").write_text("[project]\nname='x'\n")
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_type == "python"
        assert info.project_root == nested

    def test_max_depth_exceeded(self, tmp_path: Path):
        """Projects beyond _MAX_SEARCH_DEPTH levels are not detected."""
        deep = tmp_path / "a" / "b" / "c" / "d"
        deep.mkdir(parents=True)
        (deep / "pyproject.toml").write_text("[project]\nname='x'\n")
        info = detect_project(tmp_path)
        assert info is None

    def test_nonexistent_workspace(self, tmp_path: Path):
        info = detect_project(tmp_path / "does-not-exist")
        assert info is None

    def test_shallowest_project_preferred(self, tmp_path: Path):
        """BFS should find the shallowest project first."""
        shallow = tmp_path / "app"
        shallow.mkdir()
        (shallow / "package.json").write_text('{"name":"shallow"}')
        deep = tmp_path / "deep" / "nested"
        deep.mkdir(parents=True)
        (deep / "pyproject.toml").write_text("[project]\nname='deep'\n")
        info = detect_project(tmp_path)
        assert info is not None
        assert info.project_root == shallow


# ---------------------------------------------------------------------------
# Test output parsers
# ---------------------------------------------------------------------------


class TestParsePytest:
    def test_all_passed(self):
        output = "========================= 5 passed in 1.23s ========================="
        result = _parse_pytest(output)
        assert result["passed"] == 5
        assert result["failed"] is None

    def test_mixed_results(self):
        output = "============ 3 passed, 2 failed, 1 error in 4.56s ============"
        result = _parse_pytest(output)
        assert result["passed"] == 3
        assert result["failed"] == 2
        assert result["errors"] == 1

    def test_with_skipped(self):
        output = "========= 10 passed, 1 skipped, 1 warning in 2.00s ========="
        result = _parse_pytest(output)
        assert result["passed"] == 10
        assert result["skipped"] == 1

    def test_no_summary(self):
        output = "some random output\nno test summary here"
        result = _parse_pytest(output)
        assert result["passed"] is None

    def test_short_form(self):
        output = "5 passed"
        result = _parse_pytest(output)
        assert result["passed"] == 5


class TestParseJest:
    def test_jest_summary(self):
        output = "Tests:       2 failed, 5 passed, 7 total"
        result = _parse_jest(output)
        assert result["passed"] == 5
        assert result["failed"] == 2

    def test_jest_all_passed(self):
        output = "Tests:       10 passed, 10 total"
        result = _parse_jest(output)
        assert result["passed"] == 10
        assert result["failed"] is None

    def test_vitest_format(self):
        output = "Tests  5 passed | 2 failed (7)"
        result = _parse_jest(output)
        assert result["passed"] == 5
        assert result["failed"] == 2

    def test_no_summary(self):
        output = "running tests..."
        result = _parse_jest(output)
        assert result["passed"] is None


class TestParseCargo:
    def test_ok_result(self):
        output = "test result: ok. 10 passed; 0 failed; 2 ignored; 0 measured"
        result = _parse_cargo(output)
        assert result["passed"] == 10
        assert result["failed"] == 0
        assert result["skipped"] == 2

    def test_failed_result(self):
        output = "test result: FAILED. 8 passed; 2 failed; 0 ignored; 0 measured"
        result = _parse_cargo(output)
        assert result["passed"] == 8
        assert result["failed"] == 2

    def test_no_summary(self):
        output = "compiling..."
        result = _parse_cargo(output)
        assert result["passed"] is None


class TestParseGo:
    def test_mixed_results(self):
        output = (
            "--- PASS: TestAdd (0.00s)\n"
            "--- PASS: TestSub (0.00s)\n"
            "--- FAIL: TestDiv (0.01s)\n"
        )
        result = _parse_go(output)
        assert result["passed"] == 2
        assert result["failed"] == 1

    def test_all_pass(self):
        output = "--- PASS: TestOne (0.00s)\n--- PASS: TestTwo (0.00s)\n"
        result = _parse_go(output)
        assert result["passed"] == 2
        assert result["failed"] == 0

    def test_no_results(self):
        output = "building..."
        result = _parse_go(output)
        assert result["passed"] is None


class TestParseTestOutput:
    def test_total_computed(self):
        result = parse_test_output("python", "===== 3 passed, 1 failed in 1.0s =====")
        assert result["total"] == 4

    def test_unknown_project_type(self):
        result = parse_test_output("unknown", "some output")
        assert result["passed"] is None
        assert result["total"] is None


# ---------------------------------------------------------------------------
# Output truncation
# ---------------------------------------------------------------------------


class TestTruncate:
    def test_short_text_unchanged(self):
        assert _truncate("hello", 100) == "hello"

    def test_long_text_truncated(self):
        text = "x" * 20000
        result = _truncate(text, 10000)
        assert len(result) < 11000
        assert "truncated" in result

    def test_exact_limit(self):
        text = "x" * 10000
        assert _truncate(text, 10000) == text


# ---------------------------------------------------------------------------
# Full run_post_evaluation integration
# ---------------------------------------------------------------------------


class TestRunPostEvaluation:
    def test_no_workspace(self, tmp_path: Path):
        # No workspace/ directory at all
        config = RunnerConfig()
        result_path = run_post_evaluation(tmp_path, config)
        assert result_path is not None
        with open(result_path) as f:
            data = yaml.safe_load(f)
        assert data["status"] == "skipped"

    def test_empty_workspace(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()
        config = RunnerConfig()
        result_path = run_post_evaluation(tmp_path, config)
        assert result_path is not None
        with open(result_path) as f:
            data = yaml.safe_load(f)
        assert data["status"] == "skipped"
        assert "no recognised" in data["reason"]

    def test_python_project_detected(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        # Create a minimal Python project that will fail install but still produce output
        (ws / "pyproject.toml").write_text(
            '[project]\nname = "test-proj"\nversion = "0.1.0"\n'
        )

        config = RunnerConfig()
        result_path = run_post_evaluation(tmp_path, config)
        assert result_path == tmp_path / "test-results.yaml"
        assert result_path.exists()

        with open(result_path) as f:
            data = yaml.safe_load(f)
        assert data["project_type"] == "python"
        assert "install" in data
        assert "test" in data
        assert "command" in data["install"]
        assert "command" in data["test"]

    def test_result_yaml_schema(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        (ws / "pyproject.toml").write_text(
            '[project]\nname = "test-proj"\nversion = "0.1.0"\n'
        )

        config = RunnerConfig()
        result_path = run_post_evaluation(tmp_path, config)

        with open(result_path) as f:
            data = yaml.safe_load(f)

        # Verify required top-level keys
        assert "status" in data
        assert "project_type" in data
        assert "project_root" in data
        assert "install" in data
        assert "test" in data

        # Verify install structure
        assert "command" in data["install"]
        assert "exit_code" in data["install"] or data["install"].get("timed_out")
        assert "output" in data["install"]

        # Verify test structure
        assert "command" in data["test"]
        assert "parsed_results" in data["test"]
