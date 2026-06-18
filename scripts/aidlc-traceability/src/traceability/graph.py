# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Stage 3: Build traceability graph using NetworkX."""

from __future__ import annotations

import networkx as nx

from traceability.models import Artifact, ArtifactType, Relationship


def build_graph(artifacts: list[Artifact], relationships: list[Relationship]) -> tuple[nx.DiGraph, int]:
    """Build a directed graph from artifacts and relationships.

    Returns:
        Tuple of (graph, skipped_count) where skipped_count is the number of
        relationships skipped due to missing source or target artifacts.
    """
    G = nx.DiGraph()

    for a in artifacts:
        G.add_node(a.id, artifact=a)

    skipped_count = 0
    for r in relationships:
        if not G.has_node(r.source_id):
            skipped_count += 1
            continue
        if not G.has_node(r.target_id):
            skipped_count += 1
            continue
        G.add_edge(r.source_id, r.target_id, relationship_type=r.relationship_type)

    return G, skipped_count


def get_forward_trace(G: nx.DiGraph, node_id: str) -> list[str]:
    """Get all downstream nodes from a given node."""
    if node_id not in G:
        return []
    return list(nx.descendants(G, node_id))


def get_reverse_trace(G: nx.DiGraph, node_id: str) -> list[str]:
    """Get all upstream nodes that lead to a given node."""
    if node_id not in G:
        return []
    return list(nx.ancestors(G, node_id))


def get_nodes_by_type(G: nx.DiGraph, artifact_type: ArtifactType) -> list[Artifact]:
    """Get all artifacts of a specific type."""
    return [
        data["artifact"]
        for _, data in G.nodes(data=True)
        if "artifact" in data and data["artifact"].artifact_type == artifact_type
    ]
