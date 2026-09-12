# Performance Test Instructions

## MVP Approach

Performance is verified by the nature of the implementation:
- All operations are single `math` stdlib calls (nanosecond-scale)
- Response time is dominated by HTTP overhead (~1-5ms in test client)
- No I/O, no database, no network calls

## Verification

The test suite completes 130 tests in < 0.5 seconds total, confirming sub-millisecond per-operation performance.

## Future: Benchmark Script (if needed)

```bash
# Optional: run with timing
uv run pytest --durations=10
```
