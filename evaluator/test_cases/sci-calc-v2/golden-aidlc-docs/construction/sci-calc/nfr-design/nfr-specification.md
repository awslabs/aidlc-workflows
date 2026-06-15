# NFR Specification

## Quality Targets

| ID | Attribute | Target | Measure | Rationale | Source |
|---|---|---|---|---|---|
| NFR-1 | Performance | p95 response latency < 50ms | Load test with sequential requests | Stateless math on stdlib — no I/O, should be sub-millisecond | NFR-1 |
| NFR-2 | Testability | ≥ 90% line coverage | pytest-cov report | Ensures all code paths are exercised | NFR-2 |
| NFR-3 | Correctness | Results match math stdlib to ≤ 1 ULP | Comparison tests against Python math module | IEEE 754 precision guarantee for consumers | NFR-3 |
| NFR-4 | Performance | Startup time < 2 seconds | Measured from process start to first request | Fast deployment cycles | NFR-4 |
| NFR-5 | Security | Max request body 1 MB | FastAPI/Starlette body limit | Prevent memory exhaustion from oversized payloads | NFR-5 |
| NFR-6 | Reliability | No bare HTTP 500 responses | Fault-injection tests | Consumers always get structured errors | NFR-6 |
| NFR-7 | Observability | Unexpected exceptions logged at ERROR | Log output verification | Incident diagnosis capability | NFR-7 |
| NFR-8 | Correctness | Stateless — no request depends on prior | Request-order-independence tests | Any client can call in any order | NFR-8 |
| NFR-9 | Compatibility | Python 3.13.x enforced | pyproject.toml requires-python | Consistent runtime behaviour | NFR-9 |

## Tech Stack

| Layer | Choice | Rationale | Alternatives Considered |
|---|---|---|---|
| Language | Python 3.13 | Mandated by tech-env.md; math stdlib is the computation backend | None (constraint) |
| Framework | FastAPI + Pydantic v2 | Async, auto-validation, OpenAPI generation, fast | Flask (sync, no auto-validation), Django (too heavy) |
| Server | uvicorn (ASGI) | Async, lightweight, standard for FastAPI | gunicorn (sync workers), hypercorn |
| Package manager | uv | Fast, modern, replaces pip/poetry | pip (slow), poetry (heavier) |
| Testing | pytest + pytest-asyncio + httpx + pytest-cov | Async test client, coverage, standard ecosystem | unittest (verbose), nose (deprecated) |
| Linting | ruff (line-length 100, py313) | Single tool replaces black + flake8 + isort | black + flake8 (multiple tools) |
| Build | hatchling | Simple, PEP 517 compliant | setuptools (legacy), flit (limited) |
| Math backend | Python math stdlib | Zero dependencies, IEEE 754 compliant, fast C implementation | numpy (too heavy), mpmath (not needed) |

## Architectural Patterns

### Layered Modular Monolith

```
HTTP Layer (FastAPI routes) → Engine Layer (pure functions) → math stdlib
```

- **Routes** handle HTTP concerns: request parsing, response formatting, error translation
- **Engine** handles computation: pure functions, no HTTP awareness, raise domain exceptions
- **Models** define Pydantic schemas: request validation, response serialization

### Patterns Table

| Pattern | Satisfies | Applied to | How it works | Trade-off | Failure mode |
|---|---|---|---|---|---|
| Global exception handler | NFR-6, NFR-7 | CMP-008 (API Layer) | Catches all unhandled exceptions, logs at ERROR, returns INTERNAL_ERROR envelope | Hides unexpected errors from caller (intentional) | If handler itself fails, uvicorn returns 500 (last resort) |
| Custom 422 handler | NFR-6 | CMP-008 (API Layer) | Overrides FastAPI's default ValidationError response to use error envelope format | Slightly more code than default | None — deterministic |
| Engine exception pattern | NFR-6 | CMP-001-007 | Engines raise typed exceptions (DomainError, DivisionByZeroError, OverflowError); API Layer catches and maps to error codes | Engines must know exception types | If engine raises unexpected type, global handler catches it |
| Direct stdlib delegation | NFR-3 | CMP-001-007 | All computation delegates directly to math.* functions — no wrapper math | No custom optimization possible | math module bugs (extremely unlikely) |
| Pydantic validation | NFR-5, NFR-6 | CMP-008 | Request bodies validated by Pydantic models before reaching engines | Slight overhead per request (negligible for p95 target) | Malformed JSON caught at framework level |

### Error Signalling

Engines raise typed exceptions for domain violations:
- `DivisionByZeroError` → HTTP 400, DIVISION_BY_ZERO
- `DomainError` → HTTP 400, DOMAIN_ERROR
- `OverflowError` → HTTP 400, OVERFLOW

Route handlers catch these and wrap in the standard error envelope. A global exception handler catches anything else.

### Stateless Design

- No database, cache, or session state
- Each request is independent — no shared mutable state
- Enables horizontal scaling trivially (if ever needed)

## API Quality Annotations

| API ID | Latency Target | Timeout | Retry / Idempotency | Observability |
|---|---|---|---|---|
| API-001 | p95 < 50ms | N/A (no downstream calls) | All operations are idempotent (pure functions) | ERROR log on unexpected exceptions |
| API-002 | p95 < 50ms | N/A | Idempotent | ERROR log on unexpected exceptions |
| API-003 | p95 < 50ms | N/A | Idempotent | ERROR log on unexpected exceptions |
| API-004 | p95 < 50ms | N/A | Idempotent | ERROR log on unexpected exceptions |
| API-005 | p95 < 50ms | N/A | Idempotent | ERROR log on unexpected exceptions |
| API-006 | p95 < 50ms | N/A | Idempotent (read-only) | ERROR log on unexpected exceptions |
| API-007 | p95 < 50ms | N/A | Idempotent | ERROR log on unexpected exceptions |
| API-008 | p95 < 50ms | N/A | Idempotent (read-only) | None needed |

## Component Quality Annotations

| Component ID | Data Classification | Resiliency Need | Scaling Need | Security Controls |
|---|---|---|---|---|
| CMP-001 | Public (no sensitive data) | None (stateless, no deps) | N/A (single process) | Input validation via Pydantic |
| CMP-002 | Public | None | N/A | Input validation |
| CMP-003 | Public | None | N/A | Input validation |
| CMP-004 | Public | None | N/A | Input validation |
| CMP-005 | Public | None | N/A | Input validation + array size limit |
| CMP-006 | Public | None | N/A | None (read-only constants) |
| CMP-007 | Public | None | N/A | Input validation |
| CMP-008 | Public | Global exception handler | N/A | Request body size limit (1 MB) |

## Observability

| Aspect | Approach |
|---|---|
| Logging | Python `logging` module; ERROR level for unexpected exceptions |
| Health check | GET /health returns version and status |
| Metrics | Not in MVP scope (no Prometheus/StatsD) |
| Tracing | Not in MVP scope |

## Test Strategy

| Level | Scope | Tools | Target |
|---|---|---|---|
| Unit | Engine functions (pure math) | pytest | Known-value tables, boundary cases, domain errors |
| Integration | Full HTTP request/response cycle | httpx.AsyncClient + FastAPI TestClient | Endpoint behaviour, error envelopes, status codes |
| Boundary | Domain constraint validation | pytest | Every rule in rules.yaml has a test case |
| Coverage | All source | pytest-cov | ≥ 90% line coverage |

## Trade-offs

| Prioritised | Over | Decision | Rationale |
|---|---|---|---|
| Correctness | Performance | Use math stdlib directly, no caching or approximation | Precision guarantee (≤ 1 ULP) is a hard requirement |
| Simplicity | Extensibility | Single process, no plugin system | MVP scope; can refactor later if needed |
| Error clarity | Brevity | Full error envelope with operation + inputs on every error | Consumers need context to debug; small payload cost |
| Pure functions in engine | Direct route logic | Testable in isolation, no mocking needed | Slight indirection (routes → engine) |
| Custom exceptions for domain errors | Generic exceptions | Clean separation of concerns | Extra exception classes to define |
| Override FastAPI 422 handler | Default 422 behaviour | Consistent error envelope | Must intercept framework behaviour |
| No caching | Performance optimisation | Simplicity, no stale data | Repeated computations aren't cached (acceptable — math is fast) |

## Constraints

| Constraint | Impact | Source |
|---|---|---|
| Python 3.13 only | Cannot use features from other languages; locked to math stdlib | tech-env.md |
| uv only (no pip/poetry) | All dependency management via uv commands | tech-env.md |
| No numpy/pandas/sympy | Must use stdlib math for all computation | tech-env.md |
| Single process | No horizontal scaling, no distributed concerns | tech-env.md, A-3 |
| No auth/rate-limiting | No security middleware beyond input validation | OOS-5 |
