"""Tests for the run_command tool — sandboxing, timeout, and output."""

from __future__ import annotations

import textwrap
from pathlib import Path

from aidlc_runner.config import ExecutionConfig, RunnerConfig, load_config
from aidlc_runner.tools.run_command import make_run_command


def _call(run_cmd, command: str, working_directory: str = "workspace") -> str:
    """Call the run_command tool and return the string result."""
    return run_cmd(command=command, working_directory=working_directory)


class TestRunCommandSandbox:
    def test_runs_in_workspace(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        (ws / "hello.txt").write_text("hello world")

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "cat hello.txt", "workspace")
        assert "hello world" in result
        assert "[exit code: 0]" in result

    def test_default_working_directory_is_workspace(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()
        (ws / "marker.txt").write_text("found")

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "cat marker.txt")
        assert "found" in result

    def test_path_traversal_denied(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "ls", "../../")
        assert "Path traversal denied" in result

    def test_nonexistent_working_directory(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "ls", "nonexistent")
        assert "not found" in result

    def test_can_write_files_in_workspace(self, tmp_path: Path):
        ws = tmp_path / "workspace"
        ws.mkdir()

        run_cmd = make_run_command(tmp_path)
        _call(run_cmd, "python3 -c \"from pathlib import Path; Path('output.txt').write_text('test content')\"")
        assert (ws / "output.txt").exists()
        assert "test content" in (ws / "output.txt").read_text()


class TestRunCommandTimeout:
    def test_timeout_returns_error(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path, timeout=1)
        result = _call(run_cmd, "sleep 30")
        assert "timed out after 1s" in result


class TestRunCommandOutput:
    def test_exit_code_included(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "python3 -c \"import sys; sys.exit(42)\"")
        assert "[exit code: 42]" in result

    def test_stderr_captured(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "python3 -c \"import sys; sys.stderr.write('err msg\\n')\"")
        assert "err msg" in result

    def test_long_output_truncated(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "python3 -c \"print('x' * 60000)\"")
        assert "truncated" in result
        # Should be capped at around 50k + header
        assert len(result) < 55000

    def test_command_not_found(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "nonexistent_command_xyz")
        # shell=False raises OSError ([error:]), shell=True returns [exit code: 127]
        is_error = "[error:" in result
        is_nonzero_exit = "[exit code:" in result and "[exit code: 0]" not in result
        assert is_error or is_nonzero_exit


class TestRunCommandEdgeCases:
    def test_empty_command(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "")
        assert "empty command" in result

    def test_whitespace_only_command(self, tmp_path: Path):
        (tmp_path / "workspace").mkdir()

        run_cmd = make_run_command(tmp_path)
        result = _call(run_cmd, "   ")
        assert "empty command" in result


class TestExecutionConfig:
    def test_defaults(self):
        config = ExecutionConfig()
        assert config.enabled is True
        assert config.command_timeout == 120
        assert config.post_run_tests is True
        assert config.post_run_timeout == 300

    def test_runner_config_includes_execution(self):
        config = RunnerConfig()
        assert config.execution.enabled is True
        assert config.execution.command_timeout == 120

    def test_yaml_loading(self, tmp_path: Path):
        yaml_content = textwrap.dedent("""\
            execution:
              enabled: false
              command_timeout: 60
              post_run_tests: false
              post_run_timeout: 120
        """)
        config_file = tmp_path / "config.yaml"
        config_file.write_text(yaml_content)

        config = load_config(config_path=config_file)
        assert config.execution.enabled is False
        assert config.execution.command_timeout == 60
        assert config.execution.post_run_tests is False
        assert config.execution.post_run_timeout == 120

    def test_no_exec_cli_flag(self):
        from aidlc_runner.cli import build_parser, _build_cli_overrides

        parser = build_parser()
        args = parser.parse_args(["--vision", "v.md", "--no-exec"])
        overrides = _build_cli_overrides(args)
        assert overrides["execution"]["enabled"] is False

    def test_no_post_tests_cli_flag(self):
        from aidlc_runner.cli import build_parser, _build_cli_overrides

        parser = build_parser()
        args = parser.parse_args(["--vision", "v.md", "--no-post-tests"])
        overrides = _build_cli_overrides(args)
        assert overrides["execution"]["post_run_tests"] is False
