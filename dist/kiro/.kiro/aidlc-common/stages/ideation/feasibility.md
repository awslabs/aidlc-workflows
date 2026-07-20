---
slug: feasibility
phase: ideation
execution: CONDITIONAL
condition: Execute when there are integration constraints, regulatory requirements, or significant technical uncertainty. Skip for trivial changes with no technical risk.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-aws-platform-agent
  - aidlc-compliance-agent
mode: inline
produces:
  - feasibility-assessment
  - constraint-register
  - raid-log
  - feasibility-questions
consumes:
  - artifact: intent-statement
    required: true
  - artifact: competitive-analysis
    required: false
  - artifact: market-trends
    required: false
  - artifact: build-vs-buy
    required: false
requires_stage:
  - intent-capture
  - market-research
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
inputs: Intent statement from intent-capture stage, market research from market-research stage (if executed)
outputs: feasibility-assessment.md, constraint-register.md, raid-log.md, feasibility-questions.md (under this stage's record dir, engine-resolved)
---

# Feasibility & Constraint Analysis

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-architect-agent persona from `agents/aidlc-architect-agent.md` and knowledge from `.kiro/knowledge/aidlc-architect-agent/`.
Orchestrator will separately invoke aidlc-aws-platform-agent and aidlc-compliance-agent for their perspectives.

### Step 2: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Read market research from `<record>/ideation/market-research/` (if exists)
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 3: Generate Clarifying Questions

Create `<record>/ideation/feasibility/feasibility-questions.md` with questions:
- What existing systems must this integrate with?
- Are there regulatory/compliance requirements (PCI, HIPAA, SOC2, data residency)?
- What is the team's current tech stack and skill profile?
- What are the budget and timeline constraints?
- Are there organizational blockers (change freeze, competing priorities)?
- What AWS services and accounts are currently in use?

Follow stage-protocol.md question flow.

### Step 4: Collect and Analyze Answers

Run ambiguity detection and contradiction analysis.

### Step 5: Generate Artifacts

Create feasibility assessment (technical viability, risk analysis), constraint register (technical, organizational, regulatory), and RAID log (Risks, Assumptions, Issues, Dependencies).

The orchestrator will pass these artifacts to aidlc-aws-platform-agent for AWS landscape assessment and aidlc-compliance-agent for regulatory scanning, then synthesize all inputs.

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage feasibility --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 7: Present Completion & Request Approval

Completion emoji: :test_tube:
Review path: `<record>/ideation/feasibility/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/feasibility/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `intent-statement`, `competitive-analysis`, `market-trends`, `build-vs-buy`).

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
