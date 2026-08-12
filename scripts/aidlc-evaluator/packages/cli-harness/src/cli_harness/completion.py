"""Pure completion assessment for AI-DLC CLI runs."""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

_MAX_STATE_BYTES = 1024 * 1024
_BUILD_TEST_RE = re.compile(
    r"(?im)^\s*-\s*\[(?P<checked>[ xX])\]\s*.*\bBuild\s+(?:and|&)\s+Test\b.*$"
)


class RunStatus(StrEnum):
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"
    FAILED = "failed"


@dataclass(frozen=True)
class CompletionAssessment:
    status: RunStatus
    build_and_test_completed: bool
    pending_interaction: bool
    reason: str


def assess_completion(
    aidlc_docs: Path,
    *,
    pending_interaction: bool = False,
    process_failed: bool = False,
) -> CompletionAssessment:
    """Require a checked Build and Test state entry and no pending interaction."""
    if process_failed:
        return CompletionAssessment(
            RunStatus.FAILED, False, pending_interaction, "CLI process failed"
        )
    state_path = aidlc_docs / "aidlc-state.md"
    if not state_path.is_file():
        return CompletionAssessment(
            RunStatus.INCOMPLETE,
            False,
            pending_interaction,
            "aidlc-state.md is missing",
        )
    try:
        if state_path.stat().st_size > _MAX_STATE_BYTES:
            return CompletionAssessment(
                RunStatus.FAILED,
                False,
                pending_interaction,
                "aidlc-state.md exceeds the size limit",
            )
        content = state_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return CompletionAssessment(
            RunStatus.FAILED,
            False,
            pending_interaction,
            f"cannot read aidlc-state.md: {exc}",
        )
    matches = list(_BUILD_TEST_RE.finditer(content))
    checked = [match for match in matches if match.group("checked").lower() == "x"]
    unchecked = [match for match in matches if match.group("checked") == " "]
    if not matches:
        return CompletionAssessment(
            RunStatus.INCOMPLETE,
            False,
            pending_interaction,
            "Build and Test is not registered in aidlc-state.md",
        )
    if checked and unchecked:
        return CompletionAssessment(
            RunStatus.INCOMPLETE,
            False,
            pending_interaction,
            "aidlc-state.md contains contradictory Build and Test entries",
        )
    build_complete = bool(checked) and not unchecked
    if not build_complete:
        return CompletionAssessment(
            RunStatus.INCOMPLETE,
            False,
            pending_interaction,
            "Build and Test is not complete",
        )
    if pending_interaction:
        return CompletionAssessment(
            RunStatus.INCOMPLETE,
            True,
            True,
            "an interaction is still pending",
        )
    return CompletionAssessment(RunStatus.COMPLETED, True, False, "Build and Test is complete")
