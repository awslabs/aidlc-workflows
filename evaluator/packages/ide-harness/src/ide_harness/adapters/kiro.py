"""Kiro IDE adapter — the Kiro IDE distribution driven via kiro-cli.

Kiro is a standalone IDE, but its agent runtime is the same engine the CLI
exposes; the evaluable difference between "Kiro IDE" and "kiro-cli" runs is
the DISTRIBUTION — ``dist/kiro-ide/.kiro`` ships IDE-flavored agents and
rendering conventions (38 files differ from ``dist/kiro/.kiro``).

This adapter therefore delegates the entire drive loop to the maintained
cli-harness ``KiroCLIAdapter`` — one turn loop, invocation contract
(kiro-cli >= 2.x rejects a leading ``/aidlc``; the CLI adapter phrases it as
natural language), brownfield seeding, and completion detection
(``aidlc-state.md`` ``Status: Completed`` + generated code) — pointed at the
kiro-ide distribution. The previous standalone implementation drove the
pre-2.x ``/skill aidlc-orchestrator`` contract and detected completion via
``intent-state.md``, both long gone from the engine.
"""

from __future__ import annotations

import logging

from cli_harness.adapter import AdapterConfig as CLIAdapterConfig
from cli_harness.adapters.kiro_cli import KiroCLIAdapter as _KiroCLIAdapter

from ide_harness.adapter import AdapterConfig, AdapterResult, IDEAdapter

logger = logging.getLogger(__name__)


class KiroAdapter(IDEAdapter):
    """Drive the Kiro IDE distribution headless through the CLI kiro adapter."""

    def __init__(self) -> None:
        self._cli = _KiroCLIAdapter()

    @property
    def name(self) -> str:
        return "Kiro IDE"

    def check_prerequisites(self) -> tuple[bool, str]:
        return self._cli.check_prerequisites()

    def run(self, config: AdapterConfig) -> AdapterResult:
        cli_config = CLIAdapterConfig(
            vision_path=config.vision_path,
            output_dir=config.output_dir,
            rules_path=config.rules_path,
            tech_env_path=config.tech_env_path,
            prompt_template=config.prompt_template,
            timeout_seconds=config.timeout_seconds,
            kiro_dist_path=config.kiro_dist_path,
            aws_profile=config.aws_profile,
            aws_region=config.aws_region,
            scorer_model=config.scorer_model,
            scope=config.scope,
        )
        r = self._cli.run(cli_config)
        return AdapterResult(
            success=r.success,
            output_dir=r.output_dir,
            aidlc_docs_dir=r.aidlc_docs_dir,
            workspace_dir=r.workspace_dir,
            error=r.error,
            elapsed_seconds=r.elapsed_seconds,
            token_estimate=r.token_estimate,
            extra=r.extra,
        )
