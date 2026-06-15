# Stories

## S-1: Perform binary arithmetic operations

**Type:** user story

**Statement:**
As an API Consumer, I want to perform arithmetic operations (add, subtract, multiply, divide, modulo) on two numbers, so that I can compute results without a local math library.

**Acceptance Criteria:**
- Given valid inputs `{"a": 10, "b": 3}`, when I POST to `/api/v1/arithmetic/add`, then I receive `{"status": "ok", "operation": "add", "inputs": {"a": 10, "b": 3}, "result": 13}`
- Given valid numbers `a` and `b`, when I POST to `/api/v1/arithmetic/subtract`, then I receive the difference
- Given valid numbers `a` and `b`, when I POST to `/api/v1/arithmetic/multiply`, then I receive the product
- Given valid numbers `a` and `b`, when I POST to `/api/v1/arithmetic/divide`, then I receive the quotient
- Given valid numbers `a` and `b`, when I POST to `/api/v1/arithmetic/modulo`, then I receive the remainder

**Requirements:** FR-1

---

## S-2: Perform unary arithmetic operations

**Type:** user story

**Statement:**
As an API Consumer, I want to compute absolute value and negation of a number, so that I can transform values without client-side logic.

**Acceptance Criteria:**
- Given `{"a": -5}`, when I POST to `/api/v1/arithmetic/abs`, then I receive result `5`
- Given `{"a": 7}`, when I POST to `/api/v1/arithmetic/negate`, then I receive result `-7`

**Requirements:** FR-2

---

## S-3: Handle division by zero

**Type:** system story

**Statement:**
As the calculator service, when a divide or modulo operation receives `b = 0`, it must return HTTP 400 with error code `DIVISION_BY_ZERO`.

**Acceptance Criteria:**
- Given `{"a": 5, "b": 0}`, when I POST to `/api/v1/arithmetic/divide`, then I receive HTTP 400 with `{"status": "error", "operation": "divide", "inputs": {"a": 5, "b": 0}, "error": {"code": "DIVISION_BY_ZERO", "message": "..."}}`
- Given `{"a": 5, "b": 0}`, when I POST to `/api/v1/arithmetic/modulo`, then I receive HTTP 400 with `DIVISION_BY_ZERO`

**Requirements:** FR-3

---

## S-4: Compute powers and roots

**Type:** user story

**Statement:**
As an API Consumer, I want to compute power, square root, cube root, square, and nth root, so that I can perform exponentiation and root extraction via the API.

**Acceptance Criteria:**
- Given `{"base": 2, "exponent": 10}`, when I POST to `/api/v1/powers/power`, then I receive result `1024`
- Given `{"a": 9}`, when I POST to `/api/v1/powers/sqrt`, then I receive result `3.0`
- Given `{"a": 27}`, when I POST to `/api/v1/powers/cbrt`, then I receive result `3.0`
- Given `{"a": 5}`, when I POST to `/api/v1/powers/square`, then I receive result `25`
- Given `{"a": 16, "n": 4}`, when I POST to `/api/v1/powers/nth_root`, then I receive result `2.0`

**Requirements:** FR-4, FR-5, FR-6

---

## S-5: Handle domain errors in powers

**Type:** system story

**Statement:**
As the calculator service, when `sqrt` receives `a < 0` or `nth_root` receives `a < 0` with even `n`, it must return HTTP 400 with error code `DOMAIN_ERROR`.

**Acceptance Criteria:**
- Given `{"a": -1}`, when I POST to `/api/v1/powers/sqrt`, then I receive HTTP 400 with `DOMAIN_ERROR`
- Given `{"a": -8, "n": 2}`, when I POST to `/api/v1/powers/nth_root`, then I receive HTTP 400 with `DOMAIN_ERROR`
- Given `{"a": -8, "n": 3}`, when I POST to `/api/v1/powers/nth_root`, then I receive result `-2.0` (odd root of negative is allowed)

**Requirements:** FR-7

---

## S-6: Compute trigonometric functions

**Type:** user story

**Statement:**
As an API Consumer, I want to compute trig functions (sin, cos, tan, asin, acos, atan, atan2) and hyperbolic functions (sinh, cosh, tanh, asinh, acosh, atanh) with configurable angle unit, so that I can work in degrees or radians.

**Acceptance Criteria:**
- Given `{"a": 0, "angle_unit": "radians"}`, when I POST to `/api/v1/trigonometry/sin`, then I receive result `0.0`
- Given `{"a": 90, "angle_unit": "degrees"}`, when I POST to `/api/v1/trigonometry/sin`, then I receive result `1.0`
- Given `{"y": 1, "x": 1, "angle_unit": "radians"}`, when I POST to `/api/v1/trigonometry/atan2`, then I receive result `≈ 0.7854` (π/4)
- Given `{"a": 0}` with no `angle_unit` field, when I POST, then it defaults to radians and returns `0.0`
- All 14 trig operations respond correctly with the success envelope

**Requirements:** FR-8, FR-9, FR-10

---

## S-7: Handle domain errors in trigonometry

**Type:** system story

**Statement:**
As the calculator service, when inverse trig functions receive inputs outside their domain, it must return HTTP 400 with `DOMAIN_ERROR`.

**Acceptance Criteria:**
- Given `{"a": 2, "angle_unit": "radians"}`, when I POST to `/api/v1/trigonometry/asin`, then I receive `DOMAIN_ERROR` (requires -1 <= a <= 1)
- Given `{"a": -2, "angle_unit": "radians"}`, when I POST to `/api/v1/trigonometry/acos`, then I receive `DOMAIN_ERROR`
- Given `{"a": 0.5, "angle_unit": "radians"}`, when I POST to `/api/v1/trigonometry/acosh`, then I receive `DOMAIN_ERROR` (requires a >= 1)
- Given `{"a": 1, "angle_unit": "radians"}`, when I POST to `/api/v1/trigonometry/atanh`, then I receive `DOMAIN_ERROR` (requires -1 < a < 1)

**Requirements:** FR-11

---

## S-8: Degree mode for trigonometry

**Type:** user story

**Statement:**
As an API Consumer, I want to specify `angle_unit` as `"degrees"` so that forward trig functions accept degrees as input and inverse trig functions return degrees as output.

**Acceptance Criteria:**
- Given `{"a": 90, "angle_unit": "degrees"}`, when I POST to `/api/v1/trigonometry/sin`, then result is `1.0`
- Given `{"a": 1, "angle_unit": "degrees"}`, when I POST to `/api/v1/trigonometry/asin`, then result is `90.0`
- Given `{"a": 1, "angle_unit": "radians"}`, when I POST to `/api/v1/trigonometry/asin`, then result is `≈ 1.5708`

**Requirements:** FR-12

---

## S-9: Compute logarithmic functions

**Type:** user story

**Statement:**
As an API Consumer, I want to compute natural log, log base 10, log base 2, arbitrary-base log, and exponential, so that I can perform logarithmic operations via the API.

**Acceptance Criteria:**
- Given `{"a": 1}`, when I POST to `/api/v1/logarithmic/ln`, then I receive result `0.0`
- Given `{"a": 100}`, when I POST to `/api/v1/logarithmic/log10`, then I receive result `2.0`
- Given `{"a": 8}`, when I POST to `/api/v1/logarithmic/log2`, then I receive result `3.0`
- Given `{"a": 8, "base": 2}`, when I POST to `/api/v1/logarithmic/log`, then I receive result `3.0`
- Given `{"a": 0}`, when I POST to `/api/v1/logarithmic/exp`, then I receive result `1.0`

**Requirements:** FR-13, FR-14, FR-15

---

## S-10: Handle domain errors in logarithms

**Type:** system story

**Statement:**
As the calculator service, when logarithm operations receive inputs outside their domain, it must return HTTP 400 with `DOMAIN_ERROR`.

**Acceptance Criteria:**
- Given `{"a": 0}`, when I POST to `/api/v1/logarithmic/ln`, then I receive `DOMAIN_ERROR`
- Given `{"a": -1}`, when I POST to `/api/v1/logarithmic/log10`, then I receive `DOMAIN_ERROR`
- Given `{"a": 8, "base": 1}`, when I POST to `/api/v1/logarithmic/log`, then I receive `DOMAIN_ERROR`
- Given `{"a": 8, "base": -2}`, when I POST to `/api/v1/logarithmic/log`, then I receive `DOMAIN_ERROR`

**Requirements:** FR-16

---

## S-11: Compute statistical operations

**Type:** user story

**Statement:**
As an API Consumer, I want to compute mean, median, mode, standard deviation, variance, population stdev/variance, min, max, sum, and count on a list of numbers, so that I can perform statistical analysis via the API.

**Acceptance Criteria:**
- Given `{"values": [1, 2, 3, 4, 5]}`, when I POST to `/api/v1/statistics/mean`, then I receive result `3.0`
- Given `{"values": [1, 3, 2]}`, when I POST to `/api/v1/statistics/median`, then I receive result `2.0`
- Given `{"values": [1, 2, 2, 3]}`, when I POST to `/api/v1/statistics/mode`, then I receive result `2`
- Given `{"values": [2, 4, 4, 4, 5, 5, 7, 9]}`, when I POST to `/api/v1/statistics/stdev`, then I receive the sample standard deviation
- All statistical operations return results in the success envelope

**Requirements:** FR-17, FR-19

---

## S-12: Handle invalid statistical inputs

**Type:** system story

**Statement:**
As the calculator service, when statistics operations receive fewer elements than required, it must return appropriate errors.

**Acceptance Criteria:**
- Given `{"values": []}`, when I POST to any statistics operation, then I receive HTTP 422 with `INVALID_INPUT` (at least 1 element required)
- Given `{"values": [5]}`, when I POST to `/api/v1/statistics/stdev`, then I receive HTTP 422 with `INVALID_INPUT` (requires at least 2 elements)
- Given `{"values": [5]}`, when I POST to `/api/v1/statistics/variance`, then I receive HTTP 422 with `INVALID_INPUT`
- Given `{"values": [5]}`, when I POST to `/api/v1/statistics/pstdev`, then I receive a valid result (population stdev allows 1 element)

**Requirements:** FR-18

---

## S-13: Mode tie-breaking

**Type:** user story

**Statement:**
As an API Consumer, I want mode to return the smallest value when there are ties, so that results are deterministic.

**Acceptance Criteria:**
- Given `{"values": [1, 2, 1, 2]}`, when I POST to `/api/v1/statistics/mode`, then I receive result `1`
- Given `{"values": [3, 3, 1, 1, 2, 2]}`, when I POST to `/api/v1/statistics/mode`, then I receive result `1`

**Requirements:** FR-19 (tie-breaking behavior)

---

## S-14: Retrieve mathematical constants

**Type:** user story

**Statement:**
As an API Consumer, I want to retrieve individual mathematical constants or all constants as a map, so that I can use precise values without hardcoding them.

**Acceptance Criteria:**
- Given a GET `/api/v1/constants/pi`, then I receive result `3.141592653589793`
- Given a GET `/api/v1/constants/e`, then I receive result `2.718281828459045`
- When I GET `/api/v1/constants`, then I receive a map of all 9 constants (pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10)
- Given an unknown constant name, when I GET `/api/v1/constants/unknown`, then I receive `NOT_FOUND`

**Requirements:** FR-20, FR-21

---

## S-15: Perform unit conversions

**Type:** user story

**Statement:**
As an API Consumer, I want to convert values between units within supported categories (angle, temperature, length, weight), so that I can transform measurements via the API.

**Acceptance Criteria:**
- Given `{"value": 180, "from_unit": "degrees", "to_unit": "radians"}`, when I POST to `/api/v1/conversions/angle`, then I receive result `≈ 3.14159`
- Given `{"value": 0, "from_unit": "celsius", "to_unit": "fahrenheit"}`, when I POST to `/api/v1/conversions/temperature`, then I receive result `32.0`
- Given `{"value": 1, "from_unit": "kilometers", "to_unit": "miles"}`, when I POST to `/api/v1/conversions/length`, then I receive result `≈ 0.621371`
- Given `{"value": 1, "from_unit": "kilograms", "to_unit": "pounds"}`, when I POST to `/api/v1/conversions/weight`, then I receive result `≈ 2.20462`
- Given an unrecognized unit, when I POST, then I receive HTTP 422 with `INVALID_INPUT`

**Requirements:** FR-22, FR-23, FR-24, FR-25

---

## S-16: Health check endpoint

**Type:** user story

**Statement:**
As an Operations Engineer, I want a health-check endpoint that confirms the service is running and reports its version, so that I can use it for readiness probes.

**Acceptance Criteria:**
- When I GET `/health`, then I receive HTTP 200 with `{"status": "ok", "version": "0.1.0"}`

**Requirements:** FR-26

---

## S-17: Receive structured success responses

**Type:** system story

**Statement:**
As the calculator service, when any operation succeeds, it must return the standard success envelope with status, operation name, inputs echo, and result.

**Acceptance Criteria:**
- Given any successful operation, the response body always contains `status: "ok"`, `operation: "<name>"`, `inputs: {<echoed inputs>}`, and `result: <value>`
- The Content-Type header is `application/json`

**Requirements:** FR-27

---

## S-18: Receive structured error responses

**Type:** system story

**Statement:**
As the calculator service, when any operation fails, it must return the standard error envelope with status, operation name, inputs echo, and error object (code + message).

**Acceptance Criteria:**
- Given any validation failure, the response uses HTTP 422 with code `INVALID_INPUT`
- Given any domain error, the response uses HTTP 400 with the appropriate code
- Given any unknown endpoint, the response uses HTTP 404 with code `NOT_FOUND`
- All error responses contain `status: "error"`, `operation`, `inputs`, and `error: {code, message}`

**Requirements:** FR-28, FR-29, FR-30

---

## S-19: Override framework validation error format

**Type:** system story

**Statement:**
As the calculator service, when Pydantic validation fails, it must return the structured error envelope with code `INVALID_INPUT` (HTTP 422) instead of FastAPI's default format.

**Acceptance Criteria:**
- Given a request with `{"a": "not_a_number"}`, when processed by FastAPI, then the response is `{"status":"error","operation":"...","inputs":{...},"error":{"code":"INVALID_INPUT","message":"..."}}` with HTTP 422
- Given a request to a valid endpoint with a missing required field, then the same structured error envelope is returned

**Requirements:** FR-29

---

## S-20: Handle overflow errors

**Type:** system story

**Statement:**
As the calculator service, when a computation result exceeds representable floating-point range, it must return HTTP 400 with error code `OVERFLOW`.

**Acceptance Criteria:**
- Given `{"a": 710}`, when I POST to `/api/v1/logarithmic/exp`, then I receive HTTP 400 with `OVERFLOW` (math.exp(710) overflows to inf)
- Given `{"base": 10, "exponent": 309}`, when I POST to `/api/v1/powers/power`, then I receive HTTP 400 with `OVERFLOW`

**Requirements:** FR-31

---

## S-21: Handle unexpected errors gracefully

**Type:** system story

**Statement:**
As the calculator service, when an unexpected exception occurs, it must log at ERROR level and return a generic `INTERNAL_ERROR` response — never a bare 500 with stack trace.

**Acceptance Criteria:**
- Given an unexpected runtime exception, the service returns a JSON error envelope with `code: "INTERNAL_ERROR"` and HTTP 500
- The exception is logged at ERROR level with stack trace
- No bare 500 response with stack trace is ever returned to the client

**Requirements:** FR-32

---

## S-22: Mathematical precision guarantee

**Type:** system story

**Statement:**
As the calculator service, all mathematical operations must produce results matching Python's `math` stdlib to within 1 ULP.

**Acceptance Criteria:**
- Given standard math operations, the results are identical to Python's `math` module output (within floating-point representation limits)
- Test suite includes precision verification against known reference values

**Requirements:** NFR-1

---

## S-23: Performance target

**Type:** system story

**Statement:**
As the calculator service, any single operation must respond within 50ms at the 95th percentile.

**Acceptance Criteria:**
- Given any single computation endpoint, the p95 response time is < 50ms under normal load

**Requirements:** NFR-2

---

## S-24: Test coverage target

**Type:** system story

**Statement:**
As the calculator service, the test suite must achieve >= 90% line coverage.

**Acceptance Criteria:**
- Running the test suite with coverage measurement reports >= 90% line coverage across all source modules

**Requirements:** NFR-3

---

## S-25: Stateless operation

**Type:** system story

**Statement:**
As the calculator service, no request must depend on any prior request — all operations are stateless.

**Acceptance Criteria:**
- Given any sequence of requests in any order, when processed, then each produces the same result regardless of prior requests
- The service holds no mutable per-request state between calls

**Requirements:** NFR-5

---

## Coverage Matrix

| Requirement | Stories |
|---|---|
| FR-1 | S-1 |
| FR-2 | S-2 |
| FR-3 | S-3 |
| FR-4, FR-5, FR-6 | S-4 |
| FR-7 | S-5 |
| FR-8, FR-9, FR-10 | S-6 |
| FR-11 | S-7 |
| FR-12 | S-8 |
| FR-13, FR-14, FR-15 | S-9 |
| FR-16 | S-10 |
| FR-17, FR-19 | S-11 |
| FR-18 | S-12 |
| FR-19 (tie-breaking) | S-13 |
| FR-20, FR-21 | S-14 |
| FR-22, FR-23, FR-24, FR-25 | S-15 |
| FR-26 | S-16 |
| FR-27 | S-17 |
| FR-28, FR-29, FR-30 | S-18 |
| FR-29 | S-19 |
| FR-31 | S-20 |
| FR-32 | S-21 |
| NFR-1 | S-22 |
| NFR-2 | S-23 |
| NFR-3 | S-24 |
| NFR-4 | S-16 (URL-prefix /api/v1/ used throughout; health at /health unversioned) |
| NFR-5 | S-25 |
| NFR-6 | S-21 (structured error envelope — never bare 500) |
