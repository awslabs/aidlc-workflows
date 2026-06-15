# Systems Architect Contribution — Requirements Analysis

## Overall Assessment

The requirements document is well-structured, traceable, and verifiable. The functional requirements are comprehensive with clear acceptance criteria, the NFRs have measurable targets, and scope boundaries are explicit. A few technical observations from a systems perspective:

## Findings

### 1. nth_root edge case — n=0 (minor gap)

FR-2 states DOMAIN_ERROR for `a < 0` and even `n`, but does not specify behaviour for `n = 0`. Division by zero in the exponent (`a^(1/0)`) should be addressed.

**Suggestion:** Add "nth_root returns DOMAIN_ERROR when n=0" to FR-2 acceptance criteria.

### 2. exp overflow — detection mechanism (clarification)

FR-4 and the OVERFLOW error code (FR-22/FR-31) mention results that exceed representable float range, but do not specify detection behaviour precisely. Python's `math.exp(710)` returns `inf` rather than raising `OverflowError` in all cases. The implementation will need to check `math.isinf(result)` on a finite input as the overflow signal, not only catch `OverflowError` exceptions. OVERFLOW applies when a **finite** input produces an **infinite** result.

**Suggestion:** No change needed to requirements — this is an implementation detail that functional-design will handle. Worth noting for downstream stages.

### 3. Angle unit for inverse trig functions (clarification)

FR-5/FR-6/FR-12 specify that `angle_unit` drives degree↔radian conversion before computation for forward trig functions. For inverse trig functions (asin, acos, atan, atan2), the output should be converted back to degrees when `angle_unit` is "degrees".

**Suggestion:** Make this explicit in the acceptance criteria for FR-5 or FR-6.

### 4. NFR-3 (1 ULP precision) — scope boundary

"Standard operations" is slightly ambiguous. Python's `math.sin`, `math.cos`, etc. are wrappers around the C library's `libm`. Since the implementation uses `math` directly, 1 ULP agreement with the math stdlib is guaranteed by construction. The real precision concern is in multi-step computations (e.g., degree-to-radian conversion before a trig call), where the compound operation may introduce >1 ULP drift.

**Suggestion:** Clarify that the 1 ULP guarantee applies to the core math operation, not the full input-conversion + operation pipeline. For unit conversions (e.g., temperature), precision is governed by standard float64 arithmetic with no additional guarantee.

### 5. NaN propagation — missing assumption

The spec includes `nan` as a constant (FR-12) but does not specify how NaN inputs to operations should behave. Python's `math` functions raise `ValueError` for NaN in some cases and propagate NaN in others. The desired behaviour (reject as INVALID_INPUT, or propagate naturally per IEEE 754) should be explicit.

**Suggestion:** Add assumption: "A-6: NaN inputs propagate naturally through operations (consistent with IEEE 754 behaviour) rather than being rejected as INVALID_INPUT."

### 6. Statistics — population vs sample minimum element count (minor gap)

FR-18 covers `stdev`/`variance` requiring 2+ elements. Population variants `pstdev`/`pvariance` need only 1+ element. This is correct by implication but could be more explicit.

**Suggestion:** Clarify minimum element counts in FR-18 acceptance criteria, distinguishing sample (n≥2) from population (n≥1) variants.

### 7. JSON serialization of special float values (implementation note)

`inf` and `nan` are IEEE 754 special values. They are not valid in strict JSON (RFC 7159), though Python's `json` module and FastAPI/Pydantic support them by default. This is a potential interop concern for API consumers.

**Suggestion:** Document in assumptions that the API may return `Infinity`/`NaN` in JSON responses (non-strict JSON), or decide to return string representations. Recommendation: follow Python/FastAPI default behaviour and document it explicitly.

## Verdict

No blocking issues. The requirements are comprehensive, well-structured, and ready to proceed. The findings above are minor refinements and implementation-aware notes for downstream stages, not gaps that block progress.
