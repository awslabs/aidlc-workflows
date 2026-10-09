# CI/CD Pipeline

## MVP: Local Testing Only

No CI/CD pipeline for MVP. Quality gates are:
```bash
uv run pytest                          # Tests + coverage
uv run ruff check . && uv run ruff format --check .  # Lint + format
```

## Future CI Path (informational)

GitHub Actions or equivalent:
1. Checkout → install uv → uv sync
2. ruff check + format check
3. pytest with coverage (fail if < 90%)
4. Build package (hatchling)
