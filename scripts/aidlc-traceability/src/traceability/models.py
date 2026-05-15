# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Pydantic models for AIDLC artifacts and traceability relationships."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


class ArtifactType(str, Enum):
    REQUIREMENT = "requirement"
    STORY = "story"
    UNIT = "unit"
    COMPONENT = "component"
    CODE_PLAN = "code_plan"
    CODE = "code"  # Actual source code files
    TEST = "test"


class Artifact(BaseModel):
    """A single parsed artifact from aidlc-docs."""

    id: str
    title: str
    artifact_type: ArtifactType
    description: str = ""
    source_file: str = ""
    source_line: int = 0
    metadata: dict = Field(default_factory=dict)


class Relationship(BaseModel):
    """A directed relationship between two artifacts."""

    source_id: str
    target_id: str
    relationship_type: str = "traces_to"


class CoverageGap(BaseModel):
    """A detected coverage gap."""

    artifact_id: str
    artifact_title: str
    artifact_type: ArtifactType
    gap_type: str  # e.g. "no_tests", "no_code", "no_stories"
    description: str


class CoverageMetrics(BaseModel):
    """Coverage statistics."""

    total_requirements: int = 0
    total_stories: int = 0
    total_units: int = 0
    total_code_files: int = 0
    total_tests: int = 0
    requirements_with_stories: int = 0
    stories_with_units: int = 0
    units_with_code: int = 0
    code_with_tests: int = 0


class TraceabilityReport(BaseModel):
    """Complete traceability report data."""

    project_name: str = "Unknown Project"
    generated_at: str = ""
    artifacts: list[Artifact] = Field(default_factory=list)
    relationships: list[Relationship] = Field(default_factory=list)
    gaps: list[CoverageGap] = Field(default_factory=list)
    metrics: CoverageMetrics = Field(default_factory=CoverageMetrics)
    forward_matrix: list[dict] = Field(default_factory=list)
    reverse_matrix: list[dict] = Field(default_factory=list)
