---
slug: scope-definition
phase: ideation
execution: ALWAYS
condition: Always executes — defines the scope boundary and prioritized backlog
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-delivery-agent
mode: inline
summary_confirmation: required
produces:
  - scope-document
  - intent-backlog
  - scope-definition-questions
consumes:
  - artifact: intent-statement
    required: true
  - artifact: feasibility-assessment
    required: false
  - artifact: constraint-register
    required: false
requires_stage:
  - intent-capture
  - feasibility
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
inputs: Intent statement, feasibility assessment, constraint register
outputs: scope-document.md, intent-backlog.md, scope-definition-questions.md (under this stage's record dir, engine-resolved)
---

# Scope Definition & Prioritization

## Steps

### Step 1: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Read feasibility assessment from `<record>/ideation/feasibility/` (if exists)
- Read constraint register and RAID log (if exist)

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/scope-definition/scope-definition-questions.md` with questions:
- What is the minimum viable scope that delivers value?
- What capabilities are must-have vs. nice-to-have?
- What are the dependencies between capabilities?
- What is the sequencing preference (risk-first, value-first, dependency-first)?
- Are there hard deadlines tied to specific capabilities?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Run ambiguity detection, contradiction analysis, and scope-vs-timeline validation.

### Step 4: Generate Artifacts

Create scope definition document (in/out boundary), prioritized intent backlog (proto-Units using MoSCoW/WSJF/RICE), and value stream map.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .cursor/tools/aidlc-orchestrate.ts report --stage scope-definition --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :dart:
Review path: `<record>/ideation/scope-definition/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/scope-definition/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`, `feasibility-assessment`, `constraint-register`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
