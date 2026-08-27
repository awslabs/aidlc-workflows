---
slug: team-formation
phase: ideation
execution: CONDITIONAL
condition: Execute when team composition, capacity, or mob planning is relevant. Skip for solo developer or small team projects.
lead_agent: aidlc-delivery-agent
support_agents: []
mode: inline
summary_confirmation: required
produces:
  - team-assessment
  - skill-matrix
  - mob-composition
  - team-formation-questions
consumes:
  - artifact: scope-document
    required: true
  - artifact: intent-backlog
    required: true
  - artifact: feasibility-assessment
    required: false
requires_stage:
  - scope-definition
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
inputs: Scope definition, intent backlog, feasibility assessment
outputs: team-assessment.md, skill-matrix.md, mob-composition.md, team-formation-questions.md (under this stage's record dir, engine-resolved)
---

# Team Formation & Mob Planning

## Steps

### Step 1: Load Prior Context

- Read scope definition from `<record>/ideation/scope-definition/`
- Read feasibility assessment and constraint register (if exist)
- Read intent backlog for work volume estimation

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/team-formation/team-formation-questions.md` with questions:
- What teams and individuals are available?
- What is the current capacity and utilization?
- What skills are required vs. available?
- Are there competing initiatives drawing from the same talent pool?
- What is the preferred team topology?
- What time zones and locations are team members in?
- Are external partners, contractors, or AWS Professional Services needed?
- Who are the decision-makers for each phase?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Run gap analysis between required skills and available skills.

### Step 4: Generate Artifacts

Create team availability assessment, skill matrix (with gap analysis), mob composition plan, RACI matrix, capacity allocation agreement, skill gap remediation plan, and onboarding checklist.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage team-formation --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :people_holding_hands:
Review path: `<record>/ideation/team-formation/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/team-formation/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `scope-document`, `intent-backlog`, `feasibility-assessment`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
