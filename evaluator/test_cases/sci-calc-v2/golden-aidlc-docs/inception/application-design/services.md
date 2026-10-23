# Services

## Service: Scientific Calculator API

- **Type**: Stateless HTTP API
- **Framework**: FastAPI (ASGI)
- **Server**: uvicorn
- **Port**: 8000 (development)
- **No external service dependencies**
- **No database**
- **No message queue**
- **No cache layer**

## Internal Service Boundaries

This is a monolithic single-service application. No microservices, no inter-service communication. The internal layering (routes → engine) is a code organization pattern, not a service boundary.

## Data Flow

```
HTTP Request → FastAPI Router → Pydantic Validation → Route Handler → Math Engine → Response Builder → HTTP Response
```

No async I/O needed (all operations are CPU-bound and sub-millisecond). The async framework is used for concurrency under load, not for I/O-bound operations.
