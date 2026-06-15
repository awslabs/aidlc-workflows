# Integration Test Instructions

## Purpose
Test the full request→route→engine→response pipeline across all 7 API domains.

## Test Scenarios

### Scenario 1: Arithmetic Operations
- **Endpoints**: POST `/api/v1/arithmetic/{add,subtract,multiply,divide,modulo,abs,negate}`
- **Tests**: 12 integration tests
- **Covers**: binary ops, unary ops, division-by-zero, invalid input, NaN rejection, 404

### Scenario 2: Powers & Roots
- **Endpoints**: POST `/api/v1/powers/{power,sqrt,cbrt,square,nth_root}`
- **Tests**: 9 integration tests
- **Covers**: all operations, domain errors, overflow, 404

### Scenario 3: Trigonometry
- **Endpoints**: POST `/api/v1/trigonometry/{sin,cos,tan,asin,acos,atan,atan2,sinh,cosh,tanh,asinh,acosh,atanh}`
- **Tests**: 8 integration tests
- **Covers**: radians/degrees, domain errors, hyperbolic functions, 404

### Scenario 4: Logarithmic
- **Endpoints**: POST `/api/v1/logarithmic/{ln,log10,log2,log,exp}`
- **Tests**: 9 integration tests
- **Covers**: all operations, domain errors, overflow, 404

### Scenario 5: Statistics
- **Endpoints**: POST `/api/v1/statistics/{mean,median,mode,stdev,variance,pstdev,pvariance,min,max,sum,count}`
- **Tests**: 14 integration tests
- **Covers**: all operations, domain errors, empty input validation, 404

### Scenario 6: Constants
- **Endpoints**: GET `/api/v1/constants/` and GET `/api/v1/constants/{name}`
- **Tests**: 4 integration tests
- **Covers**: single constant retrieval, listing all, unknown constant 404

### Scenario 7: Conversions & Health
- **Endpoints**: POST `/api/v1/conversions/{angle,temperature,length,weight}`, GET `/health`
- **Tests**: 7 integration tests
- **Covers**: all conversion types, unknown category, unknown unit, health check

## Run Integration Tests
```bash
# All integration tests are in the same test files alongside unit tests
# They use the `client` fixture from conftest.py
set PYTHONPATH=src
python -m pytest tests/ -v -k "API" -p no:anyio -p no:asyncio
```

## Expected Results
- **Total Integration Tests**: 63
- **All passing**: ✅
- **Response format validated**: status, operation, inputs, result (or error)
