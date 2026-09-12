# Team Practices

## Build & Package Management

- **uv** is the sole package manager — no pip, poetry, or conda
- All dependencies managed via `pyproject.toml`
- Build backend: hatchling

## Code Style

- **ruff** for linting and formatting (line-length 100, target py313)
- No black, flake8, or isort
- Python naming conventions (snake_case)

## Testing

- **pytest** as the test runner
- pytest-asyncio for async test support
- httpx AsyncClient for integration tests
- pytest-cov for coverage reporting (>= 90% line coverage)
- Run command: `uv run pytest`

## Project Structure

- src-layout (`src/sci_calc/`)
- Route modules per domain (arithmetic, trigonometry, etc.)
- Separate models directory (requests.py, responses.py)
- Separate engine directory (math_engine.py)
- Tests at top-level `tests/` directory

## Development Workflow

- `uv sync` to install dependencies
- `uv run uvicorn sci_calc.app:app --reload --port 8000` for dev server
- `uv run pytest` for tests
- `uv run ruff check . && uv run ruff format .` for linting

## API Conventions

- All endpoints accept/return `application/json`
- Structured response envelope for both success and error
- URL-versioned API (`/api/v1/...`)
- RESTful: GET for reads, POST for calculations
