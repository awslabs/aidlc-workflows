---
slug: team-formation
phase: ideation
execution: CONDITIONAL
condition: Execute when team composition, capacity, or mob planning is relevant. Skip for solo developer or small team projects.
lead_agent: aidlc-delivery-agent
support_agents: []
mode: inline
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

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-delivery-agent persona from `agents/aidlc-delivery-agent.md` and knowledge from `.kiro/knowledge/aidlc-delivery-agent/`.

### Step 2: Load Prior Context

- Read scope definition from `<record>/ideation/scope-definition/`
- Read feasibility assessment and constraint register (if exist)
- Read intent backlog for work volume estimation

### Step 3: Generate Clarifying Questions

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

### Step 4: Collect and Analyze Answers

Run gap analysis between required skills and available skills.

### Step 5: Generate Artifacts

Create team availability assessment, skill matrix (with gap analysis), mob composition plan, RACI matrix, capacity allocation agreement, skill gap remediation plan, and onboarding checklist.

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage team-formation --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 7: Present Completion & Request Approval

Completion emoji: :people_holding_hands:
Review path: `<record>/ideation/team-formation/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/team-formation/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `scope-document`, `intent-backlog`, `feasibility-assessment`).

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
- Verification check → new manifest at `.kiro/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
