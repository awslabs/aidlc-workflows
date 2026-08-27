---
slug: refined-mockups
phase: inception
execution: CONDITIONAL
condition: Execute when user-facing UI exists and rough mockups were produced in Ideation; for APIs, refine interaction diagrams
lead_agent: aidlc-design-agent
support_agents:
  - aidlc-product-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-product-lead-agent
review_artifact: mockups
reviewer_max_iterations: 2
review_class: advisory
produces:
  - mockups
  - interaction-spec
  - design-system-mapping
  - accessibility-checklist
  - refined-mockups-questions
consumes:
  - artifact: wireframes
    required: true
  - artifact: user-flow
    required: true
  - artifact: stories
    required: false
  - artifact: requirements
    required: true
  - artifact: team-practices
    required: false
requires_stage:
  - user-stories
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - classic
  - workshop
inputs: Rough mockups from rough-mockups stage, user stories from user-stories stage, requirements from requirements-analysis stage
outputs: mockups.md, interaction-spec.md, design-system-mapping.md, accessibility-checklist.md, refined-mockups-questions.md (under this stage's record dir, engine-resolved)
---

# Refined Mockups & UX Design

## Steps

### Step 1: Load Prior Context

- Read rough mockups from `<record>/ideation/rough-mockups/` (if exists)
- Read user stories from `<record>/inception/user-stories/`
- Read requirements from `<record>/inception/requirements-analysis/`

The classic scope skips rough-mockups by design (no Ideation phase); when the wireframes and user-flow inputs are absent, design the refined mockups directly from the user stories and requirements — never invent the content of a missing artifact.

### Step 2: Generate Clarifying Questions

Create `<record>/inception/refined-mockups/refined-mockups-questions.md` with questions:
- How should each user story be represented in the UI?
- What interaction patterns are needed (modals, inline edits, wizards, progressive disclosure)?
- What states must each screen handle (loading, empty, error, success, partial)?
- Does the design align with the existing design system / component library?
- What accessibility requirements apply (WCAG level)?
- What responsive breakpoints are needed?
- For APIs: what does the developer experience look like?

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Validate design decisions against user stories and requirements for consistency.

### Step 4: Generate Artifacts

Create mid-to-high fidelity mockups (per user story/screen), interaction specification document (use `.kiro/knowledge/aidlc-design-agent/component-spec-template.md` as the format for component-level specifications), design system mapping, responsive behavior specification, and accessibility compliance checklist.

For non-UI: create API developer experience specification.

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .kiro/tools/aidlc-orchestrate.ts report --stage refined-mockups --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Present Completion & Request Approval

Completion emoji: :art:
Review path: `<record>/inception/refined-mockups/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/refined-mockups/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `wireframes`, `user-flow`, `stories`, `requirements`, `team-practices`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
