"""Tests for the /aidlc prompt rendering.

The intent string is the ONLY channel that reaches the executor — no stage
ingests an authored tech-constraint doc on greenfield, and under --test-run
there is no human to answer the scope/stack questions. So render_v2_prompt
must pin the specs (full vision scope + tech-env stack) into the intent itself,
ahead of the trailing flags the engine parses.
"""

from __future__ import annotations

from cli_harness.prompt_template import render_v2_prompt


class TestRenderV2Prompt:
    def test_leads_with_slash_command_and_intent(self):
        out = render_v2_prompt("Scientific Calculator API", scope="mvp", test_run=True)
        assert out.startswith("/aidlc Scientific Calculator API")

    def test_flags_are_trailing(self):
        # The engine parses flags off the end; pins must come before them.
        out = render_v2_prompt("X", scope="poc", test_run=True, tech_env=True)
        assert out.rstrip().endswith("--scope poc --test-run")
        assert out.index("vision.md") < out.index("--scope")
        assert out.index("tech-env.md") < out.index("--scope")

    def test_always_pins_full_vision_scope(self):
        # Even without a tech-env, the full functional scope is pinned so the
        # executor does not MVP-trim the vision to its title.
        out = render_v2_prompt("X", scope="mvp", test_run=True, tech_env=False)
        assert "COMPLETE functionality specified in vision.md" in out
        assert "tech-env.md" not in out  # no tech-env supplied → no stack pin

    def test_pins_tech_env_as_hard_constraint_when_present(self):
        out = render_v2_prompt("X", scope="mvp", test_run=True, tech_env=True)
        assert "tech-env.md" in out
        assert "HARD CONSTRAINT" in out

    def test_single_line(self):
        # Must submit as one slash command in the PTY/chat transport.
        out = render_v2_prompt("X", scope="mvp", test_run=True, tech_env=True)
        assert "\n" not in out

    def test_test_run_flag_omitted_when_false(self):
        out = render_v2_prompt("X", scope="mvp", test_run=False, tech_env=True)
        assert "--test-run" not in out
        assert out.rstrip().endswith("--scope mvp")


class TestBrownfieldPrompt:
    def test_brownfield_replaces_build_pin_with_modify_clause(self):
        out = render_v2_prompt("Fix base64", scope="feature", brownfield=True)
        assert "EXISTING codebase" in out
        assert "task.md" in out
        assert "smallest correct change" in out
        # Greenfield "build the complete functionality" pin must NOT appear.
        assert "COMPLETE functionality" not in out

    def test_greenfield_unchanged_by_default(self):
        out = render_v2_prompt("Build X", scope="mvp")
        assert "COMPLETE functionality" in out
        assert "EXISTING codebase" not in out

    def test_brownfield_still_pins_tech_env_when_present(self):
        out = render_v2_prompt("Fix X", scope="feature", tech_env=True, brownfield=True)
        assert "EXISTING codebase" in out
        assert "HARD CONSTRAINT" in out

    def test_brownfield_single_line(self):
        out = render_v2_prompt("Fix X", scope="feature", brownfield=True)
        assert "\n" not in out
