---
slug: market-research
phase: ideation
execution: CONDITIONAL
condition: Execute when initiative has external market positioning or build-vs-buy considerations. Skip for internal tools, bug fixes, or refactors.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
summary_confirmation: required
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

## Steps

### Step 1: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Identify market-relevant aspects of the initiative

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/market-research/market-research-questions.md` with questions:
- What competing products or solutions exist in the market?
- What are their strengths, weaknesses, and pricing models?
- What industry trends or regulatory shifts are relevant?
- What do customers expect as table-stakes vs. differentiators?
- For internal initiatives: are there existing tools, SaaS products, or open-source alternatives?
- What is the build-vs-buy-vs-partner calculus?
- What market size or addressable audience are we targeting?

Follow stage-protocol.md question flow (Guide Me / Edit File / Chat).

### Step 3: Collect and Analyze Answers

Run ambiguity detection and contradiction analysis on all answers.

### Step 4: Generate Artifacts

Create competitive analysis, market trends report, build-vs-buy assessment, and differentiation strategy brief based on answers and research.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage market-research --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :bar_chart:
Review path: `<record>/ideation/market-research/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/market-research/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
