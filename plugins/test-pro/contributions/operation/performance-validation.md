---
target: performance-validation
bundle: test-pro
adds:
  produces:
    - test-pro-load-regression-matrix
  required_sections:
    - "Load Regression"
fragments:
  - anchor: end-of-steps
    order: 100
---

## fragment: end-of-steps

### Step (test-pro): Load regression matrix

Cross-reference the construction regression suite (`test-pro-regression-suite`)
and coverage summary against the load-test results. Write
`test-pro-load-regression-matrix.md` under a `## Load Regression` heading,
flagging any performance regression vs the prior run and any load-path not
covered by the regression suite.
