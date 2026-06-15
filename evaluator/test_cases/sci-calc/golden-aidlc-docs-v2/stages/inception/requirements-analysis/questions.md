# Clarification Questions

The spec is comprehensive and leaves very little ambiguous. One question to confirm:

### Q1: Statistics — maximum array size

The spec says `values` requires at least 1 element. Is there a maximum array size we should enforce (e.g., 10,000 elements) to bound computation time, or should we accept any array that fits within the 1 MB request body limit?

a) Enforce a max of 10,000 elements (explicit validation)
b) No explicit limit — rely on the 1 MB body size constraint naturally bounding it
c) Other

**Recommendation:** (b) — the 1 MB body limit already constrains array size to roughly 100K numbers. Adding an explicit cap is unnecessary complexity for MVP.

[Answer]: (b) — no explicit limit, rely on 1 MB body constraint.
