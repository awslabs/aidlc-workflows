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
Shared Jinja2 template environment for report rendering.

Pattern 5.2: Single Environment with select_autoescape and custom filters.
Templates loaded via importlib.resources (D2.1=A).
"""

import importlib.resources  # nosemgrep: python37-compatibility-importlib2 — project requires Python 3.12+
from typing import Any, Optional

from jinja2 import BaseLoader, Environment, TemplateNotFound, select_autoescape


class ResourceLoader(BaseLoader):
    """Custom Jinja2 loader that reads templates via importlib.resources."""

    def get_source(
        self, _environment: Environment, template: str
    ) -> tuple[str, Optional[str], Any]:
        package = importlib.resources.files("design_reviewer.reporting.templates")
        resource = package.joinpath(template)
        try:
            source = resource.read_text(encoding="utf-8")
        except (FileNotFoundError, TypeError) as exc:
            raise TemplateNotFound(template) from exc
        return source, template, lambda: True


def markdown_escape(value: str) -> str:
    """Escape special characters for markdown output (BR-5.12)."""
    if not isinstance(value, str):
        return str(value)
    value = value.replace("|", "\\|")
    value = value.replace("<", "&lt;")
    value = value.replace(">", "&gt;")
    return value


def severity_color(severity: str) -> str:
    """Map severity level to CSS color class (BR-5.17)."""
    colors = {
        "critical": "severity-critical",
        "high": "severity-high",
        "medium": "severity-medium",
        "low": "severity-low",
    }
    return colors.get(str(severity).lower(), "severity-low")


def _create_environment() -> Environment:
    """Create and configure the shared Jinja2 Environment."""
    env = Environment(  # nosemgrep: direct-use-of-jinja2 — CLI tool, not Flask; autoescape configured via select_autoescape below
        loader=ResourceLoader(),
        autoescape=select_autoescape(
            enabled_extensions=("html.jinja2",),
            default_for_string=False,
        ),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["markdown_escape"] = markdown_escape
    env.filters["severity_color"] = severity_color
    return env


_environment: Optional[Environment] = None


def get_environment() -> Environment:
    """Get the shared Jinja2 Environment (lazy singleton)."""
    global _environment
    if _environment is None:
        _environment = _create_environment()
    return _environment


def reset_environment() -> None:
    """Reset the shared environment (for testing)."""
    global _environment
    _environment = None
