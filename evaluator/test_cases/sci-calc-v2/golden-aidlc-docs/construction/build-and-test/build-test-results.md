# Build & Test Results

## Test Run Output

```
============================= test session starts ==============================
platform darwin -- Python 3.13.13, pytest-9.1.0, pluggy-1.6.0
collected 130 items

tests/test_arithmetic.py ......................                          [ 16%]
tests/test_constants.py .........                                        [ 23%]
tests/test_conversions.py ....................                           [ 39%]
tests/test_logarithmic.py ....................                           [ 54%]
tests/test_powers.py ..............                                      [ 65%]
tests/test_statistics.py ..................                              [ 79%]
tests/test_trigonometry.py ...........................                   [100%]

============================= 130 passed in 0.45s ==============================
```

## Coverage Report

```
Name                                  Stmts   Miss  Cover
-------------------------------------------------------------------
src/sci_calc/__init__.py                  0      0   100%
src/sci_calc/app.py                      43      7    84%
src/sci_calc/engine/__init__.py           0      0   100%
src/sci_calc/engine/math_engine.py      195     10    95%
src/sci_calc/models/__init__.py           0      0   100%
src/sci_calc/models/requests.py          29      0   100%
src/sci_calc/models/responses.py         15      0   100%
src/sci_calc/routes/__init__.py           0      0   100%
src/sci_calc/routes/arithmetic.py        38      8    79%
src/sci_calc/routes/constants.py         16      0   100%
src/sci_calc/routes/conversions.py       19      0   100%
src/sci_calc/routes/logarithmic.py       40      2    95%
src/sci_calc/routes/powers.py            46      9    80%
src/sci_calc/routes/statistics.py        19      0   100%
src/sci_calc/routes/trigonometry.py      40      9    78%
-------------------------------------------------------------------
TOTAL                                   500     45    91%
```

## Lint Results

```
All checks passed!
24 files already formatted
```
