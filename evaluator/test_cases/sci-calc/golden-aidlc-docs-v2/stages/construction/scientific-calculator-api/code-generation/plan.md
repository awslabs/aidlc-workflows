# Plan: Code Generation — scientific-calculator-api

## Context

Implementing the full scientific calculator API per functional-design and nfr-design artifacts. Single FastAPI application with pure computation engines.

## Artifact Resolution

- **Functional design:** `stages/construction/scientific-calculator-api/functional-design/entities.yaml`, `rules.yaml`, `api-specification.md`
- **NFR design:** `stages/construction/scientific-calculator-api/nfr-design/nfr-specification.md` (Python 3.11+, FastAPI, Pydantic v2, pytest)
- **Secondary:** `requirements.md`, `stories.md`, `intent.md`

## Steps

- [x] Project setup: pyproject.toml, app package structure, verify clean install
- [x] Domain layer: exceptions.py, response helpers, models (Pydantic request/response schemas)
- [x] Engines layer: arithmetic, powers, trigonometry, logarithmic, statistics, constants, conversions
- [x] Error handling: custom exceptions + global handlers
- [x] Routers layer: all API endpoints per api-specification.md
- [x] Main app: FastAPI application assembly with exception handlers
- [x] Tests: conftest + unit tests for all engines + integration tests for API endpoints
- [x] Verify: full test suite passes, coverage ≥90%
- [x] Write implementation-map.md
