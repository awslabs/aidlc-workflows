# Discovered Rules

## Mandated (from tech-env.md HARD CONSTRAINT)

1. Use Python 3.13 with `requires-python = ">=3.13"`
2. Use uv exclusively for package management
3. Use FastAPI + Pydantic v2 + uvicorn
4. Use hatchling as build backend
5. Use ruff for linting/formatting (line-length 100, target py313)
6. Use pytest + pytest-asyncio + httpx for testing
7. Follow exact project structure from tech-env.md

## Forbidden (from tech-env.md)

1. No Flask, Django
2. No requests library (use httpx)
3. No sympy
4. No pandas, numpy
5. No pip, poetry, pipenv
6. No black, flake8, isort

## Quality Gates

1. >= 90% line coverage (pytest-cov)
2. Results match Python math stdlib to <= 1 ULP
3. p95 latency < 50ms
4. Startup < 2 seconds
