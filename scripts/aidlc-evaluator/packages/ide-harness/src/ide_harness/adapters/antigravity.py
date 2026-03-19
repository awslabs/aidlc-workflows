"""Antigravity adapter — AI coding assistant."""

from __future__ import annotations

from ide_harness.adapter import AdapterConfig, AdapterResult, IDEAdapter


class AntigravityAdapter(IDEAdapter):
    """Adapter for Antigravity AI coding assistant.

    TODO: Research Antigravity's automation capabilities:
    - CLI or API availability
    - Extension or standalone application
    - Scripted interaction support
    """

    @property
    def name(self) -> str:
        return "Antigravity"

    def check_prerequisites(self) -> tuple[bool, str]:
        return False, "Antigravity adapter requires manual configuration. See docs/ide-automation-research.md."

    def run(self, config: AdapterConfig) -> AdapterResult:
        return AdapterResult(
            success=False,
            output_dir=config.output_dir,
            error="Antigravity adapter not yet implemented",
        )
