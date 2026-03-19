# Unit Test Execution

## Run Unit Tests

### 1. Execute All Tests (standard environment)
```bash
cd workspace
uv run pytest tests/ -v --cov=sci_calc --cov-report=term-missing --cov-fail-under=90
```

### 2. Execute All Tests (Windows asyncio-broken environment)
```bash
cd workspace
set PYTHONPATH=src
python -m pytest tests/ -v -p no:anyio -p no:asyncio
```

### 3. Review Test Results

#### Expected: 192 tests pass, 0 failures

| Test Module         | Engine Tests | API Tests | Total |
|---------------------|-------------|-----------|-------|
| test_arithmetic.py  | 20          | 12        | 32    |
| test_constants.py   | 12          | 4         | 16    |
| test_conversions.py | 21          | 7         | 28    |
| test_logarithmic.py | 17          | 9         | 26    |
| test_powers.py      | 16          | 9         | 25    |
| test_statistics.py  | 18          | 14        | 32    |
| test_trigonometry.py| 25          | 8         | 33    |
| **TOTAL**           | **129**     | **63**    | **192** |

- **Test Coverage Target**: ≥90%
- **Test Report Location**: stdout (via `--cov-report=term-missing`)

### 4. Fix Failing Tests
If tests fail:
1. Review the verbose output showing which test failed and why
2. Check the error traceback
3. Fix code issues in `src/sci_calc/` or `tests/`
4. Rerun tests until all 192 pass

## Test Architecture

### Engine Unit Tests (129)
- Direct imports from `sci_calc.engine.math_engine`
- Test every math function with valid, edge-case, and error inputs
- Verify custom exceptions (`MathDomainError`, `MathDivisionByZeroError`, `MathOverflowError`)
- No HTTP or framework dependency

### API Integration Tests (63)
- Use test client to call full HTTP endpoint paths
- Validate status codes, response structure, and error envelopes
- Test happy path, domain errors, validation errors, and 404s
- Exercise Pydantic model validation (NaN rejection, type coercion)

### Test Client
- **Standard**: `starlette.testclient.TestClient` (requires working asyncio)
- **Fallback**: Custom `SyncTestClient` in `conftest.py` that drives async handlers
  synchronously without importing `asyncio` — used in environments where
  Windows `_overlapped` DLL is broken
