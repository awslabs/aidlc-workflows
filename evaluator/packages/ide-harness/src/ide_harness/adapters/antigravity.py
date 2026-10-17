"""Antigravity adapter — AI coding assistant.

EXPERIMENTAL / work in progress. This IDE adapter is not production-ready;
the automation path is incomplete. For proven execution use the CLI harness
(claude-code, kiro-cli) or the Strands execution path.
"""

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
        return (
            False,
            "Antigravity adapter requires manual configuration. See docs/ide-automation-research.md.",  # noqa: E501
        )

    def run(self, config: AdapterConfig) -> AdapterResult:
        return AdapterResult(
            success=False,
            output_dir=config.output_dir,
            error="Antigravity adapter not yet implemented",
        )
