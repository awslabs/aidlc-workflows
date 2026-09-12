# API Contract Wireframes

## Endpoint Structure

```
GET  /health
POST /api/v1/arithmetic/{operation}     → add, subtract, multiply, divide, modulo, abs, negate
POST /api/v1/powers/{operation}         → power, sqrt, cbrt, nth_root, square
POST /api/v1/trigonometry/{operation}   → sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh
POST /api/v1/logarithmic/{operation}    → ln, log10, log2, log, exp
POST /api/v1/statistics/{operation}     → mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count
GET  /api/v1/constants                  → all constants as map
GET  /api/v1/constants/{name}           → single constant by name
POST /api/v1/conversions/{category}     → angle, temperature, length, weight
```

## Request Shapes

```
Binary operation:     {"a": N, "b": N}
Unary operation:      {"a": N}
Power operation:      {"base": N, "exponent": N}
Nth root:             {"a": N, "n": int}
Trig operation:       {"a": N, "angle_unit": "radians"|"degrees"}
Atan2:                {"y": N, "x": N, "angle_unit": "radians"|"degrees"}
Log arbitrary base:   {"a": N, "base": N}
Statistics:           {"values": [N, ...]}
Conversion:           {"value": N, "from_unit": "...", "to_unit": "..."}
```

## Response Envelope

```
Success: {"status": "ok",    "operation": "<name>", "inputs": {...}, "result": <N|object>}
Error:   {"status": "error", "operation": "<name>", "inputs": {...}, "error": {"code": "...", "message": "..."}}
```

## Error Flow Diagram

```
Request
  │
  ├─ Schema validation fails → 422 INVALID_INPUT
  │
  ├─ Unknown endpoint → 404 NOT_FOUND
  │
  ├─ Domain error (sqrt(-1), log(0), etc.) → 400 DOMAIN_ERROR
  │
  ├─ Division/modulo by zero → 400 DIVISION_BY_ZERO
  │
  ├─ Overflow → 400 OVERFLOW
  │
  └─ Success → 200 {"status": "ok", ...}
```
