# Requirements Verification Questions

The vision document and technical environment document are remarkably thorough. The following questions address remaining ambiguities to ensure completeness before generating the formal requirements.

Please answer each question by filling in the letter choice after the `[Answer]:` tag.

---

## Question 1
The vision specifies structured error responses with specific error codes. Should the custom 422 handler also wrap Pydantic validation errors in the same envelope structure (`{"status": "error", "operation": "...", "inputs": {...}, "error": {"code": "INVALID_INPUT", "message": "..."}}`), or is a simpler format acceptable for validation errors?

A) Use the exact same envelope structure for all errors including Pydantic validation errors
B) Use a simplified envelope for Pydantic validation errors (omit `operation` and `inputs` fields)
C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 2
For the statistics `mode` operation, the vision states "returns smallest mode on ties." Should `mode` return a single numeric value, or a list of values (with only the smallest returned on ties)?

A) Always return a single numeric value (the smallest mode if there are ties)
B) Return a list of all modes, sorted ascending
C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 3
The vision mentions `OVERFLOW` as an error code. Python's `math` module returns `inf` for overflow cases (e.g., `math.exp(1000)`). Should the API return `inf` in the result field, or should it return an OVERFLOW error response?

A) Return an OVERFLOW error response whenever the result would be `inf` or `-inf`
B) Return `inf`/`-inf` as valid results (only error on truly unrepresentable values)
C) Return `inf`/`-inf` as valid results for `exp` but OVERFLOW error for other operations
D) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 4
For unit conversions, the vision lists specific units for each category. Should unknown `from_unit`/`to_unit` values return `INVALID_INPUT` (422) or a more specific error?

A) Return `INVALID_INPUT` (422) for unknown units — consistent with other validation errors
B) Return a specific `UNKNOWN_UNIT` error code with HTTP 400
C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 5
The tech-env specifies `uv run pytest` and `pytest-cov` with 90% coverage minimum. Should the `pyproject.toml` configure `pytest-cov` to enforce the 90% threshold (fail the test run if below 90%), or just report coverage?

A) Enforce 90% minimum — tests fail if coverage drops below 90%
B) Report coverage only — do not fail the test run based on coverage
C) Other (please describe after [Answer]: tag below)

[Answer]: A

## Question 6
The vision lists `nan` as a constant. Should operations that receive `NaN` as input (e.g., `add(NaN, 5)`) return `NaN` following IEEE 754 propagation, or return an `INVALID_INPUT` error?

A) Propagate NaN following IEEE 754 rules (return NaN in result)
B) Reject NaN inputs with `INVALID_INPUT` error
C) Other (please describe after [Answer]: tag below)

[Answer]: B
