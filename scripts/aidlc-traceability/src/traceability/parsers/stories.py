# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Parse stories.md files to extract user story artifacts."""

from __future__ import annotations

import re
from pathlib import Path

from traceability.models import Artifact, ArtifactType


def parse_stories(file_path: Path) -> list[Artifact]:
    """Parse user stories from a markdown file.

    Handles formats like:
    - ### US-CAT-001: Add a Book
    - ### STORY-001: Title
    - ### Story 1.1: Specify AI-DLC Project Path
    - ### Story 1.1 - Specify AI-DLC Project Path
    """
    content = file_path.read_text(encoding="utf-8")
    lines = content.split("\n")
    artifacts: list[Artifact] = []

    # Pattern 1: Traditional format (US-XXX or STORY-XXX)
    traditional_pattern = re.compile(
        r"^#{2,4}\s+((?:US|STORY)-[\w-]+)[:\s]+(.+)",
        re.IGNORECASE,
    )

    # Pattern 2: Numeric format (Story 1.1, Story 1.1:, Story 1.1 -)
    numeric_pattern = re.compile(
        r"^#{2,4}\s+Story\s+([\d.]+)(?:\s*[:-]\s*|\s*:\s*)(.+)",
        re.IGNORECASE,
    )

    current_story: dict | None = None
    desc_lines: list[str] = []

    for i, line in enumerate(lines, start=1):
        # Try traditional pattern first
        m = traditional_pattern.match(line)
        if m:
            if current_story:
                current_story["description"] = "\n".join(desc_lines).strip()
                artifacts.append(Artifact(**current_story))
            current_story = {
                "id": m.group(1).strip(),
                "title": m.group(2).strip(),
                "artifact_type": ArtifactType.STORY,
                "source_file": str(file_path),
                "source_line": i,
            }
            desc_lines = []
        else:
            # Try numeric pattern
            m = numeric_pattern.match(line)
            if m:
                if current_story:
                    current_story["description"] = "\n".join(desc_lines).strip()
                    artifacts.append(Artifact(**current_story))
                story_id = f"US-{m.group(1).strip()}"
                current_story = {
                    "id": story_id,
                    "title": m.group(2).strip(),
                    "artifact_type": ArtifactType.STORY,
                    "source_file": str(file_path),
                    "source_line": i,
                }
                desc_lines = []
            elif current_story:
                desc_lines.append(line)

    if current_story:
        current_story["description"] = "\n".join(desc_lines).strip()
        artifacts.append(Artifact(**current_story))

    return artifacts
