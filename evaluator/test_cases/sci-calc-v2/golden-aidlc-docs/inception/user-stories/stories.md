# User Stories

## Arithmetic

### US-01: Basic Arithmetic
**As** an API consumer, **I want** to perform basic arithmetic (add, subtract, multiply, divide, modulo) on two numbers, **so that** I can offload calculations to the API.

**Given** a valid POST to /api/v1/arithmetic/{operation} with `{"a": N, "b": N}`
**When** the operation is supported and inputs are valid
**Then** the API returns 200 with `{"status": "ok", "operation": "<op>", "inputs": {...}, "result": N}`

### US-02: Unary Arithmetic
**As** an API consumer, **I want** to compute absolute value and negation, **so that** I can transform single numbers.

**Given** a valid POST to /api/v1/arithmetic/abs or /negate with `{"a": N}`
**When** the input is valid
**Then** the API returns the correct result in the success envelope

### US-03: Division by Zero
**As** an API consumer, **I want** a clear error when dividing by zero, **so that** I can handle it in my application.

**Given** a POST to /api/v1/arithmetic/divide with `{"a": N, "b": 0}`
**When** the divisor is zero
**Then** the API returns 400 with error code DIVISION_BY_ZERO

## Powers and Roots

### US-04: Power Operations
**As** an API consumer, **I want** to compute powers, square roots, cube roots, and nth roots, **so that** I can perform exponential calculations.

**Given** valid inputs to /api/v1/powers/{operation}
**When** the domain constraints are satisfied
**Then** the API returns the correct result

### US-05: Domain Errors for Roots
**As** an API consumer, **I want** a DOMAIN_ERROR when requesting sqrt of a negative number, **so that** I know my input is mathematically invalid.

**Given** POST /api/v1/powers/sqrt with `{"a": -1}`
**When** the input violates the mathematical domain
**Then** the API returns 400 with DOMAIN_ERROR

## Trigonometry

### US-06: Trig Calculations
**As** an API consumer, **I want** to compute trig functions in both degrees and radians, **so that** I can work in my preferred angle unit.

**Given** POST /api/v1/trigonometry/{operation} with `{"a": N, "angle_unit": "degrees"|"radians"}`
**When** the input is within the function's domain
**Then** the API returns the correct result (defaulting to radians if angle_unit omitted)

### US-07: Inverse Trig Domain Errors
**As** an API consumer, **I want** clear errors for invalid inverse trig inputs (e.g., asin(2)), **so that** I can validate inputs client-side.

**Given** POST /api/v1/trigonometry/asin with `{"a": 2}`
**When** input is outside [-1, 1]
**Then** the API returns 400 with DOMAIN_ERROR

## Logarithms

### US-08: Logarithmic Calculations
**As** an API consumer, **I want** to compute natural log, log base 10, log base 2, arbitrary-base log, and exp, **so that** I have full logarithmic support.

**Given** valid inputs to /api/v1/logarithmic/{operation}
**When** the domain constraints are satisfied (a > 0, base > 0, base != 1)
**Then** the API returns the correct result

## Statistics

### US-09: Statistical Aggregations
**As** an API consumer, **I want** to compute mean, median, mode, stdev, variance, and other statistics on a list of numbers, **so that** I can perform data analysis via HTTP.

**Given** POST /api/v1/statistics/{operation} with `{"values": [N, ...]}`
**When** the array meets minimum size requirements
**Then** the API returns the correct statistical result

### US-10: Mode Tie-Breaking
**As** an API consumer, **I want** mode to return the smallest value on ties, **so that** results are deterministic.

**Given** POST /api/v1/statistics/mode with `{"values": [1, 2, 1, 2]}`
**When** multiple modes exist
**Then** the API returns 1 (smallest)

## Constants

### US-11: Retrieve Constants
**As** an API consumer, **I want** to retrieve mathematical constants (pi, e, tau, etc.), **so that** I use consistent precision values.

**Given** GET /api/v1/constants or GET /api/v1/constants/{name}
**When** the constant name is valid
**Then** the API returns the constant value in the success envelope

## Conversions

### US-12: Unit Conversions
**As** an API consumer, **I want** to convert between units (angle, temperature, length, weight), **so that** I can handle unit transformations without local logic.

**Given** POST /api/v1/conversions/{category} with `{"value": N, "from_unit": "...", "to_unit": "..."}`
**When** units are valid for the category
**Then** the API returns the converted value

## Health & Errors

### US-13: Health Check
**As** an API consumer, **I want** a health endpoint, **so that** I can verify the service is running.

**Given** GET /health
**When** the service is up
**Then** returns `{"status": "ok", "version": "0.1.0"}`

### US-14: Unknown Endpoint
**As** an API consumer, **I want** a 404 with NOT_FOUND error code for invalid paths, **so that** I can distinguish routing errors from operation errors.

**Given** a request to an unknown path
**When** no route matches
**Then** returns 404 with error code NOT_FOUND
