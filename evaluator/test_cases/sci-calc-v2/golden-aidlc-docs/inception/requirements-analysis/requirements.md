# Requirements — Scientific Calculator API

## Intent Summary

| Attribute | Value |
|-----------|-------|
| **Type** | New feature (greenfield) |
| **Scope** | Single component |
| **Complexity** | Medium |
| **Classification** | Greenfield — no existing codebase |
| **Affected Repos** | None (new project) |

---

## Functional Requirements

### Arithmetic Operations

**FR-1:** The API SHALL expose `POST /api/v1/arithmetic/{operation}` for operations: `add`, `subtract`, `multiply`, `divide`, `modulo`, `abs`, `negate`.

**FR-2:** Binary arithmetic operations (`add`, `subtract`, `multiply`, `divide`, `modulo`) SHALL accept a JSON body `{"a": N, "b": N}` where N is a finite number.

**FR-3:** Unary arithmetic operations (`abs`, `negate`) SHALL accept a JSON body `{"a": N}` where N is a finite number.

**FR-4:** Division by zero (`divide` or `modulo` with `b = 0`) SHALL return error code `DIVISION_BY_ZERO` with HTTP 400.

### Powers and Roots

**FR-5:** The API SHALL expose `POST /api/v1/powers/{operation}` for operations: `power`, `sqrt`, `cbrt`, `nth_root`, `square`.

**FR-6:** `power` SHALL accept `{"base": N, "exponent": N}` and return `base ** exponent`.

**FR-7:** `sqrt`, `cbrt`, `square` SHALL accept `{"a": N}`.

**FR-8:** `nth_root` SHALL accept `{"a": N, "n": int}` and return the nth root of a.

**FR-9:** `sqrt` SHALL return `DOMAIN_ERROR` (400) when `a < 0`.

**FR-10:** `nth_root` SHALL return `DOMAIN_ERROR` (400) when `a < 0` and `n` is even.

### Trigonometry

**FR-11:** The API SHALL expose `POST /api/v1/trigonometry/{operation}` for operations: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`.

**FR-12:** Standard trig operations SHALL accept `{"a": N, "angle_unit": "radians"|"degrees"}` with `"radians"` as default.

**FR-13:** `atan2` SHALL accept `{"y": N, "x": N, "angle_unit": "radians"|"degrees"}` with `"radians"` as default.

**FR-14:** `asin` and `acos` SHALL return `DOMAIN_ERROR` (400) when input is outside [-1, 1].

**FR-15:** `acosh` SHALL return `DOMAIN_ERROR` (400) when `a < 1`.

**FR-16:** `atanh` SHALL return `DOMAIN_ERROR` (400) when `a` is outside (-1, 1).

### Logarithms

**FR-17:** The API SHALL expose `POST /api/v1/logarithmic/{operation}` for operations: `ln`, `log10`, `log2`, `log`, `exp`.

**FR-18:** `ln`, `log10`, `log2` SHALL accept `{"a": N}` and return `DOMAIN_ERROR` (400) when `a <= 0`.

**FR-19:** `log` SHALL accept `{"a": N, "base": N}` and return `DOMAIN_ERROR` (400) when `a <= 0`, `base <= 0`, or `base = 1`.

**FR-20:** `exp` SHALL accept `{"a": N}` and return `e ** a`. If the result overflows, return `OVERFLOW` (400).

### Statistics

**FR-21:** The API SHALL expose `POST /api/v1/statistics/{operation}` for operations: `mean`, `median`, `mode`, `stdev`, `variance`, `pstdev`, `pvariance`, `min`, `max`, `sum`, `count`.

**FR-22:** All statistics operations SHALL accept `{"values": [N, ...]}`.

**FR-23:** All statistics operations SHALL require at least 1 element. An empty array SHALL return `INVALID_INPUT` (422).

**FR-24:** `stdev` and `variance` SHALL require at least 2 elements. Arrays with fewer than 2 elements SHALL return `INVALID_INPUT` (422).

**FR-25:** `pstdev` and `pvariance` SHALL require at least 1 element.

**FR-26:** `mode` SHALL return the smallest mode when there are ties.

**FR-27:** Statistics operations SHALL use the Python `statistics` module directly and return its exact results.

### Constants

**FR-28:** The API SHALL expose `GET /api/v1/constants/{name}` returning the named constant's value.

**FR-29:** The API SHALL expose `GET /api/v1/constants` returning all constants as a map.

**FR-30:** Supported constants SHALL be: `pi`, `e`, `tau`, `inf`, `nan`, `golden_ratio`, `sqrt2`, `ln2`, `ln10`.

### Unit Conversions

**FR-31:** The API SHALL expose `POST /api/v1/conversions/{category}` accepting `{"value": N, "from_unit": "...", "to_unit": "..."}`.

**FR-32:** Supported categories and units SHALL be:
- **angle**: degrees, radians, gradians
- **temperature**: celsius, fahrenheit, kelvin
- **length**: meters, feet, inches, centimeters, millimeters, kilometers, miles, yards
- **weight**: kilograms, pounds, ounces, grams, milligrams, tonnes, stones

**FR-33:** An unrecognised unit string within a valid category SHALL return `INVALID_INPUT` (422) with a descriptive message indicating the unrecognised unit.

### Health Check

**FR-34:** The API SHALL expose `GET /health` returning `{"status": "ok", "version": "0.1.0"}`.

### Response Format

**FR-35:** All successful responses SHALL use the envelope: `{"status": "ok", "operation": "<name>", "inputs": {...}, "result": <value>}`.

**FR-36:** All error responses SHALL use the envelope: `{"status": "error", "operation": "<name>", "inputs": {...}, "error": {"code": "<CODE>", "message": "..."}}`.

**FR-37:** The API SHALL support the following error codes with corresponding HTTP statuses:
- `INVALID_INPUT` → 422
- `DIVISION_BY_ZERO` → 400
- `DOMAIN_ERROR` → 400
- `OVERFLOW` → 400
- `NOT_FOUND` → 404

### Input Validation

**FR-38:** The API SHALL reject `inf`, `-inf`, and `nan` as input values with `INVALID_INPUT` (422). Only finite numeric values are accepted.

**FR-39:** FastAPI/Pydantic schema validation errors SHALL be intercepted and returned in the structured error envelope format with code `INVALID_INPUT` (422).

### Error Handling

**FR-40:** The API SHALL never return a bare HTTP 500. All math-domain and overflow errors SHALL be caught and translated to the structured error envelope.

**FR-41:** Unexpected exceptions SHALL be logged at ERROR level and return a generic `INTERNAL_ERROR` response in the structured error envelope.

---

## Non-Functional Requirements

**NFR-1:** Response latency (p95) SHALL be less than 50ms for any single operation.

**NFR-2:** Test coverage SHALL be >= 90% line coverage.

**NFR-3:** Floating-point results for `math`-based operations SHALL match the Python `math` stdlib to <= 1 ULP (unit in the last place).

**NFR-4:** Statistics results SHALL match the Python `statistics` stdlib implementation exactly (use the module directly).

**NFR-5:** Application startup time SHALL be less than 2 seconds.

**NFR-6:** Maximum request body size SHALL be limited to 1 MB.

**NFR-7:** All endpoints SHALL accept and return `application/json` exclusively.

**NFR-8:** API SHALL be versioned via URL prefix (`/api/v1/...`). Initial release is v0.1.0 following semver.

---

## Assumptions

1. **Stateless architecture** — The API has no shared mutable state. Each request is independently processed. No concurrency concerns exist beyond framework defaults (uvicorn's async handling).
2. **Python stdlib sufficiency** — The Python `math` and `statistics` standard library modules provide sufficient precision and functionality. No third-party math libraries are needed.
3. **Single deployment unit** — The application is a single FastAPI service. No multi-service orchestration is required.
4. **Development scope** — This is a development/demonstration API. Production hardening (authentication, rate-limiting, TLS termination) is explicitly excluded.
5. **IEEE 754 double precision** — All numeric values use Python's native `float` (IEEE 754 double precision). No arbitrary-precision arithmetic is required.

---

## Out of Scope

1. Persistent storage or user accounts
2. Graphical or terminal UI
3. Symbolic / computer-algebra (CAS) capabilities
4. Arbitrary-precision or big-number libraries beyond Python's standard `decimal` module
5. Authentication, rate-limiting, or production hardening
6. Expression evaluation from string input
7. Deployment infrastructure (Docker, Kubernetes, CI/CD pipelines)
8. API documentation hosting (Swagger UI is auto-generated by FastAPI but not a deliverable)
