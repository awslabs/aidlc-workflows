# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Tests for graph building and analysis."""

from __future__ import annotations

from traceability.models import ArtifactType
from traceability.graph import (
    build_graph,
    get_forward_trace,
    get_nodes_by_type,
    get_reverse_trace,
)
from traceability.analysis import calculate_metrics, detect_gaps
from tests.conftest import make_artifact, make_rel


class TestBuildGraph:
    def test_basic(self, sample_artifacts, sample_relationships):
        G, skipped = build_graph(sample_artifacts, sample_relationships)
        assert G.number_of_nodes() == 8
        assert G.number_of_edges() == 6
        assert skipped == 0

    def test_skips_missing_source(self):
        arts = [make_artifact("A", artifact_type=ArtifactType.REQUIREMENT)]
        rels = [make_rel("MISSING", "A")]
        G, skipped = build_graph(arts, rels)
        assert skipped == 1
        assert G.number_of_edges() == 0

    def test_skips_missing_target(self):
        arts = [make_artifact("A", artifact_type=ArtifactType.REQUIREMENT)]
        rels = [make_rel("A", "MISSING")]
        G, skipped = build_graph(arts, rels)
        assert skipped == 1

    def test_empty(self):
        G, skipped = build_graph([], [])
        assert G.number_of_nodes() == 0
        assert skipped == 0

    def test_stores_artifact_data(self, sample_artifacts, sample_relationships):
        G, _ = build_graph(sample_artifacts, sample_relationships)
        data = G.nodes["REQ-1"]
        assert data["artifact"].id == "REQ-1"
        assert data["artifact"].artifact_type == ArtifactType.REQUIREMENT


class TestGetForwardTrace:
    def test_traces_downstream(self, sample_graph):
        descendants = get_forward_trace(sample_graph, "REQ-1")
        assert "US-1" in descendants
        assert "unit-alpha" in descendants

    def test_missing_node(self, sample_graph):
        assert get_forward_trace(sample_graph, "MISSING") == []


class TestGetReverseTrace:
    def test_traces_upstream(self, sample_graph):
        ancestors = get_reverse_trace(sample_graph, "CODE:src/foo.py")
        assert "COMP-Foo" in ancestors
        assert "unit-alpha" in ancestors

    def test_missing_node(self, sample_graph):
        assert get_reverse_trace(sample_graph, "MISSING") == []


class TestGetNodesByType:
    def test_filters_requirements(self, sample_graph):
        reqs = get_nodes_by_type(sample_graph, ArtifactType.REQUIREMENT)
        assert len(reqs) == 2
        assert all(r.artifact_type == ArtifactType.REQUIREMENT for r in reqs)

    def test_filters_code(self, sample_graph):
        code = get_nodes_by_type(sample_graph, ArtifactType.CODE)
        assert len(code) == 1

    def test_empty_type(self, sample_graph):
        tests = get_nodes_by_type(sample_graph, ArtifactType.TEST)
        assert tests == []


# ===== Analysis =====

class TestDetectGaps:
    def test_detects_orphaned_requirement(self):
        arts = [
            make_artifact("REQ-1", "Orphan Req", ArtifactType.REQUIREMENT),
            make_artifact("US-1", "Story", ArtifactType.STORY),
        ]
        # No relationship between REQ-1 and US-1
        G, _ = build_graph(arts, [])
        gaps = detect_gaps(G)
        req_gaps = [g for g in gaps if g.artifact_id == "REQ-1"]
        assert len(req_gaps) == 1
        assert req_gaps[0].gap_type == "no_stories"

    def test_detects_orphaned_story(self):
        arts = [
            make_artifact("US-1", "Orphan Story", ArtifactType.STORY),
        ]
        G, _ = build_graph(arts, [])
        gaps = detect_gaps(G)
        story_gaps = [g for g in gaps if g.artifact_id == "US-1"]
        assert len(story_gaps) == 1
        assert story_gaps[0].gap_type == "no_code"

    def test_no_gaps_when_connected(self, sample_artifacts, sample_relationships):
        G, _ = build_graph(sample_artifacts, sample_relationships)
        gaps = detect_gaps(G)
        # REQ-1 → US-1 and REQ-2 → US-2 are connected, stories have units
        req_gaps = [g for g in gaps if g.gap_type == "no_stories"]
        story_gaps = [g for g in gaps if g.gap_type == "no_code"]
        assert len(req_gaps) == 0
        assert len(story_gaps) == 0

    def test_empty_graph(self):
        G, _ = build_graph([], [])
        assert detect_gaps(G) == []


class TestCalculateMetrics:
    def test_counts(self, sample_artifacts, sample_relationships):
        G, _ = build_graph(sample_artifacts, sample_relationships)
        m = calculate_metrics(G)
        assert m.total_requirements == 2
        assert m.total_stories == 2
        assert m.total_units == 2
        assert m.total_code_files == 1
        assert m.requirements_with_stories == 2
        assert m.stories_with_units == 2

    def test_empty_graph(self):
        G, _ = build_graph([], [])
        m = calculate_metrics(G)
        assert m.total_requirements == 0
        assert m.total_stories == 0

    def test_disconnected_nodes(self):
        arts = [
            make_artifact("REQ-1", artifact_type=ArtifactType.REQUIREMENT),
            make_artifact("US-1", artifact_type=ArtifactType.STORY),
        ]
        G, _ = build_graph(arts, [])
        m = calculate_metrics(G)
        assert m.total_requirements == 1
        assert m.requirements_with_stories == 0
