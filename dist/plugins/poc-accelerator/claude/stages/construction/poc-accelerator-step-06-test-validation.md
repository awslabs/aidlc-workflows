---
slug: poc-accelerator-step-06-test-validation
number: 3.83
name: PoC Test Validation
plugin: poc-accelerator
phase: construction
execution: ALWAYS
condition: Always executes after core implementation to produce concise, repeatable validation evidence.
lead_agent: aidlc-quality-agent
support_agents:
  - aidlc-developer-agent
mode: inline
produces:
  - poc-accelerator-test-plan
  - poc-accelerator-test-results
consumes:
  - artifact: poc-accelerator-feature-summary
    required: true
  - artifact: poc-accelerator-acceptance-criteria
    required: true
requires_stage:
  - poc-accelerator-step-05-feature-expansion
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - poc-accelerator-cde
inputs: Core feature summary, acceptance criteria, source code, and deployed PoC endpoint when available
outputs: poc-accelerator-test-plan.md and poc-accelerator-test-results.md (under this stage's record dir, engine-resolved)
---

# PoC Test Validation

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Plan Requirement-Level Tests

Load the quality persona and map each acceptance criterion to the smallest
meaningful unit or integration test. Include the safe demo path, a key invalid
input, and the redaction behavior. State explicitly which production test types
are out of scope for this PoC.

### Step 2: Execute Repeatable Checks

Run the project build, unit tests, and focused integration/smoke checks against
the deployed non-production environment when available. Use read-only AWS API
MCP server calls to confirm the deployed resource states the integration checks
depend on. Do not call customer production systems or use unapproved real data.

### Step 3: Write Evidence

Create `poc-accelerator-test-plan.md` and
`poc-accelerator-test-results.md` with commands, timestamps, criterion mapping,
pass/fail results, defects, and rerun instructions. A failure stays visible;
create a bounded remediation item instead of silently excluding it.

### Step 4: Update State

This is an automatic validation checkpoint. Mark
`poc-accelerator-step-06-test-validation` complete in `<record>/aidlc-state.md` once
results and any known failure disposition are documented.

## Sensors

The required-sections and upstream-coverage sensors keep validation evidence
reviewable and traceable to the feature summary and acceptance criteria.

## Learn

Maintain timestamped interpretations, deviations, tradeoffs, and open questions
in `<record>/<phase>/<stage>/memory.md`. Do not confuse passing PoC tests with
production readiness.
