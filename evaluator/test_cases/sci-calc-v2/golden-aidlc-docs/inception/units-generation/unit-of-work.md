# Units of Work

## UoW-01: Project Scaffold & Core Infrastructure

**Scope**: Create the project structure per tech-env.md, pyproject.toml, app.py with error handlers, models (requests.py, responses.py), empty route modules, math_engine.py skeleton, test conftest.py, health endpoint.

**Files**: pyproject.toml, src/sci_calc/__init__.py, src/sci_calc/app.py, src/sci_calc/routes/__init__.py, src/sci_calc/models/__init__.py, src/sci_calc/models/requests.py, src/sci_calc/models/responses.py, src/sci_calc/engine/__init__.py, src/sci_calc/engine/math_engine.py, tests/__init__.py, tests/conftest.py

**Stories**: US-13 (health check), US-14 (unknown endpoint / NOT_FOUND)

**Acceptance**: `uv sync` succeeds, `uv run pytest` passes, health endpoint returns correct response, unknown paths return 404 with error envelope.

## UoW-02: Arithmetic Operations

**Scope**: Implement arithmetic route module + engine functions + tests. Operations: add, subtract, multiply, divide, modulo, abs, negate.

**Files**: src/sci_calc/routes/arithmetic.py, engine additions, tests/test_arithmetic.py

**Stories**: US-01, US-02, US-03

**Acceptance**: All 7 operations return correct results; division-by-zero returns DIVISION_BY_ZERO error; tests pass.

## UoW-03: Powers & Roots Operations

**Scope**: Implement powers route module + engine functions + tests. Operations: power, sqrt, cbrt, square, nth_root.

**Files**: src/sci_calc/routes/powers.py, engine additions, tests/test_powers.py

**Stories**: US-04, US-05

**Acceptance**: All 5 operations return correct results; domain errors for sqrt(negative) and nth_root(negative, even); tests pass.

## UoW-04: Trigonometry Operations

**Scope**: Implement trigonometry route module + engine functions + tests. 14 trig operations with angle_unit support.

**Files**: src/sci_calc/routes/trigonometry.py, engine additions, tests/test_trigonometry.py

**Stories**: US-06, US-07

**Acceptance**: All 14 operations correct in both radians and degrees; domain errors for inverse trig out-of-range; tests pass.

## UoW-05: Logarithmic Operations

**Scope**: Implement logarithmic route module + engine functions + tests. Operations: ln, log10, log2, log, exp.

**Files**: src/sci_calc/routes/logarithmic.py, engine additions, tests/test_logarithmic.py

**Stories**: US-08

**Acceptance**: All 5 operations correct; domain errors for non-positive inputs and invalid bases; tests pass.

## UoW-06: Statistics Operations

**Scope**: Implement statistics route module + engine functions + tests. 12 operations on value arrays.

**Files**: src/sci_calc/routes/statistics.py, engine additions, tests/test_statistics.py

**Stories**: US-09, US-10

**Acceptance**: All 12 operations correct; minimum element validation; mode returns smallest on ties; tests pass.

## UoW-07: Constants

**Scope**: Implement constants route module + engine functions + tests. 9 named constants + list-all.

**Files**: src/sci_calc/routes/constants.py, engine additions, tests/test_constants.py

**Stories**: US-11

**Acceptance**: All constants match Python math values; list-all returns complete map; unknown name returns 404; tests pass.

## UoW-08: Unit Conversions

**Scope**: Implement conversions route module + engine functions + tests. 4 categories: angle, temperature, length, weight.

**Files**: src/sci_calc/routes/conversions.py, engine additions, tests/test_conversions.py

**Stories**: US-12

**Acceptance**: All conversion pairs correct; invalid units return INVALID_INPUT; tests pass.
