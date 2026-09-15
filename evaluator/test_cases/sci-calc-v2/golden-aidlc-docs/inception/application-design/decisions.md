# Architecture Decisions

## ADR-01: Single math_engine.py

**Context**: Tech-env.md prescribes `engine/math_engine.py` as a single file for all computation logic.

**Decision**: All math operations (arithmetic, powers, trig, log, stats, constants, conversions) live in one engine file.

**Consequences**: Simple dependency graph; file may grow large but operations are short pure functions. Easy to test in isolation.

**Alternatives Rejected**: Per-domain engine files (arithmetic_engine.py, trig_engine.py) — would violate the prescribed structure.

## ADR-02: Custom Exception Classes for Domain Errors

**Context**: Need to distinguish domain errors (sqrt of negative) from division-by-zero from overflow for correct HTTP status mapping.

**Decision**: Define `DomainError` and custom `DivisionByZeroError` in the engine; route handlers catch and map to error envelope codes.

**Consequences**: Clean separation between computation errors and HTTP responses. Engine remains framework-agnostic.

**Alternatives Rejected**: Returning error tuples — less Pythonic, harder to compose. Using HTTP exceptions directly in engine — couples engine to FastAPI.

## ADR-03: Pydantic v2 for All Validation

**Context**: FastAPI + Pydantic v2 provides automatic request validation and OpenAPI generation.

**Decision**: Define all request/response shapes as Pydantic BaseModel classes in models/. Let FastAPI handle 422 validation; override the default handler to conform to our error envelope.

**Consequences**: Zero manual validation code for schema correctness. Custom 422 handler needed for envelope consistency.

**Alternatives Rejected**: Manual validation in route handlers — duplicates Pydantic's work. Dataclasses — no built-in JSON schema generation.

## ADR-04: Stateless, No Middleware

**Context**: MVP excludes auth, rate-limiting, CORS, and other middleware concerns.

**Decision**: No middleware beyond FastAPI defaults. Request body size limit via uvicorn configuration (1 MB).

**Consequences**: Simplest possible request pipeline. Future NFRs (auth, CORS) add middleware without changing existing code.

**Alternatives Rejected**: Pre-adding disabled middleware stubs — YAGNI for MVP.
