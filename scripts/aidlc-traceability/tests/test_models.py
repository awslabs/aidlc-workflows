# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Tests for Pydantic data models."""

from __future__ import annotations

from traceability.models import (
    Artifact,
    ArtifactType,
    CoverageGap,
    CoverageMetrics,
    Relationship,
    TraceabilityReport,
)


class TestArtifactType:
    def test_values(self):
        assert ArtifactType.REQUIREMENT == "requirement"
        assert ArtifactType.STORY == "story"
        assert ArtifactType.CODE == "code"

    def test_all_members(self):
        assert len(ArtifactType) == 7


class TestArtifact:
    def test_minimal(self):
        a = Artifact(id="REQ-1", title="Req", artifact_type=ArtifactType.REQUIREMENT)
        assert a.id == "REQ-1"
        assert a.description == ""
        assert a.metadata == {}

    def test_full(self):
        a = Artifact(
            id="CODE:foo.py",
            title="Foo",
            artifact_type=ArtifactType.CODE,
            description="A code file",
            source_file="/tmp/foo.py",
            source_line=42,
            metadata={"language": "Python"},
        )
        assert a.source_line == 42
        assert a.metadata["language"] == "Python"

    def test_serialization_roundtrip(self):
        a = Artifact(id="X", title="Y", artifact_type=ArtifactType.UNIT)
        data = a.model_dump()
        b = Artifact(**data)
        assert a == b


class TestRelationship:
    def test_defaults(self):
        r = Relationship(source_id="A", target_id="B")
        assert r.relationship_type == "traces_to"

    def test_custom_type(self):
        r = Relationship(source_id="A", target_id="B", relationship_type="implemented_by")
        assert r.relationship_type == "implemented_by"


class TestCoverageGap:
    def test_creation(self):
        g = CoverageGap(
            artifact_id="REQ-1",
            artifact_title="Req",
            artifact_type=ArtifactType.REQUIREMENT,
            gap_type="no_stories",
            description="No linked stories",
        )
        assert g.gap_type == "no_stories"


class TestCoverageMetrics:
    def test_defaults(self):
        m = CoverageMetrics()
        assert m.total_requirements == 0
        assert m.code_with_tests == 0


class TestTraceabilityReport:
    def test_defaults(self):
        r = TraceabilityReport()
        assert r.project_name == "Unknown Project"
        assert r.artifacts == []
        assert r.relationships == []

    def test_with_data(self, sample_artifacts, sample_relationships):
        r = TraceabilityReport(
            project_name="Test",
            artifacts=sample_artifacts,
            relationships=sample_relationships,
        )
        assert len(r.artifacts) == 8
        assert len(r.relationships) == 6
