# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Tests for CLI and pipeline orchestration."""

from __future__ import annotations

from pathlib import Path

import pytest
from click.testing import CliRunner

from traceability.cli import cli
from traceability.pipeline import _dedup_artifacts, _dedup_relationships, run_pipeline
from traceability.models import Artifact, ArtifactType, Relationship


# ===== Pipeline Helpers =====

class TestDedupArtifacts:
    def test_removes_duplicates(self):
        arts = [
            Artifact(id="A", title="First", artifact_type=ArtifactType.REQUIREMENT),
            Artifact(id="A", title="Duplicate", artifact_type=ArtifactType.REQUIREMENT),
            Artifact(id="B", title="Unique", artifact_type=ArtifactType.STORY),
        ]
        result = _dedup_artifacts(arts)
        assert len(result) == 2
        assert result[0].title == "First"  # Keeps first occurrence

    def test_empty_list(self):
        assert _dedup_artifacts([]) == []


class TestDedupRelationships:
    def test_removes_duplicates(self):
        rels = [
            Relationship(source_id="A", target_id="B", relationship_type="traces_to"),
            Relationship(source_id="A", target_id="B", relationship_type="traces_to"),
            Relationship(source_id="A", target_id="B", relationship_type="implemented_by"),
        ]
        result = _dedup_relationships(rels)
        assert len(result) == 2

    def test_empty_list(self):
        assert _dedup_relationships([]) == []


# ===== Pipeline Integration =====

class TestRunPipeline:
    def test_no_ai_with_project(self, tmp_project: Path):
        """Run pipeline without AI on the test project."""
        output = tmp_project / "output.md"
        report = run_pipeline(
            project_root=tmp_project,
            output_paths=[output],
            output_format="markdown",
            use_ai=False,
        )
        assert output.exists()
        assert len(report.artifacts) > 0
        assert report.project_name is not None

    def test_html_format(self, tmp_project: Path):
        output = tmp_project / "output.html"
        _report = run_pipeline(
            project_root=tmp_project,
            output_paths=[output],
            output_format="html",
            use_ai=False,
        )
        assert output.exists()
        content = output.read_text()
        assert "<!DOCTYPE html>" in content

    def test_both_format(self, tmp_project: Path):
        md_path = tmp_project / "matrix.md"
        html_path = tmp_project / "matrix.html"
        _report = run_pipeline(
            project_root=tmp_project,
            output_paths=[md_path, html_path],
            output_format="both",
            use_ai=False,
        )
        assert md_path.exists()
        assert html_path.exists()

    def test_missing_aidlc_docs(self, tmp_path: Path):
        with pytest.raises(SystemExit):
            run_pipeline(
                project_root=tmp_path,
                output_paths=[tmp_path / "out.md"],
                use_ai=False,
            )

    def test_deprecated_output_path(self, tmp_project: Path):
        output = tmp_project / "legacy.md"
        _report = run_pipeline(
            project_root=tmp_project,
            output_path=output,
            output_format="markdown",
            use_ai=False,
        )
        assert output.exists()


# ===== CLI =====

class TestCLI:
    def test_help(self):
        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "AIDLC Traceability" in result.output

    def test_generate_help(self):
        runner = CliRunner()
        result = runner.invoke(cli, ["generate", "--help"])
        assert result.exit_code == 0
        assert "--no-ai" in result.output
        assert "--format" in result.output

    def test_version(self):
        runner = CliRunner()
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert "0.1.0" in result.output

    def test_generate_no_ai(self, tmp_project: Path):
        runner = CliRunner()
        result = runner.invoke(cli, [
            "generate",
            "--input", str(tmp_project),
            "--output", str(tmp_project / "reports"),
            "--format", "markdown",
            "--no-ai",
        ])
        assert result.exit_code == 0
        assert (tmp_project / "reports" / "traceability-matrix.md").exists()

    def test_generate_missing_input(self, tmp_path: Path):
        runner = CliRunner()
        result = runner.invoke(cli, [
            "generate",
            "--input", str(tmp_path / "nonexistent"),
            "--no-ai",
        ])
        assert result.exit_code != 0
