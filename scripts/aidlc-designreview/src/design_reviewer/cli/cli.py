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
CLI entry point — Click-based command-line interface.

Pattern 5.7: Minimal CLI that delegates to Application.
"""

import sys
from pathlib import Path

import click

__version__ = "0.1.0"


@click.command()
@click.option(
    "--aidlc-docs",
    required=True,
    type=click.Path(exists=True),
    help="Path to aidlc-docs folder containing design artifacts.",
)
@click.option(
    "--output",
    required=False,
    type=click.Path(),
    default=None,
    help="Base path for report output (default: ./review). Generates .md and .html.",
)
@click.option(
    "--config",
    required=False,
    type=click.Path(),
    default=None,
    help="Path to config.yaml (default: ./config.yaml).",
)
@click.version_option(version=__version__, prog_name="design-reviewer")
def main(aidlc_docs: str, output: str | None, config: str | None) -> None:
    """AI-powered design review tool for AIDLC projects."""
    from .application import Application

    app = Application(config_path=config)
    exit_code = app.run(
        aidlc_docs=Path(aidlc_docs),
        output=output,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
