# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Main pipeline: orchestrates discovery → parsing → graph → analysis → generation."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from rich.console import Console

from traceability.models import Artifact, ArtifactType, Relationship, TraceabilityReport
from traceability.discovery import find_aidlc_docs, discover_artifacts, discover_source_code
from traceability.parsers.requirements import parse_requirements
from traceability.parsers.stories import parse_stories
from traceability.parsers.units import parse_units
from traceability.parsers.code_plans import parse_code_plans
from traceability.parsers.components import parse_components
from traceability.parsers.code import parse_all_code_files
from traceability.parsers.linker import infer_requirement_story_links
from traceability.graph import build_graph
from traceability.analysis import detect_gaps, calculate_metrics
from traceability.generators.markdown import generate_markdown
from traceability.generators.html import generate_html

console = Console()


def _dedup_artifacts(artifacts: list[Artifact]) -> list[Artifact]:
    """Deduplicate artifacts by ID, keeping the first occurrence."""
    seen: dict[str, Artifact] = {}
    for a in artifacts:
        if a.id not in seen:
            seen[a.id] = a
    return list(seen.values())


def _dedup_relationships(rels: list[Relationship]) -> list[Relationship]:
    """Deduplicate relationships by (source, target, type)."""
    seen: set[tuple[str, str, str]] = set()
    result: list[Relationship] = []
    for r in rels:
        key = (r.source_id, r.target_id, r.relationship_type)
        if key not in seen:
            seen.add(key)
            result.append(r)
    return result


def run_pipeline(
    project_root: Path,
    output_paths: list[Path] | None = None,
    output_path: Path | None = None,  # Deprecated, use output_paths
    output_format: str = "markdown",
    use_ai: bool = True,
    aws_profile: str | None = None,
    aws_region: str = "us-east-1",
    verbose: bool = False,
) -> TraceabilityReport:
    """Run the full traceability pipeline."""

    # Stage 1: Discovery
    console.print("[bold blue]Stage 1:[/] Discovering AIDLC artifacts...")
    aidlc_root = find_aidlc_docs(project_root)
    if not aidlc_root:
        console.print("[red]Error:[/] Could not find aidlc-docs directory")
        raise SystemExit(1)

    console.print(f"  Found aidlc-docs at: {aidlc_root}")
    artifact_files = discover_artifacts(aidlc_root)

    # Discover source code files
    code_files = discover_source_code(project_root)
    artifact_files["code_files"] = code_files
    console.print(f"  Found {len(code_files)} source code files")

    if verbose:
        for cat, files in artifact_files.items():
            if files:
                console.print(f"  {cat}: {len(files)} files")

    # Stage 2: Parsing
    console.print("[bold blue]Stage 2:[/] Parsing artifacts...")
    all_artifacts: list[Artifact] = []
    all_relationships: list[Relationship] = []

    for f in artifact_files["requirements"]:
        try:
            arts = parse_requirements(f)
            all_artifacts.extend(arts)
            if verbose:
                console.print(f"  Parsed {len(arts)} requirements from {f.name}")
        except Exception as e:
            console.print(f"  [yellow]Warning:[/] Failed to parse {f}: {e}")

    for f in artifact_files["stories"]:
        try:
            arts = parse_stories(f)
            all_artifacts.extend(arts)
            if verbose:
                console.print(f"  Parsed {len(arts)} stories from {f.name}")
        except Exception as e:
            console.print(f"  [yellow]Warning:[/] Failed to parse {f}: {e}")

    for f in artifact_files["units"]:
        try:
            arts, rels = parse_units(f)
            all_artifacts.extend(arts)
            all_relationships.extend(rels)
            if verbose:
                console.print(f"  Parsed {len(arts)} units, {len(rels)} relationships from {f.name}")
        except Exception as e:
            console.print(f"  [yellow]Warning:[/] Failed to parse {f}: {e}")

    for f in artifact_files["code_plans"]:
        try:
            arts = parse_code_plans(f)
            all_artifacts.extend(arts)
            if verbose:
                console.print(f"  Parsed {len(arts)} code plan steps from {f.name}")
        except Exception as e:
            console.print(f"  [yellow]Warning:[/] Failed to parse {f}: {e}")

    for f in artifact_files["components"]:
        try:
            arts = parse_components(f)
            all_artifacts.extend(arts)
            if verbose:
                console.print(f"  Parsed {len(arts)} components from {f.name}")
        except Exception as e:
            console.print(f"  [yellow]Warning:[/] Failed to parse {f}: {e}")

    # Parse source code files
    if code_files:
        try:
            code_arts = parse_all_code_files(code_files, project_root)
            all_artifacts.extend(code_arts)
            console.print(f"  Parsed {len(code_arts)} source code files")
        except Exception as e:
            console.print(f"  [yellow]Warning:[/] Failed to parse code files: {e}")

    # Deduplicate
    all_artifacts = _dedup_artifacts(all_artifacts)

    # Stage 2.5: Heuristic linking (requirement → story)
    console.print("[bold blue]Stage 2.5:[/] Inferring requirement→story links...")
    heuristic_rels = infer_requirement_story_links(all_artifacts)
    all_relationships.extend(heuristic_rels)
    if verbose or heuristic_rels:
        console.print(f"  Inferred {len(heuristic_rels)} requirement→story links")

    # Deduplicate relationships
    all_relationships = _dedup_relationships(all_relationships)

    console.print(f"  Total: {len(all_artifacts)} artifacts, {len(all_relationships)} relationships")

    # Stage 3: AI-powered analysis with focused sub-agents (optional)
    ai_insights: list[str] = []
    if use_ai:
        console.print("[bold blue]Stage 3:[/] Running AI-powered analysis with focused agents...")
        try:
            from traceability.agent import (
                create_req_story_agent,
                create_story_unit_agent,
                create_unit_component_agent,
                create_component_code_agent,
                run_req_story_analysis,
                run_story_unit_analysis,
                run_unit_component_analysis,
                run_component_code_analysis,
            )

            # Extract artifact types for focused analysis
            requirements = [a for a in all_artifacts if a.artifact_type == ArtifactType.REQUIREMENT]
            stories = [a for a in all_artifacts if a.artifact_type == ArtifactType.STORY]
            units = [a for a in all_artifacts if a.artifact_type == ArtifactType.UNIT]
            components = [a for a in all_artifacts if a.artifact_type == ArtifactType.COMPONENT]
            code_artifacts = [a for a in all_artifacts if a.artifact_type == ArtifactType.CODE]

            # Initialize relationship lists
            rs_rels: list[Relationship] = []
            su_rels: list[Relationship] = []
            uc_rels: list[Relationship] = []
            cc_rels: list[Relationship] = []

            # Stage 3a: Requirements → Stories
            if requirements and stories:
                console.print(f"  [bold cyan]Stage 3a:[/] Mapping {len(requirements)} requirements to {len(stories)} stories...")
                agent_rs = create_req_story_agent(profile_name=aws_profile, region=aws_region)
                rs_rels, rs_insights = run_req_story_analysis(agent_rs, requirements, stories)
                all_relationships.extend(rs_rels)
                ai_insights.extend(rs_insights)
                console.print(f"    Found {len(rs_rels)} requirement→story relationships")

            # Stage 3b: Stories → Units
            if stories and units:
                console.print(f"  [bold cyan]Stage 3b:[/] Mapping {len(stories)} stories to {len(units)} units...")
                agent_su = create_story_unit_agent(profile_name=aws_profile, region=aws_region)
                su_rels, su_insights = run_story_unit_analysis(agent_su, stories, units)
                all_relationships.extend(su_rels)
                ai_insights.extend(su_insights)
                console.print(f"    Found {len(su_rels)} story→unit relationships")

            # Stage 3c: Units → Components
            if units and components:
                console.print(f"  [bold cyan]Stage 3c:[/] Mapping {len(units)} units to {len(components)} components...")
                agent_uc = create_unit_component_agent(profile_name=aws_profile, region=aws_region)
                uc_rels, uc_insights = run_unit_component_analysis(agent_uc, units, components)
                all_relationships.extend(uc_rels)
                ai_insights.extend(uc_insights)
                console.print(f"    Found {len(uc_rels)} unit→component relationships")

            # Stage 3d: Components → Code
            if components and code_artifacts:
                console.print(f"  [bold cyan]Stage 3d:[/] Mapping {len(components)} components to {len(code_artifacts)} code files...")
                agent_cc = create_component_code_agent(profile_name=aws_profile, region=aws_region)
                cc_rels, cc_insights = run_component_code_analysis(agent_cc, components, code_artifacts)
                all_relationships.extend(cc_rels)
                ai_insights.extend(cc_insights)
                console.print(f"    Found {len(cc_rels)} component→code relationships")

            all_relationships = _dedup_relationships(all_relationships)
            total_ai_rels = len(rs_rels) + len(su_rels) + len(uc_rels) + len(cc_rels)
            console.print(f"  [green]AI analysis complete:[/] {total_ai_rels} total relationships from 4 focused agents")

            if verbose and ai_insights:
                for insight in ai_insights:
                    console.print(f"  [dim]{insight}[/dim]")
        except Exception as e:
            console.print(f"  [yellow]Warning:[/] AI analysis failed: {e}")
            console.print("  Continuing with rule-based analysis only...")
            if verbose:
                import traceback
                console.print(f"  [dim]{traceback.format_exc()}[/dim]")

    # Stage 4: Build Graph
    console.print("[bold blue]Stage 4:[/] Building traceability graph...")
    G, skipped_rels = build_graph(all_artifacts, all_relationships)
    console.print(f"  Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    if skipped_rels > 0:
        console.print(f"  [yellow]Warning:[/] Skipped {skipped_rels} relationships due to missing artifact IDs")

    # Stage 5: Analysis
    console.print("[bold blue]Stage 5:[/] Analyzing coverage...")
    gaps = detect_gaps(G)
    metrics = calculate_metrics(G)

    if gaps:
        console.print(f"  Found {len(gaps)} coverage gaps")
    else:
        console.print("  [green]No coverage gaps detected[/green]")

    # Detect project name from state file
    project_name = "Unknown Project"
    for f in artifact_files.get("state", []):
        content = f.read_text(encoding="utf-8")
        for line in content.split("\n"):
            if "project name" in line.lower() and ":" in line:
                project_name = line.split(":", 1)[1].strip().strip("*")
                break

    report = TraceabilityReport(
        project_name=project_name,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        artifacts=all_artifacts,
        relationships=all_relationships,
        gaps=gaps,
        metrics=metrics,
    )

    # Stage 6: Generate Report
    # Handle deprecated output_path parameter
    if output_path and not output_paths:
        output_paths = [output_path]
    elif not output_paths:
        output_paths = [project_root / "traceability-matrix.md"]

    if output_format == "both":
        console.print("[bold blue]Stage 6:[/] Generating markdown and html reports...")

        # Generate markdown
        md_content = generate_markdown(report, G)
        md_path = output_paths[0]
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text(md_content, encoding="utf-8")
        console.print(f"  [green]Markdown report written to:[/green] {md_path}")

        # Generate HTML
        html_content = generate_html(report, G)
        html_path = output_paths[1] if len(output_paths) > 1 else md_path.with_suffix(".html")
        html_path.parent.mkdir(parents=True, exist_ok=True)
        html_path.write_text(html_content, encoding="utf-8")
        console.print(f"  [green]HTML report written to:[/green] {html_path}")
    else:
        console.print(f"[bold blue]Stage 6:[/] Generating {output_format} report...")

        if output_format == "html":
            content = generate_html(report, G)
        else:
            content = generate_markdown(report, G)

        out_path = output_paths[0]
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(content, encoding="utf-8")
        console.print(f"  [green]Report written to:[/green] {out_path}")

    return report
