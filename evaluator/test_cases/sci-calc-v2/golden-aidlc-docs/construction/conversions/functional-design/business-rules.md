# Business Rules — Conversions

## BR-CV1: Invalid Unit
Unknown from_unit or to_unit for the given category → INVALID_INPUT (422).

## BR-CV2: Same Unit
Converting a value to the same unit → return the value unchanged.

## BR-CV3: Invalid Category
Unknown category in URL path → NOT_FOUND (404).
