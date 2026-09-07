---
slug: rough-mockups
phase: ideation
execution: CONDITIONAL
condition: Execute when user-facing UI is part of the initiative; for API/backend, produce system interaction diagrams. Skip for non-UI, API-only, or infrastructure-only initiatives.
lead_agent: aidlc-design-agent
support_agents:
  - aidlc-product-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-product-lead-agent
review_artifact: wireframes
reviewer_max_iterations: 2
review_class: advisory
produces:
  - wireframes
  - user-flow
  - rough-mockups-questions
consumes:
  - artifact: intent-statement
    required: true
  - artifact: scope-document
    required: true
  - artifact: intent-backlog
    required: true
requires_stage:
  - scope-definition
  - team-formation
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
inputs: Intent statement, scope definition, intent backlog
outputs: wireframes.md, user-flow.md, rough-mockups-questions.md (under this stage's record dir, engine-resolved)
---

# Rough Mockups & Concept Visualization

## Steps

### Step 1: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Read scope definition and intent backlog from `<record>/ideation/scope-definition/`

### Step 2: Generate Clarifying Questions

Create `<record>/ideation/rough-mockups/rough-mockups-questions.md` with questions:
- What are the primary user entry points and key screens/views?
- What is the core user flow (happy path)?
- What does the information hierarchy look like?
- Are there existing brand guidelines, design systems, or UI patterns to follow?
- What device/form factors must be supported?
- Are there known accessibility requirements (WCAG level, screen reader support, keyboard-only navigation)?
- For non-UI initiatives: what are the key system interactions and data flows?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Run contradiction analysis between UX expectations and scope constraints.

### Step 4: Generate Artifacts

For UI initiatives: Create low-fidelity wireframes (ASCII art or structured descriptions), core user flow diagram, information architecture outline. Include a one-line accessibility note per screen: heading level (h1–h3), primary landmark regions (header/main/nav/footer), keyboard entry point.

For non-UI initiatives: Create system context diagram, key interaction flow sketches.

All diagrams follow ASCII diagram standards from stage-protocol.md.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage rough-mockups --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :pencil2:
Review path: `<record>/ideation/rough-mockups/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/rough-mockups/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `intent-statement`, `scope-document`, `intent-backlog`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
