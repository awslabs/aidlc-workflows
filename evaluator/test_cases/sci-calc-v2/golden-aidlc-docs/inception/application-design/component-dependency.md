# Component Dependency

## Dependency Graph

```
app.py
  ├── routes/arithmetic.py    ──┐
  ├── routes/powers.py        ──┤
  ├── routes/trigonometry.py  ──┤
  ├── routes/logarithmic.py   ──┼── engine/math_engine.py
  ├── routes/statistics.py    ──┤
  ├── routes/constants.py     ──┤
  ├── routes/conversions.py   ──┘
  │
  └── models/
       ├── requests.py   (used by route modules)
       └── responses.py  (used by route modules)
```

## Dependency Rules

1. **app.py** imports all route modules and registers them as routers
2. **Route modules** import from `models/` (request/response schemas) and `engine/` (computation)
3. **Engine** imports only from Python stdlib (`math`, `statistics`) — no framework dependencies
4. **Models** import only from Pydantic — no app dependencies
5. **No circular dependencies** — dependency flow is strictly top-down

## External Dependencies (Python packages)

| Package | Used By | Purpose |
|---------|---------|---------|
| fastapi | app.py, routes/* | HTTP framework |
| pydantic | models/* | Request/response validation |
| uvicorn | Entry point | ASGI server |
| (stdlib math) | engine/math_engine.py | Computation |
| (stdlib statistics) | engine/math_engine.py | Statistical operations |
