---
slug: test-pro-full-suite
number: 4.45
name: Full Test Suite Execution
plugin: test-pro
phase: operation
execution: CONDITIONAL
condition: Execute under the enterprise scope when the regression suite is on this scope's resolved plan, after deployment.
lead_agent: aidlc-quality-agent
support_agents: []
mode: inline
produces:
  - test-pro-full-suite-results
  - test-pro-edge-api-report
consumes:
  - artifact: deployment-log
    required: false
  - artifact: test-pro-regression-suite
    required: false
  - artifact: test-pro-integration-test-results
    required: false
requires_stage:
  - deployment-execution
  - test-pro-integration
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - test-pro-validation
when:
  producer-in-plan: test-pro-regression-suite
inputs: Deployed environment coordinates, the construction regression suite, and integration results
outputs: test-pro-full-suite-results.md, test-pro-edge-api-report.md (under this stage's record dir, engine-resolved)
---

# Full Test Suite Execution

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Runs the full regression + edge + API positive/negative suite against the
DEPLOYED environment — the end-to-end confirmation that the assembled, deployed
system behaves, beyond the per-unit construction tests.

## Steps

### Step 1: Load Agent Personas

Load aidlc-quality-agent persona from `agents/aidlc-quality-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-quality-agent/`.

### Step 2: Load Prior Context

Read the deployed-environment coordinates from `deployment-log`, the regression
suite (`test-pro-regression-suite`), and the cross-unit integration results.

### Step 3: Execute the Full Suite

Run the regression suite, the edge/boundary tests, and the API positive+negative
tests against the deployed environment. Capture pass/fail per category.

### Step 4: Generate Reports

Write `test-pro-full-suite-results.md` (regression results, per-category
summary) and `test-pro-edge-api-report.md` (edge + API positive/negative detail,
with any failures and the requirement each touches).

### Step 5: Update State

Update `<record>/aidlc-state.md`: mark test-pro-full-suite as `[x]` completed and update "Current Status".

### Step 6: Present Completion & Request Approval

Completion emoji: :test_tube:
Review path: this stage's engine-resolved record dir.
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under its record dir. The imported `required-sections` and `upstream-coverage` sensors check those outputs.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
