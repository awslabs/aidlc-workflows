# Scientific Calculator API

## Executive Summary

A stateless HTTP API that performs scientific math operations — arithmetic, trigonometry, logarithms, powers, statistics, and unit conversions. Any HTTP client can consume it without installing a math library. The calculator prioritises correctness, precision, and clear error reporting over raw throughput. It serves as a golden test-case application: small enough to reason about completely, yet rich enough to exercise code-generation tooling across many dimensions.

## Features In Scope (MVP)

- Arithmetic: add, subtract, multiply, divide, modulo, abs, negate
- Powers and roots: power, sqrt, cbrt, nth_root, square
- Trigonometry: sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh (degree and radian modes)
- Logarithms: ln, log10, log2, log (arbitrary base), exp
- Statistics: mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count
- Constants: pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10
- Unit conversions: angle, temperature, length, weight
- Health-check endpoint
- Structured error responses for all failure cases
- Unit and integration tests

## Features Explicitly Out of Scope (MVP)

- Persistent storage or user accounts
- Graphical or terminal UI
- Symbolic / computer-algebra (CAS) capabilities
- Arbitrary-precision or big-number libraries beyond Python's standard `decimal` module
- Authentication, rate-limiting, or production hardening
- Expression evaluation from string input

## API Specification

All endpoints accept and return `application/json`.

### Response Envelopes

**Success:**

```json
{ "status": "ok", "operation": "<name>", "inputs": { ... }, "result": <number | object> }
```

**Error:**

```json
{ "status": "error", "operation": "<name>", "inputs": { ... }, "error": { "code": "<CODE>", "message": "..." } }
```

| Error Code | HTTP Status | Meaning |
|---|---|---|
| `INVALID_INPUT` | 422 | Request body fails validation |
| `DIVISION_BY_ZERO` | 400 | Division or modulo by zero |
| `DOMAIN_ERROR` | 400 | Input outside mathematical domain (e.g. sqrt(-1), log(0)) |
| `OVERFLOW` | 400 | Result exceeds representable range |
| `NOT_FOUND` | 404 | Unknown endpoint |

### Endpoints

**`GET /health`** — Returns `{"status": "ok", "version": "0.1.0"}`.

**`POST /api/v1/arithmetic/{operation}`** — `add`, `subtract`, `multiply`, `divide`, `modulo` take `{"a": N, "b": N}`. `abs`, `negate` take `{"a": N}`.

**`POST /api/v1/powers/{operation}`** — `power` takes `{"base": N, "exponent": N}`. `sqrt`, `cbrt`, `square` take `{"a": N}`. `nth_root` takes `{"a": N, "n": int}`. Domain error if `a < 0` for sqrt; domain error if `a < 0` and `n` is even for nth_root.

**`POST /api/v1/trigonometry/{operation}`** — Most take `{"a": N, "angle_unit": "radians"|"degrees"}` (defaults to radians). `atan2` takes `{"y": N, "x": N, "angle_unit": ...}`. Domain constraints: asin/acos require -1 <= a <= 1, acosh requires a >= 1, atanh requires -1 < a < 1.

**`POST /api/v1/logarithmic/{operation}`** — `ln`, `log10`, `log2` take `{"a": N}` (domain error if a <= 0). `log` takes `{"a": N, "base": N}` (domain error if a <= 0, base <= 0, or base = 1). `exp` takes `{"a": N}`.

**`POST /api/v1/statistics/{operation}`** — All take `{"values": [N, ...]}`. At least 1 element required. `stdev`/`variance` require at least 2 elements. `pstdev`/`pvariance` require at least 1. `mode` returns smallest mode on ties.

**`GET /api/v1/constants/{name}`** — Returns the named constant. `GET /api/v1/constants` returns all as a map.

**`POST /api/v1/conversions/{category}`** — Takes `{"value": N, "from_unit": "...", "to_unit": "..."}`. Categories: angle (degrees/radians/gradians), temperature (celsius/fahrenheit/kelvin), length (meters/feet/inches/centimeters/millimeters/kilometers/miles/yards), weight (kilograms/pounds/ounces/grams/milligrams/tonnes/stones).

## Error Handling Principles

1. Never return a bare 500. Catch math-domain and overflow errors and translate them to the structured error envelope.
2. Let FastAPI/Pydantic handle schema-validation errors; override the default 422 handler to conform to the error envelope.
3. Log unexpected exceptions at ERROR level and return a generic `INTERNAL_ERROR` response.

## Success Metrics

- All tests pass with >= 90% line coverage
- Results match Python `math` stdlib to <= 1 ULP for standard operations
- Response latency p95 < 50ms for any single operation

## Versioning

API versioned via URL prefix (`/api/v1/...`). Initial release is v0.1.0. Semver applies.
