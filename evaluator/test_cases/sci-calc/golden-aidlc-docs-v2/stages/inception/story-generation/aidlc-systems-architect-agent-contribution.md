# Systems Architect Contribution — Story Generation

## Overall Assessment

Stories are well-decomposed, traceable to requirements, and have concrete acceptance criteria. Coverage matrix confirms no orphan requirements. Good separation of concerns: user stories for happy paths, system stories for error handling and NFRs.

## Findings

### 1. Missing: nth_root with odd n and negative a

S-4 correctly covers domain errors for sqrt(negative) and nth_root(negative, even_n). However, `nth_root(-8, 3)` is mathematically valid (result: -2.0). The spec says "domain error if a < 0 and n is even" — implying odd n with negative a is valid. Consider adding an acceptance criterion for this case.

### 2. Angle unit default behaviour — not explicitly tested

S-5 tests both explicit angle_unit values but doesn't have a criterion for the default (omit angle_unit → radians). This is implied but worth an explicit AC.

**Suggestion:** Add to S-5: "Given `{"a": 0}` with no angle_unit field, when I POST /api/v1/trigonometry/sin, then it defaults to radians and returns 0.0"

### 3. Conversion invalid unit names

No story covers what happens when an invalid from_unit or to_unit is provided (e.g., "parsecs" for length). This should produce INVALID_INPUT.

**Suggestion:** Consider adding an AC to the conversions story or a small system story for conversion validation.

### 4. exp overflow boundary

S-21 (or equivalent) uses `exp(1000)` as the overflow case. This is correct — `math.exp(710)` already overflows in Python. However, the story should specify that exp does NOT trigger OVERFLOW for values like exp(710) that return inf — it returns inf as a valid result per math stdlib behaviour.

### 5. Suggestion: Explicit float vs int result typing

Stories don't specify whether results are always floats or sometimes integers. For consistency, recommend documenting that all numeric results are JSON numbers (float representation). This is a design decision that can be deferred to functional-design.

## Coverage Verification

All endpoint categories are covered:
- Arithmetic: S-1, S-2 ✓
- Powers: S-3, S-4 ✓
- Trigonometry: S-5, S-6, S-7 ✓
- Logarithmic: S-8, S-9, S-10 ✓
- Statistics: S-11, S-12 ✓
- Constants: S-13, S-14 ✓
- Conversions: S-15, S-16, S-17, S-18, S-19 ✓
- Error handling: S-20, S-21, S-22 ✓
- Cross-cutting: S-23, S-24, S-25 ✓
- Health: S-26 ✓

NFR-4, NFR-5, NFR-9 are appropriately treated as cross-cutting concerns enforced by project config (pyproject.toml requires-python, uvicorn config, etc.) rather than individual stories.

## Verdict

Stories are solid. The nth_root odd-n case (finding #1) should be added as an acceptance criterion. Finding #2 (angle unit default) is a minor gap worth closing before implementation. All other findings are non-blocking observations or deferred design decisions. Proceed.
