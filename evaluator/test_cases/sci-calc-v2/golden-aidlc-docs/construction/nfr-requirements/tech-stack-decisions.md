# Tech Stack Decisions

## Decided (HARD CONSTRAINT from tech-env.md)

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | Python 3.13 | Prescribed |
| Package manager | uv | Prescribed |
| Web framework | FastAPI | Prescribed |
| Validation | Pydantic v2 | Prescribed (comes with FastAPI) |
| Server | uvicorn | Prescribed |
| Build backend | hatchling | Prescribed |
| Test runner | pytest | Prescribed |
| Async test client | httpx | Prescribed |
| Coverage | pytest-cov | Prescribed |
| Linter/formatter | ruff | Prescribed |
| Math library | Python stdlib (math, statistics) | Prescribed (no numpy/sympy) |

## No Decisions to Make

The tech stack is fully prescribed by tech-env.md. There are no technology choices left open for this project.
