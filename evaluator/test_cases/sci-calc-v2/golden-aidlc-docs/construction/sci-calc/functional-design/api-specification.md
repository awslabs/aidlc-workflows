# API Specification — sci-calc

## Interface Summary

| ID | Type | Name | Component | Consumer(s) | Contract |
|---|---|---|---|---|---|
| API-001 | REST | POST /api/v1/arithmetic/{operation} | CMP-001, CMP-008 | External API consumers | N/A |
| API-002 | REST | POST /api/v1/powers/{operation} | CMP-002, CMP-008 | External API consumers | N/A |
| API-003 | REST | POST /api/v1/trigonometry/{operation} | CMP-003, CMP-008 | External API consumers | N/A |
| API-004 | REST | POST /api/v1/logarithmic/{operation} | CMP-004, CMP-008 | External API consumers | N/A |
| API-005 | REST | POST /api/v1/statistics/{operation} | CMP-005, CMP-008 | External API consumers | N/A |
| API-006 | REST | GET /api/v1/constants[/{name}] | CMP-006, CMP-008 | External API consumers | N/A |
| API-007 | REST | POST /api/v1/conversions/{category} | CMP-007, CMP-008 | External API consumers | N/A |
| API-008 | REST | GET /health | CMP-008 | External API consumers | N/A |

## Operations

### API-001: Arithmetic Operations

| Field | Value |
|---|---|
| Purpose | Perform basic arithmetic on numeric inputs |
| Trigger | POST request to /api/v1/arithmetic/{operation} |
| Auth | None |
| Input | BinaryOperands (ENT-001) for add/subtract/multiply/divide/modulo: `{"a": float, "b": float}`. UnaryOperand (ENT-002) for abs/negate: `{"a": float}` |
| Output | SuccessResponse (ENT-010): `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": float}` |
| Business rules | BR-001 (division by zero), BR-011 (overflow) |
| Errors | DIVISION_BY_ZERO (400), OVERFLOW (400), INVALID_INPUT (422), NOT_FOUND (404) |

**Valid operations:** add, subtract, multiply, divide, modulo, abs, negate

---

### API-002: Power Operations

| Field | Value |
|---|---|
| Purpose | Compute powers and roots |
| Trigger | POST request to /api/v1/powers/{operation} |
| Auth | None |
| Input | PowerInput (ENT-003) for power: `{"base": float, "exponent": float}`. UnaryOperand (ENT-002) for sqrt/cbrt/square: `{"a": float}`. NthRootInput (ENT-004) for nth_root: `{"a": float, "n": int}` |
| Output | SuccessResponse (ENT-010): `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": float}` |
| Business rules | BR-002 (sqrt domain), BR-003 (nth_root domain), BR-011 (overflow) |
| Errors | DOMAIN_ERROR (400), OVERFLOW (400), INVALID_INPUT (422), NOT_FOUND (404) |

**Valid operations:** power, sqrt, cbrt, square, nth_root

---

### API-003: Trigonometric Operations

| Field | Value |
|---|---|
| Purpose | Compute trigonometric and hyperbolic functions |
| Trigger | POST request to /api/v1/trigonometry/{operation} |
| Auth | None |
| Input | TrigInput (ENT-005) for most: `{"a": float, "angle_unit": "radians"\|"degrees"}`. Atan2Input (ENT-006) for atan2: `{"y": float, "x": float, "angle_unit": "radians"\|"degrees"}` |
| Output | SuccessResponse (ENT-010): `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": float}` |
| Business rules | BR-004 (asin/acos domain), BR-005 (acosh domain), BR-006 (atanh domain), BR-012 (angle conversion) |
| Errors | DOMAIN_ERROR (400), INVALID_INPUT (422), NOT_FOUND (404) |

**Valid operations:** sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh

---

### API-004: Logarithmic Operations

| Field | Value |
|---|---|
| Purpose | Compute logarithms and exponentials |
| Trigger | POST request to /api/v1/logarithmic/{operation} |
| Auth | None |
| Input | UnaryOperand (ENT-002) for ln/log10/log2/exp: `{"a": float}`. LogBaseInput (ENT-007) for log: `{"a": float, "base": float}` |
| Output | SuccessResponse (ENT-010): `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": float}` |
| Business rules | BR-007 (log domain), BR-008 (base constraints), BR-011 (overflow) |
| Errors | DOMAIN_ERROR (400), OVERFLOW (400), INVALID_INPUT (422), NOT_FOUND (404) |

**Valid operations:** ln, log10, log2, log, exp

---

### API-005: Statistics Operations

| Field | Value |
|---|---|
| Purpose | Compute descriptive statistics on arrays |
| Trigger | POST request to /api/v1/statistics/{operation} |
| Auth | None |
| Input | StatisticsInput (ENT-008): `{"values": [float, ...]}` |
| Output | SuccessResponse (ENT-010): `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": float}` |
| Business rules | BR-009 (min 1 element), BR-010 (stdev/variance min 2 elements), BR-013 (mode tie-breaking) |
| Errors | INVALID_INPUT (422), NOT_FOUND (404) |

**Valid operations:** mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count

---

### API-006: Constants

| Field | Value |
|---|---|
| Purpose | Retrieve mathematical constants |
| Trigger | GET request to /api/v1/constants or /api/v1/constants/{name} |
| Auth | None |
| Input | Path parameter: name (optional) |
| Output (single) | SuccessResponse (ENT-010): `{"status": "ok", "operation": "get_constant", "inputs": {"name": "<name>"}, "result": float}` |
| Output (all) | SuccessResponse (ENT-010): `{"status": "ok", "operation": "get_constants", "inputs": {}, "result": {name: float, ...}}` |
| Business rules | BR-014 (NOT_FOUND for unknown name) |
| Errors | NOT_FOUND (404) |

**Valid constants:** pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10

---

### API-007: Unit Conversions

| Field | Value |
|---|---|
| Purpose | Convert values between units within a category |
| Trigger | POST request to /api/v1/conversions/{category} |
| Auth | None |
| Input | ConversionInput (ENT-009): `{"value": float, "from_unit": string, "to_unit": string}` |
| Output | SuccessResponse (ENT-010): `{"status": "ok", "operation": "convert", "inputs": {...}, "result": float}` |
| Business rules | BR-015 (valid units), BR-016 (temperature formula) |
| Errors | INVALID_INPUT (422), NOT_FOUND (404) |

**Valid categories and units:**
- angle: degrees, radians, gradians
- temperature: celsius, fahrenheit, kelvin
- length: meters, feet, inches, centimeters, millimeters, kilometers, miles, yards
- weight: kilograms, pounds, ounces, grams, milligrams, tonnes, stones

---

### API-008: Health Check

| Field | Value |
|---|---|
| Purpose | Service liveness check |
| Trigger | GET request to /health |
| Auth | None |
| Input | None |
| Output | `{"status": "ok", "version": "0.1.0"}` |
| Business rules | None |
| Errors | None |

## Error Response Codes

| Code | HTTP Status | Trigger |
|---|---|---|
| INVALID_INPUT | 422 | Pydantic validation failure, missing fields, wrong types, array too small |
| DIVISION_BY_ZERO | 400 | divide or modulo with b=0 |
| DOMAIN_ERROR | 400 | Math domain violation (sqrt(-1), log(0), asin(2), etc.) |
| OVERFLOW | 400 | Result is infinity or exceeds float range |
| NOT_FOUND | 404 | Unknown operation name or endpoint |
| INTERNAL_ERROR | 500 | Unexpected exception (should never happen in normal operation) |

All error responses conform to the error envelope:

```json
{
  "status": "error",
  "operation": "<operation-name>",
  "inputs": { ... },
  "error": {
    "code": "<ERROR_CODE>",
    "message": "<human-readable description>"
  }
}
```

## Versioning

- URL prefix: `/api/v1/...`
- Semantic versioning (0.1.0)
- Adding new operations or fields is non-breaking
- Removing or renaming operations/fields is breaking
