from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

from aidlc_interactive.agents import agent_adapters
from aidlc_interactive.cli import main
from aidlc_interactive.models import ResultStatus
from aidlc_interactive.onboarding import apply_setup, setup_plan


class CliAndOnboardingTests(unittest.TestCase):
    def test_detect_json_has_all_mvp_agents(self) -> None:
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = main(["detect", "--json"])
        value = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            {agent["agent"] for agent in value["agents"]},
            {"kiro", "claude-code", "codex"},
        )

    def test_setup_without_confirmation_is_dry_in_non_tty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            output = io.StringIO()
            with patch("sys.stdin.isatty", return_value=False), redirect_stdout(output):
                exit_code = main(
                    [
                        "setup",
                        "--workspace",
                        str(workspace),
                        "--agents",
                        "kiro",
                        "--json",
                    ]
                )
            self.assertEqual(exit_code, 2)
            self.assertTrue(json.loads(output.getvalue())["confirmation_required"])

    def test_setup_plan_names_all_selected_targets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plan = setup_plan(root, ["kiro", "claude-code", "codex"], "plannotator", home=root)
            paths = {item["path"] for item in plan["writes"] if item["kind"] == "skill"}
            adapters = agent_adapters(root)
            self.assertEqual(paths, {str(adapter.skill_path) for adapter in adapters.values()})
            self.assertFalse(plan["provider_installation"]["automatic"])

    def test_skill_contains_fallback_and_state_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            adapter = agent_adapters(Path(directory))["kiro"]
            skill = adapter.render_skill(Path(directory))
            self.assertIn("fallback_required", skill)
            self.assertIn("aidlc-state.md", skill)
            self.assertIn("exact path", skill)
            self.assertIn('--workspace "."', skill)
            self.assertNotIn("--allow-non-tty", skill)
            self.assertNotIn(str(Path(directory)), skill)

    def test_confirmed_setup_is_idempotent_and_scoped_to_managed_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            workspace.mkdir()
            config_path = root / "config" / "interaction.yaml"
            with patch("aidlc_interactive.onboarding.global_config_path", return_value=config_path):
                first = apply_setup(workspace, ["kiro"], "plannotator", home=root)
                second = apply_setup(workspace, ["kiro"], "plannotator", home=root)
            skill = agent_adapters(root)["kiro"].skill_path
            self.assertTrue(first["applied"])
            self.assertTrue(second["applied"])
            self.assertTrue(config_path.is_file())
            self.assertTrue(skill.is_file())
            self.assertTrue(config_path.with_name("install-manifest.json").is_file())

    def test_ci_forces_fallback_even_when_non_tty_is_explicitly_allowed(self) -> None:
        result = Mock(status=ResultStatus.FALLBACK_REQUIRED)
        result.to_dict.return_value = {"status": "fallback_required"}
        output = io.StringIO()
        with (
            patch.dict(os.environ, {"CI": "1"}, clear=False),
            patch("aidlc_interactive.cli.interact", return_value=result) as invoke,
            redirect_stdout(output),
        ):
            exit_code = main(
                [
                    "review",
                    "--workspace",
                    ".",
                    "--artifact",
                    "aidlc-docs/plan.md",
                    "--allow-non-tty",
                    "--json",
                ]
            )
        self.assertEqual(exit_code, 2)
        self.assertFalse(invoke.call_args.kwargs["interactive_session"])


if __name__ == "__main__":
    unittest.main()
