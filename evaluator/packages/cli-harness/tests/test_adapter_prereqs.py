"""Prerequisite checks for the CLI adapters — all now require bun."""

from __future__ import annotations

import sys

import cli_harness.adapters.claude_cli as claude_cli_mod
import cli_harness.adapters.codex_cli as codex_mod
import cli_harness.adapters.kiro_cli as kiro_mod
import pytest
from cli_harness.adapters.claude_cli import ClaudeCLIAdapter
from cli_harness.adapters.codex_cli import CodexCLIAdapter
from cli_harness.adapters.kiro_cli import KiroCLIAdapter


class TestKiroPrereqs:
    def test_requires_kiro_cli(self, monkeypatch):
        monkeypatch.setattr(kiro_mod.shutil, "which", lambda cmd: None)
        ok, msg = KiroCLIAdapter().check_prerequisites()
        assert ok is False
        assert "kiro-cli" in msg

    def test_requires_bun_when_kiro_present(self, monkeypatch):
        # kiro-cli present, bun absent → must fail on bun
        monkeypatch.setattr(
            kiro_mod.shutil, "which", lambda cmd: "/usr/bin/kiro-cli" if cmd == "kiro-cli" else None
        )
        ok, msg = KiroCLIAdapter().check_prerequisites()
        assert ok is False
        assert "bun" in msg.lower()

    def test_passes_when_both_present(self, monkeypatch):
        monkeypatch.setattr(kiro_mod.shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
        ok, msg = KiroCLIAdapter().check_prerequisites()
        assert ok is True
        assert "bun" in msg.lower()


@pytest.mark.skipif(sys.platform == "win32", reason="claude-cli PTY adapter is POSIX-only")
class TestClaudeCliPrereqs:
    def test_requires_claude_binary(self, monkeypatch):
        monkeypatch.setattr(claude_cli_mod.shutil, "which", lambda cmd: None)
        ok, msg = ClaudeCLIAdapter().check_prerequisites()
        assert ok is False
        assert "claude" in msg.lower()

    def test_requires_bun_when_claude_present(self, monkeypatch):
        monkeypatch.setattr(
            claude_cli_mod.shutil,
            "which",
            lambda cmd: "/usr/bin/claude" if cmd == "claude" else None,
        )
        ok, msg = ClaudeCLIAdapter().check_prerequisites()
        assert ok is False
        assert "bun" in msg.lower()

    def test_passes_when_all_present(self, monkeypatch):
        monkeypatch.setattr(claude_cli_mod.shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
        ok, msg = ClaudeCLIAdapter().check_prerequisites()
        assert ok is True


class TestCodexCliPrereqs:
    def test_requires_codex_binary(self, monkeypatch):
        monkeypatch.setattr(codex_mod.shutil, "which", lambda cmd: None)
        ok, msg = CodexCLIAdapter().check_prerequisites()
        assert ok is False
        assert "codex" in msg.lower()

    def test_rejects_old_codex_version(self, monkeypatch):
        monkeypatch.setattr(codex_mod.shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
        monkeypatch.setattr(codex_mod, "_codex_version_ok", lambda binary: (False, "0.138.0"))
        ok, msg = CodexCLIAdapter().check_prerequisites()
        assert ok is False
        assert "0.139" in msg

    def test_requires_bun_when_codex_present(self, monkeypatch):
        # codex present + new enough, bun absent → must fail on bun
        monkeypatch.setattr(
            codex_mod.shutil, "which", lambda cmd: "/usr/bin/codex" if cmd == "codex" else None
        )
        monkeypatch.setattr(codex_mod, "_codex_version_ok", lambda binary: (True, "0.140.0"))
        ok, msg = CodexCLIAdapter().check_prerequisites()
        assert ok is False
        assert "bun" in msg.lower()

    def test_passes_when_all_present(self, monkeypatch):
        monkeypatch.setattr(codex_mod.shutil, "which", lambda cmd: f"/usr/bin/{cmd}")
        monkeypatch.setattr(codex_mod, "_codex_version_ok", lambda binary: (True, "0.140.0"))
        ok, msg = CodexCLIAdapter().check_prerequisites()
        assert ok is True
        assert "bun" in msg.lower()


class TestCodexStagesCompleted:
    """The resume-on-idle forward-progress signal counts STAGE_COMPLETED rows."""

    def _docs(self, tmp_path):
        docs = tmp_path / "aidlc-docs"
        docs.mkdir()
        return docs

    def test_zero_when_no_docs(self, tmp_path):
        from cli_harness.adapters.codex_cli import _stages_completed

        assert _stages_completed(tmp_path) == 0

    def test_counts_stage_completed_rows(self, tmp_path):
        from cli_harness.adapters.codex_cli import _stages_completed

        docs = self._docs(tmp_path)
        # find_aidlc_docs requires at least one .md artifact to recognise the dir
        (docs / "state.md").write_text("# state", encoding="utf-8")
        (docs / "audit.md").write_text(
            "**Event**: STAGE_COMPLETED\n...\n**Event**: STAGE_COMPLETED\n"
            "**Event**: STAGE_STARTED\n**Event**: STAGE_COMPLETED\n",
            encoding="utf-8",
        )
        assert _stages_completed(tmp_path) == 3

    def test_zero_when_audit_absent(self, tmp_path):
        from cli_harness.adapters.codex_cli import _stages_completed

        docs = self._docs(tmp_path)
        (docs / "state.md").write_text("# state only, no audit", encoding="utf-8")
        assert _stages_completed(tmp_path) == 0


class TestTrustedAgentsPatch:
    def test_adds_reviewers(self, tmp_path):
        import json

        from cli_harness.adapters.kiro_cli import _patch_trusted_agents

        agents = tmp_path / "agents"
        agents.mkdir()
        (agents / "aidlc.json").write_text(
            json.dumps(
                {
                    "name": "aidlc",
                    "toolsSettings": {
                        "subagent": {
                            "trustedAgents": ["aidlc-developer-agent", "aidlc-architect-agent"]
                        }
                    },
                }
            )
        )
        _patch_trusted_agents(tmp_path)
        trusted = json.loads((agents / "aidlc.json").read_text())["toolsSettings"]["subagent"][
            "trustedAgents"
        ]
        assert "aidlc-product-lead-agent" in trusted
        assert "aidlc-architecture-reviewer-agent" in trusted

    def test_idempotent_and_no_dupes(self, tmp_path):
        import json

        from cli_harness.adapters.kiro_cli import _patch_trusted_agents

        agents = tmp_path / "agents"
        agents.mkdir()
        (agents / "aidlc.json").write_text(
            json.dumps({"toolsSettings": {"subagent": {"trustedAgents": []}}})
        )
        _patch_trusted_agents(tmp_path)
        _patch_trusted_agents(tmp_path)
        trusted = json.loads((agents / "aidlc.json").read_text())["toolsSettings"]["subagent"][
            "trustedAgents"
        ]
        assert trusted.count("aidlc-product-lead-agent") == 1

    def test_missing_file_noops(self, tmp_path):
        from cli_harness.adapters.kiro_cli import _patch_trusted_agents

        _patch_trusted_agents(tmp_path)  # no agents/aidlc.json — must not raise
