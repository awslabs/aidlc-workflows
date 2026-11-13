# CI Configuration

## MVP: Local Quality Gates

No CI platform configured for MVP. Quality is enforced locally:

```bash
cd sci-calc
uv sync
uv run ruff check .
uv run ruff format --check .
uv run pytest --cov=sci_calc --cov-fail-under=90
```

## Future CI (GitHub Actions example)

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v4
      - run: uv sync
      - run: uv run ruff check .
      - run: uv run ruff format --check .
      - run: uv run pytest --cov=sci_calc --cov-fail-under=90
```
