# Component Dependencies

## Dependency Matrix

| From | To | Pattern | Rationale |
|---|---|---|---|
| Router | MathEngine | Sync call (function invocation) | Router delegates all computation to MathEngine |
| Router | Models | Type reference (import) | Router uses Models for request validation and response construction |
| App | Router | Registration (include_router) | App registers all route modules at startup |
| App | Models | Type reference (import) | App uses Models for custom exception handler response shapes |
| MathEngine | Models | Type reference (import) | MathEngine raises typed domain errors defined in Models |

## Dependency Direction

```
App → Router → MathEngine
 ↓       ↓         ↓
 └───→ Models ←────┘
```

## Notes

- No circular dependencies exist.
- Models is a leaf dependency (pure type definitions, depends on nothing).
- MathEngine has a minimal dependency on Models only for error type definitions. Alternatively, MathEngine could raise its own exception types and Router translates — either approach is valid.
- All dependencies are synchronous function calls or type imports. No async communication, no events, no shared mutable state.
