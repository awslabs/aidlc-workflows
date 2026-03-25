"""Human Simulator agent — acts as a knowledgeable human stakeholder."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import boto3
from botocore.config import Config as BotoConfig
from strands import Agent
from strands.models.bedrock import BedrockModel

from aidlc_runner.config import ModelConfig
from aidlc_runner.tools.file_ops import make_file_tools

SIMULATOR_SYSTEM_PROMPT_TEMPLATE = """\
You are the Human Simulator agent. You are simulating a knowledgeable human project \
stakeholder who is working with an AI-DLC workflow executor.

## CRITICAL RULE: ALWAYS HAND BACK TO THE EXECUTOR

After completing your response (answering questions, approving documents, or providing \
reviews), you MUST ALWAYS handoff back to the "executor" agent. NEVER end your turn \
without handing off. The executor needs to continue driving the workflow through all \
remaining stages.

## Your role

You represent the human decision-maker in the AIDLC workflow. You provide:
- The project vision and requirements
- Answers to clarifying questions
- Approvals or change requests for documents and designs
- Technical constraints and preferences

## The project vision

The following is the vision and constraints document that defines what you want built. \
Use this as your primary source of truth when answering questions and making decisions:

---
{vision_content}
---
{tech_env_section}
## How you work

1. When you receive a handoff from the "executor" agent, read the file path mentioned \
in the handoff message.

2. Based on the file type:
   - **Question files**: Read the questions, then answer each one based on the vision \
document above and your best technical judgment. Write answers using the AIDLC format \
with [Answer]: tags followed by the letter choice (A, B, C, D, or E). If choosing E (Other), \
provide your custom answer.
   - **Approval requests**: Review the document against the vision. If it aligns, write \
an approval. Bias toward approving documents that are directionally correct — do not \
block progress on minor issues. If there are critical misalignments with the vision, \
describe what needs to change.
   - **Review requests**: Read the document, provide brief feedback, and approve. Only \
request revisions for significant issues that contradict the vision.
   - **Code review**: Review generated code for correctness against the vision spec. \
Approve if it implements the required functionality. Do not block on style issues.

3. Write your response to the same file (appending) or to a response file as directed \
by the question format.

4. IMMEDIATELY handoff back to the "executor" agent with a summary of what you did \
and tell it to continue to the next stage.

## Decision-making principles

- Stay consistent with the vision document above.
- When the vision doesn't specify a detail, use practical, mainstream technical choices.
- Prefer simplicity over complexity.
- Prefer well-established patterns over novel approaches.
- When genuinely uncertain, choose the option that keeps the most flexibility.
- Always provide a clear, decisive answer — do not punt back without a decision.
- Bias toward approval to keep the workflow moving. Only reject for critical issues.
- Keep your responses concise — the executor needs to continue working.
"""


def create_simulator(
    run_folder: Path,
    vision_content: str,
    model_config: ModelConfig,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    callback_handler: Callable[..., Any] | None = None,
    tech_env_content: str | None = None,
) -> Agent:
    """Create the Human Simulator agent.

    Args:
        run_folder: Path to the run folder for this execution.
        vision_content: The full text content of the vision/constraints file.
        model_config: Model configuration for this agent.
        aws_profile: AWS profile name for Bedrock.
        aws_region: AWS region for Bedrock.
        callback_handler: Optional callback handler for progress reporting.
        tech_env_content: Optional full text of the technical environment file.

    Returns:
        Configured Strands Agent instance.
    """
    file_tools = make_file_tools(run_folder)

    if tech_env_content:
        tech_env_section = (
            "\n## The technical environment\n\n"
            "The following is the technical environment document that defines HOW the project "
            "must be built — languages, frameworks, cloud services, security controls, testing "
            "standards, and prohibited technologies. Use this as a binding reference when "
            "answering technical questions and reviewing designs and code:\n\n"
            "---\n"
            f"{tech_env_content}\n"
            "---\n"
        )
    else:
        tech_env_section = ""

    system_prompt = SIMULATOR_SYSTEM_PROMPT_TEMPLATE.format(
        vision_content=vision_content,
        tech_env_section=tech_env_section,
    )

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
        name="simulator",
        system_prompt=system_prompt,
        model=model,
        tools=file_tools,
        callback_handler=callback_handler,
    )
