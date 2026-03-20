# Requirements: Scientific Calculator API

## Intent Analysis

| Attribute | Value |
|---|---|
| **User Request** | Build a stateless HTTP API for scientific math operations |
| **Request Type** | New Project (greenfield) |
| **Scope Estimate** | Single Application — multiple components (routes, models, engine) |
| **Complexity Estimate** | Moderate — well-defined API surface, many operations, thorough error handling |
| **Requirements Depth** | Standard |

---

## 1. Functional Requirements

### FR-1: Health Check
- **FR-1.1**: `GET /health` returns `{"status": "ok", "version": "0.1.0"}` with HTTP 200.

### FR-2: Arithmetic Operations
- **FR-2.1**: `POST /api/v1/arithmetic/{operation}` supports: `add`, `subtract`, `multiply`, `divide`, `modulo`, `abs`, `negate`.
- **FR-2.2**: Binary operations (`add`, `subtract`, `multiply`, `divide`, `modulo`) accept `{"a": N, "b": N}`.
- **FR-2.3**: Unary operations (`abs`, `negate`) accept `{"a": N}`.
- **FR-2.4**: `divide` and `modulo` return `DIVISION_BY_ZERO` error when `b == 0`.

### FR-3: Powers and Roots
- **FR-3.1**: `POST /api/v1/powers/{operation}` supports: `power`, `sqrt`, `cbrt`, `square`, `nth_root`.
- **FR-3.2**: `power` accepts `{"base": N, "exponent": N}`.
- **FR-3.3**: `sqrt`, `cbrt`, `square` accept `{"a": N}`.
- **FR-3.4**: `nth_root` accepts `{"a": N, "n": int}`.
- **FR-3.5**: `sqrt` returns `DOMAIN_ERROR` when `a < 0`.
- **FR-3.6**: `nth_root` returns `DOMAIN_ERROR` when `a < 0` and `n` is even.

### FR-4: Trigonometric Operations
- **FR-4.1**: `POST /api/v1/trigonometry/{operation}` supports: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`.
- **FR-4.2**: Most operations accept `{"a": N, "angle_unit": "radians"|"degrees"}` with default `"radians"`.
- **FR-4.3**: `atan2` accepts `{"y": N, "x": N, "angle_unit": "radians"|"degrees"}`.
- **FR-4.4**: Domain constraints enforced: `asin`/`acos` require `-1 <= a <= 1`, `acosh` requires `a >= 1`, `atanh` requires `-1 < a < 1`.
- **FR-4.5**: Domain violations return `DOMAIN_ERROR`.

### FR-5: Logarithmic Operations
- **FR-5.1**: `POST /api/v1/logarithmic/{operation}` supports: `ln`, `log10`, `log2`, `log`, `exp`.
- **FR-5.2**: `ln`, `log10`, `log2` accept `{"a": N}` — `DOMAIN_ERROR` if `a <= 0`.
- **FR-5.3**: `log` accepts `{"a": N, "base": N}` — `DOMAIN_ERROR` if `a <= 0`, `base <= 0`, or `base == 1`.
- **FR-5.4**: `exp` accepts `{"a": N}`.

### FR-6: Statistical Operations
- **FR-6.1**: `POST /api/v1/statistics/{operation}` supports: `mean`, `median`, `mode`, `stdev`, `variance`, `pstdev`, `pvariance`, `min`, `max`, `sum`, `count`.
- **FR-6.2**: All accept `{"values": [N, ...]}` with at least 1 element required.
- **FR-6.3**: `stdev`/`variance` require at least 2 elements.
- **FR-6.4**: `pstdev`/`pvariance` require at least 1 element.
- **FR-6.5**: `mode` returns a single numeric value; on ties, returns the smallest mode.

### FR-7: Mathematical Constants
- **FR-7.1**: `GET /api/v1/constants/{name}` returns a named constant.
- **FR-7.2**: `GET /api/v1/constants` returns all constants as a map.
- **FR-7.3**: Supported constants: `pi`, `e`, `tau`, `inf`, `nan`, `golden_ratio`, `sqrt2`, `ln2`, `ln10`.

### FR-8: Unit Conversions
- **FR-8.1**: `POST /api/v1/conversions/{category}` accepts `{"value": N, "from_unit": "...", "to_unit": "..."}`.
- **FR-8.2**: Angle: `degrees`, `radians`, `gradians`.
- **FR-8.3**: Temperature: `celsius`, `fahrenheit`, `kelvin`.
- **FR-8.4**: Length: `meters`, `feet`, `inches`, `centimeters`, `millimeters`, `kilometers`, `miles`, `yards`.
- **FR-8.5**: Weight: `kilograms`, `pounds`, `ounces`, `grams`, `milligrams`, `tonnes`, `stones`.
- **FR-8.6**: Unknown units return `INVALID_INPUT` (422).

### FR-9: Response Envelope
- **FR-9.1**: Success responses: `{"status": "ok", "operation": "<name>", "inputs": {...}, "result": <number|object>}`.
- **FR-9.2**: Error responses: `{"status": "error", "operation": "<name>", "inputs": {...}, "error": {"code": "<CODE>", "message": "..."}}`.
- **FR-9.3**: All endpoints accept and return `application/json`.

### FR-10: Error Handling
- **FR-10.1**: Error codes: `INVALID_INPUT` (422), `DIVISION_BY_ZERO` (400), `DOMAIN_ERROR` (400), `OVERFLOW` (400), `NOT_FOUND` (404).
- **FR-10.2**: Pydantic validation errors are wrapped in the same error envelope with `INVALID_INPUT` code.
- **FR-10.3**: Results that would be `inf` or `-inf` return `OVERFLOW` error.
- **FR-10.4**: `NaN` inputs are rejected with `INVALID_INPUT` error.
- **FR-10.5**: Unknown endpoints return `NOT_FOUND`.
- **FR-10.6**: Unexpected exceptions are logged at ERROR level and return a generic `INTERNAL_ERROR` response; never return bare 500.

---

## 2. Non-Functional Requirements

### NFR-1: Performance
- **NFR-1.1**: Startup time < 2 seconds.
- **NFR-1.2**: Response latency p95 < 50ms for any single operation.

### NFR-2: Correctness
- **NFR-2.1**: Results match Python `math` stdlib to ≤ 1 ULP for standard operations.

### NFR-3: Testing
- **NFR-3.1**: All tests pass with ≥ 90% line coverage (enforced — test run fails if below 90%).
- **NFR-3.2**: Unit tests exercise `math_engine.py` directly with known-value tables.
- **NFR-3.3**: Integration tests use `httpx.AsyncClient` with FastAPI TestClient.
- **NFR-3.4**: Boundary tests verify every domain constraint produces the correct error code.

### NFR-4: Security
- **NFR-4.1**: Max request body size 1 MB.
- **NFR-4.2**: No authentication, rate-limiting, or production hardening in MVP.

### NFR-5: Maintainability
- **NFR-5.1**: Code linted and formatted with `ruff` (line-length 100, target py313).
- **NFR-5.2**: Clear separation of concerns: routes, models, engine.

---

## 3. Technical Constraints

| Constraint | Value |
|---|---|
| Language | Python 3.13 |
| Package Manager | uv (no pip, poetry, conda) |
| Framework | FastAPI + Pydantic v2 |
| ASGI Server | uvicorn |
| Build Backend | hatchling |
| Test Framework | pytest + pytest-asyncio + httpx + pytest-cov |
| Linter/Formatter | ruff |
| Prohibited | Flask, Django, requests, sympy, pandas, numpy, pip, poetry, pipenv, black, flake8, isort |

---

## 4. API Versioning
- URL prefix: `/api/v1/...`
- Initial release: v0.1.0
- Semver applies.

---

## 5. Out of Scope (MVP)
- Persistent storage or user accounts
- Graphical or terminal UI
- Symbolic / CAS capabilities
- Arbitrary-precision beyond Python `decimal` module
- Expression evaluation from string input
