# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Stage 4: Analyze traceability graph for gaps and coverage metrics."""

from __future__ import annotations

import networkx as nx

from traceability.models import ArtifactType, CoverageGap, CoverageMetrics
from traceability.graph import get_nodes_by_type


def detect_gaps(G: nx.DiGraph) -> list[CoverageGap]:
    """Detect coverage gaps in the traceability graph."""
    gaps: list[CoverageGap] = []

    requirements = get_nodes_by_type(G, ArtifactType.REQUIREMENT)
    stories = get_nodes_by_type(G, ArtifactType.STORY)

    # Requirements without stories
    for req in requirements:
        successors = list(G.successors(req.id))
        has_story = any(
            G.nodes[s].get("artifact", None) and G.nodes[s]["artifact"].artifact_type == ArtifactType.STORY
            for s in successors
        )
        if not has_story:
            # Check if any story traces to this requirement (reverse)
            predecessors = list(G.predecessors(req.id))
            has_story = any(
                G.nodes[p].get("artifact", None) and G.nodes[p]["artifact"].artifact_type == ArtifactType.STORY
                for p in predecessors
            )
        if not has_story:
            gaps.append(CoverageGap(
                artifact_id=req.id,
                artifact_title=req.title,
                artifact_type=ArtifactType.REQUIREMENT,
                gap_type="no_stories",
                description=f"Requirement '{req.title}' has no linked user stories",
            ))

    # Stories without units/code
    for story in stories:
        connected = set(G.successors(story.id)) | set(G.predecessors(story.id))
        has_unit = any(
            G.nodes[n].get("artifact", None) and G.nodes[n]["artifact"].artifact_type == ArtifactType.UNIT
            for n in connected
        )
        if not has_unit:
            gaps.append(CoverageGap(
                artifact_id=story.id,
                artifact_title=story.title,
                artifact_type=ArtifactType.STORY,
                gap_type="no_code",
                description=f"Story '{story.title}' has no linked unit of work or code",
            ))

    return gaps


def calculate_metrics(G: nx.DiGraph) -> CoverageMetrics:
    """Calculate coverage metrics from the graph."""
    requirements = get_nodes_by_type(G, ArtifactType.REQUIREMENT)
    stories = get_nodes_by_type(G, ArtifactType.STORY)
    units = get_nodes_by_type(G, ArtifactType.UNIT)
    code_files = get_nodes_by_type(G, ArtifactType.CODE)
    tests = get_nodes_by_type(G, ArtifactType.TEST)

    # Count requirements that have at least one story connection
    reqs_with_stories = 0
    for req in requirements:
        connected = set(G.successors(req.id)) | set(G.predecessors(req.id))
        if any(G.nodes[n].get("artifact", None) and G.nodes[n]["artifact"].artifact_type == ArtifactType.STORY for n in connected):
            reqs_with_stories += 1

    # Count stories with unit connections
    stories_with_units = 0
    for story in stories:
        connected = set(G.successors(story.id)) | set(G.predecessors(story.id))
        if any(G.nodes[n].get("artifact", None) and G.nodes[n]["artifact"].artifact_type == ArtifactType.UNIT for n in connected):
            stories_with_units += 1

    # Count units with code connections
    units_with_code = 0
    for unit in units:
        connected = set(G.successors(unit.id)) | set(G.predecessors(unit.id))
        if any(G.nodes[n].get("artifact", None) and G.nodes[n]["artifact"].artifact_type == ArtifactType.CODE for n in connected):
            units_with_code += 1

    return CoverageMetrics(
        total_requirements=len(requirements),
        total_stories=len(stories),
        total_units=len(units),
        total_code_files=len(code_files),
        total_tests=len(tests),
        requirements_with_stories=reqs_with_stories,
        stories_with_units=stories_with_units,
        units_with_code=units_with_code,
        code_with_tests=0,  # Will be enhanced later
    )
