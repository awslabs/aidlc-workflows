# Ideation Phase -- Stage Reference (1.1-1.11)

## Phase Overview

The Ideation phase is the second of five phases in the AI-DLC lifecycle. It
establishes the foundation for the entire initiative by capturing intent,
validating feasibility, defining scope, and securing approval before any
technical work begins. The phase holds two paths: the delivery path (stages
1.1 through 1.7) concludes with a go/no-go gate that controls entry into the
Inception phase, and the opt-in discovery path (stage 1.1 followed by stages
1.8 through 1.11, run only by the `discovery` scope) is an idea-to-decision
flow that concludes with an explicit commit, pivot, or park decision. Both
paths share the same entry point: Stage 1.1 Intent Capture.

All eleven stages execute inline (no subagent delegation) and follow the
standard stage-protocol.md for approval gates, question format, and completion
messages. The orchestrator routes through them sequentially, skipping
CONDITIONAL stages that do not apply to the current scope.

**Key characteristics of the Ideation phase:**

- Every stage uses inline execution mode (direct conversation with the user).
- Stages produce artifacts under the intent's record dir at `<record>/ideation/<stage-name>/`, where `<record>` is `aidlc/spaces/<space>/intents/<YYMMDD>-<label>/` (the `audit/` shard dir, the per-stage `memory.md`, and the verification reports live under the same record dir).
- All stages except Stage 1.1 depend on outputs from earlier stages.
- Stage 1.7 runs a phase boundary verification check before handing off to
  Inception.
- The delivery path is bookended by two ALWAYS stages (1.1 Intent Capture and
  1.7 Approval & Handoff); the five middle stages are CONDITIONAL and may be
  skipped depending on scope. The four discovery stages (1.8-1.11) are ALWAYS
  within their path but belong only to the `discovery` scope — every other
  scope skips them.

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
| discovery        | 1.1, then 1.8-1.11                          |

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
| 1.8   | Discovery Current State     | ALWAYS      | aidlc-product-agent   | aidlc-design-agent, aidlc-architect-agent         | inline |
| 1.9   | Discovery Future State      | ALWAYS      | aidlc-product-agent   | aidlc-design-agent, aidlc-architect-agent         | inline |
| 1.10  | Discovery Experimentation   | ALWAYS      | aidlc-product-agent   | aidlc-developer-agent, aidlc-quality-agent, aidlc-design-agent | inline |
| 1.11  | Discovery Decision          | ALWAYS      | aidlc-product-agent   | aidlc-product-lead-agent, aidlc-delivery-agent    | inline |

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

The stage works materials-first: the person may point at existing asks
(tickets, exports, notes, links) and hand over supporting materials, and the
stage answers its clarifying questions from those sources before asking the
person anything — each material-derived answer carries its source and stays
`unconfirmed` until the person validates it at the gate. It also records any
mandate (something already decided elsewhere) and any decide-by date, and
seeds a source inventory and an open questions record that later stages
consume. With nothing supplied beyond the project description, the
questionnaire path is unchanged.

If the user provided freeform intent text via `$ARGUMENTS`, that text is passed
as seed context so the stage does not re-ask "what do you want to build?"

### Inputs

- User's project description from `$ARGUMENTS` or the intent's `audit/` shards
- Existing `<record>/` artifacts from prior sessions (if any)
- Guardrails from `aidlc/spaces/<space>/memory/`

### Steps

1. **Load Agent Personas** -- Load aidlc-product-agent persona and knowledge. Load aidlc-architect-agent persona for technical context perspective.
2. **Load Prior Context** -- Read user's project description. Check for existing artifacts. Load guardrails.
3. **Collect the Asks and Materials** -- Ask once for asks, supporting materials, any mandate, and any decide-by date. When asks or materials arrive, record the person's own reading verbatim before any agent synthesis.
4. **Generate the Source Inventory** -- One row per supplied material; "None" is a valid inventory.
5. **Generate Clarifying Questions** -- Create `<record>/ideation/intent-capture/intent-capture-questions.md` with questions covering business problem, customer, success metrics, initiative trigger, project type. Answers found in the materials are filled in with their source and marked `unconfirmed`; only the remainder is asked. Uses `[Answer]:` tag format with A-E options plus X (Other). Offers tri-mode question flow.
6. **Collect and Analyze Answers** -- Confirm all tags filled. Run ambiguity/contradiction analysis. Flag a material scope misfit and offer the composer or a restart rather than proceeding silently.
7. **Generate Artifacts** -- Produce intent statement (with conditional Where This Came From, Already Decided, and Decide-By Date sections when the run supplied them), stakeholder map, and the open questions record.
8. **Update State** -- Mark 1.1 as `[x]` completed.
9. **Present Completion & Request Approval** -- Standard 2-option gate.

### Outputs

| File                          | Contents                                                      |
|-------------------------------|---------------------------------------------------------------|
| `intent-statement.md`         | Problem Statement, Target Customer, Success Metrics, Initiative Trigger, Project Type, Initial Scope Signal; plus Where This Came From, Already Decided, and Decide-By Date when the run supplied them. On a discovery commit, stage 1.11 adds a What Discovery Validated section (the one cross-stage write in the phase) |
| `stakeholder-map.md`          | Key stakeholders and interests, decision-makers vs. influencers, communication requirements |
| `intent-capture-questions.md` | Clarifying questions with `[Answer]:` tags (input artifact) |
| `source-inventory.md`         | One row per supplied material and what it likely answers; suggested-but-not-supplied; gaps |
| `open-questions-record.md`    | The questions the initiative still carries, with answers, sources, and confidence |

### Notes

- First stage of every workflow. No prior artifacts other than user input.
- Freeform intent in `$ARGUMENTS` is used as seed context.
- The intent statement feeds every subsequent Ideation stage and carries forward into Inception.
- Under the `discovery` scope this stage is the discovery path's entry point: the intent statement, source inventory, and open questions record feed Stage 1.8 Discovery Current State directly.

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
6. Update state, transition to INCEPTION phase.
7. Present 3-option approval gate.

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

## Stage 1.8: Discovery Current State

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.8                                                                    |
| Condition        | Discovery scope only (always runs within it) -- builds the evidenced as-is picture the framing decision rests on |
| Lead Agent       | aidlc-product-agent                                                    |
| Support Agents   | aidlc-design-agent, aidlc-architect-agent                              |
| Mode             | inline                                                                 |
| Completion Emoji | :mag:                                                                  |

### Purpose

Builds an evidenced picture of the current state from the intent statement,
the open questions record, and the source inventory (if it exists) —
evidence before interpretation.

### Outputs

`current-state.md`, `design-language-record.md`.

---

## Stage 1.9: Discovery Future State

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.9                                                                    |
| Condition        | Discovery scope only (always runs within it) -- chooses the problem framing and expresses the future state as testable options |
| Lead Agent       | aidlc-product-agent                                                    |
| Support Agents   | aidlc-design-agent, aidlc-architect-agent                              |
| Mode             | inline                                                                 |
| Completion Emoji | :art:                                                                  |

### Purpose

Chooses a problem framing from genuinely distinct candidates and expresses
the future state as options, recording the assumptions each option rests on.

### Outputs

`future-state.md`, `assumptions-record.md`.

---

## Stage 1.10: Discovery Experimentation

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.10                                                                   |
| Condition        | Discovery scope only (always runs within it) -- tests the riskiest assumptions before commitment through composed test plans |
| Lead Agent       | aidlc-product-agent                                                    |
| Support Agents   | aidlc-developer-agent, aidlc-quality-agent, aidlc-design-agent         |
| Mode             | inline                                                                 |
| Completion Emoji | :test_tube:                                                            |

### Purpose

Tests the riskiest assumptions first, composing test plans over the recorded
assumptions and capturing what the tests actually showed as an evidence
record.

### Outputs

`test-plans.md`, `evidence-record.md`.

---

## Stage 1.11: Discovery Decision

### Metadata

| Field            | Value                                                                  |
|------------------|------------------------------------------------------------------------|
| Phase            | Ideation                                                               |
| Stage #          | 1.11                                                                   |
| Condition        | Discovery scope only (always runs within it) -- ends the phase over the decision pack: commit, pivot, or park |
| Lead Agent       | aidlc-product-agent                                                    |
| Support Agents   | aidlc-product-lead-agent, aidlc-delivery-agent                         |
| Mode             | inline                                                                 |
| Completion Emoji | :scales:                                                               |

### Purpose

Compiles the evidence, assumptions, intent statement, future state, and open
questions into a decision pack and ends the discovery path in an explicit
commit, pivot, or park decision. On commit the person chooses where the
build happens: continue here (the stage relays `scope-change` to the chosen
delivery scope, marks the covered ideation stages skipped, and the same
workflow proceeds into Inception with the full record) or hand off (the
workflow completes and the pack's handoff contract travels to the receiving
team). Discovery itself runs no delivery-path stages.

### Outputs

`decision-pack.md` (on a commit, with the appended handoff contract). A
commit also writes the What Discovery Validated section into stage 1.1's
`intent-statement.md` — the one cross-stage write in the phase, so the
intent delivery reads reflects the validated framing.

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
10. **Decision Pack** (1.11) -- Commit/pivot/park decision over the discovery evidence (discovery scope only).

### Handoff to Inception

Upon approval at Stage 1.7, the framework transitions to the Inception
phase. Inception begins with Stage 2.1 Reverse Engineering (for brownfield
projects) or Stage 2.3 Requirements Analysis (for greenfield projects).
Under the `discovery` scope the phase instead ends at Stage 1.11 with a
commit, pivot, or park decision. A commit either continues into Inception in
the same workspace (the decision stage relays the engine's scope change and
the workflow carries on under the chosen delivery scope) or hands off to a
delivery workflow elsewhere via the decision pack's handoff contract.

## Cross-References

- [Orchestrator](../03-orchestrator.md) -- routing logic, scope-to-stage mapping
- [Stage Protocol](../04-stage-protocol.md) -- approval gates, question format, phase boundary verification
- [Inception Stages](inception.md) -- next phase
- [Initialization Stages](initialization.md) -- previous phase
