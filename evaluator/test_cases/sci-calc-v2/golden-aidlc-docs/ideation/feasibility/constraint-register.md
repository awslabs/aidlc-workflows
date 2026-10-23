# Constraint Register

## Hard Constraints (from tech-env.md)

| ID | Category | Constraint | Source |
|----|----------|-----------|--------|
| C1 | Language | Python 3.13 only | tech-env.md |
| C2 | Framework | FastAPI with Pydantic v2 | tech-env.md |
| C3 | Package Manager | uv exclusively (no pip, poetry, conda) | tech-env.md |
| C4 | Build Backend | hatchling | tech-env.md |
| C5 | Testing | pytest with pytest-asyncio and httpx | tech-env.md |
| C6 | Linting | ruff only (no black, flake8, isort) | tech-env.md |
| C7 | Server | uvicorn ASGI | tech-env.md |
| C8 | Prohibited | No Flask, Django, requests, sympy, pandas, numpy | tech-env.md |
| C9 | Structure | Exact directory layout as specified in tech-env.md | tech-env.md |
| C10 | Coverage | >= 90% line coverage | tech-env.md, vision.md |

## Soft Constraints (from vision.md)

| ID | Category | Constraint | Source |
|----|----------|-----------|--------|
| S1 | Precision | Results match Python math stdlib to <= 1 ULP | vision.md |
| S2 | Performance | p95 latency < 50ms per operation | vision.md |
| S3 | Startup | < 2 seconds | tech-env.md |
| S4 | Request size | Max 1 MB request body | tech-env.md |
| S5 | Versioning | API versioned via /api/v1/ URL prefix | vision.md |
