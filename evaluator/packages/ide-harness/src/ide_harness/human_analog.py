"""Human analog — generates contextually appropriate responses to Kiro's questions.

When Kiro presents questions, plans, or approval gates, a naive evaluator just sends
"Approve & Continue."  This module uses a Bedrock LLM to read what Kiro actually said
and respond as an informed human would — confirming recommendations, correcting anything
that conflicts with the tech-env, and approving plans that look correct.

Uses the same system prompt logic as the execution package's simulator agent so both
the Bedrock-swarm path and the CLI/IDE harness paths behave consistently as a human.

Falls back to "Approve & Continue." if Bedrock is unavailable.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Mirror the execution package's simulator system prompt so the human analog
# behaves consistently across the Bedrock-swarm and CLI/IDE harness paths.
_SYSTEM_PROMPT_TEMPLATE = """\
You are simulating a knowledgeable human project stakeholder in an AI-assisted \
software development workflow. An AI coding assistant (Kiro) is building a project \
and occasionally pauses to ask you specific questions or present decisions that \
require human judgment.

## Your role — answer questions, not file I/O

You ONLY respond substantively when Kiro asks a question that genuinely requires \
human judgment:
- Clarification questions about requirements or behaviour (e.g. "How should mode \
behave when all values are unique?", "Which error code for overflow?")
- Decisions about workflow composition (e.g. "Should we include NFR assessment?")
- Approval of a proposed workflow or phase plan

You do NOT respond substantively to:
- Reports of file writes, directory creation, or test runs (those are internal steps)
- Summaries of completed work where no question is asked
- Any message that is just Kiro narrating what it did

For those, simply reply: "Approved. Continue."

## The project vision

{vision_content}

{tech_env_section}
## How to answer questions

- Answer each question directly, using the vision and tech-env as your source of truth.
- Confirm Kiro's recommendations when they align with the tech-env; correct them \
when they conflict (e.g. if Kiro proposes Flask, say "Use FastAPI as specified in tech-env").
- For workflow composition questions, approve the minimal workflow unless the vision \
clearly requires more phases.
- Keep answers to 1-3 sentences per question. Be decisive — do not hedge.
- Do NOT ask questions back. Do NOT add scope (README, CI, docs, etc.).
- Do NOT declare the project "done" or "shipped" — that is Kiro's decision.
"""

_USER_TEMPLATE = """\
Kiro's latest message:
---
{turn_output}
---

Does this message ask a question or present a plan/workflow for your approval? \
If yes, answer it concisely. If no (it's just a progress update or file I/O report), \
reply only: "Approved. Continue.\""""


def _extract_final_response(raw_output: str) -> str:
    """Extract just the final assistant response block from a kiro-cli turn output.

    Kiro session logs interleave tool calls (file writes, shell runs) with assistant
    responses marked by "> " prefix lines.  We extract the *last* contiguous response
    block so the human analog sees only what Kiro said to the human, not the tool noise.
    Includes any ━━━ approval gate separators that follow the last response.
    """
    import re as _re

    ansi_re = _re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b.")
    text = ansi_re.sub("", raw_output)

    # Collect all ">" response blocks
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in text.splitlines():
        if line.startswith("> "):
            if not current:
                blocks.append(current)
            current.append(line[2:])
        elif current and line.strip():
            # Include ━━━ separator lines and approval gate content that follows
            current.append(line)
        elif current and not line.strip():
            current.append("")

    if blocks:
        last_block = "\n".join(blocks[-1]).strip()
        return last_block[:2000]

    # Fallback: last 1500 chars
    return text[-1500:].strip()


def generate_human_response(
    turn_output: str,
    vision_path: Path,
    tech_env_path: Path | None,
    aws_profile: str | None = None,
    aws_region: str | None = None,
    model_id: str = "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
) -> str:
    """Generate a contextually appropriate human response to Kiro's turn output.

    Uses the same model configuration as the execution package's simulator agent.
    Falls back to "Approve & Continue." if Bedrock is unavailable.
    """
    try:
        import boto3

        vision = vision_path.read_text(encoding="utf-8") if vision_path.is_file() else ""
        tech_env = (
            tech_env_path.read_text(encoding="utf-8")
            if tech_env_path and tech_env_path.is_file()
            else ""
        )

        if tech_env:
            tech_env_section = (
                "## The technical environment\n\n"
                "The following defines HOW the project must be built — languages, frameworks, "
                "testing standards, and prohibited technologies. Use this as a binding reference:\n\n"  # noqa: E501
                f"---\n{tech_env[:2000]}\n---\n"
            )
        else:
            tech_env_section = ""

        system_prompt = _SYSTEM_PROMPT_TEMPLATE.format(
            vision_content=vision[:2000],
            tech_env_section=tech_env_section,
        )

        # Extract the final assistant response block (lines starting with "> ")
        # This avoids feeding Kiro's tool output (file writes, shell runs) to the LLM
        # and focuses it on what Kiro actually said to the human.
        trimmed_output = _extract_final_response(turn_output)
        user_content = _USER_TEMPLATE.format(turn_output=trimmed_output)

        session_kwargs = {}
        if aws_profile:
            session_kwargs["profile_name"] = aws_profile
        session = boto3.Session(**session_kwargs)

        client_kwargs = {"service_name": "bedrock-runtime"}
        if aws_region:
            client_kwargs["region_name"] = aws_region
        client = session.client(**client_kwargs)

        body = json.dumps(
            {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 256,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_content}],
            }
        )

        response = client.invoke_model(modelId=model_id, body=body)
        result = json.loads(response["body"].read())
        text = result["content"][0]["text"].strip()
        logger.info("Human analog response (%s): %s", model_id, text[:120])
        return text

    except Exception as exc:
        logger.warning("Human analog Bedrock call failed (%s) — falling back to approval", exc)
        return "Approve & Continue."
