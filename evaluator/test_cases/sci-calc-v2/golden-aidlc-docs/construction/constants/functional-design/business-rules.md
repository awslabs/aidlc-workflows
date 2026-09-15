# Business Rules — Constants

## BR-C1: Unknown Constant
Request for unknown constant name → NOT_FOUND (404).

## BR-C2: NaN Handling
NaN is a valid constant. JSON serialization must handle NaN properly (some JSON libraries reject it — use float("nan") which FastAPI handles).

## BR-C3: Immutability
Constants are computed once at import time and never change.
