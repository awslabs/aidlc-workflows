# Stories

## S-1: Perform arithmetic operations

**Type:** user story

**Statement:** As an API Consumer, I want to perform arithmetic operations (add, subtract, multiply, divide, modulo, abs, negate) via HTTP POST, so that I can compute basic math without a local library.

**Acceptance Criteria:**
- Given valid inputs `{"a": 10, "b": 3}`, when I POST to `/api/v1/arithmetic/add`, then I receive `{"status":"ok","operation":"add","inputs":{"a":10,"b":3},"result":13}`
- Given valid inputs, when I POST to `/api/v1/arithmetic/subtract`, then result is `a - b`
- Given valid inputs, when I POST to `/api/v1/arithmetic/multiply`, then result is `a * b`
- Given valid inputs where `b != 0`, when I POST to `/api/v1/arithmetic/divide`, then result is `a / b`
- Given valid inputs where `b != 0`, when I POST to `/api/v1/arithmetic/modulo`, then result is `a % b`
- Given valid input `{"a": -5}`, when I POST to `/api/v1/arithmetic/abs`, then I receive result `5`
- Given valid input `{"a": 7}`, when I POST to `/api/v1/arithmetic/negate`, then I receive result `-7`

**Requirements:** FR-1

---

## S-2: Division by zero error handling

**Type:** system story

**Statement:** As the calculator API, when a division or modulo operation receives b=0, it must return a DIVISION_BY_ZERO error with HTTP 400.

**Acceptance Criteria:**
- Given input `{"a": 10, "b": 0}`, when POST to `/api/v1/arithmetic/divide`, then response is HTTP 400 with `{"status":"error","operation":"divide","inputs":{"a":10,"b":0},"error":{"code":"DIVISION_BY_ZERO","message":"..."}}`
- Given input `{"a": 10, "b": 0}`, when POST to `/api/v1/arithmetic/modulo`, then response is HTTP 400 with DIVISION_BY_ZERO error

**Requirements:** FR-2

---

## S-3: Perform power and root operations

**Type:** user story

**Statement:** As an API Consumer, I want to compute powers (power, square) and roots (sqrt, cbrt, nth_root) via HTTP POST, so that I can perform exponentiation without a local math library.

**Acceptance Criteria:**
- Given `{"base": 2, "exponent": 10}`, when POST to `/api/v1/powers/power`, then result is `1024`
- Given `{"a": 16}`, when POST to `/api/v1/powers/sqrt`, then result is `4.0`
- Given `{"a": 27}`, when POST to `/api/v1/powers/cbrt`, then result is `3.0`
- Given `{"a": 5}`, when POST to `/api/v1/powers/square`, then result is `25`
- Given `{"a": 27, "n": 3}`, when POST to `/api/v1/powers/nth_root`, then result is `3.0`

**Requirements:** FR-3

---

## S-4: Power/root domain errors

**Type:** system story

**Statement:** As the calculator API, when sqrt receives a<0 or nth_root receives a<0 with even n, it must return a DOMAIN_ERROR with HTTP 400.

**Acceptance Criteria:**
- Given `{"a": -1}`, when POST to `/api/v1/powers/sqrt`, then response is HTTP 400 with DOMAIN_ERROR
- Given `{"a": -4, "n": 2}`, when POST to `/api/v1/powers/nth_root`, then response is HTTP 400 with DOMAIN_ERROR
- Given `{"a": -8, "n": 3}`, when POST to `/api/v1/powers/nth_root`, then result is `-2.0` (odd root of negative is valid)
- Given `{"a": 0, "n": 0}`, when POST to `/api/v1/powers/nth_root`, then response is HTTP 400 with DOMAIN_ERROR

**Requirements:** FR-4

---

## S-5: Perform trigonometric operations

**Type:** user story

**Statement:** As an API Consumer, I want to compute trigonometric functions (sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh) with configurable angle units, so that I can do trig calculations in either degrees or radians.

**Acceptance Criteria:**
- Given `{"a": 1.5707963267948966, "angle_unit": "radians"}`, when POST to `/api/v1/trigonometry/sin`, then result is `1.0`
- Given `{"a": 90, "angle_unit": "degrees"}`, when POST to `/api/v1/trigonometry/sin`, then result is `1.0`
- Given `{"a": 0}` without `angle_unit`, when POST to any trig endpoint, then radians is used as default
- Given `{"y": 1, "x": 1, "angle_unit": "degrees"}`, when POST to `/api/v1/trigonometry/atan2`, then result is `45.0`
- Given `{"a": 1, "angle_unit": "radians"}`, when POST to `/api/v1/trigonometry/asin`, then result is approximately `1.5708` (pi/2)
- Given `{"a": 1, "angle_unit": "degrees"}`, when POST to `/api/v1/trigonometry/asin`, then result is `90.0`
- Given `{"a": 1, "angle_unit": "radians"}`, when POST to `/api/v1/trigonometry/sinh`, then result matches `math.sinh(1)`

**Requirements:** FR-5, FR-6

---

## S-6: Trigonometric domain errors

**Type:** system story

**Statement:** As the calculator API, when inverse trig domain constraints are violated (asin/acos: |a|>1, acosh: a<1, atanh: |a|≥1), it must return DOMAIN_ERROR with HTTP 400.

**Acceptance Criteria:**
- Given `{"a": 2, "angle_unit": "radians"}`, when POST to `/api/v1/trigonometry/asin`, then response is HTTP 400 with DOMAIN_ERROR
- Given `{"a": -2, "angle_unit": "radians"}`, when POST to `/api/v1/trigonometry/acos`, then response is HTTP 400 with DOMAIN_ERROR
- Given `{"a": 0.5, "angle_unit": "radians"}`, when POST to `/api/v1/trigonometry/acosh`, then response is HTTP 400 with DOMAIN_ERROR
- Given `{"a": 1, "angle_unit": "radians"}`, when POST to `/api/v1/trigonometry/atanh`, then response is HTTP 400 with DOMAIN_ERROR

**Requirements:** FR-7

---

## S-7: Perform logarithmic operations

**Type:** user story

**Statement:** As an API Consumer, I want to compute logarithms (ln, log10, log2, log with arbitrary base) and exp via HTTP POST, so that I can do log/exp calculations remotely.

**Acceptance Criteria:**
- Given `{"a": 2.718281828459045}`, when POST to `/api/v1/logarithmic/ln`, then result is approximately `1.0`
- Given `{"a": 100}`, when POST to `/api/v1/logarithmic/log10`, then result is `2.0`
- Given `{"a": 8}`, when POST to `/api/v1/logarithmic/log2`, then result is `3.0`
- Given `{"a": 81, "base": 3}`, when POST to `/api/v1/logarithmic/log`, then result is `4.0`
- Given `{"a": 1}`, when POST to `/api/v1/logarithmic/exp`, then result is approximately `2.718281828459045`

**Requirements:** FR-8

---

## S-8: Logarithmic domain errors

**Type:** system story

**Statement:** As the calculator API, when log operations receive invalid domains (a≤0 for ln/log10/log2, a≤0 or base≤0 or base=1 for log), it must return DOMAIN_ERROR with HTTP 400.

**Acceptance Criteria:**
- Given `{"a": 0}`, when POST to `/api/v1/logarithmic/ln`, then response is HTTP 400 with DOMAIN_ERROR
- Given `{"a": -5}`, when POST to `/api/v1/logarithmic/log10`, then response is HTTP 400 with DOMAIN_ERROR
- Given `{"a": 10, "base": 1}`, when POST to `/api/v1/logarithmic/log`, then response is HTTP 400 with DOMAIN_ERROR
- Given `{"a": 10, "base": -2}`, when POST to `/api/v1/logarithmic/log`, then response is HTTP 400 with DOMAIN_ERROR

**Requirements:** FR-9

---

## S-9: Perform statistical operations

**Type:** user story

**Statement:** As an API Consumer, I want to compute statistical functions (mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count) on arrays of numbers, so that I can do stats without a local library.

**Acceptance Criteria:**
- Given `{"values": [1, 2, 3, 4, 5]}`, when POST to `/api/v1/statistics/mean`, then result is `3.0`
- Given `{"values": [1, 3, 2]}`, when POST to `/api/v1/statistics/median`, then result is `2`
- Given `{"values": [1, 2, 2, 3]}`, when POST to `/api/v1/statistics/mode`, then result is `2`
- Given `{"values": [1, 1, 2, 2]}`, when POST to `/api/v1/statistics/mode`, then result is `1` (tie → smallest)
- Given `{"values": [2, 4, 4, 4, 5, 5, 7, 9]}`, when POST to `/api/v1/statistics/stdev`, then result matches Python `statistics.stdev`
- Given `{"values": [10, 20, 30]}`, when POST to `/api/v1/statistics/sum`, then result is `60`
- Given `{"values": [10, 20, 30]}`, when POST to `/api/v1/statistics/count`, then result is `3`

**Requirements:** FR-10

---

## S-10: Statistics validation and edge cases

**Type:** system story

**Statement:** As the calculator API, when statistics operations receive insufficient data (empty array, or <2 elements for stdev/variance), it must return INVALID_INPUT with HTTP 422.

**Acceptance Criteria:**
- Given `{"values": []}`, when POST to `/api/v1/statistics/mean`, then response is HTTP 422 with INVALID_INPUT
- Given `{"values": [5]}`, when POST to `/api/v1/statistics/stdev`, then response is HTTP 422 with INVALID_INPUT
- Given `{"values": [5]}`, when POST to `/api/v1/statistics/variance`, then response is HTTP 422 with INVALID_INPUT
- Given `{"values": [5]}`, when POST to `/api/v1/statistics/pstdev`, then result is `0.0` (1 element is valid for population)

**Requirements:** FR-11

---

## S-11: Retrieve mathematical constants

**Type:** user story

**Statement:** As an API Consumer, I want to retrieve mathematical constants (pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10) individually or all at once, so that I can use precise values without hardcoding.

**Acceptance Criteria:**
- Given GET `/api/v1/constants/pi`, then result is `3.141592653589793`
- Given GET `/api/v1/constants/e`, then result is `2.718281828459045`
- Given GET `/api/v1/constants`, then result is an object mapping all constant names to values
- Given GET `/api/v1/constants/unknown`, then response is HTTP 404 with NOT_FOUND

**Requirements:** FR-12

---

## S-12: Perform angle unit conversions

**Type:** user story

**Statement:** As an API Consumer, I want to convert angle values between degrees, radians, and gradians via HTTP POST, so that I can handle angle unit conversion without local lookup tables.

**Acceptance Criteria:**
- Given `{"value": 180, "from_unit": "degrees", "to_unit": "radians"}`, when POST to `/api/v1/conversions/angle`, then result is approximately `3.14159`
- Given `{"value": 3.14159, "from_unit": "radians", "to_unit": "gradians"}`, when POST to `/api/v1/conversions/angle`, then result is approximately `200`

**Requirements:** FR-13

---

## S-13: Perform temperature unit conversions

**Type:** user story

**Statement:** As an API Consumer, I want to convert temperature values between celsius, fahrenheit, and kelvin via HTTP POST, so that I can handle temperature conversion without local formulas.

**Acceptance Criteria:**
- Given `{"value": 100, "from_unit": "celsius", "to_unit": "fahrenheit"}`, when POST to `/api/v1/conversions/temperature`, then result is `212`
- Given `{"value": 0, "from_unit": "celsius", "to_unit": "kelvin"}`, when POST to `/api/v1/conversions/temperature`, then result is `273.15`

**Requirements:** FR-14

---

## S-14: Perform length unit conversions

**Type:** user story

**Statement:** As an API Consumer, I want to convert length values between meters, feet, inches, centimeters, millimeters, kilometers, miles, and yards via HTTP POST, so that I can handle length conversion without local lookup tables.

**Acceptance Criteria:**
- Given `{"value": 1, "from_unit": "kilometers", "to_unit": "meters"}`, when POST to `/api/v1/conversions/length`, then result is `1000`
- Given `{"value": 1, "from_unit": "kilometers", "to_unit": "miles"}`, when POST to `/api/v1/conversions/length`, then result is approximately `0.621371`

**Requirements:** FR-15

---

## S-15: Perform weight unit conversions

**Type:** user story

**Statement:** As an API Consumer, I want to convert weight values between kilograms, pounds, ounces, grams, milligrams, tonnes, and stones via HTTP POST, so that I can handle weight conversion without local lookup tables.

**Acceptance Criteria:**
- Given `{"value": 1, "from_unit": "kilograms", "to_unit": "pounds"}`, when POST to `/api/v1/conversions/weight`, then result is approximately `2.20462`
- Given `{"value": 1, "from_unit": "stones", "to_unit": "kilograms"}`, when POST to `/api/v1/conversions/weight`, then result is approximately `6.35029`

**Requirements:** FR-16

---

## S-16: Invalid conversion unit handling

**Type:** system story

**Statement:** As the calculator API, when a conversion request specifies an unsupported or unrecognized unit, it must return INVALID_INPUT with HTTP 422.

**Acceptance Criteria:**
- Given `{"value": 1, "from_unit": "parsecs", "to_unit": "meters"}`, when POST to `/api/v1/conversions/length`, then response is HTTP 422 with INVALID_INPUT
- Given `{"value": 1, "from_unit": "liters", "to_unit": "meters"}`, when POST to `/api/v1/conversions/length`, then response is HTTP 422 with INVALID_INPUT

**Requirements:** FR-17

---

## S-17: Health check endpoint

**Type:** user story

**Statement:** As an Operations Engineer, I want a health-check endpoint at GET /health, so that I can monitor service liveness.

**Acceptance Criteria:**
- Given the service is running, when GET `/health`, then response is HTTP 200 with `{"status":"ok","version":"0.1.0"}`

**Requirements:** FR-18

---

## S-18: Consistent response envelopes

**Type:** system story

**Statement:** As the calculator API, when any operation succeeds it must return the success envelope; when any operation fails it must return the error envelope — both with the operation name and echoed inputs.

**Acceptance Criteria:**
- Given any successful operation, then response body contains `{"status":"ok","operation":"<name>","inputs":{...},"result":...}`
- Given any failed operation, then response body contains `{"status":"error","operation":"<name>","inputs":{...},"error":{"code":"...","message":"..."}}`
- Given the operation name matches the URL path segment (e.g., `/arithmetic/add` → operation="add")

**Requirements:** FR-19, FR-20

---

## S-19: Schema validation returns INVALID_INPUT

**Type:** system story

**Statement:** As the calculator API, when a request body fails Pydantic validation, it must return HTTP 422 with INVALID_INPUT in the structured error envelope.

**Acceptance Criteria:**
- Given POST `/api/v1/arithmetic/add` with body `{"a": 10}` (missing b), then response is HTTP 422 with INVALID_INPUT error
- Given POST `/api/v1/arithmetic/add` with body `{"a": "text", "b": 2}`, then response is HTTP 422 with INVALID_INPUT error

**Requirements:** FR-21

---

## S-20: Unknown endpoint returns NOT_FOUND

**Type:** system story

**Statement:** As the calculator API, when a request hits an unknown endpoint, it must return HTTP 404 with the structured error envelope containing NOT_FOUND.

**Acceptance Criteria:**
- Given GET `/api/v1/nonexistent`, then response is HTTP 404 with `{"status":"error","operation":"unknown","inputs":{},"error":{"code":"NOT_FOUND","message":"..."}}`

**Requirements:** FR-22

---

## S-21: Overflow handling

**Type:** system story

**Statement:** As the calculator API, when a finite input produces a result that overflows to infinity, it must return OVERFLOW with HTTP 400.

**Acceptance Criteria:**
- Given `{"a": 710}`, when POST to `/api/v1/logarithmic/exp`, then response is HTTP 400 with OVERFLOW error
- Given `{"base": 10, "exponent": 309}`, when POST to `/api/v1/powers/power`, then response is HTTP 400 with OVERFLOW error

**Requirements:** FR-23

---

## S-22: Unexpected exception handling

**Type:** system story

**Statement:** As the calculator API, when an unexpected exception occurs, it must log at ERROR level and return a generic INTERNAL_ERROR response — never a bare HTTP 500 with a stack trace.

**Acceptance Criteria:**
- Given an unexpected exception during processing, then response is HTTP 500 with `{"status":"error","error":{"code":"INTERNAL_ERROR","message":"An unexpected error occurred"}}`
- Given the above, then the exception is logged at ERROR level with stack trace

**Requirements:** FR-24

---

## S-23: Test coverage and precision

**Type:** system story

**Statement:** As the calculator API, it must maintain ≥90% line coverage and all math operations must match Python math stdlib to ≤1 ULP.

**Acceptance Criteria:**
- Given the full test suite, when run with coverage, then line coverage is ≥90%
- Given each math operation, when compared to Python `math` stdlib result, then difference is ≤1 ULP

**Requirements:** NFR-1, NFR-2

---

## S-24: Response latency

**Type:** system story

**Statement:** As the calculator API, p95 response latency for any single operation must be under 50ms.

**Acceptance Criteria:**
- Given a benchmark of 1000 requests per operation, when measuring p95 latency, then it is <50ms

**Requirements:** NFR-3

---

## S-25: Stateless and versioned

**Type:** system story

**Statement:** As the calculator API, it must be fully stateless (no storage between requests) and all operational endpoints must be under the /api/v1/ prefix.

**Acceptance Criteria:**
- Given two identical requests sent sequentially, then both produce identical results (no session state)
- Given any operational endpoint, then its URL starts with `/api/v1/`

**Requirements:** NFR-4, NFR-5

---

## Traceability Matrix

| Requirement | Stories |
|---|---|
| FR-1 | S-1 |
| FR-2 | S-2 |
| FR-3 | S-3 |
| FR-4 | S-4 |
| FR-5 | S-5 |
| FR-6 | S-5 |
| FR-7 | S-6 |
| FR-8 | S-7 |
| FR-9 | S-8 |
| FR-10 | S-9 |
| FR-11 | S-10 |
| FR-12 | S-11 |
| FR-13 | S-12 |
| FR-14 | S-13 |
| FR-15 | S-14 |
| FR-16 | S-15 |
| FR-17 | S-16 |
| FR-18 | S-17 |
| FR-19 | S-18 |
| FR-20 | S-18 |
| FR-21 | S-19 |
| FR-22 | S-20 |
| FR-23 | S-21 |
| FR-24 | S-22 |
| NFR-1 | S-23 |
| NFR-2 | S-23 |
| NFR-3 | S-24 |
| NFR-4 | S-25 |
| NFR-5 | S-25 |
