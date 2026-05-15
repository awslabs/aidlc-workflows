# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Parse requirements.md files to extract requirement artifacts."""

from __future__ import annotations

import re
from pathlib import Path

from traceability.models import Artifact, ArtifactType


def parse_requirements(file_path: Path) -> list[Artifact]:
    """Parse requirements from a markdown file.

    Handles formats like:
    - ## REQ-001: Title
    - #### FR-CAT-001: Title
    - ### NFR-001: Title
    """
    content = file_path.read_text(encoding="utf-8")
    lines = content.split("\n")
    artifacts: list[Artifact] = []

    # Match requirement headers: ## REQ-001: Title, #### FR-CAT-001: Title, etc.
    req_pattern = re.compile(
        r"^#{2,4}\s+((?:REQ|FR|NFR|FR-[A-Z]+)-[\w-]+):\s*(.+)",
        re.IGNORECASE,
    )

    current_req: dict | None = None
    desc_lines: list[str] = []

    for i, line in enumerate(lines, start=1):
        m = req_pattern.match(line)
        if m:
            if current_req:
                current_req["description"] = "\n".join(desc_lines).strip()
                artifacts.append(Artifact(**current_req))
            req_id = m.group(1).strip()
            title = m.group(2).strip()
            req_type = "non-functional" if req_id.upper().startswith("NFR") else "functional"
            current_req = {
                "id": req_id,
                "title": title,
                "artifact_type": ArtifactType.REQUIREMENT,
                "source_file": str(file_path),
                "source_line": i,
                "metadata": {"type": req_type},
            }
            desc_lines = []
        elif current_req:
            # Collect description lines (stop at next header)
            if line.startswith("## ") or line.startswith("### ") or line.startswith("#### "):
                # Check if it's a new requirement or just a section header
                if not req_pattern.match(line):
                    desc_lines.append(line)
            else:
                desc_lines.append(line)

    if current_req:
        current_req["description"] = "\n".join(desc_lines).strip()
        artifacts.append(Artifact(**current_req))

    return artifacts
