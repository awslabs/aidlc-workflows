---
target: nfr-design
bundle: test-pro
adds:
  produces:
    - test-pro-test-harness-design
  consumes:
    - artifact: test-pro-testability-requirements
      required: false
  required_sections:
    - "Test Harness Design"
fragments:
  - anchor: end-of-steps
    order: 100
---

## fragment: end-of-steps

### Step (test-pro): Design the test harness

Design the test harness that the build-and-test stage will implement. Write
`test-pro-test-harness-design` to this stage's engine-resolved per-unit record
dir (the same dir nfr-design's core artifacts land in) under a `## Test Harness
Design` heading. Cover:

- **Framework selection** per unit (runner, assertion lib) consistent with the
  tech stack.
- **Coverage instrumentation** — the tool that produces branch+line coverage
  (e.g. c8/nyc for JS, coverage.py, JaCoCo) and how it emits a machine-readable
  summary.
- **Fixtures & factories** — shared test data, boundary-value generators for
  edge tests, and malformed-payload fixtures for API negative tests.
- **Determinism** — injectable clock/seed and the mock/stub boundaries for
  integration seams.
- **Machine-readable results** — the harness must emit
  `test-pro-test-results.json` and `test-pro-coverage-summary.json` (shapes
  defined in the build-and-test stage) so the advisory test-pro sensors can read
  them.
