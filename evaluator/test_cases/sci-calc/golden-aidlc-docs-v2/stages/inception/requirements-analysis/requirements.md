# Requirements

## Intent Summary

- **Type:** new feature
- **Scope:** single component
- **Classification:** greenfield
- **Affected repos:** none (new repo: sci-calc)

## Functional Requirements

| ID | Requirement | Acceptance Criteria |
|---|---|---|
| FR-1 | The API shall provide arithmetic operations: add, subtract, multiply, divide, modulo (accepting two operands a, b) and abs, negate (accepting one operand a) at POST /api/v1/arithmetic/{operation} | POST /api/v1/arithmetic/{op} returns correct result for each operation with valid inputs |
| FR-2 | Division and modulo by zero shall return a DIVISION_BY_ZERO error (HTTP 400) | POST /api/v1/arithmetic/divide with b=0 returns `{"status":"error","error":{"code":"DIVISION_BY_ZERO",...}}` with HTTP 400 |
| FR-3 | The API shall provide power/root operations: power (base, exponent), sqrt (a), cbrt (a), square (a), nth_root (a, n) at POST /api/v1/powers/{operation} | POST /api/v1/powers/{op} returns correct mathematical result for valid inputs |
| FR-4 | sqrt shall return DOMAIN_ERROR (HTTP 400) when a < 0; nth_root shall return DOMAIN_ERROR when a < 0 and n is even | POST /api/v1/powers/sqrt with a=-1 returns DOMAIN_ERROR; nth_root with a=-4, n=2 returns DOMAIN_ERROR |
| FR-5 | The API shall provide trigonometric operations: sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh at POST /api/v1/trigonometry/{operation} | POST /api/v1/trigonometry/{op} returns correct result matching Python math stdlib to ≤1 ULP |
| FR-6 | Trigonometric operations shall accept an optional angle_unit parameter ("radians" default, "degrees" optional); atan2 accepts y, x, angle_unit | sin with a=90, angle_unit="degrees" returns 1.0; sin with a=π/2, angle_unit="radians" returns 1.0 |
| FR-7 | For forward trig functions (sin, cos, tan), input shall be converted from degrees to radians before computation when angle_unit="degrees"; for inverse trig functions (asin, acos, atan, atan2), output shall be converted from radians to degrees | asin with a=1, angle_unit="degrees" returns 90.0 |
| FR-8 | Inverse trig domain constraints shall be enforced: asin/acos require -1≤a≤1, acosh requires a≥1, atanh requires -1<a<1; violations return DOMAIN_ERROR (HTTP 400) | asin with a=2 returns DOMAIN_ERROR |
| FR-9 | The API shall provide logarithmic operations: ln, log10, log2 (accepting a), log (accepting a, base), exp (accepting a) at POST /api/v1/logarithmic/{operation} | POST /api/v1/logarithmic/{op} returns correct result for valid inputs |
| FR-10 | Logarithmic domain constraints shall be enforced: ln/log10/log2 require a>0; log requires a>0, base>0, base≠1; violations return DOMAIN_ERROR (HTTP 400) | ln with a=0 returns DOMAIN_ERROR; log with base=1 returns DOMAIN_ERROR |
| FR-11 | The API shall provide statistical operations: mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count at POST /api/v1/statistics/{operation} accepting {"values": [N, ...]} | POST /api/v1/statistics/mean with values=[1,2,3] returns 2.0 |
| FR-12 | Statistics operations shall require at least 1 element; stdev/variance (sample) shall require at least 2 elements; violations return INVALID_INPUT (HTTP 422) | stdev with values=[5] returns INVALID_INPUT |
| FR-13 | mode shall return the smallest mode on ties | mode with values=[1,2,1,2] returns 1 |
| FR-14 | The API shall expose named mathematical constants via GET /api/v1/constants/{name}: pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10 | GET /api/v1/constants/pi returns {"status":"ok","result":3.141592653589793} |
| FR-15 | GET /api/v1/constants shall return all constants as a map | Response contains all 9 constant names and their values |
| FR-16 | The API shall provide unit conversions via POST /api/v1/conversions/{category} accepting {"value": N, "from_unit": "...", "to_unit": "..."} | POST /api/v1/conversions/temperature with value=100, from_unit="celsius", to_unit="fahrenheit" returns 212.0 |
| FR-17 | Supported conversion categories and units: angle (degrees/radians/gradians), temperature (celsius/fahrenheit/kelvin), length (meters/feet/inches/centimeters/millimeters/kilometers/miles/yards), weight (kilograms/pounds/ounces/grams/milligrams/tonnes/stones) | All listed unit pairs produce correct conversions |
| FR-18 | GET /health shall return {"status":"ok","version":"0.1.0"} with HTTP 200 | GET /health returns 200 with the specified JSON body |
| FR-19 | All success responses shall use the envelope: `{"status":"ok","operation":"<name>","inputs":{...},"result":<value>}` | Every successful endpoint returns this exact shape |
| FR-20 | All error responses shall use the envelope: `{"status":"error","operation":"<name>","inputs":{...},"error":{"code":"<CODE>","message":"..."}}` | Every error response matches this shape including validation errors |
| FR-21 | Schema validation errors (from Pydantic) shall be overridden to conform to the error envelope with code INVALID_INPUT and HTTP 422 | Sending {"a":"not_a_number"} returns the structured error envelope, not FastAPI's default 422 format |
| FR-22 | Unknown endpoints shall return NOT_FOUND (HTTP 404) in the structured error envelope | GET /api/v1/nonexistent returns {"status":"error","error":{"code":"NOT_FOUND",...}} |
| FR-23 | Results that exceed representable float range shall return OVERFLOW (HTTP 400) in the structured error envelope | exp(a=99999) or similar overflow returns HTTP 400 with OVERFLOW code |
| FR-24 | Unexpected exceptions shall be caught, logged at ERROR level, and return a generic INTERNAL_ERROR response (never a bare HTTP 500 with stack trace) | No operation ever returns an unstructured 500 response to the client |

## Non-Functional Requirements

| ID | Requirement | Measure |
|---|---|---|
| NFR-1 | All tests shall achieve ≥90% line coverage | pytest-cov report shows ≥90% line coverage |
| NFR-2 | Results shall match Python math stdlib to ≤1 ULP for standard operations | Automated tests verify each operation against math stdlib within 1 ULP tolerance |
| NFR-3 | Response latency shall be p95 < 50ms for any single operation | Load test or benchmark shows p95 latency under 50ms |
| NFR-4 | Application startup time shall be < 2 seconds | Server responds to /health within 2s of process start |
| NFR-5 | Maximum request body size shall be 1 MB | Requests exceeding 1 MB are rejected |
| NFR-6 | The API shall be stateless — no persistent storage or session state between requests | No database, file, or session storage is used; confirmed by architecture review |
| NFR-7 | The API shall be versioned via URL prefix (/api/v1/...) following semver | All operational endpoints are under /api/v1/ path prefix |
| NFR-8 | The API shall never return a bare HTTP 500; unexpected exceptions are caught and returned as structured INTERNAL_ERROR responses | Error handler middleware catches all unhandled exceptions; logged at ERROR level |

## Assumptions

- A-1: The implementation language is Python with FastAPI framework (implied by references to FastAPI/Pydantic and Python math stdlib)
- A-2: Python's built-in `math` and `statistics` modules provide sufficient precision (no external arbitrary-precision libraries needed)
- A-3: The API will run as a single-process HTTP server via uvicorn (no distributed deployment concerns for MVP)
- A-4: "0.1.0" is the initial version identifier returned by the health endpoint
- A-5: All numeric inputs and outputs use IEEE 754 double-precision floating point (Python's native float)
- A-6: Inverse trig functions (asin, acos, atan, atan2) return results in the unit specified by angle_unit (radians default, degrees if requested)
- A-7: Special float inputs (NaN, Infinity, -Infinity) are accepted where mathematically valid; behavior follows Python math stdlib semantics
- A-8: JSON serialization of special float values (inf, nan) uses string representations where standard JSON cannot represent them
- A-9: Unit conversion factors use standard authoritative values (SI definitions, exact where possible)
- A-10: No authentication or authorization is needed for MVP; the API is for development/testing use

## Out of Scope

- OOS-1: Persistent storage or user accounts
- OOS-2: Graphical or terminal UI
- OOS-3: Symbolic / computer-algebra (CAS) capabilities
- OOS-4: Arbitrary-precision or big-number libraries beyond Python's standard `decimal` module
- OOS-5: Authentication, rate-limiting, or production hardening
- OOS-6: Expression evaluation from string input
- OOS-7: WebSocket or streaming responses
- OOS-8: Caching layer
- OOS-9: Containerization or deployment scripts (infrastructure)
- OOS-10: API documentation UI (Swagger/ReDoc auto-generated by FastAPI is acceptable but not a deliverable)
