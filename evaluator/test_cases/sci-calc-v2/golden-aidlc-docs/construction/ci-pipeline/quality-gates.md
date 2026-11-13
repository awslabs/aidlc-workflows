# Quality Gates

## Gates (all must pass before merge)

| Gate | Command | Threshold |
|------|---------|-----------|
| Lint | `uv run ruff check .` | 0 errors |
| Format | `uv run ruff format --check .` | 0 reformats needed |
| Tests | `uv run pytest` | All pass |
| Coverage | `uv run pytest --cov=sci_calc --cov-fail-under=90` | >= 90% |

## Current Status

All gates pass as of code-generation completion.
