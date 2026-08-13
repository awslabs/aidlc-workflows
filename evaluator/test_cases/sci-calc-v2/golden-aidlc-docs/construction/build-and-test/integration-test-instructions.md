# Integration Test Instructions

## Approach

All tests use `httpx.AsyncClient` with `ASGITransport` — they exercise the full HTTP stack (routing, validation, serialization, error handling) without a running server. These ARE integration tests.

## Run Command

```bash
cd sci-calc
uv run pytest tests/ -v
```

## What They Cover

- Full request → response cycle through FastAPI
- Pydantic validation (422 responses)
- Domain error handling (400 responses)
- Route matching (404 responses)
- Response envelope format verification
- All endpoint paths and HTTP methods
