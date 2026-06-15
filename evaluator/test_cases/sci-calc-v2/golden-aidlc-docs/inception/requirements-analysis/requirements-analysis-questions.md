# Requirements Analysis — Clarification Questions

## Context

These questions clarify ambiguities in the Scientific Calculator API intent to ensure the requirements document is complete and unambiguous.

---

### Q1: How should the `angle_unit` be reflected in the response envelope?

a) Echo the `angle_unit` in the `inputs` field of the response
b) Add a separate top-level `angle_unit` field to the response
c) Only include it when it differs from the default (radians)
d) Other

**Trade Offs:** Option (a) is consistent with the response envelope spec which already echoes all inputs. Option (b) adds redundancy. Option (c) loses information for default cases.

**Recommendation:** (a) — echoing in the inputs field matches the existing envelope pattern and keeps responses self-describing.

[Answer]: Echo in inputs field

---

### Q2: Should the API support batch operations (multiple calculations in one request)?

a) Yes — accept an array of operations
b) No — single operation per request only
c) Optional batch endpoint alongside single endpoints
d) Other

**Trade Offs:** Batch operations reduce HTTP overhead for bulk use but add complexity and are not mentioned in the vision. Single-operation keeps the API simple and predictable.

**Recommendation:** (b) — the vision specifies single-operation endpoints and the scope is MVP. Batch can be a future enhancement.

[Answer]: No

---

### Q3: For the statistics `mode` operation, how should ties be handled when multiple values have the same frequency?

a) Return the smallest tied mode
b) Return all tied modes as an array
c) Return an error
d) Other

**Trade Offs:** Returning smallest is deterministic and simple. Returning an array changes the response shape (array vs scalar). Returning an error is overly restrictive.

**Recommendation:** (a) — the vision already states "mode returns smallest mode on ties", confirming this behaviour.

[Answer]: Return smallest tied mode

---

### Q4: How should NaN and Infinity inputs be handled?

a) Reject with INVALID_INPUT error
b) Accept and propagate IEEE 754 semantics
c) Accept NaN but reject Infinity
d) Other

**Trade Offs:** IEEE 754 propagation is mathematically correct but produces confusing results for most users (NaN poisons everything). Rejection provides clear error feedback.

**Recommendation:** (a) — the vision emphasises clear error reporting over edge-case mathematical purity. Rejecting special values upfront prevents confusing downstream results.

[Answer]: Reject with INVALID_INPUT

---

### Q5: How should the system behave when a calculation result overflows float64 range?

a) Return OVERFLOW error, never return Infinity
b) Return Infinity as a valid result
c) Return OVERFLOW error but allow negative Infinity
d) Other

**Trade Offs:** Returning Infinity is technically IEEE 754 correct but the vision explicitly defines an OVERFLOW error code. Consistent rejection avoids ambiguity about valid results.

**Recommendation:** (a) — the vision defines OVERFLOW as an error code, implying the API should never return Infinity as a successful result.

[Answer]: OVERFLOW error, never return Infinity

---

### Q6: What is the maximum array size for statistics operations?

a) 10,000 elements
b) 100,000 elements
c) No explicit limit (bounded only by 1MB request body)
d) Other

**Trade Offs:** 10,000 keeps p95 < 50ms comfortably for all statistics operations. 100,000 may push sort-based operations (median, mode) beyond 50ms. No limit relies solely on request body size (~65K float64 values in 1MB JSON).

**Recommendation:** (a) — 10,000 guarantees p95 latency target is met for all statistics operations including median (O(n log n) sort).

[Answer]: 10000 elements max

---

### Q7: What precision should unit conversions use, and what source of conversion factors?

a) Float64 precision using NIST/SI official conversion factors
b) Float64 precision using commonly rounded factors
c) Decimal precision for exact conversions
d) Other

**Trade Offs:** NIST/SI factors are authoritative and reproducible. Decimal adds complexity and is out of scope per the vision. Rounded factors may diverge from expectations.

**Recommendation:** (a) — Float64 matches the rest of the API's precision model, and NIST/SI factors provide authoritative reproducibility.

[Answer]: Float64, NIST/SI conversion factors

---

## Summary of Answers

| ID | Topic | Answer |
|----|-------|--------|
| Q1 | angle_unit_in_response | Echo in inputs field |
| Q2 | batch_operations | No |
| Q3 | multiple_modes | Return smallest tied mode |
| Q4 | nan_infinity_handling | Reject with INVALID_INPUT |
| Q5 | overflow_behavior | OVERFLOW error, never return Infinity |
| Q6 | statistics_array_limit | 10000 elements max |
| Q7 | unit_conversion_precision | Float64, NIST/SI conversion factors |
