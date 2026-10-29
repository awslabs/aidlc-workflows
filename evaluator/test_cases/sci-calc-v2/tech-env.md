# Technical Environment: Scientific Calculator API

## Language and Package Manager

- **Python 3.13**
- **uv** for all package management (no pip, poetry, or conda)
- `pyproject.toml` for project and tool configuration

## Web Framework

- **FastAPI** with Pydantic v2 for request/response validation
- **uvicorn** as the ASGI server

## Project Structure

```
sci-calc/
├── pyproject.toml
├── src/
│   └── sci_calc/
│       ├── __init__.py
│       ├── app.py
│       ├── routes/
│       │   ├── __init__.py
│       │   ├── arithmetic.py
│       │   ├── trigonometry.py
│       │   ├── logarithmic.py
│       │   ├── powers.py
│       │   ├── statistics.py
│       │   ├── constants.py
│       │   └── conversions.py
│       ├── models/
│       │   ├── __init__.py
│       │   ├── requests.py
│       │   └── responses.py
│       └── engine/
│           ├── __init__.py
│           └── math_engine.py
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_arithmetic.py
    ├── test_trigonometry.py
    ├── test_logarithmic.py
    ├── test_powers.py
    ├── test_statistics.py
    ├── test_constants.py
    └── test_conversions.py
```

## Testing

- **pytest** with pytest-asyncio and httpx (async test client)
- **pytest-cov** with 90% line coverage minimum
- Unit tests exercise `math_engine.py` directly with known-value tables
- Integration tests use `httpx.AsyncClient` with FastAPI TestClient
- Boundary tests verify every domain constraint produces the correct error code
- Run command: `uv run pytest`

## Linting and Formatting

- **ruff** (line-length 100, target py313)

## Build Backend

- **hatchling**

## Do NOT Use

| Prohibited | Reason | Use Instead |
|-----------|--------|-------------|
| Flask, Django | Project uses FastAPI | FastAPI |
| requests | Blocks async event loop | httpx |
| sympy | Too heavy for this scope | Python `math` stdlib |
| pandas, numpy | Not needed for single calculations | Standard Python |
| pip, poetry, pipenv | Project uses uv exclusively | uv |
| black, flake8, isort | Replaced by ruff | ruff |

## Non-Functional Requirements

| Requirement | Target |
|---|---|
| Startup time | < 2 seconds |
| Response latency (p95) | < 50ms for any single operation |
| Test coverage | >= 90% line coverage |
| Floating-point agreement | Results match Python `math` stdlib to <= 1 ULP |
| Max request body size | 1 MB |
| Python version | 3.13.x (enforced via `requires-python = ">=3.13"`) |

## Development Workflow

```bash
uv sync
uv run uvicorn sci_calc.app:app --reload --port 8000
uv run pytest
uv run ruff check . && uv run ruff format .
```
