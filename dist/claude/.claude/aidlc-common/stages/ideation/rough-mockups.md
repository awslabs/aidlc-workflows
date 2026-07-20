---
slug: rough-mockups
phase: ideation
execution: CONDITIONAL
condition: Execute when user-facing UI is part of the initiative; for API/backend, produce system interaction diagrams. Skip for non-UI, API-only, or infrastructure-only initiatives.
lead_agent: aidlc-design-agent
support_agents:
  - aidlc-product-agent
mode: inline
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
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

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-design-agent persona from `agents/aidlc-design-agent.md` and knowledge from `.claude/knowledge/aidlc-design-agent/`.

### Step 2: Load Prior Context

- Read intent statement from `<record>/ideation/intent-capture/`
- Read scope definition and intent backlog from `<record>/ideation/scope-definition/`

### Step 3: Generate Clarifying Questions

Create `<record>/ideation/rough-mockups/rough-mockups-questions.md` with questions:
- What are the primary user entry points and key screens/views?
- What is the core user flow (happy path)?
- What does the information hierarchy look like?
- Are there existing brand guidelines, design systems, or UI patterns to follow?
- What device/form factors must be supported?
- Are there known accessibility requirements (WCAG level, screen reader support, keyboard-only navigation)?
- For non-UI initiatives: what are the key system interactions and data flows?

Follow stage-protocol.md question flow.

### Step 4: Collect and Analyze Answers

Run contradiction analysis between UX expectations and scope constraints.

### Step 5: Generate Artifacts

For UI initiatives: Create low-fidelity wireframes (ASCII art or structured descriptions), core user flow diagram, information architecture outline. Include a one-line accessibility note per screen: heading level (h1–h3), primary landmark regions (header/main/nav/footer), keyboard entry point.

For non-UI initiatives: Create system context diagram, key interaction flow sketches.

All diagrams follow ASCII diagram standards from stage-protocol.md.

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage rough-mockups --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 7: Present Completion & Request Approval

Completion emoji: :pencil2:
Review path: `<record>/ideation/rough-mockups/`
Standard approval gate (Approve / Request Changes).

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/rough-mockups/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `intent-statement`, `scope-document`, `intent-backlog`).

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
- Verification check → new manifest at `.claude/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
