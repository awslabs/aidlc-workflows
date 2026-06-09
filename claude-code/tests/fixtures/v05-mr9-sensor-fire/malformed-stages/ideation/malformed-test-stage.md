---
slug: malformed-test-stage
phase: ideation
execution: ALWAYS
condition: Fixture for t92 — malformed because lead_agent is missing
mode: inline
produces:
  - dummy-output
consumes: []
requires_stage: []
inputs: dummy
outputs: dummy
---

# Malformed Test Stage

This fixture intentionally omits the required `lead_agent` field in
frontmatter so `loadGraph()` throws during validation. t92's "validation
order" group asserts the dispatcher fails before lock acquisition.
