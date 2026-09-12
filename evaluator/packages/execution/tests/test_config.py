"""Tests for configuration loading."""

from __future__ import annotations

import textwrap
from pathlib import Path

from aidlc_runner.config import RunnerConfig, load_config


class TestRunnerConfigDefaults:
    def test_default_aws_profile(self):
        config = RunnerConfig()
        assert config.aws.profile is None

    def test_default_aws_region(self):
        config = RunnerConfig()
        assert config.aws.region is None

    def test_default_executor_model(self):
        config = RunnerConfig()
        assert config.models.executor.provider == "bedrock"
        assert "opus" in config.models.executor.model_id

    def test_default_simulator_model(self):
        config = RunnerConfig()
        assert config.models.simulator.provider == "bedrock"
        assert "opus" in config.models.simulator.model_id

    def test_default_swarm_settings(self):
        config = RunnerConfig()
        assert config.swarm.max_handoffs == 200
        assert config.swarm.max_iterations == 200
        assert config.swarm.execution_timeout == 14400.0
        assert config.swarm.node_timeout == 3600.0


class TestLoadConfig:
    def test_load_without_file_returns_defaults(self):
        config = load_config()
        assert config.aws.profile is None
        assert config.runs.output_dir == "./runs"

    def test_load_from_yaml(self, tmp_path: Path):
        yaml_content = textwrap.dedent("""\
            aws:
              profile: "custom-profile"
              region: "eu-west-1"
            runs:
              output_dir: "/tmp/custom-runs"
        """)
        config_file = tmp_path / "test-config.yaml"
        config_file.write_text(yaml_content)

        config = load_config(config_path=config_file)
        assert config.aws.profile == "custom-profile"
        assert config.aws.region == "eu-west-1"
        assert config.runs.output_dir == "/tmp/custom-runs"  # nosec B108 - Test assertion, not creating temp files
        # Unchanged defaults
        assert config.swarm.max_handoffs == 200

    def test_cli_overrides_applied(self):
        overrides = {
            "aws": {"profile": "override-profile"},
            "models": {"executor": {"model_id": "some-other-model"}},
        }
        config = load_config(cli_overrides=overrides)
        assert config.aws.profile == "override-profile"
        assert config.models.executor.model_id == "some-other-model"
        # Unaffected fields
        assert config.aws.region is None
        assert config.models.simulator.model_id != "some-other-model"

    def test_cli_overrides_on_top_of_yaml(self, tmp_path: Path):
        yaml_content = textwrap.dedent("""\
            aws:
              profile: "yaml-profile"
              region: "ap-southeast-1"
        """)
        config_file = tmp_path / "config.yaml"
        config_file.write_text(yaml_content)

        overrides = {"aws": {"profile": "cli-wins"}}
        config = load_config(config_path=config_file, cli_overrides=overrides)
        assert config.aws.profile == "cli-wins"
        assert config.aws.region == "ap-southeast-1"

    def test_nonexistent_config_file_returns_defaults(self):
        config = load_config(config_path="/nonexistent/path.yaml")
        assert config.aws.profile is None

    def test_rules_source_override(self):
        overrides = {
            "aidlc": {
                "rules_source": "local",
                "rules_local_path": "/some/path",
            },
        }
        config = load_config(cli_overrides=overrides)
        assert config.aidlc.rules_source == "local"
        assert config.aidlc.rules_local_path == "/some/path"
