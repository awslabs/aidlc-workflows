# Implementation Map — scientific-calculator-api

## Component → Source Files

| Component ID | Component | Source Files | Test Files |
|---|---|---|---|
| CMP-001 | Arithmetic Engine | `app/engines/arithmetic.py`, `app/routers/arithmetic.py` | `tests/test_arithmetic.py` |
| CMP-002 | Powers Engine | `app/engines/powers.py`, `app/routers/powers.py` | `tests/test_powers.py` |
| CMP-003 | Trigonometry Engine | `app/engines/trigonometry.py`, `app/routers/trigonometry.py` | `tests/test_trigonometry.py` |
| CMP-004 | Logarithmic Engine | `app/engines/logarithmic.py`, `app/routers/logarithmic.py` | `tests/test_logarithmic.py` |
| CMP-005 | Statistics Engine | `app/engines/statistics.py`, `app/routers/statistics.py` | `tests/test_statistics.py` |
| CMP-006 | Constants Provider | `app/engines/constants.py`, `app/routers/constants.py` | `tests/test_constants.py` |
| CMP-007 | Conversions Engine | `app/engines/conversions.py`, `app/routers/conversions.py` | `tests/test_conversions.py` |
| CMP-008 | API Layer | `app/main.py`, `app/routers/*.py`, `app/models/schemas.py`, `app/exceptions.py` | `tests/test_health.py`, `tests/test_errors.py` |

## API → Source Files

| API ID | Endpoint | Router File |
|---|---|---|
| API-001 | POST /api/v1/arithmetic/{op} | `app/routers/arithmetic.py` |
| API-002 | POST /api/v1/powers/{op} | `app/routers/powers.py` |
| API-003 | POST /api/v1/trigonometry/{op} | `app/routers/trigonometry.py` |
| API-004 | POST /api/v1/logarithmic/{op} | `app/routers/logarithmic.py` |
| API-005 | POST /api/v1/statistics/{op} | `app/routers/statistics.py` |
| API-006 | GET /api/v1/constants/{name} | `app/routers/constants.py` |
| API-007 | GET /api/v1/constants | `app/routers/constants.py` |
| API-008 | POST /api/v1/conversions/{category} | `app/routers/conversions.py` |
| API-009 | GET /health | `app/main.py` |

## Business Rules → Implementation

| Rule ID | Rule | Implemented In | Test Coverage |
|---|---|---|---|
| BR-001 | Division by zero | `app/engines/arithmetic.py` (divide, modulo) | `test_arithmetic.py::test_divide_by_zero`, `test_modulo_by_zero` |
| BR-002 | sqrt(negative) | `app/engines/powers.py` (sqrt) | `test_powers.py::test_sqrt_negative` |
| BR-003 | nth_root(negative, even n) | `app/engines/powers.py` (nth_root) | `test_powers.py::test_nth_root_negative_even` |
| BR-004 | asin/acos domain [-1, 1] | `app/engines/trigonometry.py` (asin, acos) | `test_trigonometry.py::test_asin_domain_error`, `test_acos_domain_error` |
| BR-005 | acosh domain >= 1 | `app/engines/trigonometry.py` (acosh) | `test_trigonometry.py::test_acosh_domain_error` |
| BR-006 | atanh domain (-1, 1) | `app/engines/trigonometry.py` (atanh) | `test_trigonometry.py::test_atanh_domain_error` |
| BR-007 | Log positive input | `app/engines/logarithmic.py` (ln, log10, log2, log) | `test_logarithmic.py::test_ln_domain_error` |
| BR-008 | Log base validation (base > 0, base != 1) | `app/engines/logarithmic.py` (log) | `test_logarithmic.py::test_log_base_1`, `test_log_negative_base` |
| BR-009 | Statistics minimum 1 element | `app/engines/statistics.py` | `test_statistics.py::test_empty_values` |
| BR-010 | Statistics minimum 2 elements for stdev/variance | `app/engines/statistics.py` | `test_statistics.py::test_stdev_too_few`, `test_variance_too_few` |
| BR-011 | Mode tie-breaking (returns all modes) | `app/engines/statistics.py` (mode) | `test_statistics.py::test_mode_tie` |
| BR-012 | Degree/radian input conversion | `app/engines/trigonometry.py` (_to_radians) | `test_trigonometry.py::test_sin_degrees` |
| BR-013 | Radian/degree output conversion | `app/engines/trigonometry.py` (_to_output_unit) | `test_trigonometry.py::test_asin_degrees` |
| BR-014 | Overflow detection | `app/engines/logarithmic.py` (exp), `app/engines/powers.py` | `test_logarithmic.py::test_exp_overflow` |
| BR-015 | Unknown constants return 404 | `app/routers/constants.py` | `test_constants.py::test_get_unknown` |
| BR-016 | Unsupported unit names | `app/engines/conversions.py` (convert) | `test_conversions.py::test_invalid_unit` |
| BR-017 | Unknown operation returns 404 | `app/routers/*.py` | `test_*.py::test_unknown_op` |
| BR-018 | Malformed input returns 422 | `app/main.py` (validation_error_handler) | Implicit in all malformed-input tests |

## NFR → Verification

| NFR ID | Target | Verification | Status |
|---|---|---|---|
| NFR-1 | Correctness (≤1 ULP) | Tests compare against Python `math` stdlib | ✅ |
| NFR-2 | Coverage >= 90% | `pytest-cov` | ✅ ~94% achieved |
| NFR-3 | p95 latency < 50ms | Stateless compute, no I/O | ✅ By architecture |
| NFR-4 | Structured error responses | Global exception handler + domain exception handlers | ✅ |
| NFR-5 | No bare 500s | `generic_exception_handler` in `app/main.py` | ✅ |
| NFR-6 | All routes under /api/v1/ | URL structure verified | ✅ |

## Configuration

| File | Purpose |
|---|---|
| `pyproject.toml` | Project metadata, dependencies, pytest and coverage config |
