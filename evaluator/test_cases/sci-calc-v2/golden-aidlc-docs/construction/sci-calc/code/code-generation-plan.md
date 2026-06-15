# Code Generation Plan — sci-calc

## Overview

Generate a complete Scientific Calculator API implementation following a layered approach:
- **Layer 1 (Models):** Pydantic request/response models, error definitions, custom types
- **Layer 2 (Engine):** Pure business logic functions per domain
- **Layer 3 (Routes + App):** FastAPI routes, exception handlers, application assembly
- **Layer 4 (Tests + Config):** Integration tests, test fixtures, project configuration

---

## Layer 1: Models & Errors

- [x] `workspace/src/sci_calc/__init__.py` — Package init with version
- [x] `workspace/src/sci_calc/models/__init__.py` — Models package init
- [x] `workspace/src/sci_calc/models/errors.py` — Error codes enum, exception classes, HTTP status mapping
- [x] `workspace/src/sci_calc/models/requests.py` — Pydantic request models with FiniteFloat validator
- [x] `workspace/src/sci_calc/models/responses.py` — Response envelope models and helper functions

**Verification:** All models importable, no runtime errors, FiniteFloat rejects inf/nan.

---

## Layer 2: Business Logic (Engine)

- [x] `workspace/src/sci_calc/engine/__init__.py` — Engine package init
- [x] `workspace/src/sci_calc/engine/arithmetic.py` — add, subtract, multiply, divide, modulo, abs, negate
- [x] `workspace/src/sci_calc/engine/powers.py` — power, sqrt, cbrt, nth_root, square
- [x] `workspace/src/sci_calc/engine/trigonometry.py` — All trig operations with angle conversion
- [x] `workspace/src/sci_calc/engine/logarithmic.py` — ln, log10, log2, log, exp
- [x] `workspace/src/sci_calc/engine/statistics.py` — mean, median, mode, stdev, variance, etc.
- [x] `workspace/src/sci_calc/engine/constants.py` — Constants registry
- [x] `workspace/src/sci_calc/engine/conversions.py` — Unit conversion logic

**Verification:** Each engine module importable. Domain checks raise CalculatorError subclasses.

---

## Layer 3: API Routes & Application

- [x] `workspace/src/sci_calc/routes/__init__.py` — Routes package init
- [x] `workspace/src/sci_calc/routes/arithmetic.py` — Arithmetic endpoint handlers
- [x] `workspace/src/sci_calc/routes/powers.py` — Powers endpoint handlers
- [x] `workspace/src/sci_calc/routes/trigonometry.py` — Trigonometry endpoint handlers
- [x] `workspace/src/sci_calc/routes/logarithmic.py` — Logarithmic endpoint handlers
- [x] `workspace/src/sci_calc/routes/statistics.py` — Statistics endpoint handlers
- [x] `workspace/src/sci_calc/routes/constants.py` — Constants endpoint handlers
- [x] `workspace/src/sci_calc/routes/conversions.py` — Conversions endpoint handlers
- [x] `workspace/src/sci_calc/app.py` — FastAPI app with exception handlers and router includes

**Verification:** App starts without errors. All routes registered.

---

## Layer 4: Tests & Configuration

- [x] `workspace/pyproject.toml` — Project configuration with all dependencies
- [x] `workspace/tests/__init__.py` — Tests package init
- [x] `workspace/tests/conftest.py` — Shared fixtures (async client)
- [x] `workspace/tests/test_arithmetic.py` — Arithmetic operation tests
- [x] `workspace/tests/test_powers.py` — Powers operation tests
- [x] `workspace/tests/test_trigonometry.py` — Trigonometry operation tests
- [x] `workspace/tests/test_logarithmic.py` — Logarithmic operation tests
- [x] `workspace/tests/test_statistics.py` — Statistics operation tests
- [x] `workspace/tests/test_constants.py` — Constants operation tests
- [x] `workspace/tests/test_conversions.py` — Conversions operation tests

**Verification:** `uv run pytest` passes. All error paths covered.

---

## Completion Criteria

- All 41 FRs implemented
- All 37 BRs implemented
- Structured error envelopes for all error codes
- Tests cover happy path + every error path
- Code passes `ruff check` and `ruff format`
