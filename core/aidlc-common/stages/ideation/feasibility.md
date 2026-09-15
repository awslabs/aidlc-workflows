---
slug: feasibility
name: Feasibility & Constraints
phase: ideation
execution: CONDITIONAL
condition: Execute when there are integration constraints, regulatory requirements, or significant technical uncertainty. Skip for trivial changes with no technical risk.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-aws-platform-agent
  - aidlc-compliance-agent
mode: inline
summary_confirmation: required
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

## Steps

### Step 1: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Read market research from `<record>/ideation/market-research/` (if exists)
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/feasibility/feasibility-questions.md` with questions:
- What existing systems must this integrate with?
- Are there regulatory/compliance requirements (PCI, HIPAA, SOC2, data residency)?
- What is the team's current tech stack and skill profile?
- What are the budget and timeline constraints?
- Are there organizational blockers (change freeze, competing priorities)?
- What AWS services and accounts are currently in use?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Run ambiguity detection and contradiction analysis.

### Step 4: Generate Artifacts

Create feasibility assessment (technical viability, risk analysis), constraint register (technical, organizational, regulatory), and RAID log (Risks, Assumptions, Issues, Dependencies).

The orchestrator will pass these artifacts to aidlc-aws-platform-agent for AWS landscape assessment and aidlc-compliance-agent for regulatory scanning, then synthesize all inputs.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage feasibility --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :test_tube:
Review path: `<record>/ideation/feasibility/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/feasibility/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`, `competitive-analysis`, `market-trends`, `build-vs-buy`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual.
