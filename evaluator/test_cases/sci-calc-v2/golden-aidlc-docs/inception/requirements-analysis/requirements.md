# Requirements

## Functional Requirements

### FR-01: Arithmetic Operations
The API SHALL provide POST /api/v1/arithmetic/{operation} endpoints for: add, subtract, multiply, divide, modulo (accepting `{"a": N, "b": N}`) and abs, negate (accepting `{"a": N}`).

**Pass/fail**: Each operation returns correct result in the success envelope.

### FR-02: Powers and Roots Operations
The API SHALL provide POST /api/v1/powers/{operation} endpoints for: power (`{"base": N, "exponent": N}`), sqrt/cbrt/square (`{"a": N}`), nth_root (`{"a": N, "n": int}`).

**Pass/fail**: Correct results; DOMAIN_ERROR for sqrt(negative) and nth_root(negative, even).

### FR-03: Trigonometry Operations
The API SHALL provide POST /api/v1/trigonometry/{operation} for 14 trig functions accepting `{"a": N, "angle_unit": "radians"|"degrees"}` (default radians). atan2 accepts `{"y": N, "x": N, "angle_unit": ...}`.

**Pass/fail**: Correct results; DOMAIN_ERROR for asin/acos outside [-1,1], acosh < 1, atanh outside (-1,1).

### FR-04: Logarithmic Operations
The API SHALL provide POST /api/v1/logarithmic/{operation} for: ln, log10, log2 (`{"a": N}`), log (`{"a": N, "base": N}`), exp (`{"a": N}`).

**Pass/fail**: Correct results; DOMAIN_ERROR for a <= 0, base <= 0, base = 1.

### FR-05: Statistics Operations
The API SHALL provide POST /api/v1/statistics/{operation} for: mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count (accepting `{"values": [N, ...]}`).

**Pass/fail**: Correct results; INVALID_INPUT for empty arrays; stdev/variance require >= 2 elements; mode returns smallest on ties.

### FR-06: Constants
The API SHALL provide GET /api/v1/constants (all as map) and GET /api/v1/constants/{name} for: pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10.

**Pass/fail**: Correct constant values returned in success envelope.

### FR-07: Unit Conversions
The API SHALL provide POST /api/v1/conversions/{category} for angle (degrees/radians/gradians), temperature (celsius/fahrenheit/kelvin), length (meters/feet/inches/centimeters/millimeters/kilometers/miles/yards), weight (kilograms/pounds/ounces/grams/milligrams/tonnes/stones).

**Pass/fail**: Correct conversion results for all unit pairs.

### FR-08: Health Check
The API SHALL provide GET /health returning `{"status": "ok", "version": "0.1.0"}`.

**Pass/fail**: Returns 200 with exact schema.

### FR-09: Structured Error Responses
The API SHALL return errors in the envelope `{"status": "error", "operation": "...", "inputs": {...}, "error": {"code": "...", "message": "..."}}` with codes: INVALID_INPUT (422), DIVISION_BY_ZERO (400), DOMAIN_ERROR (400), OVERFLOW (400), NOT_FOUND (404).

**Pass/fail**: All error conditions return correct code and HTTP status.

### FR-10: Input Validation
The API SHALL validate all request bodies via Pydantic v2 schemas and return INVALID_INPUT (422) for malformed requests conforming to the error envelope.

**Pass/fail**: Invalid inputs rejected with structured error response.

## Non-Functional Requirements

### NFR-01: Test Coverage
Line coverage >= 90% as measured by pytest-cov.

### NFR-02: Floating-Point Precision
Results match Python `math` stdlib to <= 1 ULP for standard operations.

### NFR-03: Response Latency
p95 < 50ms for any single operation.

### NFR-04: Startup Time
Application starts in < 2 seconds.

### NFR-05: Request Size
Max request body size: 1 MB.

### NFR-06: Python Version
Requires Python 3.13.x (enforced via `requires-python = ">=3.13"`).

## Traceability

| Requirement | Source |
|-------------|--------|
| FR-01 through FR-10 | vision.md § "Features In Scope (MVP)" and § "API Specification" |
| NFR-01 through NFR-06 | tech-env.md § "Non-Functional Requirements" |
| All | intent-statement.md § "Success Metrics" |
