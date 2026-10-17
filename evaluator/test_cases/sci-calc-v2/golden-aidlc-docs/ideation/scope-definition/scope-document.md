# Scope Document

## Scope: MVP

## In Scope

### Functional Features (from vision.md)

1. **Arithmetic** — add, subtract, multiply, divide, modulo, abs, negate
2. **Powers and Roots** — power, sqrt, cbrt, nth_root, square
3. **Trigonometry** — sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh (degree/radian modes)
4. **Logarithms** — ln, log10, log2, log (arbitrary base), exp
5. **Statistics** — mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count
6. **Constants** — pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10
7. **Unit Conversions** — angle, temperature, length, weight
8. **Health-check endpoint** — GET /health
9. **Structured error responses** — INVALID_INPUT, DIVISION_BY_ZERO, DOMAIN_ERROR, OVERFLOW, NOT_FOUND
10. **Unit and integration tests** — >= 90% line coverage

### Technical Stack (from tech-env.md — HARD CONSTRAINT)

- Python 3.13 with uv
- FastAPI + Pydantic v2 + uvicorn
- pytest + pytest-asyncio + httpx + pytest-cov
- ruff for linting/formatting
- hatchling build backend
- Exact directory structure as specified

## Out of Scope

- Persistent storage or user accounts
- Graphical or terminal UI
- Symbolic/CAS capabilities
- Arbitrary-precision beyond Python's standard `decimal`
- Authentication, rate-limiting, or production hardening
- Expression evaluation from string input
- Operations phase (deployment, observability, incident response)

## Depth

**Standard** — Full ideation, inception, and construction phases. Operations phase skipped per MVP scope.

## Success Criteria

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Test coverage | >= 90% line | pytest-cov report |
| Precision | <= 1 ULP vs math stdlib | Known-value test tables |
| Latency (p95) | < 50ms | Timing assertions or benchmarks |
| Completeness | All vision.md endpoints implemented | Manual verification against endpoint list |
| Startup | < 2 seconds | Timed uvicorn boot |
