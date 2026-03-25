"""Tests for two-input-document support (vision + tech-env)."""

from __future__ import annotations

from pathlib import Path

import yaml

from aidlc_runner.agents.simulator import SIMULATOR_SYSTEM_PROMPT_TEMPLATE, create_simulator
from aidlc_runner.cli import build_parser
from aidlc_runner.runner import write_run_meta
from aidlc_runner.config import RunnerConfig


# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------


class TestCliTechEnvArgument:
    def test_tech_env_accepted(self, tmp_path: Path):
        vision = tmp_path / "vision.md"
        vision.write_text("# Vision")
        tech_env = tmp_path / "tech-env.md"
        tech_env.write_text("# Tech Env")

        parser = build_parser()
        args = parser.parse_args(["--vision", str(vision), "--tech-env", str(tech_env)])

        assert args.tech_env == tech_env
        assert args.vision == vision

    def test_tech_env_defaults_to_none(self, tmp_path: Path):
        vision = tmp_path / "vision.md"
        vision.write_text("# Vision")

        parser = build_parser()
        args = parser.parse_args(["--vision", str(vision)])

        assert args.tech_env is None

    def test_tech_env_validation_in_main(self, tmp_path: Path):
        """main() should exit with error when --tech-env file doesn't exist."""
        import sys

        vision = tmp_path / "vision.md"
        vision.write_text("# Vision")

        from aidlc_runner.cli import main

        try:
            main(["--vision", str(vision), "--tech-env", str(tmp_path / "missing.md")])
            assert False, "Should have called sys.exit"
        except SystemExit as e:
            assert e.code == 1


# ---------------------------------------------------------------------------
# Runner: write_run_meta records tech-env path
# ---------------------------------------------------------------------------


class TestRunMetaTechEnv:
    def test_meta_includes_tech_env_path(self, tmp_path: Path):
        vision = tmp_path / "vision.md"
        vision.write_text("# Vision")
        tech_env = tmp_path / "tech-env.md"
        tech_env.write_text("# Tech Env")

        run_folder = tmp_path / "run"
        run_folder.mkdir()

        write_run_meta(run_folder, RunnerConfig(), vision, tech_env_path=tech_env)

        meta_path = run_folder / "run-meta.yaml"
        with open(meta_path) as f:
            meta = yaml.safe_load(f)

        assert meta["tech_env_file"] == str(tech_env.resolve())

    def test_meta_tech_env_null_when_omitted(self, tmp_path: Path):
        vision = tmp_path / "vision.md"
        vision.write_text("# Vision")

        run_folder = tmp_path / "run"
        run_folder.mkdir()

        write_run_meta(run_folder, RunnerConfig(), vision)

        meta_path = run_folder / "run-meta.yaml"
        with open(meta_path) as f:
            meta = yaml.safe_load(f)

        assert meta["tech_env_file"] is None


# ---------------------------------------------------------------------------
# Simulator: tech-env injection into system prompt
# ---------------------------------------------------------------------------


class TestSimulatorTechEnvPrompt:
    def test_template_has_tech_env_placeholder(self):
        assert "{tech_env_section}" in SIMULATOR_SYSTEM_PROMPT_TEMPLATE

    def test_prompt_includes_tech_env_when_provided(self):
        result = SIMULATOR_SYSTEM_PROMPT_TEMPLATE.format(
            vision_content="Build a calculator",
            tech_env_section="\n## The technical environment\n\nUse Python 3.12\n",
        )
        assert "The technical environment" in result
        assert "Use Python 3.12" in result
        assert "Build a calculator" in result

    def test_prompt_excludes_tech_env_when_empty(self):
        result = SIMULATOR_SYSTEM_PROMPT_TEMPLATE.format(
            vision_content="Build a calculator",
            tech_env_section="",
        )
        assert "technical environment" not in result.lower().split("how you work")[0]
        assert "Build a calculator" in result

    def test_prompt_backward_compatible_with_no_tech_env(self):
        """When tech_env_section is empty, prompt should be identical to old behavior."""
        result = SIMULATOR_SYSTEM_PROMPT_TEMPLATE.format(
            vision_content="My vision doc",
            tech_env_section="",
        )
        # The vision content is still present
        assert "My vision doc" in result
        # "How you work" section immediately follows the vision closing ---
        # No extra blank sections between vision and how-you-work
        assert "---\n\n## How you work" in result


# ---------------------------------------------------------------------------
# Initial prompt: tech-env mention is conditional
# ---------------------------------------------------------------------------


class TestInitialPromptTechEnv:
    @staticmethod
    def _build_initial_prompt(tech_env_content: str | None) -> str:
        """Reproduce the initial prompt logic from runner.py."""
        initial_prompt = (
            "Begin the AIDLC workflow and execute it TO COMPLETION through ALL phases. "
            "The project vision is available at vision.md in the run folder. "
        )
        if tech_env_content is not None:
            initial_prompt += (
                "The technical environment document is available at tech-env.md in the run folder. "
                "It defines the required languages, frameworks, cloud services, security controls, "
                "testing standards, and prohibited technologies. Follow it as a binding reference "
                "during all Construction stages. "
            )
        initial_prompt += (
            "Start by loading the core workflow rules and the process overview, then "
            "execute every stage of the Inception phase followed by every stage of the "
            "Construction phase. The workspace directory is 'workspace/' (currently empty — "
            "this is a greenfield project). You MUST generate all application code in "
            "workspace/ before the workflow is complete. Do NOT stop after requirements — "
            "continue through application design, code generation, and build-and-test."
        )
        return initial_prompt

    def test_prompt_mentions_tech_env_when_present(self):
        prompt = self._build_initial_prompt("# Tech Env Content")
        assert "tech-env.md" in prompt
        assert "binding reference" in prompt

    def test_prompt_omits_tech_env_when_absent(self):
        prompt = self._build_initial_prompt(None)
        assert "tech-env.md" not in prompt
        assert "technical environment" not in prompt.lower()

    def test_prompt_always_mentions_vision(self):
        assert "vision.md" in self._build_initial_prompt(None)
        assert "vision.md" in self._build_initial_prompt("some content")
