# Code Generation Plan — sci-calc

Skill: aidlc-code-generation
Unit: sci-calc
Status: complete
Created: 2025-01-21T15:55:00Z
Completed: 2025-01-21T16:05:00Z

---

## Overview

Generate production-ready code for the Scientific Calculator API following a 4-layer approach. Each layer is independently compilable and testable before proceeding to the next.

**Architecture:** Layered / MVC adapted to FastAPI
**Engine:** Single `math_engine.py` (per Q5/A)
**Error handling:** Custom exception hierarchy — `CalculatorError` base with subclasses (per Q1/A)
**Response envelope:** Shared helper function `success_response()` (per Q2/B)
**Test strategy:** Unit tests with engine layer, integration tests with route layers (per Q3/D)
**Logging:** Python stdlib `logging` (per Q4/A)
**Layer breakdown:** 4-layer route split (per Q6/C)
**Documentation:** README.md included (per Q7/A)

---

## Layer 1: Models, Error Classes, and App Scaffold

**Purpose:** Establish the foundational types, error hierarchy, response helper, and application shell so all subsequent layers have stable imports.

**Files:**

- [x] `src/sci_calc/__init__.py` — Package init with version
- [x] `src/sci_calc/models/__init__.py` — Models package init
- [x] `src/sci_calc/models/requests.py` — Pydantic request models (TwoOperandRequest, SingleOperandRequest, TrigRequest, LogBaseRequest, StatisticsRequest, ConversionRequest)
- [x] `src/sci_calc/models/responses.py` — Pydantic response models + `success_response()` helper function + error envelope model
- [x] `src/sci_calc/engine/__init__.py` — Engine package init
- [x] `src/sci_calc/routes/__init__.py` — Routes package init
- [x] `src/sci_calc/exceptions.py` — Custom exception hierarchy: `CalculatorError`, `DivisionByZeroError`, `DomainError`, `OverflowError`, `InvalidInputError`, `NotFoundError`
- [x] `src/sci_calc/app.py` — FastAPI app factory with exception handlers, validation error override, health endpoint, router inclusion, logging config

**Verification criteria:**
- All modules import cleanly (`python -c "from sci_calc.app import app"`)
- Health endpoint returns `{"status": "ok", "version": "0.1.0"}`
- No forward references to layers 2–4

**Checkpoint:** [x] Layer 1 complete

---

## Layer 2: Math Engine + Unit Tests

**Purpose:** Implement all mathematical operations in a single `math_engine.py` module and verify with comprehensive unit tests using known-value tables.

**Files:**

- [x] `src/sci_calc/engine/math_engine.py` — All computation functions: arithmetic (add, subtract, multiply, divide, modulo, abs, negate), powers (power, sqrt, cbrt, square, nth_root), trigonometry (sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh), logarithmic (ln, log10, log2, log, exp), statistics (mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count), constants (get_constant, list_constants), conversions (angle, temperature, length, weight)
- [x] `tests/__init__.py` — Tests package init
- [x] `tests/conftest.py` — Shared pytest fixtures (FastAPI test client, tolerance helper)
- [x] `tests/test_engine_arithmetic.py` — Unit tests for arithmetic engine functions (known-value tables, edge cases, division-by-zero raises)
- [x] `tests/test_engine_powers.py` — Unit tests for powers engine functions (known-value tables, domain errors, overflow)
- [x] `tests/test_engine_trig.py` — Unit tests for trigonometry engine functions (known-value tables, degree/radian conversion, domain errors)
- [x] `tests/test_engine_log.py` — Unit tests for logarithmic engine functions (known-value tables, domain errors, overflow)
- [x] `tests/test_engine_stats.py` — Unit tests for statistics engine functions (known-value tables, empty/insufficient input errors)

**Verification criteria:**
- All engine functions are importable and callable
- All unit tests pass (`uv run pytest tests/test_engine_*.py`)
- Engine functions raise custom exceptions from `exceptions.py` (not raw Python exceptions)
- Results match `math` stdlib to ≤ 1 ULP

**Checkpoint:** [x] Layer 2 complete

---

## Layer 3: Routes (Arithmetic, Powers, Trigonometry) + Integration Tests

**Purpose:** Wire up the first batch of route modules (3 route files) to the engine, with corresponding integration tests using httpx AsyncClient.

**Files:**

- [x] `src/sci_calc/routes/arithmetic.py` — 7 POST endpoints: add, subtract, multiply, divide, modulo, abs, negate (FR-1 through FR-7)
- [x] `src/sci_calc/routes/powers.py` — 5 POST endpoints: power, sqrt, cbrt, square, nth_root (FR-8 through FR-12)
- [x] `src/sci_calc/routes/trigonometry.py` — 14 POST endpoints: sin, cos, tan, asin, acos, atan, atan2, sinh, cosh, tanh, asinh, acosh, atanh + angle_unit handling (FR-13 through FR-26)
- [x] `tests/test_arithmetic.py` — Integration tests for arithmetic routes (success cases, error envelope for division by zero, validation errors)
- [x] `tests/test_powers.py` — Integration tests for powers routes (success cases, DOMAIN_ERROR, OVERFLOW)
- [x] `tests/test_trigonometry.py` — Integration tests for trigonometry routes (success cases, degree/radian modes, DOMAIN_ERROR for inverse functions)

**Verification criteria:**
- All 26 endpoints respond correctly to valid inputs
- Error cases return structured error envelope with correct HTTP status codes
- Integration tests pass (`uv run pytest tests/test_arithmetic.py tests/test_powers.py tests/test_trigonometry.py`)
- No import errors or forward references

**Checkpoint:** [x] Layer 3 complete

---

## Layer 4: Routes (Logarithmic, Statistics, Constants, Conversions) + Integration Tests + README

**Purpose:** Wire up the remaining route modules (4 route files), add integration tests, and produce the README.md and CODE_SUMMARY.md documentation.

**Files:**

- [x] `src/sci_calc/routes/logarithmic.py` — 5 POST endpoints: ln, log10, log2, log, exp (FR-27 through FR-31)
- [x] `src/sci_calc/routes/statistics.py` — 11 POST endpoints: mean, median, mode, stdev, variance, pstdev, pvariance, min, max, sum, count (FR-32 through FR-42)
- [x] `src/sci_calc/routes/constants.py` — 2 GET endpoints: get constant by name, list all constants (FR-43, FR-44)
- [x] `src/sci_calc/routes/conversions.py` — 4 POST endpoints: angle, temperature, length, weight (FR-45 through FR-48)
- [x] `tests/test_logarithmic.py` — Integration tests for logarithmic routes (success, DOMAIN_ERROR, OVERFLOW)
- [x] `tests/test_statistics.py` — Integration tests for statistics routes (success, INVALID_INPUT for empty/insufficient arrays)
- [x] `tests/test_constants.py` — Integration tests for constants routes (valid names, NOT_FOUND for invalid)
- [x] `tests/test_conversions.py` — Integration tests for conversion routes (valid conversions, INVALID_INPUT for unknown units)
- [x] `pyproject.toml` — Project configuration (hatchling build backend, dependencies: fastapi, uvicorn, httpx, pytest, pytest-asyncio, pytest-cov, ruff)
- [x] `README.md` — Setup instructions, API overview, run commands, project structure

**Verification criteria:**
- All remaining endpoints respond correctly
- Full test suite passes (`uv run pytest`)
- README contains accurate setup/run instructions
- All 54 functional requirements are covered by at least one test

**Checkpoint:** [x] Layer 4 complete

---

## Post-Completion Documentation

After all 4 layers are complete:

- [x] `CODE_SUMMARY.md` — Summary of generated code: architecture decisions, conventions followed, file inventory, and requirement traceability matrix

**Location:** `aidlc-docs/intent-001-scientific-calculator-api/construction/sci-calc/code-generation/CODE_SUMMARY.md`

---

## Traceability Summary

| Layer | Requirements Covered | Components |
|---|---|---|
| Layer 1 | FR-50, FR-51, FR-52, FR-53, FR-49, NFR-7 | models, exceptions, app scaffold |
| Layer 2 | FR-1–FR-48 (engine logic), NFR-1, NFR-2 | math_engine |
| Layer 3 | FR-1–FR-26 (route wiring) | routes/arithmetic, routes/powers, routes/trigonometry |
| Layer 4 | FR-27–FR-48, FR-43–FR-44 (route wiring), NFR-5, NFR-6 | routes/logarithmic, routes/statistics, routes/constants, routes/conversions |

---

## File Count Summary

| Layer | File Count | Within Limit? |
|---|---|---|
| Layer 1 | 8 files | ✅ (≤ 12, target 5–8) |
| Layer 2 | 8 files | ✅ (≤ 12, target 5–8) |
| Layer 3 | 6 files | ✅ (≤ 12, target 5–8) |
| Layer 4 | 10 files | ✅ (≤ 12) |
| Post-completion | 1 file | ✅ |
| **Total** | **33 files** | — |
