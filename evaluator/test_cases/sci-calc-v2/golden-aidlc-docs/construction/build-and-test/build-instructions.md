# Build Instructions

## Prerequisites

- Python 3.13
- uv (package manager)

## Build Steps

```bash
cd sci-calc
uv sync                    # Install all dependencies
uv run ruff check .        # Lint check
uv run ruff format --check .  # Format check
uv run pytest --cov=sci_calc  # Run tests with coverage
```

## Build Verification

- `uv sync` exits 0 (all dependencies resolved)
- `uv run ruff check .` exits 0 (no lint errors)
- `uv run ruff format --check .` exits 0 (all formatted)
- `uv run pytest` exits 0 (all tests pass)
- Coverage report shows >= 90%
