# Components

## MathEngine

**Purpose**: Performs all mathematical computations — pure functions with no I/O or framework dependencies.

**Responsibilities**:
- Execute arithmetic operations (add, subtract, multiply, divide, modulo, abs, negate)
- Execute power and root operations (power, sqrt, cbrt, nth_root, square)
- Execute trigonometric and hyperbolic functions (with angle unit conversion)
- Execute logarithmic and exponential functions
- Compute statistical aggregations (mean, median, mode, stdev, variance, etc.)
- Provide mathematical constants
- Perform unit conversions (angle, temperature, length, weight)
- Validate domain constraints and raise domain errors

**State**: Stateless

**Owns**: Mathematical constants definitions, unit conversion factors

---

## Router

**Purpose**: HTTP routing layer — receives requests, validates input shapes, delegates to MathEngine, and formats responses.

**Responsibilities**:
- Define API endpoints for each operation group
- Parse and validate request bodies against Pydantic models
- Delegate computation to MathEngine
- Wrap results in the success response envelope
- Translate domain errors into error response envelopes
- Handle unknown endpoints (404)

**State**: Stateless

**Owns**: Endpoint definitions, URL routing structure

---

## Models

**Purpose**: Data contract definitions — request schemas, response envelopes, and error structures.

**Responsibilities**:
- Define Pydantic request models for each operation type
- Define the success response envelope
- Define the error response envelope
- Define error code enumeration
- Provide type safety for all data flowing between layers

**State**: Stateless (pure type definitions)

**Owns**: Request/response schemas, error code definitions

---

## App

**Purpose**: Application bootstrap and configuration — creates the FastAPI application instance, registers routers, and configures exception handlers.

**Responsibilities**:
- Create and configure FastAPI application
- Register all route modules
- Configure custom exception handlers (override 422, catch-all for 500)
- Configure middleware (if any)
- Expose the ASGI application for uvicorn

**State**: Stateless (singleton application instance)

**Owns**: Application lifecycle, global exception handling configuration
