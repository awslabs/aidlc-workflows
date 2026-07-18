---
slug: approval-handoff
phase: ideation
execution: ALWAYS
condition: Always executes — compiles all Ideation artifacts into initiative brief for approval
lead_agent: aidlc-delivery-agent
support_agents:
  - aidlc-product-agent
mode: inline
produces:
  - initiative-brief
  - decision-log
  - approval-handoff-questions
consumes:
  - artifact: intent-statement
    required: true
  - artifact: scope-document
    required: true
  - artifact: intent-backlog
    required: true
  - artifact: competitive-analysis
    required: false
  - artifact: feasibility-assessment
    required: false
  - artifact: constraint-register
    required: false
  - artifact: team-assessment
    required: false
  - artifact: wireframes
    required: false
requires_stage:
  - intent-capture
  - feasibility
  - scope-definition
  - team-formation
  - rough-mockups
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
inputs: All Ideation phase artifacts (intent, market research, feasibility, scope, team, mockups)
outputs: initiative-brief.md, decision-log.md, approval-handoff-questions.md (under this stage's record dir, engine-resolved)
---

# Initiative Approval & Handoff

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-delivery-agent persona from `agents/aidlc-delivery-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-delivery-agent/`.

### Step 2: Load Prior Context

Read ALL Ideation phase artifacts:
- Intent statement and stakeholder map from `<record>/ideation/intent-capture/`
- Market research from `<record>/ideation/market-research/` (if exists)
- Feasibility assessment, constraint register, RAID log from `<record>/ideation/feasibility/` (if exists)
- Scope definition and intent backlog from `<record>/ideation/scope-definition/`
- Team formation artifacts from `<record>/ideation/team-formation/` (if exists)
- Mockups/wireframes from `<record>/ideation/rough-mockups/` (if exists)

### Step 3: Generate Approval Questions

Create `<record>/ideation/approval-handoff/approval-handoff-questions.md` with questions:
- Do all stakeholders agree on the intent and scope?
- Have all critical risks been acknowledged with mitigations?
- Is there budget/resource commitment?
- Do the rough mockups reflect the shared vision?
- Does the market research support the investment?
- Are mobs staffed and scheduled?

Follow stage-protocol.md question flow.

### Step 4: Compile Initiative Brief

Create `<record>/ideation/approval-handoff/initiative-brief.md` — a one-pager combining:
- Intent and problem statement
- Market validation summary
- Feasibility and risk highlights
- Scope boundary
- Concept visuals
- Team plan
- Go/no-go recommendation

Create `<record>/ideation/approval-handoff/decision-log.md` — record of all decisions made during Ideation.

### Step 5: Phase Boundary Verification

Run Ideation → Inception verification check:
- Intent → Scope → Intent Backlog consistency
- All scope items have feasibility backing
- Write results to `<record>/verification/phase-check-ideation.md`

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage approval-handoff --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 7: Present Completion & Request Approval

Completion emoji: :white_check_mark:
Review path: `<record>/ideation/approval-handoff/`
Approval gate: Approve (proceed to Inception) / Request Changes / Reject Initiative (end workflow).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/approval-handoff/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `intent-statement`, `scope-document`, `intent-backlog`, `competitive-analysis`, `feasibility-assessment`, `constraint-register`, `team-assessment`, `wireframes`).

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under four standard headings:

- **Interpretations** — choices made where the stage prose was ambiguous
- **Deviations** — places you intentionally departed from the stage prose, and why
- **Tradeoffs** — alternatives considered and why you picked what you did
- **Open questions** — anything to confirm before next run, or uncertain context

Format each entry with an ISO 8601 timestamp:
`- 2026-05-20T10:14:32Z — <summary>; <context>`

Before the approval gate, read memory.md and surface candidates as a
structured question. For each entry the user keeps, write to the appropriate
harness destination per `stage-protocol.md` §13 — never to this stage file:

- Prescriptive rule → a practice line under the routed heading in
  `aidlc/spaces/<active-space>/memory/project.md` (default) or `team.md` (promoted)
- Verification check → new manifest at `{{HARNESS_DIR}}/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
