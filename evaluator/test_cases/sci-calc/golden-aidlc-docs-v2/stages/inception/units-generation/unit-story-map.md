# Unit Story Map

## Coverage Matrix

| Story | Unit(s) | Coverage type |
|---|---|---|
| S-1 | scientific-calculator-api | fully implemented |
| S-2 | scientific-calculator-api | fully implemented |
| S-3 | scientific-calculator-api | fully implemented |
| S-4 | scientific-calculator-api | fully implemented |
| S-5 | scientific-calculator-api | fully implemented |
| S-6 | scientific-calculator-api | fully implemented |
| S-7 | scientific-calculator-api | fully implemented |
| S-8 | scientific-calculator-api | fully implemented |
| S-9 | scientific-calculator-api | fully implemented |
| S-10 | scientific-calculator-api | fully implemented |
| S-11 | scientific-calculator-api | fully implemented |
| S-12 | scientific-calculator-api | fully implemented |
| S-13 | scientific-calculator-api | fully implemented |
| S-14 | scientific-calculator-api | fully implemented |
| S-15 | scientific-calculator-api | fully implemented |
| S-16 | scientific-calculator-api | fully implemented |
| S-17 | scientific-calculator-api | fully implemented |
| S-18 | scientific-calculator-api | fully implemented |
| S-19 | scientific-calculator-api | fully implemented |
| S-20 | scientific-calculator-api | fully implemented |

## Per-Unit Story Assignment

### scientific-calculator-api

| Story | What this unit implements for it |
|---|---|
| S-1 | Arithmetic endpoints (add, subtract, multiply, divide, modulo, abs, negate) |
| S-2 | Division-by-zero detection and DIVISION_BY_ZERO error response |
| S-3 | Power/root endpoints (power, sqrt, cbrt, square, nth_root) |
| S-4 | Domain validation for sqrt(negative) and nth_root(negative, even) |
| S-5 | Trig endpoints with angle_unit parameter support (degrees/radians) |
| S-6 | Domain validation for inverse trig (asin/acos bounds, acosh, atanh) |
| S-7 | Logarithmic endpoints (ln, log10, log2, log, exp) |
| S-8 | Domain validation for log operations (non-positive inputs) |
| S-9 | Statistics endpoints (mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count) |
| S-10 | Statistics input validation (minimum element count, mode tie-breaking) |
| S-11 | Constants endpoint (individual lookup + full collection) |
| S-12 | Unit conversion endpoints (angle, temperature, length, weight) |
| S-13 | Standard success/error response envelope formatting |
| S-14 | GET /health endpoint returning status and version |
| S-15 | 404 NOT_FOUND handler for unknown endpoints |
| S-16 | Pydantic validation error → INVALID_INPUT envelope |
| S-17 | Overflow detection + catch-all INTERNAL_ERROR handler |
| S-18 | Test suite achieving ≥90% coverage, precision verification |
| S-19 | Performance validation (p95 < 50ms) |
| S-20 | Stateless architecture, /api/v1/ URL prefix |

## Coverage Gaps

| Story/Requirement | Gap | Resolution |
|---|---|---|
| (none) | — | All stories fully covered by the single unit |
