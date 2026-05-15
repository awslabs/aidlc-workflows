# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Strands Agent for AI-powered traceability analysis using Amazon Bedrock.

Multi-agent architecture with focused sub-agents:
- Requirements → Stories Agent
- Stories → Units Agent
- Units → Code Agent (can read actual code files)
"""

from __future__ import annotations

import json
from pathlib import Path

import boto3
from strands import Agent, tool
from strands.models import BedrockModel

from traceability.models import Artifact, Relationship


def create_bedrock_model(profile_name: str | None = None, region: str = "us-east-1") -> BedrockModel:
    """Create a BedrockModel using the specified AWS profile."""
    try:
        session = boto3.Session(profile_name=profile_name, region_name=region)
        # Validate the session works
        session.client("sts").get_caller_identity()
    except Exception:
        # Fall back to default profile
        session = boto3.Session(region_name=region)
    return BedrockModel(
        boto_session=session,
        model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
    )


@tool
def read_artifact_file(file_path: str) -> str:
    """Read the contents of an AIDLC artifact file.

    Args:
        file_path: Path to the markdown artifact file to read.
    """
    p = Path(file_path)
    if not p.exists():
        return f"Error: File not found: {file_path}"
    return p.read_text(encoding="utf-8")


@tool
def list_artifact_files(directory: str) -> str:
    """List all markdown files in an AIDLC docs directory.

    Args:
        directory: Path to the aidlc-docs directory to scan.
    """
    p = Path(directory)
    if not p.is_dir():
        return f"Error: Directory not found: {directory}"
    files = sorted(str(f) for f in p.rglob("*.md"))
    return json.dumps(files, indent=2)


@tool
def read_source_code_file(file_path: str, max_lines: int = 200) -> str:
    """Read the contents of a source code file.

    Args:
        file_path: Path to the source code file to read.
        max_lines: Maximum number of lines to return (default 200).
    """
    p = Path(file_path)
    if not p.exists():
        return f"Error: File not found: {file_path}"
    try:
        content = p.read_text(encoding="utf-8", errors="ignore")
        lines = content.split("\n")
        if len(lines) > max_lines:
            return "\n".join(lines[:max_lines]) + f"\n\n... ({len(lines) - max_lines} more lines truncated)"
        return content
    except Exception as e:
        return f"Error reading file: {e}"


def create_req_story_agent(profile_name: str | None = None, region: str = "us-east-1") -> Agent:
    """Create an agent focused on mapping requirements to stories."""
    model = create_bedrock_model(profile_name, region)

    system_prompt = """You are a requirements traceability specialist. Your ONLY job is to map requirements to the user stories that implement them.

Analyze the requirements and stories provided, then output a JSON object with:
{
  "relationships": [
    {"source_id": "FR-001", "target_id": "US-1.1", "relationship_type": "implemented_by"},
    ...
  ],
  "insights": "Brief summary of requirement→story mappings"
}

Rules:
- Use EXACT artifact IDs from the lists provided
- A requirement can be implemented by multiple stories
- Look for explicit references (e.g., "implements FR-001") and semantic matches
- Output ONLY valid JSON, no other text"""

    return Agent(model=model, tools=[], system_prompt=system_prompt)


def create_story_unit_agent(profile_name: str | None = None, region: str = "us-east-1") -> Agent:
    """Create an agent focused on mapping stories to units."""
    model = create_bedrock_model(profile_name, region)

    system_prompt = """You are a story-to-unit traceability specialist. Your ONLY job is to map user stories to the units of work that implement them.

Analyze the stories and units provided, then output a JSON object with:
{
  "relationships": [
    {"source_id": "US-1.1", "target_id": "foundation---configuration", "relationship_type": "implemented_by"},
    ...
  ],
  "insights": "Brief summary of story→unit mappings"
}

Rules:
- Use EXACT artifact IDs from the lists provided
- A story can be implemented by multiple units
- Look for explicit references and semantic/functional matches
- Unit IDs use dashes (e.g., "foundation---configuration", "validation---discovery")
- Output ONLY valid JSON, no other text"""

    return Agent(model=model, tools=[], system_prompt=system_prompt)


def create_unit_component_agent(profile_name: str | None = None, region: str = "us-east-1") -> Agent:
    """Create an agent focused on mapping units to components."""
    model = create_bedrock_model(profile_name, region)

    system_prompt = """You are a unit-to-component traceability specialist. Your ONLY job is to map units of work to the logical components that implement them.

Analyze the units and components provided, then output a JSON object with:
{
  "relationships": [
    {"source_id": "foundation---configuration", "target_id": "ConfigManager", "relationship_type": "implemented_by"},
    ...
  ],
  "insights": "Brief summary of unit→component mappings"
}

Rules:
- Use EXACT artifact IDs from the lists provided
- A unit can be implemented by multiple components
- Look for semantic matches between unit functionality and component purpose
- Output ONLY valid JSON, no other text"""

    return Agent(model=model, tools=[], system_prompt=system_prompt)


def create_component_code_agent(profile_name: str | None = None, region: str = "us-east-1") -> Agent:
    """Create an agent focused on mapping components to code files (can read actual code)."""
    model = create_bedrock_model(profile_name, region)

    system_prompt = """You are a component-to-code traceability specialist. Your ONLY job is to map logical components to the source code files that implement them.

You can read actual source code files to understand their purpose. Analyze the components and code files provided, then output a JSON object with:
{
  "relationships": [
    {"source_id": "ConfigManager", "target_id": "CODE:src/config/settings.py", "relationship_type": "implemented_by"},
    ...
  ],
  "insights": "Brief summary of component→code mappings"
}

Rules:
- Use EXACT artifact IDs from the lists provided
- Code artifact IDs start with "CODE:" (e.g., "CODE:src/config/settings.py")
- Read code files to understand their purpose before mapping
- Match components to code by class names, module names, and functionality
- A component can be implemented by multiple code files
- Output ONLY valid JSON, no other text"""

    return Agent(
        model=model,
        tools=[read_source_code_file],
        system_prompt=system_prompt,
    )


def _parse_agent_json(response_text: str, valid_ids: set[str]) -> tuple[list[Relationship], list[str]]:
    """Parse JSON response from agent and validate artifact IDs."""
    relationships: list[Relationship] = []
    insights: list[str] = []

    try:
        # Find JSON in the response
        json_start = response_text.find("{")
        json_end = response_text.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            data = json.loads(response_text[json_start:json_end])

            skipped_count = 0
            for rel in data.get("relationships", []):
                source_id = rel["source_id"]
                target_id = rel["target_id"]

                # Validate artifact IDs exist
                if source_id not in valid_ids:
                    skipped_count += 1
                    continue
                if target_id not in valid_ids:
                    skipped_count += 1
                    continue

                relationships.append(Relationship(
                    source_id=source_id,
                    target_id=target_id,
                    relationship_type=rel.get("relationship_type", "traces_to"),
                ))

            if skipped_count > 0:
                insights.append(f"Skipped {skipped_count} invalid relationships")

            if data.get("insights"):
                insights.append(data["insights"])
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        insights.append(f"JSON parsing error: {e}")

    return relationships, insights


def run_req_story_analysis(
    agent: Agent,
    requirements: list[Artifact],
    stories: list[Artifact],
) -> tuple[list[Relationship], list[str]]:
    """Map requirements to stories using focused AI agent."""
    if not requirements or not stories:
        return [], ["No requirements or stories to analyze"]

    # Build artifact lists
    req_list = "\n".join([f"- {r.id}: {r.title}" for r in requirements])
    story_list = "\n".join([f"- {s.id}: {s.title}" for s in stories])

    prompt = f"""Map these requirements to implementing stories.

## Requirements ({len(requirements)})
{req_list}

## Stories ({len(stories)})
{story_list}

Analyze semantic matches and explicit references. Output JSON only."""

    result = agent(prompt)
    valid_ids = {a.id for a in requirements + stories}
    return _parse_agent_json(str(result), valid_ids)


def run_story_unit_analysis(
    agent: Agent,
    stories: list[Artifact],
    units: list[Artifact],
) -> tuple[list[Relationship], list[str]]:
    """Map stories to units using focused AI agent."""
    if not stories or not units:
        return [], ["No stories or units to analyze"]

    # Build artifact lists
    story_list = "\n".join([f"- {s.id}: {s.title}" for s in stories])
    unit_list = "\n".join([f"- {u.id}: {u.title}" for u in units])

    prompt = f"""Map these stories to implementing units.

## Stories ({len(stories)})
{story_list}

## Units ({len(units)})
{unit_list}

Analyze semantic matches and explicit references. Output JSON only."""

    result = agent(prompt)
    valid_ids = {a.id for a in stories + units}
    return _parse_agent_json(str(result), valid_ids)


def run_unit_component_analysis(
    agent: Agent,
    units: list[Artifact],
    components: list[Artifact],
) -> tuple[list[Relationship], list[str]]:
    """Map units to components using focused AI agent."""
    if not units or not components:
        return [], ["No units or components to analyze"]

    # Build artifact lists
    unit_list = "\n".join([f"- {u.id}: {u.title}" for u in units])
    component_list = "\n".join([f"- {c.id}: {c.title}" for c in components])

    prompt = f"""Map these units to implementing components.

## Units ({len(units)})
{unit_list}

## Components ({len(components)})
{component_list}

Analyze semantic matches between unit functionality and component purpose. Output JSON only."""

    result = agent(prompt)
    valid_ids = {a.id for a in units + components}
    return _parse_agent_json(str(result), valid_ids)


def run_component_code_analysis(
    agent: Agent,
    components: list[Artifact],
    code_files: list[Artifact],
    max_files_to_read: int = 30,
) -> tuple[list[Relationship], list[str]]:
    """Map components to code files using focused AI agent (can read actual code)."""
    if not components or not code_files:
        return [], ["No components or code files to analyze"]

    # Build artifact lists
    component_list = "\n".join([f"- {c.id}: {c.title}" for c in components])

    # Group code files by directory for context
    code_by_dir: dict[str, list[Artifact]] = {}
    for code_file in code_files:
        rel_path = code_file.metadata.get("relative_path", "")
        dir_name = str(Path(rel_path).parent) if rel_path else "root"
        if dir_name not in code_by_dir:
            code_by_dir[dir_name] = []
        code_by_dir[dir_name].append(code_file)

    code_list_parts = []
    for dir_name, files in sorted(code_by_dir.items()):
        code_list_parts.append(f"\n### {dir_name}/ ({len(files)} files)")
        for f in files:
            loc = f.metadata.get("lines_of_code", "?")
            boilerplate = " [Boilerplate]" if f.metadata.get("boilerplate", False) else ""
            code_list_parts.append(f"- {f.id}: {f.title} ({loc} lines){boilerplate}")
    code_list = "\n".join(code_list_parts)

    prompt = f"""Map these components to implementing code files. Your goal is COMPLETE coverage — every code file should trace to at least one component, and every component should trace to its code files.

## Components ({len(components)})
{component_list}

## Code Files ({len(code_files)})
{code_list}

You can use read_source_code_file(file_path) to read up to {max_files_to_read} key files.
Focus on reading files from different directories to understand the codebase structure.

Match components to code based on:
1. Class names and module names matching component names
2. File purpose from reading actual code
3. Docstrings and functionality descriptions
4. Supporting files (e.g., *_models.py, *_utils.py) belong to the component they support
5. Files in the same package/directory as a component likely relate to it

IMPORTANT: After mapping components to code, check for any code files that have NO component link.
For each orphaned file, read it and determine which component it supports (e.g., a models file
that defines data structures used by a specific component).

Output JSON only."""

    result = agent(prompt)
    valid_ids = {a.id for a in components + code_files}
    relationships, insights = _parse_agent_json(str(result), valid_ids)

    # Pass 2: Find orphaned code files and ask the agent to link them specifically
    linked_code_ids = {r.target_id for r in relationships if r.target_id.startswith("CODE:")}
    non_boilerplate = [f for f in code_files if not f.metadata.get("boilerplate", False)]
    orphaned = [f for f in non_boilerplate if f.id not in linked_code_ids]

    if orphaned:
        orphan_list_parts = []
        for f in orphaned:
            orphan_list_parts.append(f"- {f.id}: {f.title} (source: {f.metadata.get('relative_path', '')})")
        orphan_list = "\n".join(orphan_list_parts)

        orphan_prompt = f"""These {len(orphaned)} code files were NOT linked to any component in the previous analysis.
Read each file and determine which component it belongs to.

## Orphaned Code Files
{orphan_list}

## Available Components
{component_list}

For each orphaned file, use read_source_code_file to read it, then determine which component
it supports. Look for: imports from sibling modules, class/model definitions used by a component,
shared package membership.

Output JSON with relationships mapping each orphaned file to its component(s). Use EXACT IDs.
Output JSON only."""

        orphan_result = agent(orphan_prompt)
        orphan_rels, orphan_insights = _parse_agent_json(str(orphan_result), valid_ids)
        relationships.extend(orphan_rels)
        if orphan_rels:
            insights.append(f"Pass 2: linked {len(orphan_rels)} previously orphaned code files")
        insights.extend(orphan_insights)

    return relationships, insights
