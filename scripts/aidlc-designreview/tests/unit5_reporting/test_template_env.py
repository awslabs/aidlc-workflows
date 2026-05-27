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
Tests for Unit 5 template environment.

Tests Environment creation, custom filters (markdown_escape, severity_color),
select_autoescape behavior, and lazy singleton.
"""

import pytest
from jinja2 import Environment, TemplateNotFound

from design_reviewer.reporting.template_env import (
    ResourceLoader,
    get_environment,
    markdown_escape,
    reset_environment,
    severity_color,
)


@pytest.fixture(autouse=True)
def clean_environment():
    """Reset the singleton environment before and after each test."""
    reset_environment()
    yield
    reset_environment()


class TestMarkdownEscapeFilter:
    def test_escapes_pipes(self):
        assert markdown_escape("col1|col2") == "col1\\|col2"

    def test_escapes_angle_brackets(self):
        assert markdown_escape("<tag>") == "&lt;tag&gt;"

    def test_no_change_for_plain_text(self):
        assert markdown_escape("hello world") == "hello world"

    def test_non_string_input(self):
        assert markdown_escape(42) == "42"

    def test_empty_string(self):
        assert markdown_escape("") == ""

    def test_combined_escapes(self):
        result = markdown_escape("a|b<c>d")
        assert result == "a\\|b&lt;c&gt;d"


class TestSeverityColorFilter:
    def test_critical(self):
        assert severity_color("critical") == "severity-critical"

    def test_high(self):
        assert severity_color("high") == "severity-high"

    def test_medium(self):
        assert severity_color("medium") == "severity-medium"

    def test_low(self):
        assert severity_color("low") == "severity-low"

    def test_unknown_defaults_to_low(self):
        assert severity_color("unknown") == "severity-low"

    def test_case_insensitive(self):
        assert severity_color("CRITICAL") == "severity-critical"
        assert severity_color("High") == "severity-high"

    def test_strenum_input(self):
        from design_reviewer.ai_review.models import Severity

        assert severity_color(Severity.CRITICAL) == "severity-critical"


class TestResourceLoader:
    def test_loads_markdown_template(self):
        loader = ResourceLoader()
        env = Environment(loader=loader)  # nosec B701 — no autoescape needed; testing ResourceLoader.get_source(), not rendering
        source, filename, uptodate = loader.get_source(env, "markdown_report.jinja2")
        assert "Design Review Report" in source or "metadata" in source.lower()
        assert filename == "markdown_report.jinja2"
        assert uptodate()

    def test_loads_html_template(self):
        loader = ResourceLoader()
        env = Environment(loader=loader)  # nosec B701 — no autoescape needed; testing ResourceLoader.get_source(), not rendering
        source, filename, _ = loader.get_source(env, "html_report.jinja2")
        assert "<html" in source.lower() or "<!doctype" in source.lower()

    def test_missing_template_raises(self):
        loader = ResourceLoader()
        env = Environment(loader=loader)  # nosec B701 — no autoescape needed; testing TemplateNotFound exception path only
        with pytest.raises(TemplateNotFound):
            loader.get_source(env, "nonexistent.jinja2")


class TestGetEnvironment:
    def test_returns_environment(self):
        env = get_environment()
        assert isinstance(env, Environment)

    def test_singleton_returns_same_instance(self):
        env1 = get_environment()
        env2 = get_environment()
        assert env1 is env2

    def test_reset_creates_new_instance(self):
        env1 = get_environment()
        reset_environment()
        env2 = get_environment()
        assert env1 is not env2

    def test_has_markdown_escape_filter(self):
        env = get_environment()
        assert "markdown_escape" in env.filters

    def test_has_severity_color_filter(self):
        env = get_environment()
        assert "severity_color" in env.filters

    def test_trim_blocks_enabled(self):
        env = get_environment()
        assert env.trim_blocks is True

    def test_lstrip_blocks_enabled(self):
        env = get_environment()
        assert env.lstrip_blocks is True

    def test_can_load_markdown_template(self):
        env = get_environment()
        template = env.get_template("markdown_report.jinja2")
        assert template is not None

    def test_can_load_html_template(self):
        env = get_environment()
        template = env.get_template("html_report.jinja2")
        assert template is not None
