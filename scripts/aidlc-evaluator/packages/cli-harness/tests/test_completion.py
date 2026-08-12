"""Tests for strict AI-DLC completion semantics."""

from pathlib import Path

from cli_harness.completion import RunStatus, assess_completion


def _state(tmp_path: Path, content: str) -> Path:
    docs = tmp_path / "aidlc-docs"
    docs.mkdir()
    (docs / "aidlc-state.md").write_text(content, encoding="utf-8")
    return docs


def test_missing_state_is_incomplete(tmp_path: Path) -> None:
    assessment = assess_completion(tmp_path / "missing")
    assert assessment.status is RunStatus.INCOMPLETE


def test_partial_build_and_test_is_incomplete(tmp_path: Path) -> None:
    docs = _state(tmp_path, "- [ ] Build and Test\n")
    assert assess_completion(docs).status is RunStatus.INCOMPLETE


def test_completed_build_and_test_requires_no_pending_gate(tmp_path: Path) -> None:
    docs = _state(tmp_path, "- [x] CONSTRUCTION - Build and Test (all pass)\n")
    assert assess_completion(docs).status is RunStatus.COMPLETED
    assert assess_completion(docs, pending_interaction=True).status is RunStatus.INCOMPLETE


def test_contradictory_state_is_incomplete(tmp_path: Path) -> None:
    docs = _state(tmp_path, "- [x] Build and Test complete\n- [ ] Build & Test pending\n")
    assessment = assess_completion(docs)
    assert assessment.status is RunStatus.INCOMPLETE
    assert "contradictory" in assessment.reason


def test_process_failure_overrides_completed_state(tmp_path: Path) -> None:
    docs = _state(tmp_path, "- [x] Build and Test complete\n")
    assert assess_completion(docs, process_failed=True).status is RunStatus.FAILED
