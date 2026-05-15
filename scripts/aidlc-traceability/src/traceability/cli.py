# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""CLI entry point for the AIDLC Traceability Matrix Tool."""

from __future__ import annotations

from pathlib import Path

import click

from traceability import __version__


@click.group()
@click.version_option(version=__version__)
def cli():
    """AIDLC Traceability Matrix Tool - Generate traceability matrices from AI-DLC artifacts."""
    pass


@cli.command()
@click.option("--input", "input_path", type=click.Path(exists=True), default=".", help="Path to project root (default: current directory)")
@click.option("--output", "output_dir", type=click.Path(), default=None, help="Output directory (default: project root)")
@click.option("--format", "fmt", type=click.Choice(["markdown", "html", "both"]), default="markdown", help="Output format")
@click.option("--no-ai", is_flag=True, default=False, help="Skip AI-powered analysis")
@click.option("--profile", default=None, help="AWS profile for Amazon Bedrock (uses default credential chain if not set)")
@click.option("--region", default="us-east-1", help="AWS region for Amazon Bedrock")
@click.option("--verbose", is_flag=True, default=False, help="Enable detailed logging")
def generate(input_path: str, output_dir: str | None, fmt: str, no_ai: bool, profile: str, region: str, verbose: bool):
    """Generate a traceability matrix from AIDLC artifacts."""
    from traceability.pipeline import run_pipeline

    project_root = Path(input_path).resolve()

    # Determine output directory
    if output_dir:
        output_directory = Path(output_dir).resolve()
        output_directory.mkdir(parents=True, exist_ok=True)
    else:
        output_directory = project_root

    if fmt == "both":
        # Generate both formats
        md_path = output_directory / "traceability-matrix.md"
        html_path = output_directory / "traceability-matrix.html"

        run_pipeline(
            project_root=project_root,
            output_paths=[md_path, html_path],
            output_format="both",
            use_ai=not no_ai,
            aws_profile=profile,
            aws_region=region,
            verbose=verbose,
        )
    else:
        # Single format
        ext = "html" if fmt == "html" else "md"
        output_path = output_directory / f"traceability-matrix.{ext}"

        run_pipeline(
            project_root=project_root,
            output_paths=[output_path],
            output_format=fmt,
            use_ai=not no_ai,
            aws_profile=profile,
            aws_region=region,
            verbose=verbose,
        )


if __name__ == "__main__":
    cli()
