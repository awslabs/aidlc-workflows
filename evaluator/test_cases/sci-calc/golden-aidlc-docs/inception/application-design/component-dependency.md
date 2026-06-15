# Component Dependencies

## Dependency Matrix

| Component | Depends On | Depended On By |
|---|---|---|
| `app.py` | All routes, responses (models) | — (entry point) |
| `routes/arithmetic.py` | `models/requests.py`, `models/responses.py`, `engine/math_engine.py` | `app.py` |
| `routes/powers.py` | `models/requests.py`, `models/responses.py`, `engine/math_engine.py` | `app.py` |
| `routes/trigonometry.py` | `models/requests.py`, `models/responses.py`, `engine/math_engine.py` | `app.py` |
| `routes/logarithmic.py` | `models/requests.py`, `models/responses.py`, `engine/math_engine.py` | `app.py` |
| `routes/statistics.py` | `models/requests.py`, `models/responses.py`, `engine/math_engine.py` | `app.py` |
| `routes/constants.py` | `models/responses.py`, `engine/math_engine.py` | `app.py` |
| `routes/conversions.py` | `models/requests.py`, `models/responses.py`, `engine/math_engine.py` | `app.py` |
| `models/requests.py` | — (standalone Pydantic models) | All routes |
| `models/responses.py` | — (standalone Pydantic models) | All routes, `app.py` |
| `engine/math_engine.py` | Python `math` stdlib, `statistics` stdlib | All routes |

## Data Flow

```
HTTP Request
    |
    v
app.py (FastAPI) --> route handler (validates via Pydantic model)
    |                    |
    |                    v
    |               math_engine.py (pure computation)
    |                    |
    |                    v
    |               result or exception
    |                    |
    v                    v
SuccessResponse or ErrorResponse (Pydantic model)
    |
    v
HTTP Response (JSON)
```

## Communication Pattern
- **Synchronous function calls** — no async engine calls needed (CPU-bound math is fast)
- **No message queues, events, or external services**
- **No database connections**
- **Exception-based error signaling** from engine to routes

## Key Design Decisions
1. Engine is a **pure module** with standalone functions — no class instantiation, no state
2. Routes **directly import** engine functions — no dependency injection needed for this scope
3. Custom exceptions (`DomainError`, `DivisionByZeroError`) are defined in the engine module
4. The engine has **zero HTTP/framework dependencies** — testable in isolation
