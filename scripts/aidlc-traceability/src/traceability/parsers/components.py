# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Parse component and design artifacts."""

from __future__ import annotations

import re
from pathlib import Path

from traceability.models import Artifact, ArtifactType


def parse_components(file_path: Path) -> list[Artifact]:
    """Parse component definitions from application-design files.

    A valid component section must have a heading followed by structured fields
    like **Component Name**, **Purpose**, or **Responsibilities**. Plain section
    headers (e.g. "Architecture Overview", "Next Steps") are skipped.
    """
    content = file_path.read_text(encoding="utf-8")
    lines = content.split("\n")
    artifacts: list[Artifact] = []

    # Match component headers like: ## ComponentName, ### 1. ComponentName, ### Component 1.1: Name
    comp_pattern = re.compile(r"^#{2,4}\s+(?:\d+(?:\.\d+)*\.?\s+)?([A-Z][\w]+(?:\s+[\w.:()-]+)*)", re.IGNORECASE)

    # Fields that indicate a real component definition
    component_field_pattern = re.compile(
        r"^\*\*(?:Component\s+Name|Purpose|Responsibilities|Public\s+Interface|Dependencies|Technology|Type|Exception\s+Hierarchy)\*\*",
        re.IGNORECASE,
    )

    # Extract the actual component name from **Component Name**: `FooBar`
    comp_name_pattern = re.compile(r"^\*\*Component\s+Name\*\*:\s*`?([^`\n]+)`?", re.IGNORECASE)

    # Extract the **Type**: field value
    comp_type_pattern = re.compile(r"^\*\*Type\*\*:\s*(.+)", re.IGNORECASE)

    # Component types that represent design patterns/cross-cutting concerns
    # rather than standalone implementation modules
    design_pattern_types = {
        "pattern implementation", "data storage", "infrastructure component",
        "thread-local storage", "cross-cutting concern", "design pattern",
    }

    # Generic section headers that are never components
    skip_titles = {
        "overview", "summary", "dependencies", "notes", "components", "services",
        "architecture overview", "component catalog", "cross-cutting concerns",
        "component count summary", "technology stack summary", "next steps",
        "cross", "logging", "error handling", "configuration",
    }

    current_header: dict | None = None
    desc_lines: list[str] = []
    has_component_fields = False
    component_name: str | None = None
    component_type: str | None = None

    def _flush():
        """Flush the current component if it has structured fields."""
        nonlocal current_header, desc_lines, has_component_fields, component_name, component_type
        if current_header and has_component_fields:
            # Use **Component Name** field for ID/title if found
            if component_name:
                comp_id = re.sub(r"[^a-zA-Z0-9]", "-", component_name).strip("-")
                current_header["id"] = f"COMP-{comp_id}"
                current_header["title"] = component_name
            current_header["description"] = "\n".join(desc_lines).strip()
            # Mark design patterns vs implementation components
            if component_type:
                current_header.setdefault("metadata", {})["component_type"] = component_type
                if component_type.lower() in design_pattern_types:
                    current_header["metadata"]["design_pattern"] = True
            artifacts.append(Artifact(**current_header))
        current_header = None
        desc_lines = []
        has_component_fields = False
        component_name = None
        component_type = None

    for i, line in enumerate(lines, start=1):
        m = comp_pattern.match(line)
        if m:
            _flush()

            title = m.group(1).strip()
            if title.lower() in skip_titles:
                continue

            comp_id = re.sub(r"[^a-zA-Z0-9]", "-", title).strip("-")
            current_header = {
                "id": f"COMP-{comp_id}",
                "title": title,
                "artifact_type": ArtifactType.COMPONENT,
                "source_file": str(file_path),
                "source_line": i,
            }
            desc_lines = []
            has_component_fields = False
            component_name = None
            component_type = None
        elif current_header:
            desc_lines.append(line)
            stripped = line.strip()
            if component_field_pattern.match(stripped):
                has_component_fields = True
            name_match = comp_name_pattern.match(stripped)
            if name_match:
                component_name = name_match.group(1).strip()
            type_match = comp_type_pattern.match(stripped)
            if type_match:
                component_type = type_match.group(1).strip()

    _flush()

    return artifacts
