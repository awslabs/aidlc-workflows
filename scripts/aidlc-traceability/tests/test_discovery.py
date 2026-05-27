# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Tests for artifact and source code discovery."""

from __future__ import annotations

from pathlib import Path

from traceability.discovery import (
    discover_artifacts,
    discover_source_code,
    find_aidlc_docs,
)


class TestFindAidlcDocs:
    def test_direct_child(self, tmp_path: Path):
        (tmp_path / "aidlc-docs").mkdir()
        assert find_aidlc_docs(tmp_path) == tmp_path / "aidlc-docs"

    def test_inception_at_root(self, tmp_path: Path):
        (tmp_path / "inception").mkdir()
        (tmp_path / "construction").mkdir()
        assert find_aidlc_docs(tmp_path) == tmp_path

    def test_nested_aidlc_docs(self, tmp_path: Path):
        nested = tmp_path / "project" / "aidlc-docs"
        nested.mkdir(parents=True)
        assert find_aidlc_docs(tmp_path) == nested

    def test_not_found(self, tmp_path: Path):
        assert find_aidlc_docs(tmp_path) is None


class TestDiscoverArtifacts:
    def test_categorization(self, tmp_project: Path):
        docs = tmp_project / "aidlc-docs"
        result = discover_artifacts(docs)
        assert len(result["requirements"]) == 1
        assert len(result["stories"]) == 1
        assert len(result["units"]) == 1
        assert len(result["code_plans"]) == 1
        assert len(result["components"]) == 1

    def test_empty_directory(self, tmp_path: Path):
        tmp_path.mkdir(exist_ok=True)
        result = discover_artifacts(tmp_path)
        for key in result:
            assert result[key] == []

    def test_requirement_excludes_verification(self, tmp_path: Path):
        (tmp_path / "requirements.md").write_text("# Reqs\n")
        (tmp_path / "requirement-verification.md").write_text("# Verify\n")
        result = discover_artifacts(tmp_path)
        assert len(result["requirements"]) == 1

    def test_stories_excludes_unit_story_map(self, tmp_path: Path):
        (tmp_path / "stories.md").write_text("# Stories\n")
        (tmp_path / "unit-of-work-story-map.md").write_text("# Map\n")
        result = discover_artifacts(tmp_path)
        # unit-of-work-story-map matches "unit" first
        assert len(result["stories"]) == 1
        assert len(result["units"]) == 1

    def test_test_files(self, tmp_path: Path):
        (tmp_path / "test-plan.md").write_text("# Tests\n")
        result = discover_artifacts(tmp_path)
        assert len(result["tests"]) == 1

    def test_state_files(self, tmp_path: Path):
        (tmp_path / "aidlc-state.md").write_text("# State\n")
        result = discover_artifacts(tmp_path)
        assert len(result["state"]) == 1


class TestDiscoverSourceCode:
    def test_finds_python_files(self, tmp_project: Path):
        files = discover_source_code(tmp_project)
        names = [f.name for f in files]
        assert "__init__.py" in names
        assert "catalog.py" in names

    def test_skips_excluded_dirs(self, tmp_path: Path):
        src = tmp_path / "src"
        pycache = src / "__pycache__"
        pycache.mkdir(parents=True)
        (pycache / "mod.py").write_text("")
        (src / "real.py").write_text("")
        files = discover_source_code(tmp_path)
        assert len(files) == 1
        assert files[0].name == "real.py"

    def test_skips_wrong_extensions(self, tmp_path: Path):
        src = tmp_path / "src"
        src.mkdir(parents=True)
        (src / "readme.md").write_text("")
        (src / "data.csv").write_text("")
        assert discover_source_code(tmp_path) == []

    def test_no_source_dirs(self, tmp_path: Path):
        assert discover_source_code(tmp_path) == []

    def test_includes_js_ts(self, tmp_path: Path):
        src = tmp_path / "src"
        src.mkdir()
        (src / "app.js").write_text("")
        (src / "index.ts").write_text("")
        (src / "Component.tsx").write_text("")
        files = discover_source_code(tmp_path)
        assert len(files) == 3
