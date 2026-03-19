# Services

## Service Layer

The application uses a **thin service layer** pattern where `app.py` acts as the orchestrator:

### `app.py` — Application Orchestrator
**Pattern**: FastAPI application factory
**Responsibilities**:
1. **Router Registration**: Mount all route modules with their URL prefixes
2. **Error Handler Registration**: Override Pydantic 422 handler, add catch-all exception handler
3. **Health Check**: Serve `GET /health` directly
4. **Middleware**: None for MVP (no auth, no rate-limiting)

### Route-to-Engine Delegation
Each route handler follows a consistent pattern:
1. Receive validated Pydantic request model
2. Call the appropriate `math_engine` function
3. Wrap result in `SuccessResponse` envelope
4. On exception, catch and return `ErrorResponse` envelope

There is **no separate service class** — routes call engine functions directly. This is appropriate for the project's scope: stateless computation with no persistence, no user sessions, and no cross-cutting business logic.

### Error Handling Flow
1. Pydantic validation errors → custom 422 handler → `ErrorResponse(code="INVALID_INPUT")`
2. `DivisionByZeroError` → route handler → `ErrorResponse(code="DIVISION_BY_ZERO", status=400)`
3. `DomainError` → route handler → `ErrorResponse(code="DOMAIN_ERROR", status=400)`
4. `OverflowError` → route handler → `ErrorResponse(code="OVERFLOW", status=400)`
5. Unknown endpoint → FastAPI 404 → custom handler → `ErrorResponse(code="NOT_FOUND", status=404)`
6. Unexpected exception → catch-all handler → log at ERROR → `ErrorResponse(code="INTERNAL_ERROR", status=500)`
