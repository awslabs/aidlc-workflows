# Code Generation Plan — sci-calc

## Unit Context
- **Unit**: sci-calc (single unit — entire application)
- **Project Type**: Greenfield, Python 3.13, FastAPI
- **Workspace Root**: workspace/
- **Code Location**: workspace/ (per tech-env structure: pyproject.toml, src/sci_calc/, tests/)

## Step Sequence

### Step 1: Project Structure Setup
- [ ] Create `workspace/pyproject.toml` with hatchling build backend, all dependencies (fastapi, uvicorn, httpx, pytest, pytest-asyncio, pytest-cov, ruff), Python 3.13 requirement
- [ ] Create `workspace/src/sci_calc/__init__.py` with version
- [ ] Create `workspace/src/sci_calc/routes/__init__.py`
- [ ] Create `workspace/src/sci_calc/models/__init__.py`
- [ ] Create `workspace/src/sci_calc/engine/__init__.py`
- [ ] Create `workspace/tests/__init__.py`
- [ ] Create `workspace/tests/conftest.py` with async test client fixture

### Step 2: Engine — Custom Exceptions
- [ ] Create `workspace/src/sci_calc/engine/math_engine.py` — define custom exceptions: `MathDomainError`, `MathDivisionByZeroError`, `MathOverflowError`

### Step 3: Engine — Arithmetic Operations
- [ ] Add arithmetic functions to `math_engine.py`: `add`, `subtract`, `multiply`, `divide`, `modulo`, `absolute`, `negate`
- [ ] Implement overflow detection (result is inf/-inf → raise OverflowError)

### Step 4: Engine — Powers and Roots
- [ ] Add power functions to `math_engine.py`: `power`, `sqrt_op`, `cbrt`, `square`, `nth_root`
- [ ] Implement domain validation (sqrt of negative, nth_root constraints)

### Step 5: Engine — Trigonometry
- [ ] Add trig functions to `math_engine.py`: `sin_op`, `cos_op`, `tan_op`, `asin_op`, `acos_op`, `atan_op`, `atan2_op`, `sinh_op`, `cosh_op`, `tanh_op`, `asinh_op`, `acosh_op`, `atanh_op`
- [ ] Implement angle unit conversion (degrees ↔ radians) 
- [ ] Implement domain validation for inverse trig functions

### Step 6: Engine — Logarithmic Operations
- [ ] Add log functions to `math_engine.py`: `ln`, `log10_op`, `log2_op`, `log_op`, `exp_op`
- [ ] Implement domain validation (a <= 0, base constraints)

### Step 7: Engine — Statistics
- [ ] Add statistics functions to `math_engine.py`: `mean_op`, `median_op`, `mode_op`, `stdev_op`, `variance_op`, `pstdev_op`, `pvariance_op`, `min_op`, `max_op`, `sum_op`, `count_op`
- [ ] Implement minimum element count validation

### Step 8: Engine — Constants
- [ ] Add constants functions to `math_engine.py`: `get_constant`, `get_all_constants`
- [ ] Define constant map: pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10

### Step 9: Engine — Unit Conversions
- [ ] Add conversion functions to `math_engine.py`: `convert_angle`, `convert_temperature`, `convert_length`, `convert_weight`
- [ ] Define conversion factor tables for all supported units

### Step 10: Models — Request Models
- [ ] Create `workspace/src/sci_calc/models/requests.py` — all Pydantic v2 request models with NaN validation

### Step 11: Models — Response Models
- [ ] Create `workspace/src/sci_calc/models/responses.py` — SuccessResponse, ErrorDetail, ErrorResponse models

### Step 12: Routes — Arithmetic
- [ ] Create `workspace/src/sci_calc/routes/arithmetic.py` — APIRouter with POST endpoints for all arithmetic ops

### Step 13: Routes — Powers
- [ ] Create `workspace/src/sci_calc/routes/powers.py` — APIRouter with POST endpoints for all power/root ops

### Step 14: Routes — Trigonometry
- [ ] Create `workspace/src/sci_calc/routes/trigonometry.py` — APIRouter with POST endpoints for all trig ops

### Step 15: Routes — Logarithmic
- [ ] Create `workspace/src/sci_calc/routes/logarithmic.py` — APIRouter with POST endpoints for all log ops

### Step 16: Routes — Statistics
- [ ] Create `workspace/src/sci_calc/routes/statistics.py` — APIRouter with POST endpoints for all stats ops

### Step 17: Routes — Constants
- [ ] Create `workspace/src/sci_calc/routes/constants.py` — APIRouter with GET endpoints for constants

### Step 18: Routes — Conversions
- [ ] Create `workspace/src/sci_calc/routes/conversions.py` — APIRouter with POST endpoints for all conversions

### Step 19: Application Entry Point
- [ ] Create `workspace/src/sci_calc/app.py` — FastAPI app, register all routers, custom error handlers (422 override, catch-all), health check endpoint

### Step 20: Tests — Engine Unit Tests
- [ ] Create `workspace/tests/test_arithmetic.py` — unit tests for arithmetic engine functions + boundary tests
- [ ] Create `workspace/tests/test_powers.py` — unit tests for power engine functions + domain error tests
- [ ] Create `workspace/tests/test_trigonometry.py` — unit tests for trig engine functions + domain error tests
- [ ] Create `workspace/tests/test_logarithmic.py` — unit tests for log engine functions + domain error tests
- [ ] Create `workspace/tests/test_statistics.py` — unit tests for statistics engine functions + edge cases
- [ ] Create `workspace/tests/test_constants.py` — unit tests for constants + API integration tests
- [ ] Create `workspace/tests/test_conversions.py` — unit tests for conversion functions + API integration tests

### Step 21: Tests — API Integration Tests
- [ ] Add integration tests within each test file using httpx.AsyncClient
- [ ] Test success responses match envelope structure
- [ ] Test error responses match error envelope structure
- [ ] Test 404 for unknown endpoints
- [ ] Test custom 422 handler wraps Pydantic errors

## Total: 21 steps, ~20 source files, ~7 test files
