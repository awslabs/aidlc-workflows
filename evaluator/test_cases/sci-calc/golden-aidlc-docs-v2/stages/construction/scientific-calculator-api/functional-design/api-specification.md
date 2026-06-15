# API Specification — scientific-calculator-api

## Interface Summary

| ID | Type | Name | Component | Consumer(s) | Contract |
|---|---|---|---|---|---|
| API-001 | REST POST | /api/v1/arithmetic/{operation} | CMP-001 | API Consumer | N/A |
| API-002 | REST POST | /api/v1/powers/{operation} | CMP-002 | API Consumer | N/A |
| API-003 | REST POST | /api/v1/trigonometry/{operation} | CMP-003 | API Consumer | N/A |
| API-004 | REST POST | /api/v1/logarithmic/{operation} | CMP-004 | API Consumer | N/A |
| API-005 | REST POST | /api/v1/statistics/{operation} | CMP-005 | API Consumer | N/A |
| API-006 | REST GET | /api/v1/constants[/{name}] | CMP-006 | API Consumer | N/A |
| API-007 | REST POST | /api/v1/conversions/{category} | CMP-007 | API Consumer | N/A |
| API-008 | REST GET | /health | CMP-008 | System Operator | N/A |

## Operations

### API-001: Arithmetic Operations

| Field | Value |
|---|---|
| Purpose | Perform basic arithmetic on one or two operands |
| Trigger | POST /api/v1/arithmetic/{operation} |
| Auth / Permission | None |
| Input | Binary: `{"a": float, "b": float}` for add, subtract, multiply, divide, modulo. Unary: `{"a": float}` for abs, negate |
| Output | `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": number}` |
| Business rules | BR-001 (division by zero) |
| Entities | ENT-001, ENT-002 |
| Errors | DIVISION_BY_ZERO (400), INVALID_INPUT (422) |
| Versioning | URL prefix /api/v1/ |

**Valid operations (binary):** add, subtract, multiply, divide, modulo

**Valid operations (unary):** abs, negate

### API-002: Powers and Roots Operations

| Field | Value |
|---|---|
| Purpose | Compute powers and roots |
| Trigger | POST /api/v1/powers/{operation} |
| Auth / Permission | None |
| Input | `{"base": float, "exponent": float}` for power. `{"a": float}` for sqrt, cbrt, square. `{"a": float, "n": integer}` for nth_root |
| Output | `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": number}` |
| Business rules | BR-002 (sqrt of negative), BR-003 (nth_root even index with negative base) |
| Entities | ENT-003, ENT-004, ENT-005 |
| Errors | DOMAIN_ERROR (400), INVALID_INPUT (422) |
| Versioning | URL prefix /api/v1/ |

**Valid operations:** power, sqrt, cbrt, square, nth_root

### API-003: Trigonometry Operations

| Field | Value |
|---|---|
| Purpose | Compute trigonometric, inverse trigonometric, and hyperbolic functions |
| Trigger | POST /api/v1/trigonometry/{operation} |
| Auth / Permission | None |
| Input | Standard: `{"a": float, "angle_unit": "radians"\|"degrees"}` for most ops. atan2: `{"y": float, "x": float, "angle_unit": "radians"\|"degrees"}` |
| Output | `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": number}` |
| Business rules | BR-004 (asin/acos domain [-1, 1]), BR-005 (acosh domain >= 1), BR-006 (atanh domain (-1, 1)), BR-015 (angle_unit defaults to radians) |
| Entities | ENT-006, ENT-007 |
| Errors | DOMAIN_ERROR (400), INVALID_INPUT (422) |
| Versioning | URL prefix /api/v1/ |

**Valid operations:** sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh

### API-004: Logarithmic Operations

| Field | Value |
|---|---|
| Purpose | Compute logarithmic and exponential functions |
| Trigger | POST /api/v1/logarithmic/{operation} |
| Auth / Permission | None |
| Input | `{"a": float}` for ln, log10, log2, exp. `{"a": float, "base": float}` for log |
| Output | `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": number}` |
| Business rules | BR-007 (input must be > 0 for log ops), BR-008 (base must be > 0 and != 1), BR-010 (exp overflow) |
| Entities | ENT-008, ENT-009 |
| Errors | DOMAIN_ERROR (400), OVERFLOW (400), INVALID_INPUT (422) |
| Versioning | URL prefix /api/v1/ |

**Valid operations:** ln, log10, log2, log, exp

### API-005: Statistics Operations

| Field | Value |
|---|---|
| Purpose | Compute descriptive statistics over a list of numbers |
| Trigger | POST /api/v1/statistics/{operation} |
| Auth / Permission | None |
| Input | `{"values": [float, ...]}` |
| Output | `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": number}` |
| Business rules | BR-011 (min 1 element), BR-012 (min 2 elements for stdev/variance), BR-013 (mode tie-breaking: return smallest) |
| Entities | ENT-010 |
| Errors | INVALID_INPUT (422) |
| Versioning | URL prefix /api/v1/ |

**Valid operations:** mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count

### API-006: Constants Lookup

| Field | Value |
|---|---|
| Purpose | Retrieve mathematical constants by name or retrieve all constants |
| Trigger | GET /api/v1/constants/{name} or GET /api/v1/constants |
| Auth / Permission | None |
| Input | Path parameter: constant name (optional — omit for all) |
| Output | Single: `{"status": "ok", "operation": "get_constant", "inputs": {"name": "<name>"}, "result": number}`. All: `{"status": "ok", "operation": "get_all_constants", "inputs": {}, "result": {"pi": 3.14159..., ...}}` |
| Business rules | BR-016 (unknown constant name returns NOT_FOUND) |
| Entities | ENT-012 |
| Errors | NOT_FOUND (404) |
| Versioning | URL prefix /api/v1/ |

**Valid names:** pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10

### API-007: Unit Conversions

| Field | Value |
|---|---|
| Purpose | Convert values between units within a category |
| Trigger | POST /api/v1/conversions/{category} |
| Auth / Permission | None |
| Input | `{"value": float, "from_unit": string, "to_unit": string}` |
| Output | `{"status": "ok", "operation": "convert_<category>", "inputs": {...}, "result": number}` |
| Business rules | BR-014 (units must be valid for category) |
| Entities | ENT-011 |
| Errors | INVALID_INPUT (422), NOT_FOUND (404 for unknown category) |
| Versioning | URL prefix /api/v1/ |

**Valid categories:** angle, temperature, length, weight

**Units per category:**
- angle: degrees, radians, gradians
- temperature: celsius, fahrenheit, kelvin
- length: meters, feet, inches, centimeters, millimeters, kilometers, miles, yards
- weight: kilograms, pounds, ounces, grams, milligrams, tonnes, stones

### API-008: Health Check

| Field | Value |
|---|---|
| Purpose | Verify service is running and return version |
| Trigger | GET /health |
| Auth / Permission | None |
| Input | None |
| Output | `{"status": "ok", "version": "0.1.0"}` |
| Business rules | None |
| Entities | None |
| Errors | None |
| Versioning | Not versioned (stable root path) |

## Payload Schemas

### BinaryArithmeticRequest (ENT-001)

| Field | Type | Required | Constraints |
|---|---|---|---|
| a | float | yes | Any numeric value |
| b | float | yes | Any numeric value |

### UnaryArithmeticRequest (ENT-002)

| Field | Type | Required | Constraints |
|---|---|---|---|
| a | float | yes | Any numeric value |

### PowerRequest (ENT-003)

| Field | Type | Required | Constraints |
|---|---|---|---|
| base | float | yes | Any numeric value |
| exponent | float | yes | Any numeric value |

### SingleValueRequest (ENT-004)

| Field | Type | Required | Constraints |
|---|---|---|---|
| a | float | yes | Domain rules per operation |

### NthRootRequest (ENT-005)

| Field | Type | Required | Constraints |
|---|---|---|---|
| a | float | yes | Domain rules per BR-003 |
| n | integer | yes | Non-zero integer |

### TrigRequest (ENT-006)

| Field | Type | Required | Constraints |
|---|---|---|---|
| a | float | yes | Domain rules per operation |
| angle_unit | enum | no | "radians" (default) or "degrees" |

### Atan2Request (ENT-007)

| Field | Type | Required | Constraints |
|---|---|---|---|
| y | float | yes | Any numeric value |
| x | float | yes | Any numeric value |
| angle_unit | enum | no | "radians" (default) or "degrees" |

### LogRequest (ENT-008)

| Field | Type | Required | Constraints |
|---|---|---|---|
| a | float | yes | Must be > 0 |

### ArbitraryLogRequest (ENT-009)

| Field | Type | Required | Constraints |
|---|---|---|---|
| a | float | yes | Must be > 0 |
| base | float | yes | Must be > 0 and != 1 |

### StatisticsRequest (ENT-010)

| Field | Type | Required | Constraints |
|---|---|---|---|
| values | array[float] | yes | Non-empty; min 2 elements for stdev/variance |

### ConversionRequest (ENT-011)

| Field | Type | Required | Constraints |
|---|---|---|---|
| value | float | yes | Any numeric value |
| from_unit | string | yes | Must be valid for category |
| to_unit | string | yes | Must be valid for category |

## Supported Constants

| Name | Value |
|---|---|
| pi | 3.141592653589793 |
| e | 2.718281828459045 |
| tau | 6.283185307179586 |
| inf | Infinity |
| nan | NaN |
| golden_ratio | 1.618033988749895 |
| sqrt2 | 1.4142135623730951 |
| ln2 | 0.6931471805599453 |
| ln10 | 2.302585092994046 |

## Versioning

- URL prefix: `/api/v1/`
- Initial version: 0.1.0
- Semver applies
- Adding new operations or constants is non-breaking
- Changing response shape or removing operations is breaking
