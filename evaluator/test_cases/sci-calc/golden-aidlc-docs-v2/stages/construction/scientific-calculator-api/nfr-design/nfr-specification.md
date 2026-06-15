# NFR Specification — scientific-calculator-api

## Quality Targets

| ID | Attribute | Target | Measure | Rationale | Source |
|---|---|---|---|---|---|
| NFR-1 | Correctness | Results match Python math stdlib to ≤1 ULP | Automated tests comparing against math stdlib reference values | Calculator's primary value proposition is correctness | Intent: Success Metrics |
| NFR-2 | Performance | p95 response latency <50ms per operation | Benchmark test with httpx/locust | Stateless compute should be near-instant; 50ms is generous for in-memory math | Intent: Success Metrics |
| NFR-3 | Test coverage | ≥90% line coverage | pytest-cov report | High coverage ensures edge cases and error paths are exercised | Intent: Success Metrics |
| NFR-4 | Statelessness | Zero persistent state between requests | Architecture review: no DB, no session store, no file writes | Simplicity and horizontal scalability | Intent: NFR |
| NFR-5 | Reliability | No bare HTTP 500 responses; all math errors caught and translated | Exception handler middleware; integration tests verify error envelopes | Clear error reporting is a stated priority; consumers need actionable errors | Intent: Error Handling Principles |
| NFR-6 | Versioning | URL prefix versioning (/api/v1) | URL structure verified by tests | Backward compatibility for consumers; enables future breaking changes | Intent: NFR |

## Tech Stack

| Layer | Choice | Rationale | Alternatives Considered |
|---|---|---|---|
| Language | Python 3.11+ | Math stdlib provides all needed computation with correct precision; specified in intent | Node.js (weaker math precision), Go (no compelling advantage for compute API) |
| Framework | FastAPI 0.100+ | Async-capable, Pydantic validation built-in, auto-generates OpenAPI docs, high performance for Python | Flask (no built-in validation, slower), Django (too heavy for stateless API) |
| Validation | Pydantic v2 | Integrated with FastAPI; declarative schema validation with structured error reporting | marshmallow (separate from framework, no advantage), cerberus (less ecosystem) |
| Math backend | Python `math` stdlib | Matches precision requirement (≤1 ULP); no external dependencies needed; sufficient IEEE 754 double precision | numpy (overkill, adds large dependency), decimal (only needed for arbitrary precision, out of scope) |
| Statistics | Python `statistics` stdlib | Provides mean, median, mode, stdev, variance, pstdev, pvariance; no external deps | numpy (unnecessary dependency for this scope) |
| Testing | pytest + pytest-cov + httpx | pytest is standard; pytest-cov for coverage; httpx provides async test client for FastAPI | unittest (verbose), nose2 (less maintained), requests (sync only) |
| Server | uvicorn | Standard ASGI server for FastAPI; fast and production-ready | hypercorn (less common), gunicorn+uvicorn workers (production scaling not in scope) |
| Package manager | pip with pyproject.toml | Standard Python packaging; no need for heavy tooling at this scale | poetry (heavier setup), conda (not needed) |

## Patterns

| Pattern | Satisfies | Applied to | How it works | Trade-off | Failure mode |
|---|---|---|---|---|---|
| Exception-to-envelope mapping | NFR-5 | CMP-007 (API Layer) | Custom exception classes (DomainError, DivisionByZeroError, OverflowError) caught by FastAPI exception handlers and mapped to structured error responses | Slightly more exception classes to maintain | If a new exception type is not handled, it falls to the generic 500 handler |
| Pydantic validation override | NFR-5 | CMP-007 (API Layer) | Override FastAPI's default RequestValidationError handler to return structured error envelope instead of raw 422 Pydantic output | Custom handler setup code required | Falls through to default FastAPI 422 if override fails |
| Response envelope | NFR-5, NFR-6 | All APIs | All responses wrapped in standard {status, operation, inputs, result/error} shape | Slightly larger payloads | None — pure formatting concern |
| Module-per-engine | NFR-3 | All CMPs | Each computation engine is a separate Python module with pure functions — no classes, no state | More files than a single-module approach | None — standard project structure |
| Direct function dispatch | NFR-2 | CMP-007 → CMP-001–006 | Route handlers directly call engine functions (no service layer, no DI container) — minimum overhead | Less flexible for testing mocks (mitigated: functions are independently testable) | None — pure functions remain independently testable |
| Stateless computation | NFR-2, NFR-4 | All services | No I/O, no DB, no network calls — pure math on every request | Cannot cache results across requests | No failure mode for stateless compute |

## API Quality Annotations

| API ID | Latency Target | Timeout | Idempotency | Observability |
|---|---|---|---|---|
| API-001 (arithmetic) | p95 <50ms | N/A (no downstream calls) | Yes (pure function, same input = same output) | Structured logging at ERROR for unexpected exceptions |
| API-002 (powers) | p95 <50ms | N/A | Yes | Structured logging at ERROR for unexpected exceptions |
| API-003 (trigonometry) | p95 <50ms | N/A | Yes | Structured logging at ERROR for unexpected exceptions |
| API-004 (logarithmic) | p95 <50ms | N/A | Yes | Structured logging at ERROR for unexpected exceptions |
| API-005 (statistics) | p95 <50ms | N/A | Yes | Structured logging at ERROR for unexpected exceptions |
| API-006 (conversions) | p95 <50ms | N/A | Yes | Structured logging at ERROR for unexpected exceptions |
| API-007 (constants) | p95 <50ms | N/A | Yes (static data) | None needed |
| API-008 (health) | p95 <10ms | N/A | Yes | None needed |

## Component Quality Annotations

| Component ID | Data Classification | Resiliency Need | Scaling Need | Security Controls |
|---|---|---|---|---|
| CMP-001 (arithmetic) | Public (no sensitive data) | None (stateless, no external deps) | Horizontal (add processes/instances) | Input validation only |
| CMP-002 (powers) | Public | None | Horizontal | Input validation only |
| CMP-003 (trigonometry) | Public | None | Horizontal | Input validation only |
| CMP-004 (logarithmic) | Public | None | Horizontal | Input validation only |
| CMP-005 (statistics) | Public | None | Horizontal | Input validation (including array size) |
| CMP-006 (conversions) | Public | None | Horizontal | Input validation only |
| CMP-007 (API Layer) | Public | Global exception handler for graceful error handling | Horizontal (same as services; single process) | Pydantic validation, error envelope enforcement |

## Trade-offs

| Prioritised | Over | Decision | Rationale |
|---|---|---|---|
| Correctness | Performance | Use Python math stdlib (not optimized numpy/C extensions) | Intent explicitly states correctness over raw throughput; p95 <50ms is trivially achievable with pure Python math |
| Simplicity | Extensibility | Single process, no plugin system, no dynamic dispatch | Fixed MVP scope; adding new operations is a code change, not a config change |
| Clear errors | Terse responses | Verbose error envelopes with input echo | Debugging ease for API consumers; error clarity is a stated NFR |
| Minimal dependencies | Feature richness | Only FastAPI + uvicorn + pydantic + pytest ecosystem | Fewer dependencies = fewer supply chain risks, faster installs |
| Flat module structure | Deep abstraction | No service layer, no repositories, no DI container | Single unit with pure functions; abstraction layers would add complexity without benefit |

## Constraints

| Constraint | Impact | Source |
|---|---|---|
| Python math stdlib only for math operations | Cannot use numpy/scipy optimizations; limited to IEEE 754 double precision (~15-17 significant digits) | Intent: OOS (no big-number libraries), NFR-1 |
| No persistent storage | Cannot cache computation results or track usage across requests | Intent: explicitly out of scope |
| No auth/rate-limiting | Cannot protect against abuse in production deployments | Intent: explicitly out of scope for MVP |
| No async computation | All math is CPU-bound synchronous code | Async would add complexity with no benefit for pure in-memory computation |
| No input size limits on statistics arrays | Large arrays could slow response | Acceptable for MVP; add limits if needed in later iterations |

## Observability

- Structured logging (JSON format) at ERROR level for unexpected exceptions
- No metrics collection or distributed tracing (out of scope for MVP)
- Health endpoint provides basic liveness check

## Project Structure

```
scientific-calculator-api/
├── pyproject.toml
├── README.md
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPI app, exception handlers, health endpoint
│   ├── models.py            # Pydantic request/response models
│   ├── exceptions.py        # Custom exception classes (DomainError, DivisionByZeroError, etc.)
│   ├── response.py          # Envelope helpers
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── arithmetic.py    # CMP-001
│   │   ├── powers.py        # CMP-002
│   │   ├── trigonometry.py  # CMP-003
│   │   ├── logarithmic.py   # CMP-004
│   │   ├── statistics.py    # CMP-005
│   │   ├── conversions.py   # CMP-006
│   │   └── constants.py     # CMP-007 constants endpoint
│   └── engines/
│       ├── __init__.py
│       ├── arithmetic.py    # Pure math functions
│       ├── powers.py
│       ├── trigonometry.py
│       ├── logarithmic.py
│       ├── statistics.py
│       └── conversions.py
└── tests/
    ├── __init__.py
    ├── conftest.py           # Shared fixtures (test client)
    ├── test_arithmetic.py
    ├── test_powers.py
    ├── test_trigonometry.py
    ├── test_logarithmic.py
    ├── test_statistics.py
    ├── test_conversions.py
    ├── test_constants.py
    ├── test_health.py
    └── test_errors.py
```
