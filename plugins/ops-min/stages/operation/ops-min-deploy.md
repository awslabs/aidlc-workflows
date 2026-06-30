---
slug: ops-min-deploy
number: 4.50
name: Ops-Min Deploy
bundle: ops-min
phase: operation
execution: CONDITIONAL
condition: Execute under the enterprise scope when the ops-min plugin is active.
lead_agent: aidlc-operations-agent
support_agents: []
mode: inline
produces:
  - ops-min-deploy-record
consumes: []
requires_stage: []
scopes:
  - enterprise
inputs: Deployment execution and observability outputs from the operation phase
outputs: aidlc-docs/operation/ops-min-deploy/ops-min-deploy-record.md
---

# Ops-Min Deploy

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-operations-agent persona from `agents/aidlc-operations-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-operations-agent/`.

### Step 2: Generate the deploy record

Create a markdown deploy record capturing the deployment summary and an operational sign-off. Include at least two H2 headings: a `## Summary` section and a `## Sign-off` section.

### Step 3: Update State

Mark ops-min-deploy as `[x]` completed in `aidlc-docs/aidlc-state.md`.

### Step 4: Present Completion & Request Approval

Completion emoji: :rocket:
Review path: `aidlc-docs/operation/ops-min-deploy/`
Standard 2-option approval (Approve / Request Changes).

## Sensors

This stage's output is a markdown artefact under `aidlc-docs/operation/ops-min-deploy/`. The registry-default `required-sections` check (≥2 H2 headings) applies when the stage imports it; this minimal fixture imports no sensors.

## Learn

While running this stage, maintain a running log in
`aidlc-docs/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
