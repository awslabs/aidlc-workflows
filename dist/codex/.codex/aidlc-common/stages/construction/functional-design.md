---
slug: functional-design
phase: construction
execution: CONDITIONAL
condition: New data models, complex business logic, or business rules need design. Skip if simple logic changes with no new business logic.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-developer-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-architecture-reviewer-agent
review_artifact: functional-spec
reviewer_max_iterations: 2
for_each: unit-of-work
produces:
  - entities
  - rules
  - functional-spec
  - traceability
optional_produces:
  - frontend-components
produces_kinds:
  entities: [service, spec, library]
  rules: [service, spec, library]
  functional-spec: [service, spec, ui, library]
  traceability: [service, spec, ui, library]
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
  - artifact: contract-summary
    required: false
requires_stage:
  - units-generation
  - contract-design
sensors:
  - required-sections
  - upstream-coverage
  - linter
  - type-check
  - traceability
scopes:
  - enterprise
  - feature
  - mvp
  - refactor
  - classic
  - workshop
inputs: unit-of-work.md, unit-of-work-story-map.md, requirements.md, domain-design components.md, contract-design contract-summary.md (if produced)
outputs: "entities.md, rules.md, functional-spec.md, traceability.json, CONDITIONAL: frontend-components.md (under this stage's per-unit record dir, engine-resolved); per-kind applicability via produces_kinds (untagged unit: all). entities.md and rules.md each carry a fenced ```yaml source-of-truth block; functional-spec.md is the source of truth for workflows and state machines and carries derived ER-diagram and rules-summary views."
---

# Functional Design

## Constraints

This is a design stage — artifacts describe business logic, domain models, and rules at an architectural level, not implementation-ready code. Complete function bodies, class implementations, and framework-specific code belong in code-generation. Limit code to short illustrative snippets (pseudocode or interface-level, ≤15 lines) that clarify a design decision.

## Steps

### Execution Modes

This stage supports two execution modes, controlled by the orchestrator:

**QUESTION-ONLY mode** (invoked by orchestrator during a Bolt's question phase):
Execute Steps 1–3 only (read context, generate questions, collect answers).
Do NOT proceed to artifact generation. Return control to the orchestrator.

**ARTIFACT-ONLY mode** (invoked by orchestrator during a Bolt's design phase):
Skip Steps 1–3 (questions already collected and approved).
Read the answered questions file from the per-unit directory.
Execute Steps 4–6 only (generate artifacts, update state, completion).

**Full mode** (default — single-unit projects or direct stage invocation):
Execute all steps sequentially as written.

### Step 1: Read Unit Context

Read the unit definition from `<record>/inception/units-generation/unit-of-work.md` and assigned stories from `<record>/inception/units-generation/unit-of-work-story-map.md` (if they exist). Read `<record>/inception/requirements-analysis/requirements.md` (if exists), the component catalogue from `<record>/inception/domain-design/components.md` (if it exists), and the contracts for this unit's boundaries from `<record>/inception/contract-design/contract-summary.md` (if it exists).

Incremental scopes (refactor) deliberately skip units-generation and domain-design, so those inputs are absent by design there. When an input is absent, work from what the scope does provide — the requirements and, on a brownfield workspace, the reverse-engineered code knowledge base at `aidlc/spaces/<active-space>/codekb/<repo>/` (the directory `codekb-path --repo <repo>` prints) — and treat the existing code structure as the de-facto domain design. Never invent the content of a missing artifact.

### Step 2: Create Functional Design Plan

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

### Step 3: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file). After collecting answers, perform MANDATORY ambiguity analysis:
- Identify vague answers ("mix of", "not sure", "depends", "probably")
- Check for contradictions between answers
- Flag missing details needed for artifact generation

If ANY ambiguity found: create follow-up questions and resolve before proceeding.

### Step 4: Generate Artifacts

Generate the following in `<record>/construction/{unit-name}/functional-design/`. Technology-agnostic — implementable in any language. No code, no SQL, no framework references.

- **entities.md**: The entity model. Carries a fenced ```yaml source-of-truth block listing each entity with its description, attributes (name, logical type, required/unique, references, allowed values, defaults, min/max, constraints), entity-level constraints, and relationships (cardinality + direction). Follow the block with a short human-readable summary of the entity set.
- **rules.md**: The business rules. Carries a fenced ```yaml source-of-truth block listing each numbered rule (`id: BRx.y`, e.g. `BR1.1` — the `BR{group}.{seq}` format the traceability sensor recognizes) with its statement, category (validation/authorization/constraint/calculation/policy), what it applies to, trigger, logic (IF…THEN in plain language), violation behaviour, and source (FR-n/NFR-n). Follow the block with a short human-readable rules summary table.
- **functional-spec.md**: The behavioural specification. It is the **source of truth for workflows and state machines** — the numbered step sequences a use case follows and the lifecycle-entity state transitions — because `entities.md` (data shape) and `rules.md` (decision logic) do not capture ordered behaviour or transitions. It also carries two **derived** views for readability: an entity-relationship `mermaid` diagram (derived from `entities.md` — the YAML there is source of truth) and a rules summary (derived from `rules.md`). For a UI-only unit that produces `functional-spec.md` without `entities.md`/`rules.md`, this file is self-contained: it authoritatively specifies the interaction workflows and screen/state transitions from the unit definition and requirements, with no entity/rule dependency.
- **frontend-components.md** (CONDITIONAL — only if unit includes frontend/UI): Component hierarchy, props/state design, interaction flows, form validation rules, API integration points

Create
`<record>/construction/{unit-name}/functional-design/traceability.json`.
Enumerate every acceptance criterion assigned to this Unit. Each `OK` target
must name one or more `BRx.y` IDs that exist in `rules.md`. Use the
optional `reverse` array to explain rules that intentionally have no AC; any
unexplained rule is mechanically derived as an orphan:

```json
{
  "stage": "functional-design",
  "unit": "u1-auth",
  "upstream_ids": ["AC1.1.1", "AC1.1.2"],
  "coverage": [
    { "id": "AC1.1.1", "status": "OK", "target": "BR1.1" },
    { "id": "AC1.1.2", "status": "GAP" }
  ],
  "reverse": [
    { "id": "BR1.3", "status": "N/A", "target": "technical validation rule" }
  ]
}
```

### Step 5: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .codex/tools/aidlc-orchestrate.ts report --stage functional-design --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 6: Completion

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

Imports: `required-sections`, `upstream-coverage`, `linter`, `type-check`, `traceability`.

Upstream targets: `unit-of-work`, `unit-of-work-story-map`, `requirements`, `components`, `contract-summary`.

`linter` and `type-check` inspect matching TypeScript/JavaScript snippets.
`traceability` validates per-Unit acceptance-criteria coverage, checks
`BRx.y` targets against `rules.md`, and finds unexplained business-rule orphans.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
