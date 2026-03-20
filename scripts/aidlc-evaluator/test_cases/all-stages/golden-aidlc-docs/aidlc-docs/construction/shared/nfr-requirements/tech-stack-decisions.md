# Tech Stack Decisions — Both Services

## Core Stack

| Technology | Version | Purpose |
|---|---|---|
| Python | 3.13+ | Runtime |
| FastAPI | 0.115+ | REST API framework |
| Pydantic | 2.x | Request/response validation |
| uvicorn | 0.34+ | ASGI server |
| PyJWT | 2.x | JWT generation and validation |
| passlib[bcrypt] | 1.7+ | Password hashing |
| httpx | 0.28+ | HTTP client (Lending → Catalog, test client) |

## Testing Stack

| Technology | Version | Purpose |
|---|---|---|
| pytest | 8.x | Test runner |
| pytest-asyncio | 0.24+ | Async test support |
| pytest-cov | 6.x | Coverage reporting |
| httpx | 0.28+ | AsyncClient for integration tests |

## Development Tools

| Technology | Version | Purpose |
|---|---|---|
| uv | latest | Package management |
| ruff | 0.9+ | Linting + formatting |

## Database Strategy

| Layer | Technology | Purpose |
|---|---|---|
| Repository Interface | Abstract base class | Define data access contract |
| MVP Implementation | In-memory (Python dict) | Zero-dependency development/testing |
| Future Production | DynamoDB or PostgreSQL | Cloud deployment (Phase 2) |

## Prohibited Technologies (per tech-env.md)

| Prohibited | Use Instead |
|---|---|
| Flask, Django | FastAPI |
| requests | httpx |
| pandas, numpy | Standard Python |
| pip, poetry, pipenv | uv |
| black, flake8, isort | ruff |
| EC2 (direct) | Lambda or Fargate (future) |
| Elastic Beanstalk | CDK (future) |

## Project Structure

Each service is an independent Python package:
- `catalog-service/` — pyproject.toml, src/catalog_service/, tests/
- `lending-service/` — pyproject.toml, src/lending_service/, tests/

Both use `uv` as the package manager with `pyproject.toml` for dependency specification.
