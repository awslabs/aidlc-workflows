# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Generate markdown traceability report."""

from __future__ import annotations

import networkx as nx

from traceability.models import ArtifactType, TraceabilityReport
from traceability.graph import get_nodes_by_type


def generate_markdown(report: TraceabilityReport, G: nx.DiGraph) -> str:
    """Generate a markdown traceability matrix report."""
    lines: list[str] = []

    lines.append("# Traceability Matrix")
    lines.append("")
    lines.append(f"Generated: {report.generated_at}")
    lines.append(f"Project: {report.project_name}")
    lines.append("")

    # Summary
    m = report.metrics
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Total Requirements: {m.total_requirements}")
    lines.append(f"- Total Stories: {m.total_stories}")
    lines.append(f"- Total Units: {m.total_units}")
    lines.append(f"- Total Code Files: {m.total_code_files}")
    lines.append(f"- Total Tests: {m.total_tests}")
    lines.append("")

    # Four-Layer Traceability Coverage
    lines.append("## AIDLC Traceability Coverage")
    lines.append("")
    lines.append("Complete traceability across all AI-DLC development layers:")
    lines.append("")

    # Layer 1: Requirements → Stories
    if m.total_requirements > 0:
        pct = m.requirements_with_stories / m.total_requirements * 100
        status = "✓" if pct == 100 else "⚠"
        lines.append(f"**{status} Layer 1: Requirements → Stories**")
        lines.append(f"- {m.requirements_with_stories}/{m.total_requirements} requirements traced to user stories ({pct:.0f}%)")
        lines.append("")

    # Layer 2: Stories → Units
    if m.total_stories > 0:
        pct = m.stories_with_units / m.total_stories * 100
        status = "✓" if pct == 100 else "⚠"
        lines.append(f"**{status} Layer 2: Stories → Units**")
        lines.append(f"- {m.stories_with_units}/{m.total_stories} stories traced to units of work ({pct:.0f}%)")
        lines.append("")

    # Layer 3: Units → Components
    units = get_nodes_by_type(G, ArtifactType.UNIT)
    units_with_components = 0
    for unit in units:
        connected = set(G.successors(unit.id)) | set(G.predecessors(unit.id))
        has_component = any(
            G.nodes[n].get("artifact", None) and
            G.nodes[n]["artifact"].artifact_type == ArtifactType.COMPONENT
            for n in connected
        )
        if has_component:
            units_with_components += 1

    if len(units) > 0:
        pct = units_with_components / len(units) * 100
        status = "✓" if pct == 100 else "⚠"
        lines.append(f"**{status} Layer 3: Units → Components**")
        lines.append(f"- {units_with_components}/{len(units)} units traced to logical components ({pct:.0f}%)")
        lines.append("")

    # Layer 4: Components → Code (excluding boilerplate and design patterns)
    components = get_nodes_by_type(G, ArtifactType.COMPONENT)
    code_files = get_nodes_by_type(G, ArtifactType.CODE)

    # Separate implementation components from design patterns
    impl_components = [c for c in components if not c.metadata.get("design_pattern", False)]
    design_patterns = [c for c in components if c.metadata.get("design_pattern", False)]

    # Count non-boilerplate code files
    non_boilerplate_code = [c for c in code_files if not c.metadata.get("boilerplate", False)]
    boilerplate_count = len(code_files) - len(non_boilerplate_code)

    components_with_code = 0
    for component in impl_components:
        connected = set(G.successors(component.id)) | set(G.predecessors(component.id))
        has_code = any(
            G.nodes[n].get("artifact", None) and
            G.nodes[n]["artifact"].artifact_type == ArtifactType.CODE and
            not G.nodes[n]["artifact"].metadata.get("boilerplate", False)
            for n in connected
        )
        if has_code:
            components_with_code += 1

    if len(impl_components) > 0:
        pct = components_with_code / len(impl_components) * 100
        status = "✓" if pct == 100 else "⚠"
        lines.append(f"**{status} Layer 4: Components → Code**")
        lines.append(f"- {components_with_code}/{len(impl_components)} implementation components traced to source code ({pct:.0f}%)")
        if boilerplate_count > 0:
            lines.append(f"  - {len(non_boilerplate_code)} implementation files, {boilerplate_count} boilerplate files")
        if design_patterns:
            lines.append(f"  - {len(design_patterns)} design patterns/cross-cutting concerns (traced via host components)")
        lines.append("")

    # Layer 5: Code → Components (reverse trace)
    if non_boilerplate_code:
        code_with_component = 0
        for code_file in non_boilerplate_code:
            connected = set(G.successors(code_file.id)) | set(G.predecessors(code_file.id))
            has_component = any(
                G.nodes[n].get("artifact", None) and
                G.nodes[n]["artifact"].artifact_type == ArtifactType.COMPONENT
                for n in connected
            )
            if has_component:
                code_with_component += 1

        pct = code_with_component / len(non_boilerplate_code) * 100
        status = "✓" if pct == 100 else "⚠"
        lines.append(f"**{status} Layer 5: Code → Components**")
        lines.append(f"- {code_with_component}/{len(non_boilerplate_code)} implementation files traced back to components ({pct:.0f}%)")
        untraced = len(non_boilerplate_code) - code_with_component
        if untraced > 0:
            lines.append(f"  - {untraced} orphaned implementation files")
        lines.append("")

    # Coverage Gaps
    if report.gaps:
        lines.append("## Coverage Gaps")
        lines.append("")
        for gap in report.gaps:
            lines.append(f"- **{gap.artifact_id}** ({gap.gap_type}): {gap.description}")
        lines.append("")

    # Forward Traceability Matrix
    lines.append("## Forward Traceability Matrix")
    lines.append("")
    lines.append("| Requirement | Stories | Units |")
    lines.append("|-------------|---------|-------|")

    requirements = get_nodes_by_type(G, ArtifactType.REQUIREMENT)
    for req in requirements:
        connected = set(G.successors(req.id)) | set(G.predecessors(req.id))
        stories = [
            n for n in connected
            if G.nodes[n].get("artifact") and G.nodes[n]["artifact"].artifact_type == ArtifactType.STORY
        ]
        # Find units connected to those stories
        unit_ids: set[str] = set()
        for s in stories:
            s_connected = set(G.successors(s)) | set(G.predecessors(s))
            for n in s_connected:
                if G.nodes[n].get("artifact") and G.nodes[n]["artifact"].artifact_type == ArtifactType.UNIT:
                    unit_ids.add(n)

        stories_str = ", ".join(sorted(stories)) if stories else "_none_"
        units_str = ", ".join(sorted(unit_ids)) if unit_ids else "_none_"
        lines.append(f"| {req.id}: {req.title} | {stories_str} | {units_str} |")

    lines.append("")

    # Reverse Traceability Matrix
    lines.append("## Reverse Traceability Matrix")
    lines.append("")
    lines.append("| Unit | Stories | Requirements |")
    lines.append("|------|---------|--------------|")

    units = get_nodes_by_type(G, ArtifactType.UNIT)
    for unit in units:
        connected = set(G.successors(unit.id)) | set(G.predecessors(unit.id))
        stories = [
            n for n in connected
            if G.nodes[n].get("artifact") and G.nodes[n]["artifact"].artifact_type == ArtifactType.STORY
        ]
        reqs = set()
        for s in stories:
            s_connected = set(G.successors(s)) | set(G.predecessors(s))
            for n in s_connected:
                if G.nodes[n].get("artifact") and G.nodes[n]["artifact"].artifact_type == ArtifactType.REQUIREMENT:
                    reqs.add(n)

        stories_str = ", ".join(sorted(stories)) if stories else "_none_"
        reqs_str = ", ".join(sorted(reqs)) if reqs else "_none_"
        lines.append(f"| {unit.id}: {unit.title} | {stories_str} | {reqs_str} |")

    lines.append("")

    # Component → Code Traceability
    all_components = get_nodes_by_type(G, ArtifactType.COMPONENT)
    code_files = get_nodes_by_type(G, ArtifactType.CODE)
    impl_comps = [c for c in all_components if not c.metadata.get("design_pattern", False)]
    pattern_comps = [c for c in all_components if c.metadata.get("design_pattern", False)]

    if all_components and code_files:
        lines.append("## Component → Code Traceability")
        lines.append("")
        lines.append("| Component | Code Files |")
        lines.append("|-----------|------------|")

        for comp in impl_comps:
            connected = set(G.successors(comp.id)) | set(G.predecessors(comp.id))
            code = [
                n for n in connected
                if G.nodes[n].get("artifact") and
                G.nodes[n]["artifact"].artifact_type == ArtifactType.CODE and
                not G.nodes[n]["artifact"].metadata.get("boilerplate", False)
            ]
            code_str = ", ".join(sorted(code)) if code else "_none_"
            lines.append(f"| {comp.id}: {comp.title} | {code_str} |")

        lines.append("")

        if pattern_comps:
            lines.append("### Design Patterns & Cross-Cutting Concerns")
            lines.append("")
            lines.append("These components represent architectural patterns embedded within other components rather than standalone code modules.")
            lines.append("")
            lines.append("| Pattern | Type | Host Components |")
            lines.append("|---------|------|-----------------|")

            for comp in pattern_comps:
                comp_type = comp.metadata.get("component_type", "Design Pattern")
                # Find connected implementation components (not code files)
                connected = set(G.successors(comp.id)) | set(G.predecessors(comp.id))
                hosts = [
                    G.nodes[n]["artifact"].title
                    for n in connected
                    if G.nodes[n].get("artifact") and
                    G.nodes[n]["artifact"].artifact_type == ArtifactType.COMPONENT and
                    not G.nodes[n]["artifact"].metadata.get("design_pattern", False)
                ]
                # If no direct component links, check for code links to infer host
                if not hosts:
                    code_links = [
                        n for n in connected
                        if G.nodes[n].get("artifact") and
                        G.nodes[n]["artifact"].artifact_type == ArtifactType.CODE
                    ]
                    hosts = [G.nodes[n]["artifact"].title for n in code_links] if code_links else ["_embedded in implementation_"]
                hosts_str = ", ".join(sorted(hosts)) if hosts else "_embedded in implementation_"
                lines.append(f"| {comp.title} | {comp_type} | {hosts_str} |")

        lines.append("")

    # Detailed Traceability
    lines.append("## Detailed Traceability")
    lines.append("")
    for req in requirements:
        lines.append(f"### {req.id}: {req.title}")
        lines.append(f"**Source**: {req.source_file} (line {req.source_line})")
        if req.metadata.get("type"):
            lines.append(f"**Type**: {req.metadata['type']}")
        lines.append("")

        connected = set(G.successors(req.id)) | set(G.predecessors(req.id))
        stories = [
            n for n in connected
            if G.nodes[n].get("artifact") and G.nodes[n]["artifact"].artifact_type == ArtifactType.STORY
        ]

        if stories:
            lines.append("**Stories**:")
            for s_id in sorted(stories):
                s_art = G.nodes[s_id]["artifact"]
                lines.append(f"- **{s_id}**: {s_art.title}")
                lines.append(f"  - Source: {s_art.source_file} (line {s_art.source_line})")

                # Find units for this story
                s_connected = set(G.successors(s_id)) | set(G.predecessors(s_id))
                s_units = [
                    n for n in s_connected
                    if G.nodes[n].get("artifact") and G.nodes[n]["artifact"].artifact_type == ArtifactType.UNIT
                ]
                if s_units:
                    lines.append(f"  - Units: {', '.join(sorted(s_units))}")

                    # Find components and code for each unit
                    for u_id in sorted(s_units):
                        u_connected = set(G.successors(u_id)) | set(G.predecessors(u_id))
                        u_components = [
                            n for n in u_connected
                            if G.nodes[n].get("artifact") and G.nodes[n]["artifact"].artifact_type == ArtifactType.COMPONENT
                        ]
                        if u_components:
                            lines.append(f"  - Components: {', '.join(sorted(u_components))}")
                            for c_id in sorted(u_components):
                                c_connected = set(G.successors(c_id)) | set(G.predecessors(c_id))
                                c_code = [
                                    n for n in c_connected
                                    if G.nodes[n].get("artifact") and
                                    G.nodes[n]["artifact"].artifact_type == ArtifactType.CODE and
                                    not G.nodes[n]["artifact"].metadata.get("boilerplate", False)
                                ]
                                if c_code:
                                    lines.append(f"  - Code: {', '.join(sorted(c_code))}")
        else:
            lines.append("**Stories**: _none linked_")

        lines.append("")

    return "\n".join(lines)
