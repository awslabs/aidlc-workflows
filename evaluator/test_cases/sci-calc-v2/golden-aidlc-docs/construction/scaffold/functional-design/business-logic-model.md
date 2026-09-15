# Business Logic Model — Scaffold

## Application Bootstrap

1. Create FastAPI app instance with title "Scientific Calculator API" and version "0.1.0"
2. Register all route modules as APIRouter with appropriate prefixes
3. Override default 422 validation error handler to conform to error envelope
4. Add catch-all exception handler for unexpected errors (INTERNAL_ERROR)
5. Add 404 handler for unmatched routes (NOT_FOUND error envelope)

## Health Endpoint

- GET /health → returns `{"status": "ok", "version": "0.1.0"}`
- No validation, no computation, always succeeds

## Error Handling Pipeline

1. Pydantic ValidationError → catch in custom handler → 422 INVALID_INPUT envelope
2. DomainError (custom) → catch in route handler → 400 DOMAIN_ERROR envelope
3. DivisionByZeroError (custom) → catch in route handler → 400 DIVISION_BY_ZERO envelope
4. OverflowError → catch in route handler → 400 OVERFLOW envelope
5. Unmatched route → 404 NOT_FOUND envelope
6. Unexpected exception → 500 INTERNAL_ERROR envelope (log at ERROR level)
