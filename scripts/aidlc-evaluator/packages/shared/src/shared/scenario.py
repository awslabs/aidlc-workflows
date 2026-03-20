"""Scenario discovery and loading for the AIDLC evaluation framework.

Each test case directory (e.g., test_cases/sci-calc/) contains a
``scenario.yaml`` manifest that describes the scenario's inputs and
golden-baseline artifacts.  This module provides helpers to load,
list, and resolve scenarios by name or path.
"""

from __future__ import annotations

import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

import yaml

logger = logging.getLogger(__name__)


@dataclass
class Scenario:
    """Parsed representation of a scenario.yaml manifest."""

    name: str
    description: str = ""
    status: str = "active"
    path: Path = field(default_factory=lambda: Path("."))

    # Relative file names within the scenario directory
    vision: str = "vision.md"
    tech_env: str = "tech-env.md"
    openapi: str = "openapi.yaml"
    golden_baseline: str = "golden.yaml"
    golden_aidlc_docs: str = "golden-aidlc-docs/"

    tags: list[str] = field(default_factory=list)

    # Resolved absolute paths (populated by load_scenario)
    @property
    def vision_path(self) -> Path:
        return self.path / self.vision

    @property
    def tech_env_path(self) -> Path:
        return self.path / self.tech_env

    @property
    def openapi_path(self) -> Path:
        return self.path / self.openapi

    @property
    def golden_baseline_path(self) -> Path:
        return self.path / self.golden_baseline

    @property
    def golden_aidlc_docs_path(self) -> Path:
        return self.path / self.golden_aidlc_docs


def load_scenario(test_case_path: Path) -> Scenario:
    """Load and validate a scenario.yaml from a test case directory.

    Parameters
    ----------
    test_case_path:
        Path to the test case directory (e.g., ``test_cases/sci-calc``).

    Returns
    -------
    Scenario
        Parsed scenario with ``path`` set to *test_case_path*.

    Raises
    ------
    FileNotFoundError
        If ``scenario.yaml`` does not exist in *test_case_path*.
    ValueError
        If the manifest is missing required fields.
    """
    manifest = test_case_path / "scenario.yaml"
    if not manifest.is_file():
        raise FileNotFoundError(f"scenario.yaml not found in {test_case_path}")

    with open(manifest, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    name = data.get("name")
    if not name:
        raise ValueError(f"scenario.yaml in {test_case_path} is missing 'name'")

    scenario = Scenario(
        name=name,
        description=data.get("description", ""),
        status=data.get("status", "active"),
        path=test_case_path.resolve(),
        vision=data.get("vision", "vision.md"),
        tech_env=data.get("tech_env", "tech-env.md"),
        openapi=data.get("openapi", "openapi.yaml"),
        golden_baseline=data.get("golden_baseline", "golden.yaml"),
        golden_aidlc_docs=data.get("golden_aidlc_docs", "golden-aidlc-docs/"),
        tags=data.get("tags", []),
    )

    # Validate that critical files exist early rather than failing
    # deep in the pipeline with a generic "file not found"
    if not scenario.vision_path.is_file():
        logger.warning("Scenario %r: vision file missing: %s", name, scenario.vision_path)
    if not scenario.golden_aidlc_docs_path.is_dir():
        logger.warning(
            "Scenario %r: golden aidlc-docs directory missing: %s — "
            "qualitative evaluation will fail",
            name, scenario.golden_aidlc_docs_path,
        )

    return scenario


def list_scenarios(test_cases_dir: Path) -> list[Scenario]:
    """Discover all scenarios under a test_cases/ directory.

    Scans ``test_cases_dir/*/scenario.yaml`` and returns a list of
    parsed :class:`Scenario` objects sorted by name.
    """
    scenarios: list[Scenario] = []
    if not test_cases_dir.is_dir():
        return scenarios

    for child in sorted(test_cases_dir.iterdir()):
        if not child.is_dir():
            continue
        manifest = child / "scenario.yaml"
        if manifest.is_file():
            try:
                scenarios.append(load_scenario(child))
            except (ValueError, yaml.YAMLError) as exc:
                # Skip malformed manifests but warn
                import sys
                print(f"[WARN] Skipping {child.name}: {exc}", file=sys.stderr)

    return scenarios


def resolve_scenario(
    name_or_path: str,
    test_cases_dir: Path,
) -> Scenario:
    """Resolve a scenario name or path to a :class:`Scenario`.

    *name_or_path* is interpreted as:

    1. An absolute or relative path to a test-case directory containing
       ``scenario.yaml``.
    2. A short name (e.g., ``"sci-calc"``) that maps to
       ``<test_cases_dir>/<name>/scenario.yaml``.

    Parameters
    ----------
    name_or_path:
        Scenario name or path.
    test_cases_dir:
        Root directory containing all test case sub-directories.

    Raises
    ------
    FileNotFoundError
        If the scenario cannot be found.
    """
    candidate = Path(name_or_path)

    # If it's an existing directory with a scenario.yaml, use it directly
    if candidate.is_dir() and (candidate / "scenario.yaml").is_file():
        scenario = load_scenario(candidate)
        if scenario.status == "draft":
            logger.warning(
                "Scenario %r is marked as draft — golden baseline and some "
                "artifacts may be missing",
                scenario.name,
            )
        return scenario

    # Try as a name under test_cases_dir
    by_name = test_cases_dir / name_or_path
    if by_name.is_dir() and (by_name / "scenario.yaml").is_file():
        scenario = load_scenario(by_name)
        if scenario.status == "draft":
            logger.warning(
                "Scenario %r is marked as draft — golden baseline and some "
                "artifacts may be missing",
                scenario.name,
            )
        return scenario

    raise FileNotFoundError(
        f"Scenario '{name_or_path}' not found. Looked in:\n"
        f"  - {candidate}\n"
        f"  - {by_name}\n"
        f"Available scenarios: {', '.join(s.name for s in list_scenarios(test_cases_dir))}"
    )
