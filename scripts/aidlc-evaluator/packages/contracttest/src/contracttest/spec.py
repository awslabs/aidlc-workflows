"""Load an OpenAPI 3.x specification and derive executable test cases.

The spec is a first-class project input (alongside vision.md and tech-env.md).
Each path/operation may contain an ``x-test-cases`` extension that carries
explicit inputs and expected outputs.  The loader walks every path + method,
collects those extensions, and returns a flat list of ``TestCase`` objects
ready for the runner.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")


@dataclass
class AppConfig:
    """How to start the generated server."""
    module: str
    framework: str = "fastapi"
    startup_timeout: int = 15
    port: int = 0


@dataclass
class TestCase:
    """A single request → expected response assertion."""
    name: str
    method: str
    path: str
    expected_status: int
    body: dict[str, Any] | None = None
    expected_body: dict[str, Any] | None = None
    operation_id: str | None = None
    skip: bool = False


@dataclass
class ContractSpec:
    """Parsed OpenAPI spec ready for the contract test runner."""
    app: AppConfig
    test_cases: list[TestCase] = field(default_factory=list)
    title: str = ""
    version: str = ""


def load_spec(path: Path) -> ContractSpec:
    """Load an OpenAPI YAML spec and return a ContractSpec.

    Reads the ``x-app`` top-level extension for server configuration and
    walks every ``paths`` entry to collect ``x-test-cases`` extensions.
    """
    with open(path, encoding="utf-8") as f:
        doc = yaml.safe_load(f) or {}

    # ── app config (x-app extension or sensible defaults) ──────────
    x_app = doc.get("x-app", {})
    app = AppConfig(
        module=x_app.get("module", ""),
        framework=x_app.get("framework", "fastapi"),
        startup_timeout=x_app.get("startup_timeout", 15),
        port=x_app.get("port", 0),
    )

    info = doc.get("info", {})
    title = info.get("title", "")
    version = info.get("version", "")

    # ── walk paths and collect test cases ───────────────────────────
    cases: list[TestCase] = []
    for path_str, path_item in (doc.get("paths") or {}).items():
        if not isinstance(path_item, dict):
            continue
        for method in HTTP_METHODS:
            operation = path_item.get(method)
            if not isinstance(operation, dict):
                continue
            op_id = operation.get("operationId")
            for tc in operation.get("x-test-cases", []):
                cases.append(TestCase(
                    name=tc.get("name", f"{method.upper()} {path_str}"),
                    method=method.upper(),
                    path=path_str,
                    expected_status=tc.get("expected_status", 200),
                    body=tc.get("body"),
                    expected_body=tc.get("expected_body"),
                    operation_id=op_id,
                    skip=bool(tc.get("skip", False)),
                ))

    return ContractSpec(app=app, test_cases=cases, title=title, version=version)
