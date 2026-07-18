---
slug: functional-design
phase: construction
execution: CONDITIONAL
condition: New data models, complex business logic, or business rules need design. Skip if simple logic changes with no new business logic.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-developer-agent
mode: inline
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
for_each: unit-of-work
produces:
  - business-logic-model
  - business-rules
  - domain-entities
optional_produces:
  - frontend-components
produces_kinds:
  business-logic-model: [service, ui, library]
  business-rules: [service, spec, library]
  domain-entities: [service, spec, library]
  frontend-components: [ui]
consumes:
  - artifact: unit-of-work
    required: true
  - artifact: unit-of-work-story-map
    required: false
  - artifact: requirements
    required: true
  - artifact: components
    required: true
  - artifact: component-methods
    required: true
  - artifact: services
    required: true
requires_stage:
  - units-generation
sensors:
  - required-sections
  - upstream-coverage
  - linter
  - type-check
scopes:
  - enterprise
  - feature
  - mvp
  - refactor
  - workshop
inputs: unit-of-work.md, unit-of-work-story-map.md, requirements.md, application design artifacts
outputs: "business-logic-model.md, business-rules.md, domain-entities.md, CONDITIONAL: frontend-components.md (under this stage's per-unit record dir, engine-resolved); per-kind applicability via produces_kinds (untagged unit: all)"
---

# Functional Design

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Execution Modes

This stage supports two execution modes, controlled by the orchestrator:

**QUESTION-ONLY mode** (invoked by orchestrator during a Bolt's question phase):
Execute Steps 1–4 only (load personas, read context, generate questions, collect answers).
Do NOT proceed to artifact generation. Return control to the orchestrator.

**ARTIFACT-ONLY mode** (invoked by orchestrator during a Bolt's design phase):
Skip Steps 1–4 (questions already collected and approved).
Read the answered questions file from the per-unit directory.
Execute Steps 5–7 only (generate artifacts, update state, completion).

**Full mode** (default — single-unit projects or direct stage invocation):
Execute all steps sequentially as written.

### Step 1: Load Personas

Load aidlc-architect-agent (lead) persona from `agents/aidlc-architect-agent.md` and knowledge from `.claude/knowledge/aidlc-architect-agent/`. Load aidlc-developer-agent persona from `agents/aidlc-developer-agent.md` and knowledge from `.claude/knowledge/aidlc-developer-agent/` for technical implementation input. Apply aidlc-architect-agent as the primary perspective with aidlc-developer-agent providing technical feasibility input.

### Step 2: Read Unit Context

Read the unit definition from `<record>/inception/units-generation/unit-of-work.md` and assigned stories from `<record>/inception/units-generation/unit-of-work-story-map.md` (if they exist). Read `<record>/inception/requirements-analysis/requirements.md` (if exists) and any application design artifacts from `<record>/inception/application-design/` (if they exist).

Incremental scopes (refactor) deliberately skip units-generation and application-design, so those inputs are absent by design there. When an input is absent, work from what the scope does provide — the requirements and, on a brownfield workspace, the reverse-engineered code knowledge base at `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` prints) — and treat the existing code structure as the de-facto application design. Never invent the content of a missing artifact.

### Step 3: Create Functional Design Plan

Analyze the unit's scope and create a functional design questions file at `<record>/construction/{unit-name}/functional-design/functional-design-questions.md` with context-appropriate questions using [Answer]: tags.

Focus areas:
- Business logic workflows and algorithms
- Domain models and entity relationships
- Business rules, constraints, and validation logic
- Data flow and transformations
- Integration points with other units or external systems
- Error handling and edge cases
- Frontend Components (component hierarchy, props/state, interaction flows, form validation)
- Business Scenarios (end-to-end user journeys, happy/unhappy paths, concurrency edge cases)

### Step 4: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file). After collecting answers, perform MANDATORY ambiguity analysis:
- Identify vague answers ("mix of", "not sure", "depends", "probably")
- Check for contradictions between answers
- Flag missing details needed for artifact generation

If ANY ambiguity found: create follow-up questions and resolve before proceeding.

### Step 5: Generate Artifacts

Generate the following in `<record>/construction/{unit-name}/functional-design/`:

- **business-logic-model.md**: Detailed algorithms, workflows, data transformations, processing sequences, and decision trees for the unit's business logic
- **business-rules.md**: Decision rules, validation logic, constraints, policies, conditional behavior, and business invariants
- **domain-entities.md**: Entities, relationships, data structures, attributes, lifecycle states, and entity interaction patterns
- **frontend-components.md** (CONDITIONAL — only if unit includes frontend/UI): Component hierarchy, props/state design, interaction flows, form validation rules, API integration points

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage functional-design --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 7: Completion

Present completion message and approval gate:

```
# :clipboard: Functional Design Complete — {unit-name}
```

Summary of artifacts produced, then:

```
**Review:** `<record>/construction/{unit-name}/functional-design/`
```

Approval gate: strictly 2-option (Approve / Request Changes).

## Sensors

This stage's outputs are markdown design artefacts under `<record>/construction/{unit-name}/functional-design/`. Some sections include code samples that the code-shape sensors can also flag.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings).
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter (this stage consumes `unit-of-work`, `unit-of-work-story-map`, `requirements`, `components`, `component-methods`, `services`).
- **`linter`** runs against any TypeScript/JavaScript snippets the design includes (matches `**/*.{ts,js}`).
- **`type-check`** runs against any TypeScript/TSX snippets the design includes (matches `**/*.{ts,tsx}`).

Failure modes land in `<record>/.aidlc-sensors/<stage-slug>/` as `SENSOR_FAILED` audit rows with per-sensor detail files.

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
