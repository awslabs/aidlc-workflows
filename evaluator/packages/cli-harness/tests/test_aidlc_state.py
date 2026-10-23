"""Tests for the shared AIDLC harness state helpers and adapter conformance.

Covers the contract both the claude-cli and kiro-cli adapters now share:
markdown `aidlc-docs/aidlc-state.md` completion + language-agnostic code detection.
"""

from __future__ import annotations

from pathlib import Path

from cli_harness.adapters._aidlc_state import (
    code_changed_from_seed,
    find_aidlc_docs,
    has_generated_code,
    read_state_field,
    state_status_completed,
    vision_intent,
    workflow_not_done,
)

_STATE_COMPLETED = """\
# AIDLC State

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: build-and-test
- **Next Stage**: none
- **Status**: Completed
- **Last Updated**: 2026-01-01T00:00:00Z
"""

_STATE_RUNNING = """\
# AIDLC State

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Next Stage**: build-and-test
- **In Progress**: code-generation
- **Status**: Running
"""


def _write_state(workspace: Path, content: str) -> None:
    docs = workspace / "aidlc-docs"
    docs.mkdir(parents=True, exist_ok=True)
    (docs / "aidlc-state.md").write_text(content, encoding="utf-8")


class TestStateStatusCompleted:
    def test_completed(self, tmp_path: Path):
        _write_state(tmp_path, _STATE_COMPLETED)
        assert state_status_completed(tmp_path) is True

    def test_running(self, tmp_path: Path):
        _write_state(tmp_path, _STATE_RUNNING)
        assert state_status_completed(tmp_path) is False

    def test_no_state_file(self, tmp_path: Path):
        assert state_status_completed(tmp_path) is False


class TestReadStateField:
    def test_reads_fields(self, tmp_path: Path):
        _write_state(tmp_path, _STATE_RUNNING)
        assert read_state_field(tmp_path, "Next Stage") == "build-and-test"
        assert read_state_field(tmp_path, "In Progress") == "code-generation"
        assert read_state_field(tmp_path, "Status") == "Running"

    def test_missing_field(self, tmp_path: Path):
        _write_state(tmp_path, _STATE_COMPLETED)
        assert read_state_field(tmp_path, "Nonexistent Field") is None


class TestWorkflowNotDone:
    def test_running_has_pending(self, tmp_path: Path):
        _write_state(tmp_path, _STATE_RUNNING)
        pending, detail = workflow_not_done(tmp_path)
        assert pending is True
        assert detail == "build-and-test"

    def test_completed_no_pending(self, tmp_path: Path):
        _write_state(tmp_path, _STATE_COMPLETED)
        pending, _ = workflow_not_done(tmp_path)
        assert pending is False

    def test_no_state_no_pending(self, tmp_path: Path):
        pending, detail = workflow_not_done(tmp_path)
        assert pending is False
        assert detail is None


class TestHasGeneratedCode:
    def test_python_detected(self, tmp_path: Path):
        (tmp_path / "app.py").write_text("print('hi')")
        assert has_generated_code(tmp_path) is True

    def test_typescript_detected(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "index.ts").write_text("export const x = 1;")
        assert has_generated_code(tmp_path) is True

    def test_ignores_harness_and_venv(self, tmp_path: Path):
        for sub in (".venv", ".claude", ".kiro", "node_modules"):
            d = tmp_path / sub
            d.mkdir()
            (d / "vendored.py").write_text("x = 1")
        assert has_generated_code(tmp_path) is False

    def test_docs_only_no_code(self, tmp_path: Path):
        _write_state(tmp_path, _STATE_COMPLETED)
        (tmp_path / "aidlc-docs" / "requirements.md").write_text("# reqs")
        assert has_generated_code(tmp_path) is False


# --- Regression: brownfield v1 false-completion bugs (2026-08-05) --------------
# The first brownfield batch scored v1 6/10, but two of the four "failures"
# were HARNESS false-completions that cut a still-working v1 run short, not v1
# under-delivering. These states reproduce the exact docs that tripped it.

# v1-run01: mid-workflow, Code Generation still In Progress. A status TABLE ROW
# cell `| CONSTRUCTION | Functional Design | Complete |` matched the old loose
# `construction[^\n]*\bcomplete` regex.
_V1_TABLE_CELL_MIDRUN = """\
# AI-DLC State Tracking
- **Current Stage**: CONSTRUCTION - Functional Design

| Phase | Stage | Status | Notes |
| CONSTRUCTION | Functional Design | Complete | Decided approach |
| CONSTRUCTION | Code Generation | In Progress | |
"""

# v1-run05: mid-workflow. "Workflow Status\nINCEPTION complete" — INCEPTION
# done, NOT the workflow — matched the v1.5 cross-version heuristic.
_V1_INCEPTION_ONLY = """\
# AI-DLC State Tracking
- **Current Stage**: CONSTRUCTION - Functional Design

## Workflow Status
INCEPTION complete — moving into CONSTRUCTION.
"""

# v1-run02 / run06: genuinely finished — must STILL be detected as complete.
_V1_GENUINELY_DONE = """\
# AI-DLC State Tracking
- **Current Stage**: CONSTRUCTION - COMPLETE (Build and Test done)
- **Workflow Status**: **COMPLETE** — all applicable stages executed
- [x] Code Generation — **COMPLETE**
- [x] Build and Test — **COMPLETE**
"""


class TestV1FalseCompletionRegression:
    def test_table_cell_is_not_completion(self, tmp_path: Path):
        _write_state(tmp_path, _V1_TABLE_CELL_MIDRUN)
        assert state_status_completed(tmp_path, version="v1") is False

    def test_inception_complete_is_not_workflow_complete(self, tmp_path: Path):
        _write_state(tmp_path, _V1_INCEPTION_ONLY)
        # v1-scoped: the v1.5 heuristic must not fire on a v1 file.
        assert state_status_completed(tmp_path, version="v1") is False

    def test_cross_version_contamination_scoped_out(self, tmp_path: Path):
        # The bug: unversioned detection let the v1.5 rule match this v1 doc.
        _write_state(tmp_path, _V1_INCEPTION_ONLY)
        assert state_status_completed(tmp_path, version="v1") is False

    def test_genuine_v1_completion_still_detected(self, tmp_path: Path):
        _write_state(tmp_path, _V1_GENUINELY_DONE)
        assert state_status_completed(tmp_path, version="v1") is True


class TestCodeChangedFromSeed:
    def _seed(self, root: Path) -> Path:
        seed = root / "seed"
        (seed / "pkg").mkdir(parents=True)
        (seed / "pkg" / "core.py").write_text("def f():\n    return 200\n")
        return seed

    def test_untouched_is_not_changed(self, tmp_path: Path):
        seed = self._seed(tmp_path)
        ws = tmp_path / "workspace"
        (ws / "pkg").mkdir(parents=True)
        (ws / "pkg" / "core.py").write_text("def f():\n    return 200\n")
        assert code_changed_from_seed(ws, seed) is False

    def test_edited_target_is_changed(self, tmp_path: Path):
        seed = self._seed(tmp_path)
        ws = tmp_path / "workspace"
        (ws / "pkg").mkdir(parents=True)
        (ws / "pkg" / "core.py").write_text("def f():\n    return 400\n")
        assert code_changed_from_seed(ws, seed) is True

    def test_added_file_is_changed(self, tmp_path: Path):
        seed = self._seed(tmp_path)
        ws = tmp_path / "workspace"
        (ws / "pkg").mkdir(parents=True)
        (ws / "pkg" / "core.py").write_text("def f():\n    return 200\n")
        (ws / "pkg" / "extra.py").write_text("x = 1\n")
        assert code_changed_from_seed(ws, seed) is True

    def test_missing_seed_does_not_block(self, tmp_path: Path):
        assert code_changed_from_seed(tmp_path / "ws", tmp_path / "nope") is True


class TestVisionIntent:
    def test_uses_h1(self):
        assert vision_intent("# Scientific Calculator API\n\nDetails...") == (
            "Scientific Calculator API"
        )

    def test_falls_back_to_first_line(self):
        assert vision_intent("Build a todo app\nmore text") == "Build a todo app"

    def test_empty(self):
        assert vision_intent("   \n\n") == "Build the project described in vision.md"


class TestFindAidlcDocs:
    def test_root_level(self, tmp_path: Path):
        _write_state(tmp_path, _STATE_COMPLETED)
        assert find_aidlc_docs(tmp_path) == tmp_path / "aidlc-docs"

    def test_empty_scaffold_ignored(self, tmp_path: Path):
        (tmp_path / "aidlc-docs").mkdir()  # no .md inside
        assert find_aidlc_docs(tmp_path) is None
