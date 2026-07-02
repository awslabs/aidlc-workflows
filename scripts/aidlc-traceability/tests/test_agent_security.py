# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Security regression tests for the AI agent file-reading boundary (Finding 2)."""

from __future__ import annotations

from pathlib import Path

import pytest

from traceability.agent import _resolve_within_project, make_source_code_reader


class TestResolveWithinProject:
    def test_relative_path_inside_root(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        target = tmp_path / "src" / "app.py"
        target.write_text("x = 1\n")
        resolved = _resolve_within_project(tmp_path, "src/app.py")
        assert resolved == target.resolve()

    def test_strips_code_prefix(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "app.py").write_text("")
        resolved = _resolve_within_project(tmp_path, "CODE:src/app.py")
        assert resolved == (tmp_path / "src" / "app.py").resolve()

    def test_rejects_parent_traversal(self, tmp_path: Path):
        project = tmp_path / "project"
        project.mkdir()
        with pytest.raises(ValueError):
            _resolve_within_project(project, "../secret.txt")

    def test_rejects_absolute_outside(self, tmp_path: Path):
        project = tmp_path / "project"
        project.mkdir()
        with pytest.raises(ValueError):
            _resolve_within_project(project, "/etc/passwd")


class TestMakeSourceCodeReader:
    def test_reads_file_within_root(self, tmp_path: Path):
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "app.py").write_text("hello = 1\n")
        reader = make_source_code_reader(tmp_path)
        result = reader("src/app.py")
        assert "hello = 1" in result

    def test_blocks_traversal_read(self, tmp_path: Path):
        project = tmp_path / "project"
        project.mkdir()
        secret = tmp_path / "secret.txt"
        secret.write_text("TOP SECRET\n")
        reader = make_source_code_reader(project)
        result = reader("../secret.txt")
        assert "TOP SECRET" not in result
        assert "denied" in result.lower()

    def test_blocks_absolute_path_read(self, tmp_path: Path):
        project = tmp_path / "project"
        project.mkdir()
        reader = make_source_code_reader(project)
        result = reader("/etc/hosts")
        assert "denied" in result.lower()

    def test_blocks_symlink_escape(self, tmp_path: Path):
        project = tmp_path / "project"
        (project / "src").mkdir(parents=True)
        secret = tmp_path / "secret.txt"
        secret.write_text("TOP SECRET\n")
        link = project / "src" / "leak.py"
        link.symlink_to(secret)
        reader = make_source_code_reader(project)
        result = reader("src/leak.py")
        assert "TOP SECRET" not in result
        assert "denied" in result.lower()
