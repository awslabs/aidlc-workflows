# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Tests for markdown and HTML report generators."""

from __future__ import annotations

import networkx as nx

from traceability.generators.markdown import generate_markdown
from traceability.generators.html import generate_html
from traceability.graph import build_graph


class TestGenerateMarkdown:
    def test_contains_header(self, sample_report, sample_graph):
        md = generate_markdown(sample_report, sample_graph)
        assert "# Traceability Matrix" in md
        assert "Test Project" in md

    def test_contains_summary(self, sample_report, sample_graph):
        md = generate_markdown(sample_report, sample_graph)
        assert "Total Requirements: 2" in md
        assert "Total Stories: 2" in md

    def test_contains_forward_matrix(self, sample_report, sample_graph):
        md = generate_markdown(sample_report, sample_graph)
        assert "## Forward Traceability Matrix" in md
        assert "REQ-1" in md

    def test_contains_reverse_matrix(self, sample_report, sample_graph):
        md = generate_markdown(sample_report, sample_graph)
        assert "## Reverse Traceability Matrix" in md

    def test_contains_detailed_traceability(self, sample_report, sample_graph):
        md = generate_markdown(sample_report, sample_graph)
        assert "## Detailed Traceability" in md

    def test_coverage_layers(self, sample_report, sample_graph):
        md = generate_markdown(sample_report, sample_graph)
        assert "Layer 1: Requirements" in md
        assert "Layer 2: Stories" in md

    def test_empty_report(self):
        from traceability.models import TraceabilityReport
        report = TraceabilityReport()
        G = nx.DiGraph()
        md = generate_markdown(report, G)
        assert "# Traceability Matrix" in md
        assert "Total Requirements: 0" in md


class TestGenerateHtml:
    def test_valid_html_structure(self, sample_report, sample_graph):
        html = generate_html(sample_report, sample_graph)
        assert "<!DOCTYPE html>" in html
        assert "</html>" in html
        assert "<style>" in html
        assert "<script>" in html

    def test_contains_project_name(self, sample_report, sample_graph):
        html = generate_html(sample_report, sample_graph)
        assert "Test Project" in html

    def test_contains_artifact_data_json(self, sample_report, sample_graph):
        html = generate_html(sample_report, sample_graph)
        assert "const artifacts =" in html

    def test_sidebar_groups(self, sample_report, sample_graph):
        html = generate_html(sample_report, sample_graph)
        assert "Requirements" in html
        assert "User Stories" in html

    def test_dark_mode_toggle(self, sample_report, sample_graph):
        html = generate_html(sample_report, sample_graph)
        assert "toggleDarkMode" in html
        assert "dark-mode" in html

    def test_metrics_displayed(self, sample_report, sample_graph):
        html = generate_html(sample_report, sample_graph)
        # Check metrics section has the values
        assert "metric-value" in html

    def test_escapes_special_chars(self):
        from traceability.models import Artifact, ArtifactType, TraceabilityReport, CoverageMetrics
        arts = [
            Artifact(
                id="REQ-XSS",
                title='<script>alert("xss")</script>',
                artifact_type=ArtifactType.REQUIREMENT,
            )
        ]
        report = TraceabilityReport(
            project_name="<b>Evil</b>",
            artifacts=arts,
            metrics=CoverageMetrics(total_requirements=1),
        )
        G, _ = build_graph(arts, [])
        html = generate_html(report, G)
        # User-supplied data should be escaped in the rendered HTML
        assert "&lt;b&gt;Evil&lt;/b&gt;" in html
        # The artifact title should be escaped (not rendered as raw HTML)
        assert '&lt;script&gt;alert("xss")&lt;/script&gt;' in html

    def test_empty_report(self):
        from traceability.models import TraceabilityReport
        report = TraceabilityReport()
        G = nx.DiGraph()
        html = generate_html(report, G)
        assert "<!DOCTYPE html>" in html
