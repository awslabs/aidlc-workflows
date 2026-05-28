# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Shared pytest fixtures for the traceability test suite."""

from __future__ import annotations

from pathlib import Path

import networkx as nx
import pytest

from traceability.models import (
    Artifact,
    ArtifactType,
    CoverageMetrics,
    Relationship,
    TraceabilityReport,
)
from traceability.graph import build_graph


# ---------------------------------------------------------------------------
# Simple artifact factories
# ---------------------------------------------------------------------------

def make_artifact(
    id: str,
    title: str = "",
    artifact_type: ArtifactType = ArtifactType.REQUIREMENT,
    **kwargs,
) -> Artifact:
    return Artifact(
        id=id,
        title=title or id,
        artifact_type=artifact_type,
        **kwargs,
    )


def make_rel(source: str, target: str, rel_type: str = "traces_to") -> Relationship:
    return Relationship(source_id=source, target_id=target, relationship_type=rel_type)


# ---------------------------------------------------------------------------
# Pre-built artifact sets
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_artifacts() -> list[Artifact]:
    """A small connected set: 2 reqs -> 2 stories -> 2 units -> 1 component -> 1 code."""
    return [
        make_artifact("REQ-1", "Requirement One", ArtifactType.REQUIREMENT),
        make_artifact("REQ-2", "Requirement Two", ArtifactType.REQUIREMENT),
        make_artifact("US-1", "Story One", ArtifactType.STORY),
        make_artifact("US-2", "Story Two", ArtifactType.STORY),
        make_artifact("unit-alpha", "Alpha", ArtifactType.UNIT),
        make_artifact("unit-beta", "Beta", ArtifactType.UNIT),
        make_artifact("COMP-Foo", "Foo Service", ArtifactType.COMPONENT),
        make_artifact("CODE:src/foo.py", "foo.py", ArtifactType.CODE),
    ]


@pytest.fixture
def sample_relationships() -> list[Relationship]:
    return [
        make_rel("REQ-1", "US-1"),
        make_rel("REQ-2", "US-2"),
        make_rel("US-1", "unit-alpha"),
        make_rel("US-2", "unit-beta"),
        make_rel("unit-alpha", "COMP-Foo"),
        make_rel("COMP-Foo", "CODE:src/foo.py"),
    ]


@pytest.fixture
def sample_graph(sample_artifacts, sample_relationships) -> nx.DiGraph:
    G, _ = build_graph(sample_artifacts, sample_relationships)
    return G


@pytest.fixture
def sample_report(sample_artifacts, sample_relationships) -> TraceabilityReport:
    return TraceabilityReport(
        project_name="Test Project",
        generated_at="2026-01-01 00:00:00 UTC",
        artifacts=sample_artifacts,
        relationships=sample_relationships,
        metrics=CoverageMetrics(
            total_requirements=2,
            total_stories=2,
            total_units=2,
            total_code_files=1,
            requirements_with_stories=2,
            stories_with_units=2,
            units_with_code=0,
        ),
    )


# ---------------------------------------------------------------------------
# Temporary project fixture for discovery / parser tests
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_project(tmp_path: Path) -> Path:
    """Create a minimal AIDLC project layout in a temp directory."""
    docs = tmp_path / "aidlc-docs"
    docs.mkdir()

    # Requirements file
    (docs / "requirements.md").write_text(
        "# Requirements\n\n"
        "## FR-CAT-001: Search Books\n"
        "Users can search the catalog.\n\n"
        "## NFR-PERF-001: Response Time\n"
        "API responds within 200ms.\n"
    )

    # Stories file
    (docs / "stories.md").write_text(
        "# Stories\n\n"
        "### US-CAT-001: Search by Title\n"
        "As a user I can search by title.\n\n"
        "### Story 1.1: Browse Catalog\n"
        "As a user I can browse.\n"
    )

    # Units file
    (docs / "unit-of-work.md").write_text(
        "# Units\n\n"
        "## Unit 1: Catalog Service\n"
        "Implements catalog logic.\n"
        "References US-CAT-001.\n\n"
        "## Unit 2: Search Index\n"
        "Implements search.\n"
    )

    # Code plan file
    (docs / "code-generation-plan.md").write_text(
        "# Code Plan\n\n"
        "### Step 1: Setup project\n"
        "Initialize structure.\n\n"
        "- [x] Step 2: Implement models\n"
    )

    # Components file
    (docs / "application-components.md").write_text(
        "# Components\n\n"
        "## CatalogService\n"
        "**Component Name**: `CatalogService`\n"
        "**Purpose**: Manages catalog\n"
        "**Type**: Service\n"
    )

    # Source code directory
    src = tmp_path / "src" / "myapp"
    src.mkdir(parents=True)
    (src / "__init__.py").write_text('"""My app."""\n')
    (src / "catalog.py").write_text(
        '"""Catalog module."""\n\n'
        "# AIDLC-Unit: catalog-service\n\n"
        "class CatalogService:\n"
        "    pass\n"
    )

    return tmp_path
