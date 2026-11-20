# Security Design

## Input Validation Layer (Pydantic v2)

- All request bodies validated against strict Pydantic models before reaching route logic
- Type coercion disabled where possible (strict mode for numeric fields)
- Custom 422 handler prevents Pydantic's default error format from leaking internal details

## Error Information Disclosure Prevention

- Custom exception handlers return only error code + generic message
- No stack traces, no file paths, no internal state in error responses
- Unexpected exceptions logged server-side at ERROR level, client gets INTERNAL_ERROR only

## Request Size Limiting

- Max request body: 1 MB (configured at uvicorn level or via middleware)
- Prevents memory exhaustion from large statistics arrays

## No Attack Surface

- No database → no SQL injection
- No HTML rendering → no XSS
- No outbound requests → no SSRF
- No file operations → no path traversal
- No user state → no session hijacking
- No authentication → no credential theft (nothing to steal)
