# Copyright (c) 2026 AIDLC Design Reviewer Contributors
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""
Functional tests: Reporting Pipeline (Units 4→5 boundary).

Tests the full chain: ReviewResult → ReportBuilder → real Formatters
→ real Jinja2 templates → actual file output.

No mocking — exercises real ReportBuilder, MarkdownFormatter, HTMLFormatter,
and Jinja2 templates together.
"""

from design_reviewer.reporting.html_formatter import HTMLFormatter
from design_reviewer.reporting.markdown_formatter import MarkdownFormatter
from design_reviewer.reporting.models import (
    QualityLabel,
    QualityThresholds,
    RecommendedAction,
)
from design_reviewer.reporting.report_builder import ReportBuilder


class TestReportBuilderToMarkdown:
    """ReportBuilder → MarkdownFormatter → file output."""

    def test_healthy_design_produces_excellent_markdown(
        self, review_result_healthy, project_info, output_paths
    ):
        builder = ReportBuilder()
        formatter = MarkdownFormatter()

        report = builder.build_report(
            review_result=review_result_healthy,
            project_info=project_info,
            execution_time=12.5,
            _stage_timings={"validation": 0.5, "ai_review": 10.0, "reporting": 2.0},
        )

        # Quality assessment
        assert report.executive_summary.quality_label == QualityLabel.EXCELLENT
        assert report.executive_summary.recommended_action == RecommendedAction.APPROVE

        # Render and write
        content = formatter.format(report)
        formatter.write_to_file(content, output_paths.markdown_path)

        # Verify file
        assert output_paths.markdown_path.exists()
        text = output_paths.markdown_path.read_text(encoding="utf-8")
        assert len(text) > 100
        assert "my-app" in text
        assert "Excellent" in text
        assert "Consider Adding Retry Logic" in text
        assert "Circuit Breaker Pattern" in text
        assert "Missing Rate Limit Documentation" in text

    def test_critical_design_produces_poor_markdown(
        self, review_result_critical, project_info, output_paths
    ):
        builder = ReportBuilder()
        formatter = MarkdownFormatter()

        report = builder.build_report(
            review_result=review_result_critical,
            project_info=project_info,
            execution_time=45.0,
            _stage_timings={"ai_review": 40.0, "reporting": 5.0},
        )

        assert report.executive_summary.quality_label == QualityLabel.POOR
        assert (
            report.executive_summary.recommended_action
            == RecommendedAction.REQUEST_CHANGES
        )
        # 8 critical critiques (4*8=32) + 1 critical gap (4) + 1 high gap (3) = 39
        assert report.executive_summary.quality_score == 39

        content = formatter.format(report)
        formatter.write_to_file(content, output_paths.markdown_path)

        text = output_paths.markdown_path.read_text(encoding="utf-8")
        assert "Poor" in text
        assert "Request Changes" in text
        assert "Critical Security Flaw" in text
        assert "No Authentication" in text

    def test_partial_results_produce_valid_markdown(
        self, review_result_partial, project_info, output_paths
    ):
        builder = ReportBuilder()
        formatter = MarkdownFormatter()

        report = builder.build_report(
            review_result=review_result_partial,
            project_info=project_info,
            execution_time=5.0,
            _stage_timings={"ai_review": 4.0},
        )

        assert report.alternative_suggestions == []
        assert report.gap_findings == []
        assert len(report.critique_findings) == 1

        content = formatter.format(report)
        formatter.write_to_file(content, output_paths.markdown_path)

        text = output_paths.markdown_path.read_text(encoding="utf-8")
        assert "Hardcoded Config" in text
        # Agent status should show failure
        assert "Failed" in text

    def test_top_findings_deduplication_in_rendered_output(
        self, review_result_critical, project_info, output_paths
    ):
        builder = ReportBuilder()
        formatter = MarkdownFormatter()

        report = builder.build_report(
            review_result=review_result_critical,
            project_info=project_info,
            execution_time=10.0,
            _stage_timings={},
        )

        # Should have max 5 top findings despite 10 total findings
        assert len(report.executive_summary.top_findings) <= 5

        content = formatter.format(report)
        # Executive summary section should have numbered findings
        assert "1." in content


class TestReportBuilderToHTML:
    """ReportBuilder → HTMLFormatter → file output."""

    def test_healthy_design_produces_valid_html(
        self, review_result_healthy, project_info, output_paths
    ):
        builder = ReportBuilder()
        formatter = HTMLFormatter()

        report = builder.build_report(
            review_result=review_result_healthy,
            project_info=project_info,
            execution_time=12.5,
            _stage_timings={"ai_review": 10.0},
        )

        content = formatter.format(report)
        formatter.write_to_file(content, output_paths.html_path)

        assert output_paths.html_path.exists()
        html = output_paths.html_path.read_text(encoding="utf-8")

        # Structure
        assert "<!DOCTYPE html>" in html or "<html" in html.lower()
        assert "</html>" in html
        assert "<style" in html
        assert "<script" in html

        # Content
        assert "my-app" in html
        assert "Consider Adding Retry Logic" in html
        assert "severity-low" in html

    def test_critical_design_has_severity_colors(
        self, review_result_critical, project_info, output_paths
    ):
        builder = ReportBuilder()
        formatter = HTMLFormatter()

        report = builder.build_report(
            review_result=review_result_critical,
            project_info=project_info,
            execution_time=30.0,
            _stage_timings={},
        )

        html = formatter.format(report)
        assert "severity-critical" in html
        assert "severity-high" in html

    def test_html_is_standalone(
        self, review_result_healthy, project_info, output_paths
    ):
        """HTML report should be self-contained with embedded CSS/JS."""
        builder = ReportBuilder()
        formatter = HTMLFormatter()

        report = builder.build_report(
            review_result=review_result_healthy,
            project_info=project_info,
            execution_time=5.0,
            _stage_timings={},
        )

        html = formatter.format(report)
        # No external stylesheet links
        assert 'rel="stylesheet"' not in html
        # CSS is inline
        assert "<style>" in html or "<style " in html
        # JS is inline
        assert "<script>" in html or "<script " in html


class TestBothFormatsProduced:
    """Verify both MD and HTML can be produced from the same ReportData."""

    def test_both_formats_from_same_report(
        self, review_result_healthy, project_info, output_paths
    ):
        builder = ReportBuilder()
        md_formatter = MarkdownFormatter()
        html_formatter = HTMLFormatter()

        report = builder.build_report(
            review_result=review_result_healthy,
            project_info=project_info,
            execution_time=10.0,
            _stage_timings={"ai_review": 8.0},
        )

        md_content = md_formatter.format(report)
        html_content = html_formatter.format(report)

        md_formatter.write_to_file(md_content, output_paths.markdown_path)
        html_formatter.write_to_file(html_content, output_paths.html_path)

        assert output_paths.markdown_path.exists()
        assert output_paths.html_path.exists()
        assert output_paths.markdown_path.stat().st_size > 0
        assert output_paths.html_path.stat().st_size > 0

        # Both contain the same finding data
        md_text = output_paths.markdown_path.read_text(encoding="utf-8")
        html_text = output_paths.html_path.read_text(encoding="utf-8")
        assert "Consider Adding Retry Logic" in md_text
        assert "Consider Adding Retry Logic" in html_text

    def test_metadata_consistent_across_formats(
        self, review_result_healthy, project_info, output_paths
    ):
        builder = ReportBuilder()

        report = builder.build_report(
            review_result=review_result_healthy,
            project_info=project_info,
            execution_time=10.0,
            _stage_timings={},
        )

        md = MarkdownFormatter().format(report)
        html = HTMLFormatter().format(report)

        # Both contain project name and version
        for content in [md, html]:
            assert "my-app" in content
            assert "0.1.0" in content


class TestCustomThresholds:
    """Verify custom quality thresholds work end-to-end."""

    def test_strict_thresholds_change_quality_label(
        self, review_result_healthy, project_info
    ):
        """With strict thresholds, even 2 low findings should be 'Good' not 'Excellent'."""
        strict = QualityThresholds(
            excellent_max_score=1,
            good_max_score=5,
            needs_improvement_max_score=10,
        )
        builder = ReportBuilder(quality_thresholds=strict)

        report = builder.build_report(
            review_result=review_result_healthy,
            project_info=project_info,
            execution_time=5.0,
            _stage_timings={},
        )

        # 2 low findings = score 2, strict excellent_max=1, so should be Good
        assert report.executive_summary.quality_score == 2
        assert report.executive_summary.quality_label == QualityLabel.GOOD

    def test_lenient_thresholds_change_quality_label(
        self, review_result_critical, project_info
    ):
        """With lenient thresholds, critical findings might only be 'Needs Improvement'."""
        lenient = QualityThresholds(
            excellent_max_score=20,
            good_max_score=35,
            needs_improvement_max_score=50,
        )
        builder = ReportBuilder(quality_thresholds=lenient)

        report = builder.build_report(
            review_result=review_result_critical,
            project_info=project_info,
            execution_time=30.0,
            _stage_timings={},
        )

        # Score is 39, good_max=35, needs_improvement_max=50
        assert report.executive_summary.quality_label == QualityLabel.NEEDS_IMPROVEMENT
