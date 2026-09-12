"""AIDLC Persona agents — one Strands Agent per kiro persona YAML."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

import boto3
from botocore.config import Config as BotoConfig
from strands import Agent, AgentSkills
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.models.bedrock import BedrockModel

from aidlc_runner.config import ExecutionConfig, ModelConfig
from aidlc_runner.tools.file_ops import make_file_tools
from aidlc_runner.tools.run_command import make_run_command


def _parse_persona_yaml(content: str) -> dict:
    """Parse a flat kiro persona YAML into a dict.

    Handles scalar strings and block scalars (| and >) and string arrays (- item).
    Only covers the fields used in persona files: name, description, behaviour,
    associated-skills.
    """
    result: dict = {}
    lines = content.split("\n")
    current_key: str | None = None
    current_value = ""
    block_mode: str | None = None  # '|', '>', or 'array'

    def flush() -> None:
        if current_key and not isinstance(result.get(current_key), list):
            result[current_key] = current_value.strip()

    for i, line in enumerate(lines):
        key_match = re.match(r"^([a-z][a-z0-9-]*):\s*(.*)$", line)
        if key_match and not line.startswith((" ", "\t")):
            flush()
            current_key = key_match.group(1)
            after = key_match.group(2).strip()
            if after in ("|", ">"):
                block_mode = after
                current_value = ""
            elif after == "[]":
                result[current_key] = []
                current_key = None
                block_mode = None
            elif after == "":
                # peek ahead for array
                if i + 1 < len(lines) and re.match(r"^\s+-\s", lines[i + 1]):
                    result[current_key] = []
                    block_mode = "array"
                    current_value = ""
                else:
                    block_mode = None
                    current_value = ""
            else:
                block_mode = None
                current_value = after
            continue

        if block_mode == "array" and re.match(r"^\s+-\s", line):
            item = re.sub(r"^\s+-\s*", "", line).strip()
            if current_key:
                result.setdefault(current_key, [])
                result[current_key].append(item)
            continue

        if block_mode in ("|", ">"):
            if line.startswith(" ") or line == "":
                if block_mode == "|":
                    current_value += line.replace("  ", "", 1) + "\n"
                else:
                    current_value += (line.strip() + " ") if line.strip() else "\n"
            else:
                flush()
                block_mode = None
                i -= 1  # reprocess
            continue

    flush()
    return result


def _make_bedrock_model(
    model_config: ModelConfig,
    aws_profile: str | None,
    aws_region: str | None,
) -> BedrockModel:
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
    return BedrockModel(
        model_id=model_config.model_id,
        boto_session=boto_session,
        boto_client_config=boto_client_config,
    )


def create_persona_agents(
    run_folder: Path,
    rules_dir: Path,
    model_config: ModelConfig,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    callback_handler: Callable[..., Any] | None = None,
    execution_config: ExecutionConfig | None = None,
) -> list[Agent]:
    """Create one Strands Agent per kiro persona YAML.

    Each agent gets:
    - Name matching the YAML filename stem (e.g. "aidlc-product-manager-agent")
    - System prompt built from the persona's description + behaviour
    - AgentSkills loaded from its associated-skills list in src/skills/
    - Full file tools (read + write + list)
    - run_command only for aidlc-sw-dev-engineer-agent

    Args:
        run_folder: Path to the run folder for this execution.
        rules_dir: Path to the kiro src/ directory containing skills/ and personas/.
        model_config: Model configuration shared across all personas.
        aws_profile: AWS profile name for Bedrock.
        aws_region: AWS region for Bedrock.
        callback_handler: Optional progress callback.
        execution_config: Controls run_command availability.

    Returns:
        List of configured Strands Agent instances, one per persona YAML.
    """
    if execution_config is None:
        execution_config = ExecutionConfig()

    personas_dir = rules_dir / "personas"
    skills_dir = rules_dir / "skills"
    common_skills_dir = skills_dir / "common"

    if not personas_dir.is_dir():
        return []

    model = _make_bedrock_model(model_config, aws_profile, aws_region)
    file_tools = make_file_tools(run_folder)
    run_cmd = None
    if execution_config.enabled:
        run_cmd = make_run_command(run_folder, timeout=execution_config.command_timeout)

    agents = []
    for persona_file in sorted(personas_dir.glob("*.yaml")):
        persona = _parse_persona_yaml(persona_file.read_text(encoding="utf-8"))
        name = persona.get("name") or persona_file.stem
        description = (persona.get("description") or "").strip()
        behaviour = (persona.get("behaviour") or "").strip()
        associated_skills: list[str] = persona.get("associated-skills") or []

        system_prompt = (
            f"You are {name}.\n\n"
            f"{description}\n\n"
            f"{behaviour}\n\n"
            "## Your role in this workflow\n\n"
            "You are invoked by the AIDLC Orchestrator to execute a specific stage step.\n"
            "Read the handoff message carefully — it tells you exactly what to do (clarification,\n"
            "planning, execution, or fix) and where to write your artifacts.\n\n"
            "Write all artifacts using your write_file tool.\n"
            "When your step is complete, hand off back to 'orchestrator' with a brief summary\n"
            "of what you produced and the exact paths of files you wrote.\n\n"
            "NEVER proceed to the next step or the next stage on your own.\n"
            "ONE step per invocation, then hand back to 'orchestrator'."
        )

        # Load associated skills + common skills
        skill_paths = []
        if common_skills_dir.is_dir():
            skill_paths.append(common_skills_dir)
        for skill_name in associated_skills:
            skill_path = skills_dir / skill_name
            if skill_path.is_dir():
                skill_paths.append(skill_path)

        plugins = [AgentSkills(skills=skill_paths)] if skill_paths else []

        # Only sw-dev-engineer gets run_command
        tools = list(file_tools)
        if run_cmd is not None and "sw-dev-engineer" in name:
            tools.append(run_cmd)

        agent = Agent(
            name=name,
            system_prompt=system_prompt,
            model=model,
            tools=tools,
            plugins=plugins,
            callback_handler=callback_handler,
            conversation_manager=SlidingWindowConversationManager(window_size=20),
        )
        agents.append(agent)

    return agents
