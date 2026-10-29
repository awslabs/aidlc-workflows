# Components

## Component Architecture

```
┌─────────────────────────────────────────────────┐
│                   FastAPI App                     │
│                   (app.py)                        │
├─────────────────────────────────────────────────┤
│                  Route Layer                      │
│  ┌───────────┬──────────┬──────────────────┐    │
│  │arithmetic │ powers   │ trigonometry      │    │
│  │logarithmic│statistics│ constants         │    │
│  │conversions│          │                   │    │
│  └───────────┴──────────┴──────────────────┘    │
├─────────────────────────────────────────────────┤
│                  Model Layer                      │
│  ┌─────────────────┬───────────────────────┐    │
│  │   requests.py   │    responses.py        │    │
│  └─────────────────┴───────────────────────┘    │
├─────────────────────────────────────────────────┤
│                  Engine Layer                     │
│  ┌─────────────────────────────────────────┐    │
│  │           math_engine.py                 │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## Component Descriptions

### C1: app.py (Application Entry Point)
- Creates FastAPI application instance
- Registers all route modules
- Configures error handlers (422 override, catch-all)
- Exposes the ASGI app for uvicorn

### C2: Route Modules (7 files)
- **arithmetic.py** — Binary (add, subtract, multiply, divide, modulo) and unary (abs, negate) operations
- **powers.py** — power, sqrt, cbrt, square, nth_root with domain validation
- **trigonometry.py** — 14 trig functions with angle_unit support
- **logarithmic.py** — ln, log10, log2, log, exp with domain validation
- **statistics.py** — 12 aggregation operations on value arrays
- **constants.py** — GET endpoints for mathematical constants
- **conversions.py** — 4 conversion categories with unit validation

### C3: Model Layer (2 files)
- **requests.py** — Pydantic v2 models for all request body shapes
- **responses.py** — Success and error response envelope models

### C4: Engine Layer (1 file)
- **math_engine.py** — Pure computation functions using Python `math` stdlib; raises typed exceptions for domain/overflow errors
