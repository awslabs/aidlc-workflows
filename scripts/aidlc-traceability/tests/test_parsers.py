# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Tests for all artifact parsers."""

from __future__ import annotations

from pathlib import Path

import pytest

from traceability.models import ArtifactType
from traceability.parsers.requirements import parse_requirements
from traceability.parsers.stories import parse_stories
from traceability.parsers.units import parse_units
from traceability.parsers.code_plans import parse_code_plans
from traceability.parsers.components import parse_components
from traceability.parsers.code import parse_code_file, _is_boilerplate, _extract_traceability_hints
from traceability.parsers.linker import infer_requirement_story_links, _extract_category, _match_by_keywords


# ===== Requirements Parser =====

class TestParseRequirements:
    def test_functional_requirement(self, tmp_path: Path):
        f = tmp_path / "req.md"
        f.write_text("## FR-CAT-001: Search Books\nUsers can search.\n")
        arts = parse_requirements(f)
        assert len(arts) == 1
        assert arts[0].id == "FR-CAT-001"
        assert arts[0].metadata["type"] == "functional"

    def test_nonfunctional_requirement(self, tmp_path: Path):
        f = tmp_path / "req.md"
        f.write_text("## NFR-001: Performance\nMust be fast.\n")
        arts = parse_requirements(f)
        assert len(arts) == 1
        assert arts[0].metadata["type"] == "non-functional"

    def test_multiple_requirements(self, tmp_path: Path):
        f = tmp_path / "req.md"
        f.write_text(
            "## FR-A-001: First\nDesc one.\n\n"
            "#### FR-B-002: Second\nDesc two.\n"
        )
        arts = parse_requirements(f)
        assert len(arts) == 2
        assert arts[0].id == "FR-A-001"
        assert arts[1].id == "FR-B-002"

    def test_description_accumulation(self, tmp_path: Path):
        f = tmp_path / "req.md"
        f.write_text("## REQ-001: Req\nLine 1\nLine 2\nLine 3\n")
        arts = parse_requirements(f)
        assert "Line 1" in arts[0].description
        assert "Line 3" in arts[0].description

    def test_empty_file(self, tmp_path: Path):
        f = tmp_path / "empty.md"
        f.write_text("")
        assert parse_requirements(f) == []

    def test_no_matching_headers(self, tmp_path: Path):
        f = tmp_path / "other.md"
        f.write_text("# Overview\n\nSome unrelated text.\n")
        assert parse_requirements(f) == []


# ===== Stories Parser =====

class TestParseStories:
    def test_traditional_format(self, tmp_path: Path):
        f = tmp_path / "stories.md"
        f.write_text("### US-CAT-001: Search by Title\nAs a user...\n")
        arts = parse_stories(f)
        assert len(arts) == 1
        assert arts[0].id == "US-CAT-001"

    def test_numeric_format(self, tmp_path: Path):
        f = tmp_path / "stories.md"
        f.write_text("### Story 1.1: Browse Catalog\nAs a user...\n")
        arts = parse_stories(f)
        assert len(arts) == 1
        assert arts[0].id == "US-1.1"
        assert arts[0].title == "Browse Catalog"

    def test_numeric_with_dash(self, tmp_path: Path):
        f = tmp_path / "stories.md"
        f.write_text("### Story 2.3 - Edit Profile\nAs a user...\n")
        arts = parse_stories(f)
        assert len(arts) == 1
        assert arts[0].id == "US-2.3"

    def test_mixed_formats(self, tmp_path: Path):
        f = tmp_path / "stories.md"
        f.write_text(
            "### US-AUTH-001: Login\nLogin story.\n\n"
            "### Story 1.2: Register\nRegister story.\n"
        )
        arts = parse_stories(f)
        assert len(arts) == 2

    def test_empty_file(self, tmp_path: Path):
        f = tmp_path / "stories.md"
        f.write_text("")
        assert parse_stories(f) == []


# ===== Units Parser =====

class TestParseUnits:
    def test_basic_units(self, tmp_path: Path):
        f = tmp_path / "units.md"
        f.write_text(
            "# Units\n\n"
            "## Unit 1: Catalog Service\n"
            "Description here.\n"
        )
        arts, rels = parse_units(f)
        assert len(arts) == 1
        assert arts[0].title == "Catalog Service"

    def test_story_extraction(self, tmp_path: Path):
        f = tmp_path / "units.md"
        f.write_text(
            "## Unit 1: Auth Module\n"
            "Implements US-AUTH-001 and US-AUTH-002.\n"
        )
        arts, rels = parse_units(f)
        assert len(rels) == 2
        assert rels[0].source_id == "US-AUTH-001"
        assert rels[0].relationship_type == "implemented_by"

    def test_skips_documentation_sections(self, tmp_path: Path):
        f = tmp_path / "units.md"
        f.write_text(
            "## Unit 1: Dependency Matrix\n"
            "Not a real unit.\n\n"
            "## Unit 2: Real Service\n"
            "Actual implementation.\n"
        )
        arts, _ = parse_units(f)
        # "Dependency Matrix" is in skip_titles
        assert len(arts) == 1
        assert arts[0].title == "Real Service"

    def test_skips_phase2(self, tmp_path: Path):
        f = tmp_path / "units.md"
        f.write_text(
            "## Unit 1: Real Work\nGood.\n\n"
            "## Phase 2\n\n"
            "## Unit 2: Future Work\nSkipped.\n"
        )
        arts, _ = parse_units(f)
        assert len(arts) == 1
        assert arts[0].title == "Real Work"

    def test_parenthetical_stripping(self, tmp_path: Path):
        f = tmp_path / "units.md"
        f.write_text("## Unit 1: Foundation (FIRST)\nSetup.\n")
        arts, _ = parse_units(f)
        assert arts[0].title == "Foundation"

    def test_empty_file(self, tmp_path: Path):
        f = tmp_path / "units.md"
        f.write_text("")
        arts, rels = parse_units(f)
        assert arts == []
        assert rels == []


# ===== Code Plans Parser =====

class TestParseCodePlans:
    def test_header_style(self, tmp_path: Path):
        f = tmp_path / "plan.md"
        f.write_text("### Step 1: Setup\nInit project.\n### Step 2: Build\nCompile.\n")
        arts = parse_code_plans(f)
        assert len(arts) == 2
        assert arts[0].id == "STEP-1"
        assert arts[1].id == "STEP-2"

    def test_checkbox_style(self, tmp_path: Path):
        f = tmp_path / "plan.md"
        f.write_text("- [ ] Step 1: Setup\n- [x] Step 2: Done\n")
        arts = parse_code_plans(f)
        assert len(arts) == 2
        assert arts[0].metadata["completed"] is False
        assert arts[1].metadata["completed"] is True

    def test_empty_file(self, tmp_path: Path):
        f = tmp_path / "plan.md"
        f.write_text("")
        assert parse_code_plans(f) == []


# ===== Components Parser =====

class TestParseComponents:
    def test_structured_component(self, tmp_path: Path):
        f = tmp_path / "components.md"
        f.write_text(
            "## CatalogService\n"
            "**Component Name**: `CatalogService`\n"
            "**Purpose**: Manages catalog\n"
            "**Type**: Service\n"
        )
        arts = parse_components(f)
        assert len(arts) == 1
        assert arts[0].title == "CatalogService"
        assert arts[0].id == "COMP-CatalogService"

    def test_skips_plain_headers(self, tmp_path: Path):
        f = tmp_path / "components.md"
        f.write_text(
            "## Overview\nJust text, no structured fields.\n\n"
            "## RealComponent\n"
            "**Component Name**: RealComponent\n"
            "**Purpose**: Does something\n"
        )
        arts = parse_components(f)
        assert len(arts) == 1
        assert arts[0].title == "RealComponent"

    def test_design_pattern_marking(self, tmp_path: Path):
        f = tmp_path / "components.md"
        f.write_text(
            "## Singleton\n"
            "**Component Name**: SingletonPattern\n"
            "**Purpose**: Ensures single instance\n"
            "**Type**: Pattern Implementation\n"
        )
        arts = parse_components(f)
        assert len(arts) == 1
        assert arts[0].metadata.get("design_pattern") is True

    def test_empty_file(self, tmp_path: Path):
        f = tmp_path / "components.md"
        f.write_text("")
        assert parse_components(f) == []


# ===== Code Parser =====

class TestParseCodeFile:
    def test_python_file(self, tmp_project: Path):
        code_file = tmp_project / "src" / "myapp" / "catalog.py"
        art, hints = parse_code_file(code_file, tmp_project)
        assert art.artifact_type == ArtifactType.CODE
        assert art.metadata["language"] == "Python"
        assert not art.metadata["boilerplate"]
        assert len(hints) == 1
        assert "unit:catalog-service" in hints[0]

    def test_init_is_boilerplate(self, tmp_project: Path):
        code_file = tmp_project / "src" / "myapp" / "__init__.py"
        art, _ = parse_code_file(code_file, tmp_project)
        assert art.metadata["boilerplate"] is True
        assert "[Boilerplate]" in art.title

    def test_relative_path_in_id(self, tmp_project: Path):
        code_file = tmp_project / "src" / "myapp" / "catalog.py"
        art, _ = parse_code_file(code_file, tmp_project)
        assert art.id == "CODE:src/myapp/catalog.py"


class TestIsBoilerplate:
    @pytest.mark.parametrize("filename", [
        "__init__.py", "__main__.py", "index.js", "index.ts",
        "mod.rs", "doc.go",
    ])
    def test_init_patterns(self, tmp_path: Path, filename: str):
        f = tmp_path / filename
        f.write_text("# content\n")
        assert _is_boilerplate(f, f.read_text()) is True

    def test_autogenerated_header(self, tmp_path: Path):
        f = tmp_path / "gen.py"
        content = "# Auto-generated by tool\nimport foo\n"
        f.write_text(content)
        assert _is_boilerplate(f, content) is True

    def test_test_directory(self, tmp_path: Path):
        test_dir = tmp_path / "tests"
        test_dir.mkdir()
        f = test_dir / "helper.py"
        f.write_text("def setup(): pass\n")
        assert _is_boilerplate(f, f.read_text()) is True

    def test_example_file(self, tmp_path: Path):
        f = tmp_path / "example_usage.py"
        f.write_text("print('hello')\n")
        assert _is_boilerplate(f, f.read_text()) is True

    def test_normal_file_not_boilerplate(self, tmp_path: Path):
        f = tmp_path / "service.py"
        content = "class MyService:\n    def handle(self):\n        pass\n"
        f.write_text(content)
        assert _is_boilerplate(f, content) is False


class TestExtractTraceabilityHints:
    def test_python_comments(self):
        content = "# AIDLC-Unit: catalog-service\n# AIDLC-Story: US-1.1\n"
        hints = _extract_traceability_hints(content)
        assert len(hints) == 2
        assert "unit:catalog-service" in hints[0]
        assert "story:US-1.1" in hints[1]

    def test_js_comments(self):
        content = "// AIDLC-Component: FooBar\n"
        hints = _extract_traceability_hints(content)
        assert len(hints) == 1
        assert "component:FooBar" in hints[0]

    def test_no_hints(self):
        assert _extract_traceability_hints("def foo(): pass\n") == []


# ===== Linker =====

class TestLinker:
    def test_keyword_match(self):
        from traceability.models import Artifact, ArtifactType
        arts = [
            Artifact(id="FR-CAT-001", title="Search Books", artifact_type=ArtifactType.REQUIREMENT),
            Artifact(id="US-CAT-001", title="Browse", artifact_type=ArtifactType.STORY),
        ]
        rels = infer_requirement_story_links(arts)
        assert len(rels) >= 1
        assert rels[0].source_id == "FR-CAT-001"
        assert rels[0].target_id == "US-CAT-001"

    def test_category_fallback(self):
        from traceability.models import Artifact, ArtifactType
        arts = [
            Artifact(id="FR-XYZ-001", title="Something unique", artifact_type=ArtifactType.REQUIREMENT),
            Artifact(id="US-XYZ-001", title="Related story", artifact_type=ArtifactType.STORY),
        ]
        rels = infer_requirement_story_links(arts)
        assert len(rels) == 1
        assert rels[0].target_id == "US-XYZ-001"

    def test_no_stories_returns_empty(self):
        from traceability.models import Artifact, ArtifactType
        arts = [
            Artifact(id="FR-A-001", title="Lonely req", artifact_type=ArtifactType.REQUIREMENT),
        ]
        assert infer_requirement_story_links(arts) == []

    def test_no_requirements_returns_empty(self):
        from traceability.models import Artifact, ArtifactType
        arts = [
            Artifact(id="US-A-001", title="Lonely story", artifact_type=ArtifactType.STORY),
        ]
        assert infer_requirement_story_links(arts) == []

    def test_extract_category(self):
        assert _extract_category("FR-CAT-001") == "CAT"
        assert _extract_category("US-AUTH-002") == "AUTH"
        assert _extract_category("no-match") is None

    def test_match_by_keywords(self):
        assert "CAT" in _match_by_keywords("Search books in catalog")
        assert "AUTH" in _match_by_keywords("User authentication")
        assert _match_by_keywords("something random") == []
