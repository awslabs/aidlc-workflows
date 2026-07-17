# Ideation Phase -- Stage Reference (1.1-1.7)

## Phase Overview

The Ideation phase is the second of five phases in the AI-DLC lifecycle. It
establishes the foundation for the entire initiative by capturing intent,
validating feasibility, defining scope, and securing approval before any
technical work begins. The phase runs stages 1.1 through 1.7 and concludes
with a go/no-go gate that controls entry into the Inception phase.

All seven stages execute inline (no subagent delegation) and follow the
standard stage-protocol.md for approval gates, question format, and completion
messages. The orchestrator routes through them sequentially, skipping
CONDITIONAL stages that do not apply to the current scope.

**Key characteristics of the Ideation phase:**

- Every stage uses inline execution mode (direct conversation with the user).
- Stages produce artifacts under the intent's record dir at `<record>/ideation/<stage-name>/`, where `<record>` is `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (the `audit/` shard dir, the per-stage `memory.md`, and the verification reports live under the same record dir).
- All stages except Stage 1.1 depend on outputs from earlier stages.
- Stage 1.7 runs a phase boundary verification check before handing off to
  Inception.
- The phase is bookended by two ALWAYS stages (1.1 Intent Capture and 1.7
  Approval & Handoff); the five middle stages are CONDITIONAL and may be
  skipped depending on scope.

**Scope-driven stage inclusion:**

| Scope            | Stages Included                             |
|------------------|---------------------------------------------|
| enterprise       | All 1.1-1.7                                |
| feature          | All 1.1-1.7                                |
| mvp              | 1.1, 1.3 (light), 1.4, 1.6                  |
| poc              | 1.1 (minimal)                               |
| bugfix           | None (Ideation skipped entirely)            |
| refactor         | None (Ideation skipped entirely)            |
| infra            | None (Ideation skipped entirely)            |
| security-patch   | None (Ideation skipped entirely)            |
| workshop         | None (Ideation skipped entirely)            |

---

## Stage Summary Table

| Stage | Name                        | Condition   | Lead Agent      | Support Agents                              | Mode   |
|-------|-----------------------------|-------------|-----------------|---------------------------------------------|--------|
| 1.1   | Intent Capture & Framing    | ALWAYS      | aidlc-product-agent   | aidlc-architect-agent                             | inline |
| 1.2   | Market Research             | CONDITIONAL | aidlc-product-agent   | --                                          | inline |
| 1.3   | Feasibility & Constraints   | CONDITIONAL | aidlc-architect-agent | aidlc-aws-platform-agent, aidlc-compliance-agent        | inline |
| 1.4   | Scope Definition            | ALWAYS      | aidlc-product-agent   | aidlc-delivery-agent                              | inline |
| 1.5   | Team Formation              | CONDITIONAL | aidlc-delivery-agent  | --                                          | inline |
| 1.6   | Rough Mockups               | CONDITIONAL | aidlc-design-agent    | aidlc-product-agent                               | inline |
| 1.7   | Approval & Handoff          | ALWAYS      | aidlc-delivery-agent  | aidlc-product-agent                               | inline |

---

## Stage 1.1: Intent Capture & Framing

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.1                                                                    |
| Condition        | ALWAYS -- first stage of every workflow; establishes the initiative's foundation |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | aidlc-architect-agent (technical context)                                    |
| Mode             | inline                                                                 |
| Completion Emoji | :bulb:                                                                 |

### Purpose

Intent Capture is the entry point of every AI-DLC workflow. It captures the
business problem, identifies stakeholders, establishes success metrics, and
classifies the project type (greenfield, brownfield, or migration). The
resulting intent statement and stakeholder map become the foundation that all
downstream stages build upon.

If the user provided freeform intent text via `$ARGUMENTS`, that text is passed
as seed context so the stage does not re-ask "what do you want to build?"

### Inputs

- User's project description from `$ARGUMENTS` or the intent's `audit/` shards
- Existing `<record>/` artifacts from prior sessions (if any)
- Guardrails from `aidlc/spaces/<active-space>/memory/`

### Steps

1. **Load Agent Personas** -- Load aidlc-product-agent persona and knowledge. Load aidlc-architect-agent persona for technical context perspective.
2. **Load Prior Context** -- Read user's project description. Check for existing artifacts. Load guardrails.
3. **Generate Clarifying Questions** -- Create `<record>/ideation/intent-capture/intent-capture-questions.md` with questions covering business problem, customer, success metrics, initiative trigger, project type. Uses `[Answer]:` tag format with A-E options plus X (Other). Offers tri-mode question flow.
4. **Collect and Analyze Answers** -- Confirm all tags filled. Run ambiguity/contradiction analysis.
5. **Generate Artifacts** -- Produce intent statement and stakeholder map.
6. **Prepare Completion** -- Verify both artifacts. Do not edit state; report
   the gate outcome through `aidlc-orchestrate.ts`.
7. **Present Completion & Request Approval** -- Standard 2-option gate.

### Outputs

| File                          | Contents                                                      |
|-------------------------------|---------------------------------------------------------------|
| `intent-statement.md`         | Problem Statement, Target Customer, Success Metrics, Initiative Trigger, Project Type, Initial Scope Signal |
| `stakeholder-map.md`          | Key stakeholders and interests, decision-makers vs. influencers, communication requirements |
| `intent-capture-questions.md` | Clarifying questions with `[Answer]:` tags (input artifact) |

### Notes

- First stage of every workflow. No prior artifacts other than user input.
- Freeform intent in `$ARGUMENTS` is used as seed context.
- The intent statement feeds every subsequent Ideation stage and carries forward into Inception.

---

## Stage 1.2: Market Research & Competitive Analysis

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.2                                                                    |
| Condition        | CONDITIONAL -- skip for internal tools, bug fixes, refactors           |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | (none)                                                                 |
| Mode             | inline                                                                 |
| Completion Emoji | :bar_chart:                                                            |

### Purpose

Validates the initiative against the external competitive landscape. Produces competitive analysis, market trends, build-vs-buy assessment, and differentiation strategy.

### Inputs

- Intent statement from Stage 1.1

### Outputs

| File                            | Contents                                                    |
|---------------------------------|-------------------------------------------------------------|
| `competitive-analysis.md`       | Competitive landscape, competitor profiles, strengths/weaknesses |
| `market-trends.md`              | Industry trends, regulatory shifts, market size             |
| `build-vs-buy.md`               | Build-vs-buy-vs-partner assessment                          |
| `market-research-questions.md`  | Clarifying questions with `[Answer]:` tags                  |

### Notes

- Skip conditions: internal tools, bug fixes, refactors, infrastructure-only, security patches, poc scopes.
- Feeds into Stage 1.3 Feasibility (if executed) and Stage 1.4 Scope Definition.

---

## Stage 1.3: Feasibility & Constraint Analysis

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.3                                                                    |
| Condition        | CONDITIONAL -- skip for trivial changes; execute for technical risk or compliance needs |
| Lead Agent       | aidlc-architect-agent (technical feasibility)                                |
| Support Agents   | aidlc-aws-platform-agent (AWS landscape), aidlc-compliance-agent (regulatory scanning) |
| Mode             | inline                                                                  |
| Completion Emoji | :test_tube:                                                            |

### Purpose

Evaluates technical viability, identifies constraints, and establishes a RAID log (Risks, Assumptions, Issues, Dependencies). Multi-agent stage: architect leads, then aws-platform and compliance provide input.

### Inputs

- Intent statement from Stage 1.1
- Market research from Stage 1.2 (if executed)

### Outputs

| File                         | Contents                                                       |
|------------------------------|----------------------------------------------------------------|
| `feasibility-assessment.md`  | Technical viability, risk analysis                             |
| `constraint-register.md`     | Technical, organizational, and regulatory constraints          |
| `raid-log.md`                | Risks, Assumptions, Issues, Dependencies                       |
| `feasibility-questions.md`   | Clarifying questions with `[Answer]:` tags                     |

### Notes

- For mvp scope, executes at "light" depth.
- Multi-agent pattern: orchestrator runs lead agent first, then support agents with lead's output as context.

---

## Stage 1.4: Scope Definition & Prioritization

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.4                                                                    |
| Condition        | ALWAYS -- depth adapts to scope                                        |
| Lead Agent       | aidlc-product-agent                                                          |
| Support Agents   | aidlc-delivery-agent (capacity reality-check)                                |
| Mode             | inline                                                                 |
| Completion Emoji | :dart:                                                                 |

### Purpose

Establishes the scope boundary. Produces a prioritized intent backlog (proto-units of work) using MoSCoW, WSJF, or RICE prioritization and a value stream map.

### Inputs

- Intent statement from Stage 1.1
- Feasibility assessment from Stage 1.3 (if exists)

### Outputs

| File                              | Contents                                                  |
|-----------------------------------|-----------------------------------------------------------|
| `scope-document.md`               | In/out scope boundary definition                          |
| `intent-backlog.md`               | Prioritized backlog of proto-units (MoSCoW/WSJF/RICE)    |
| `scope-definition-questions.md`   | Clarifying questions with `[Answer]:` tags                |

### Notes

- Always executes, depth adapts to scope.
- The scope document becomes the authoritative boundary for the entire project.

---

## Stage 1.5: Team Formation & Mob Planning

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.5                                                                    |
| Condition        | CONDITIONAL -- skip for solo developer or small team projects          |
| Lead Agent       | aidlc-delivery-agent                                                         |
| Mode             | inline                                                                 |
| Completion Emoji | :people_holding_hands:                                                 |

### Purpose

Assesses team availability, maps skills, identifies gaps, and produces mob composition plan.

### Inputs

- Scope definition from Stage 1.4
- Feasibility assessment from Stage 1.3 (if exists)

### Outputs

| File                            | Contents                                                    |
|---------------------------------|-------------------------------------------------------------|
| `team-assessment.md`            | Team availability, RACI matrix, capacity allocation         |
| `skill-matrix.md`               | Skills required vs. available, gap analysis                 |
| `mob-composition.md`            | Mob composition plan, team topology                         |
| `team-formation-questions.md`   | Clarifying questions with `[Answer]:` tags                  |

### Notes

- Skip conditions: solo developer projects, small teams, poc, bugfix, refactor scopes.
- Feeds into Stage 2.8 Delivery Planning.

---

## Stage 1.6: Rough Mockups & Concept Visualization

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.6                                                                    |
| Condition        | CONDITIONAL -- skip for non-UI, API-only, or infrastructure-only       |
| Lead Agent       | aidlc-design-agent                                                           |
| Support Agents   | aidlc-product-agent (validates against intent)                               |
| Mode             | inline                                                                 |
| Completion Emoji | :pencil2:                                                              |

### Purpose

Produces early concept visualizations. For UI: low-fidelity wireframes and user flow diagrams. For non-UI: system context diagrams and interaction flow sketches. All diagrams follow ASCII standards from stage-protocol.md.

### Inputs

- Intent statement from Stage 1.1
- Scope definition from Stage 1.4

### Outputs

| File                          | Contents                                                       |
|-------------------------------|----------------------------------------------------------------|
| `wireframes.md`               | Low-fidelity wireframes (UI) or system context diagrams (non-UI) |
| `user-flow.md`                | Core user flow diagram (UI) or interaction flow sketches (non-UI) |
| `rough-mockups-questions.md`  | Clarifying questions with `[Answer]:` tags                     |

### Notes

- Skip condition: non-UI, API-only, or infrastructure-only initiatives.
- Feeds into Stage 2.5 Refined Mockups in Inception (if that stage also executes).

---

## Stage 1.7: Initiative Approval & Handoff

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.7                                                                    |
| Condition        | ALWAYS -- final Ideation gate before Inception                         |
| Lead Agent       | aidlc-delivery-agent                                                         |
| Support Agents   | aidlc-product-agent (validates completeness)                                 |
| Mode             | inline                                                                 |
| Completion Emoji | :white_check_mark:                                                     |

### Purpose

Compiles all Ideation artifacts into a single initiative brief, records all decisions, runs phase boundary verification, and presents a go/no-go gate.

### Inputs

All Ideation phase artifacts from stages 1.1-1.6.

### Steps

1. Load aidlc-delivery-agent persona and knowledge.
2. Read ALL Ideation phase artifacts.
3. Generate approval questions.
4. Compile initiative brief (one-pager combining all outputs).
5. Phase boundary verification (Intent -> Scope -> Intent Backlog consistency).
6. Verify the handoff and phase-boundary artifacts; do not edit lifecycle
   state directly.
7. Present the 3-option approval gate. On approval, report the outcome so the
   engine completes the stage and transitions to Inception atomically.

### Outputs

| File                              | Contents                                                  |
|-----------------------------------|-----------------------------------------------------------|
| `initiative-brief.md`             | One-page summary combining all Ideation outputs           |
| `decision-log.md`                 | Record of all decisions made during Ideation              |
| `approval-handoff-questions.md`   | Approval questions with `[Answer]:` tags                  |

Phase boundary verification:

| File                                          | Contents                                    |
|-----------------------------------------------|---------------------------------------------|
| `<record>/verification/phase-check-ideation.md` | Ideation-to-Inception traceability check |

### Approval Gate

Special 3-option gate:

- **Approve** -- Proceed to Inception phase
- **Request Changes** -- Provide revision feedback
- **Reject Initiative** -- End the workflow entirely

### Notes

- Phase boundary stage -- runs verification per stage-protocol governance.
- Initiative brief serves as executive summary for the entire Ideation phase.

---

## Phase Summary

### Key Outputs

1. **Intent Statement** (1.1) -- Problem statement, target customer, success metrics, project classification.
2. **Stakeholder Map** (1.1) -- Key stakeholders, decision-makers, communication requirements.
3. **Competitive Analysis** (1.2) -- Market positioning, build-vs-buy (when applicable).
4. **Feasibility Assessment and RAID Log** (1.3) -- Technical viability, risk register, constraints (when applicable).
5. **Scope Document and Intent Backlog** (1.4) -- Authoritative scope boundary, prioritized proto-unit list.
6. **Team Plan** (1.5) -- Skill matrix, mob composition, capacity allocation (when applicable).
7. **Concept Mockups** (1.6) -- Wireframes/user flows or system context diagrams (when applicable).
8. **Initiative Brief** (1.7) -- Executive one-pager synthesizing all Ideation outputs.
9. **Phase Boundary Verification** (1.7) -- Traceability check results.

### Handoff to Inception

Upon approval at Stage 1.7, the framework transitions to the Inception
phase. Inception begins with Stage 2.1 Reverse Engineering (for brownfield
projects) or Stage 2.3 Requirements Analysis (for greenfield projects).

## Cross-References

- [Orchestrator](../03-orchestrator.md) -- routing logic, scope-to-stage mapping
- [Stage Protocol](../04-stage-protocol.md) -- approval gates, question format, phase boundary verification
- [Inception Stages](inception.md) -- next phase
- [Initialization Stages](initialization.md) -- previous phase
