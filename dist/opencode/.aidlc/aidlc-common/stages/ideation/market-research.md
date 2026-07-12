---
slug: market-research
phase: ideation
execution: CONDITIONAL
condition: Execute when initiative has external market positioning or build-vs-buy considerations. Skip for internal tools, bug fixes, or refactors.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - competitive-analysis
  - market-trends
  - build-vs-buy
  - market-research-questions
consumes:
  - artifact: intent-statement
    required: true
requires_stage:
  - intent-capture
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
inputs: Intent statement from intent-capture stage
outputs: competitive-analysis.md, market-trends.md, build-vs-buy.md, market-research-questions.md (under this stage's record dir, engine-resolved)
---

# Market Research & Competitive Analysis

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `.aidlc/knowledge/aidlc-product-agent/`.

### Step 2: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Identify market-relevant aspects of the initiative

### Step 3: Generate Clarifying Questions

Create `<record>/ideation/market-research/market-research-questions.md` with questions:
- What competing products or solutions exist in the market?
- What are their strengths, weaknesses, and pricing models?
- What industry trends or regulatory shifts are relevant?
- What do customers expect as table-stakes vs. differentiators?
- For internal initiatives: are there existing tools, SaaS products, or open-source alternatives?
- What is the build-vs-buy-vs-partner calculus?
- What market size or addressable audience are we targeting?

Follow stage-protocol.md question flow (Guide Me / Edit File / Chat).

### Step 4: Collect and Analyze Answers

Run ambiguity detection and contradiction analysis on all answers.

### Step 5: Generate Artifacts

Create competitive analysis, market trends report, build-vs-buy assessment, and differentiation strategy brief based on answers and research.

### Step 6: Update State

Mark market-research as `[x]` completed in `<record>/aidlc-state.md`.

### Step 7: Present Completion & Request Approval

Completion emoji: :bar_chart:
Review path: `<record>/ideation/market-research/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/market-research/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `intent-statement`).

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

- Prescriptive rule → `.aidlc/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.aidlc/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
