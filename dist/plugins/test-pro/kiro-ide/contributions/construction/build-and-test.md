---
target: build-and-test
bundle: test-pro
adds:
  produces:
    - test-pro-branch-coverage-instructions
    - test-pro-edge-case-instructions
    - test-pro-api-contract-instructions
    - test-pro-regression-suite
    - test-pro-requirement-traceability-matrix
  consumes:
    - artifact: test-pro-testability-requirements
      required: false
    - artifact: test-pro-test-harness-design
      required: false
  sensors:
    - coverage-threshold
    - requirement-coverage
  required_sections:
    - "Branch Coverage"
    - "Edge Cases"
    - "API Positive and Negative"
    - "Requirement Traceability"
fragments:
  - anchor: after-step:9
    order: 100
  - anchor: after-step:9
    order: 110
  - anchor: after-step:9
    order: 120
  - anchor: after-step:10
    order: 130
  - anchor: after-step:10
    order: 140
  - anchor: in:Sensors
    order: 150
---

## fragment: after-step:9

### Step 9a (test-pro): Branch + coverage enrichment

Enable BRANCH coverage in the test runner (not just line coverage). Raise
per-component coverage targets to the `## Coverage Targets` declared in
`test-pro-testability-requirements`. Document the coverage run command. Write
`test-pro-branch-coverage-instructions.md` with a `## Branch Coverage` section
covering every decision point (if/else, switch, ternary, short-circuit).

## fragment: after-step:9

### Step 9b (test-pro): Edge & boundary tests

For each input domain, generate edge tests: off-by-one, ±min and ±max,
empty/null/zero, overflow, and just-inside/just-outside boundaries. Write
`test-pro-edge-case-instructions.md` with a `## Edge Cases` section enumerating
the boundary tests per component.

## fragment: after-step:9

### Step 9c (test-pro): API positive + negative

If the unit exposes an API, generate BOTH positive (happy-path 2xx) and negative
tests (4xx/5xx, malformed payload, auth failure, rate-limit, schema violation)
for each endpoint/contract. Write `test-pro-api-contract-instructions.md` with a
`## API Positive and Negative` section.

## fragment: after-step:10

### Step 10a (test-pro): Regression suite + requirement traceability

Assemble the union of unit, functional, integration, edge, and API tests into a
named regression suite manifest (`test-pro-regression-suite.md`). Build a
`test-pro-requirement-traceability-matrix.md` mapping EVERY functional
requirement (from `requirements`, `stories`, `business-rules`) to its covering
test ids, under a `## Requirement Traceability` table:
`| requirement-id | test-ids | status |`. Any requirement with no covering test
is a gap to flag.

## fragment: after-step:10

### Step 10b (test-pro): Emit machine-readable results

After executing the build and tests, emit two machine-readable JSON files the
advisory test-pro sensors read. These are sensor SIDE-INPUTS, not stage
deliverables — they are not in `produces:` (which resolves to `.md` artifacts);
write them beside this stage's other outputs, under the engine-resolved record
dir (`<record>/construction/build-and-test/`, the same dir the stage's `.md`
artifacts land in):

- `test-pro-test-results.json` —
  `{ "tests": [...], "requirements": { "<req-id>": { "covered": <bool>, "test_ids": [...] } }, "summary": { "total": n, "passed": n, "failed": n } }`
- `test-pro-coverage-summary.json` —
  `{ "line_pct": <n>, "branch_pct": <n>, "targets": { "line": 80, "branch": 70 } }`

## fragment: in:Sensors

The test-pro bundle wires two ADVISORY sensors onto this stage:
`coverage-threshold` (reads `test-pro-coverage-summary.json`) and
`requirement-coverage` (reads `test-pro-test-results.json`). They REPORT against
the targets — they do not block the build (the framework has no blocking sensor
severity yet). Treat their findings as authoritative guidance and drive the
tests to meet the coverage targets and cover every requirement.
