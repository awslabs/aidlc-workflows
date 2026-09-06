# Performance Design

## Approach: No Special Optimization Needed

All operations are single `math` stdlib calls (nanosecond-scale computation). The 50ms p95 budget is consumed almost entirely by HTTP overhead (serialization, routing, validation). FastAPI's default performance is sufficient.

## Design Decisions

1. **Synchronous route handlers**: All operations are CPU-bound and instantaneous. No `async` needed on route functions (FastAPI runs sync handlers in threadpool automatically).
2. **No caching**: Results are pure functions of inputs; computation is cheaper than cache lookup overhead.
3. **No connection pooling**: No external connections exist.
4. **Direct function calls**: Engine functions called directly from routes (no middleware, no interceptors, no abstraction layers between input and computation).

## Verification

- pytest timing assertions on integration tests (assert response time < 50ms)
- Coverage report confirms all paths exercised
