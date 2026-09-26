# Business Logic Model — Statistics

## Operations

| Operation | Logic | Min Elements |
|-----------|-------|-------------|
| mean | statistics.mean(values) | 1 |
| median | statistics.median(values) | 1 |
| mode | min of statistics.multimode(values) | 1 |
| stdev | statistics.stdev(values) | 2 |
| variance | statistics.variance(values) | 2 |
| pstdev | statistics.pstdev(values) | 1 |
| pvariance | statistics.pvariance(values) | 1 |
| min | min(values) | 1 |
| max | max(values) | 1 |
| sum | sum(values) | 1 |
| count | len(values) | 1 |

## Mode Tie-Breaking
Python's statistics.multimode returns all modes. We take min() of the result to return the smallest mode on ties.

## Element Validation
- Empty array → INVALID_INPUT (Pydantic min_length=1)
- stdev/variance with < 2 elements → INVALID_INPUT (checked before calling engine)
