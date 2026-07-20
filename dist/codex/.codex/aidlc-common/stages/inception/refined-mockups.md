---
slug: refined-mockups
phase: inception
execution: CONDITIONAL
condition: Execute when user-facing UI exists and rough mockups were produced in Ideation; for APIs, refine interaction diagrams
lead_agent: aidlc-design-agent
support_agents:
  - aidlc-product-agent
mode: inline
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
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
  - workshop
inputs: Rough mockups from rough-mockups stage, user stories from user-stories stage, requirements from requirements-analysis stage
outputs: mockups.md, interaction-spec.md, design-system-mapping.md, accessibility-checklist.md, refined-mockups-questions.md (under this stage's record dir, engine-resolved)
---

# Refined Mockups & UX Design

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-design-agent persona from `agents/aidlc-design-agent.md` and knowledge from `.codex/knowledge/aidlc-design-agent/`.

### Step 2: Load Prior Context

- Read rough mockups from `<record>/ideation/rough-mockups/` (if exists)
- Read user stories from `<record>/inception/user-stories/`
- Read requirements from `<record>/inception/requirements-analysis/`

The workshop scope skips rough-mockups by design (no Ideation phase); when the wireframes and user-flow inputs are absent, design the refined mockups directly from the user stories and requirements — never invent the content of a missing artifact.

### Step 3: Generate Clarifying Questions

Create `<record>/inception/refined-mockups/refined-mockups-questions.md` with questions:
- How should each user story be represented in the UI?
- What interaction patterns are needed (modals, inline edits, wizards, progressive disclosure)?
- What states must each screen handle (loading, empty, error, success, partial)?
- Does the design align with the existing design system / component library?
- What accessibility requirements apply (WCAG level)?
- What responsive breakpoints are needed?
- For APIs: what does the developer experience look like?

Follow stage-protocol.md question flow.

### Step 4: Collect and Analyze Answers

Validate design decisions against user stories and requirements for consistency.

### Step 5: Generate Artifacts

Create mid-to-high fidelity mockups (per user story/screen), interaction specification document (use `.codex/knowledge/aidlc-design-agent/component-spec-template.md` as the format for component-level specifications), design system mapping, responsive behavior specification, and accessibility compliance checklist.

For non-UI: create API developer experience specification.

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .codex/tools/aidlc-orchestrate.ts report --stage refined-mockups --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 7: Present Completion & Request Approval

Completion emoji: :art:
Review path: `<record>/inception/refined-mockups/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/refined-mockups/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `wireframes`, `user-flow`, `stories`, `requirements`, `team-practices`).

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
- Verification check → new manifest at `.codex/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
