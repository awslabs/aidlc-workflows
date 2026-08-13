---
slug: test-pro-integration
number: 3.85
name: Cross-Unit Integration Testing
plugin: test-pro
phase: construction
execution: CONDITIONAL
condition: Execute once after build-and-test when the test-pro plugin is active and the build spans more than one unit of work.
lead_agent: aidlc-quality-agent
support_agents:
  - test-pro-metrics-agent
mode: inline
produces:
  - test-pro-integration-test-plan
  - test-pro-integration-test-results
  - test-pro-cross-unit-contract-matrix
consumes:
  - artifact: build-and-test-summary
    required: false
  - artifact: test-pro-regression-suite
    required: false
requires_stage:
  - build-and-test
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - test-pro-validation
  - workshop
inputs: All per-unit build/test outputs and the regression suite from build-and-test
outputs: test-pro-integration-test-plan.md, test-pro-integration-test-results.md, test-pro-cross-unit-contract-matrix.md (under this stage's record dir, engine-resolved)
---

# Cross-Unit Integration Testing

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Unlike `build-and-test`, which runs per the unit boundary, this stage runs ONCE
after all units are built — so it can test that the units COMPOSE. It exercises
the cross-unit seams the per-unit tests structurally cannot see.

## Steps

### Step 1: Load Agent Personas

Load aidlc-quality-agent persona from `agents/aidlc-quality-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-quality-agent/`.
Load test-pro-metrics-agent support persona from `agents/test-pro-metrics-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/test-pro-metrics-agent/`.

### Step 2: Read All Per-Unit Outputs

Read every unit's code summary and build-and-test output from the per-unit
construction record dirs and the cross-unit `build-and-test-summary`. Build
the cross-unit view: which units call which, the shared contracts, the data that
crosses unit boundaries.

### Step 3: Identify Cross-Unit Seams

Enumerate the integration points — API calls between units, shared data
contracts, event/message boundaries, shared state. Produce
`test-pro-cross-unit-contract-matrix.md` mapping each seam to the contract it
must honor.

### Step 4: Generate the Integration Test Plan

Write `test-pro-integration-test-plan.md`: for each seam, the integration tests
(happy path + contract violation + failure propagation across the boundary).

### Step 5: Execute Integration Tests

Run the integration tests against the assembled units. Capture results into
`test-pro-integration-test-results.md` (total / passed / failed, with the seam
each failure touches).

### Step 6: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage test-pro-integration --result awaiting-approval`.

### Step 7: Present Completion & Request Approval

Completion emoji: :link:
Review path: this stage's engine-resolved record dir.
Standard 2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. The imported `required-sections` and `upstream-coverage` sensors check those outputs.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
