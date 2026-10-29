"""AIDLC Orchestrator agent — coordinator that drives the v2 AI-DLC workflow."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import boto3
from botocore.config import Config as BotoConfig
from strands import Agent
from strands.models.bedrock import BedrockModel

from aidlc_runner.config import ExecutionConfig, ModelConfig
from aidlc_runner.tools.file_ops import make_readonly_file_tools
from aidlc_runner.tools.rule_loader import make_rule_loader

ORCHESTRATOR_SYSTEM_PROMPT = """\
You are the AIDLC Orchestrator — a pure coordinator. You never write artifacts yourself.

## Startup

Load and follow your orchestration skill:
  load_rule('skills/aidlc-orchestration')

Then follow it exactly.

## Agent names in this swarm

When the skill says to invokeSubAgent, use handoff_to_agent with the exact persona name:
  - aidlc-product-manager-agent
  - aidlc-systems-architect-agent
  - aidlc-app-architect-agent
  - aidlc-sw-dev-engineer-agent
  - aidlc-ux-designer-agent
  - aidlc-code-reviewer-agent
  - aidlc-product-lead-agent
  - aidlc-architecture-reviewer-agent

For human interaction (questions, plan approvals, artifact verification):
  handoff_to_agent('simulator', ...)

## Your constraints

- You have READ-ONLY file access. You CANNOT write files.
- ALL artifact writing is done by persona agents via handoff.
- You manage state and audit by handing off to the appropriate persona agent.
- ONE handoff per turn. After calling handoff_to_agent, stop immediately.

## File paths

All skill files are loaded via load_rule. All intent artifacts are in aidlc-docs/.

## Completion rule

Drive every stage to complete in state.json. Never end your turn without handing off
to the next agent or having confirmed the full workflow is done.
"""


def create_orchestrator(
    run_folder: Path,
    rules_dir: Path,
    model_config: ModelConfig,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    callback_handler: Callable[..., Any] | None = None,
    execution_config: ExecutionConfig | None = None,
) -> Agent:
    """Create the AIDLC Orchestrator — a read-only coordinator agent.

    The orchestrator reads state and skills, then delegates all artifact
    production to persona agents via handoff_to_agent.

    Args:
        run_folder: Path to the run folder for this execution.
        rules_dir: Path to the kiro src/ directory containing skills/.
        model_config: Model configuration for this agent.
        aws_profile: AWS profile name for Bedrock.
        aws_region: AWS region for Bedrock.
        callback_handler: Optional callback handler for progress reporting.
        execution_config: Unused — orchestrator never executes commands.

    Returns:
        Configured Strands Agent instance.
    """
    file_tools = make_readonly_file_tools(run_folder)
    rule_loader = make_rule_loader(rules_dir)
    tools = [*file_tools, rule_loader]

    session_kwargs: dict = {}
    if aws_profile:
        session_kwargs["profile_name"] = aws_profile
    if aws_region:
        session_kwargs["region_name"] = aws_region
    boto_session = boto3.Session(**session_kwargs)
    boto_client_config = BotoConfig(
        read_timeout=900,
        connect_timeout=30,
        retries={"max_attempts": 10, "mode": "adaptive"},
    )
    model = BedrockModel(
        model_id=model_config.model_id,
        boto_session=boto_session,
        boto_client_config=boto_client_config,
    )

    return Agent(
        name="orchestrator",
        system_prompt=ORCHESTRATOR_SYSTEM_PROMPT,
        model=model,
        tools=tools,
        callback_handler=callback_handler,
    )
