---
target: build-and-test
plugin: ddd
adds:
  consumes:
    - artifact: ddd-conformance-suite
      required: false
fragments:
  - anchor: end-of-steps
    order: 100
---

## fragment: end-of-steps

### Step (ddd): Fold the domain-conformance tests into the canonical suite

The `ddd-conformance` gate stage generates the domain tests (structural rule-0, invariant/property,
FSM transition-matrix, and business-rule tests) into the workspace. Ensure the canonical build/test
command discovers and runs them alongside the functional tests, so they persist and re-run in CI on
every future change — not only during the one-time gate. A failing domain test fails the build.

(The authoritative hard gate remains the `ddd-conformance` stage, which runs these tests and
adjudicates violations; this step keeps them in the standing suite.)
