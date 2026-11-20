# Security Test Instructions

## MVP Security Verification

| Check | Method | Status |
|-------|--------|--------|
| Input validation | Pydantic rejects invalid types (tested) | Pass |
| No secret exposure | No secrets in codebase | Pass |
| Error info disclosure | Error handlers return generic messages only (tested) | Pass |
| No dependencies with known CVEs | uv audit (if available) | N/A (fresh install) |

## Automated Security Checks

```bash
cd sci-calc
uv run ruff check .  # Catches common security anti-patterns
```

No additional security testing needed for MVP (no auth, no DB, no user input beyond math operations).
