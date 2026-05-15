# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Parse code-generation-plan.md files."""

from __future__ import annotations

import re
from pathlib import Path

from traceability.models import Artifact, ArtifactType


def parse_code_plans(file_path: Path) -> list[Artifact]:
    """Parse code generation plan steps as artifacts.

    Handles formats:
    - ### Step 1: Title
    - - [ ] Step 1: Title
    """
    content = file_path.read_text(encoding="utf-8")
    lines = content.split("\n")
    artifacts: list[Artifact] = []

    # Match header-style steps: ### Step 1: Title
    header_pattern = re.compile(r"^#{2,4}\s+Step\s+(\d+):\s*(.+)", re.IGNORECASE)
    # Match checkbox-style steps: - [ ] Step 1: Title
    checkbox_pattern = re.compile(r"^-\s*\[[ x]\]\s*Step\s+(\d+):\s*(.+)", re.IGNORECASE)

    for i, line in enumerate(lines, start=1):
        m = header_pattern.match(line) or checkbox_pattern.match(line)
        if m:
            step_num = m.group(1)
            title = m.group(2).strip()
            completed = "[x]" in line.lower()
            artifacts.append(Artifact(
                id=f"STEP-{step_num}",
                title=title,
                artifact_type=ArtifactType.CODE_PLAN,
                source_file=str(file_path),
                source_line=i,
                metadata={"completed": completed},
            ))

    return artifacts
