---
slug: ops-min-verify
number: 4.51
name: Ops-Min Verify
bundle: ops-min
phase: operation
execution: CONDITIONAL
condition: Execute when the ops-min deploy record is on this scope's resolved plan.
lead_agent: aidlc-operations-agent
support_agents: []
mode: inline
produces: []
consumes:
  - artifact: ops-min-deploy-record
    required: true
requires_stage: []
scopes:
  - enterprise
  - feature
when:
  producer-in-plan: ops-min-deploy-record
inputs: The deploy record from ops-min-deploy
outputs: aidlc-docs/operation/ops-min-verify/ops-min-verify-report.md
---

# Ops-Min Verify

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

This stage demonstrates the `when: {producer-in-plan}` predicate. It lists both
`enterprise` and `feature` in `scopes:`, but `ops-min-deploy` (which produces
`ops-min-deploy-record`) is enterprise-only. So the compile-time grid pass keeps
ops-min-verify EXECUTE under enterprise (its producer is on the plan) and SKIPs it
under feature (the producer is not), even though feature is in its scope list.

## Steps

### Step 1: Verify the deploy record

Read the deploy record from `aidlc-docs/operation/ops-min-deploy/` and produce a
short verification report with a `## Summary` and a `## Checks` section.

### Step 2: Update State

Mark ops-min-verify as `[x]` completed in `aidlc-docs/aidlc-state.md`.

### Step 3: Present Completion & Request Approval

Completion emoji: :white_check_mark:
Review path: `aidlc-docs/operation/ops-min-verify/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's output is a markdown artefact under `aidlc-docs/operation/ops-min-verify/`.

## Learn

While running this stage, maintain a running log in
`aidlc-docs/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings: Interpretations, Deviations,
Tradeoffs, Open questions, each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
