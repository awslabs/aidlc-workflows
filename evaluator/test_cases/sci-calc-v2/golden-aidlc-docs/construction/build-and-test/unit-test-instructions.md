# Unit Test Instructions

## Run Command

```bash
cd sci-calc
uv run pytest tests/ -v
```

## Test Structure

| Test File | Coverage | Operations Tested |
|-----------|----------|-------------------|
| test_arithmetic.py | 7 operations + error cases | add, subtract, multiply, divide, modulo, abs, negate |
| test_powers.py | 5 operations + domain errors | power, sqrt, cbrt, square, nth_root |
| test_trigonometry.py | 14 operations + domain errors | Full trig suite with angle modes |
| test_logarithmic.py | 5 operations + domain errors | ln, log10, log2, log, exp |
| test_statistics.py | 12 operations + validation | mean, median, mode, stdev, variance, etc. |
| test_constants.py | All constants + list + 404 | pi, e, tau, inf, nan, golden_ratio, sqrt2, ln2, ln10 |
| test_conversions.py | All categories + validation | angle, temperature, length, weight |

## Total: 130 tests
