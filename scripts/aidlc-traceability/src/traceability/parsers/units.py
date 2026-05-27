# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Parse unit-of-work.md and unit-of-work-story-map.md files."""

from __future__ import annotations

import re
from pathlib import Path

from traceability.models import Artifact, ArtifactType, Relationship


def parse_units(file_path: Path) -> tuple[list[Artifact], list[Relationship]]:
    """Parse units of work and extract story mappings.

    Only parses actual implementation units (headings starting with "Unit X:").
    Skips documentation sections like "Dependency Matrix", "Completion Gates", etc.
    """
    content = file_path.read_text(encoding="utf-8")
    lines = content.split("\n")
    artifacts: list[Artifact] = []
    relationships: list[Relationship] = []

    # Match ONLY real unit headers like:
    # ## Unit 1: Catalog Service
    # ### Unit 2: Validation
    # ## U1: Foundation & Configuration
    # NOT: ## Dependency Matrix, ## Completion Gates, etc.
    unit_header_pattern = re.compile(
        r"^#{2,3}\s+(?:Unit|U)[\s\d]+:\s*(.+?)\s*$",
        re.IGNORECASE,
    )
    story_id_pattern = re.compile(r"((?:US|STORY)-[\w-]+)", re.IGNORECASE)

    current_unit_id: str | None = None
    current_unit: dict | None = None
    desc_lines: list[str] = []

    # These are NOT units, they're documentation scaffolding
    skip_titles = {
        "definition", "responsibilities", "code organization", "deployment profile",
        "units of work", "summary", "build order", "unit of work — story map",
        "unit of work - story map", "overview", "purpose", "context", "approach",
        "dependency matrix", "implementation sequence", "completion gates",
        "risk mitigation", "timeline", "integration points", "sequence order",
        "phase 2 story summary", "phase 2",
    }

    in_phase2_section = False

    for i, line in enumerate(lines, start=1):
        # Skip the top-level title
        if line.startswith("# ") and not line.startswith("## "):
            continue

        # Detect Phase 2 sections
        if line.startswith("##") and "phase 2" in line.lower():
            in_phase2_section = True
            continue

        m = unit_header_pattern.match(line)
        if m:
            # Skip units inside Phase 2 sections (they're summaries, not real units)
            if in_phase2_section:
                continue

            title = m.group(1).strip()

            # Extract base title before any parentheses (e.g., "Foundation (FIRST)" → "Foundation")
            base_title = title.split("(")[0].strip()

            if base_title.lower() in skip_titles:
                continue

            if current_unit:
                current_unit["description"] = "\n".join(desc_lines).strip()
                artifacts.append(Artifact(**current_unit))

            # Create canonical ID from base title only (deduplicates variants)
            unit_id = re.sub(r"[^a-zA-Z0-9]", "-", base_title.lower()).strip("-")
            current_unit_id = unit_id
            current_unit = {
                "id": unit_id,
                "title": base_title,  # Use base title without parenthetical info
                "artifact_type": ArtifactType.UNIT,
                "source_file": str(file_path),
                "source_line": i,
            }
            desc_lines = []
        elif current_unit:
            desc_lines.append(line)
            # Extract story references from table rows or text
            for story_match in story_id_pattern.finditer(line):
                story_id = story_match.group(1)
                if current_unit_id:
                    relationships.append(Relationship(
                        source_id=story_id,
                        target_id=current_unit_id,
                        relationship_type="implemented_by",
                    ))

    if current_unit:
        current_unit["description"] = "\n".join(desc_lines).strip()
        artifacts.append(Artifact(**current_unit))

    return artifacts, relationships
