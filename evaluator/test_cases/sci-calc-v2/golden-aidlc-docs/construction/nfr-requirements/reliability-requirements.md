# Reliability Requirements

## MVP Reliability Posture

- **No SLA** (development/test use)
- **No persistent state** (nothing to lose on crash)
- **Graceful error handling**: All exceptions caught and returned as structured errors
- **No bare 500s**: Every code path has an error handler

## Error Handling Reliability

| Scenario | Behavior |
|----------|----------|
| Invalid input | 422 with structured error (Pydantic handles) |
| Math domain error | 400 with DOMAIN_ERROR code |
| Overflow | 400 with OVERFLOW code |
| Unknown exception | 500 with INTERNAL_ERROR (logged, never crashes server) |

## Process Reliability

- uvicorn auto-restarts workers on crash (if configured with --workers > 1)
- No external dependencies that can fail (no DB, no cache, no network calls)
- No startup initialization that can fail (beyond Python import)
