---
slug: domain-design
phase: inception
execution: CONDITIONAL
condition: Execute when new components or logical building blocks are needed. Skip when changes are modifications to existing components only.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-aws-platform-agent
  - aidlc-design-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-architecture-reviewer-agent
review_artifact: components
reviewer_max_iterations: 2
review_class: advisory
produces:
  - components
  - decisions
  - traceability
consumes:
  - artifact: requirements
    required: true
  - artifact: stories
    required: false
  - artifact: architecture
    required: false
    conditional_on: brownfield
  - artifact: component-inventory
    required: false
    conditional_on: brownfield
  - artifact: team-practices
    required: false
requires_stage:
  - requirements-analysis
  - refined-mockups
sensors:
  - required-sections
  - upstream-coverage
  - traceability
scopes:
  - enterprise
  - feature
  - mvp
  - classic
  - workshop
inputs: <record>/inception/requirements-analysis/requirements.md, <record>/inception/user-stories/stories.md (if produced), RE artifacts (if brownfield)
outputs: components.md (fenced ```yaml component catalogue plus a human-readable mermaid diagram and summary table), decisions.md (Architecture Decision Records), and traceability.json — all under this stage's record dir, engine-resolved
---

# Domain Design

Identify and detail the **logical building blocks** of the system — the components you will write code for. A component is a bounded piece of software with its own business logic, entities, and lifecycle: **code you write, not infrastructure you deploy.** Databases, caches, queues, and third-party services are dependencies OF components, not components themselves.

This stage does NOT decide deployment topology (monolith, microservices, serverless, etc.) — that is Units Generation's job. Domain Design produces the building blocks so the team can then decide how to group them into deployable units. It also does not choose the tech stack or NFR patterns — those belong to the NFR and infrastructure stages.

## Steps

### Step 1: Load Prior Context

- Read `<record>/inception/requirements-analysis/requirements.md`
- Read `<record>/inception/user-stories/stories.md` (if produced)
- If brownfield: Read relevant RE artifacts (especially architecture.md, component-inventory.md, dependencies.md)

### Step 2: Create Design Plan with Questions

Create `<record>/inception/domain-design/domain-design-questions.md` with context-appropriate questions using [Answer]: tag format:
- Component boundary decisions (what is a distinct building block, and why)
- Entity ownership (each entity has exactly one owning component — ambiguity is a design smell)
- Component responsibilities (what business logic each block owns)
- Interaction between components (which component calls which, and why)
- Integration approach with existing components (brownfield)
- UI component structure (if user-facing, informed by UX designer perspective)

### Step 3: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file).
- MANDATORY ambiguity analysis: scan for vague language, contradictions, missing details
- Create follow-up questions if ANY ambiguity found
- Resolve all ambiguities before proceeding

### Step 4: Generate the Component Catalogue

Create `<record>/inception/domain-design/components.md`. This single artifact carries both a machine-readable catalogue and the human-readable view.

**Entity capture depth.** Capture entities at the **ownership + shape** level only — which component owns each entity, its identifier, its attribute names, and any cross-component references. Do NOT specify data types, validation constraints, allowed values, or relationship cardinality here — that full schema belongs to Functional Design (`entities.md`). Every entity has **exactly one** owning component; ambiguous ownership is a design smell to resolve before the gate.

**Part A — machine-readable catalogue (fenced `yaml` block).** Author a fenced ```yaml block near the top of the file listing every component. This block is the source of truth; the human view below is derived from it:

```yaml
components:
  - name: <ComponentName>              # PascalCase, unique
    summary: <one-line purpose>
    behaviour: >
      <business rules, validation logic, security constraints, key behaviours — be specific>
    responsibilities:
      - <what this component owns>
    depends_on:                        # components it CALLS ([] if none)
      - component: <OtherComponentName>
        interaction: <why / what for>
        style: <sync | async | event>
    dependents:                        # components that CALL this one ([] if none)
      - component: <OtherComponentName>
        interaction: <why / what for>
    external_dependencies:             # infra / third-party this component USES (optional)
      - name: <e.g. PostgreSQL | Redis | Stripe API>
        kind: <database | cache | queue | object-store | third-party-api | other>
        purpose: <what it's used for>
    entities:                          # entities owned by THIS component ([] if none)
      - name: <EntityName>
        identifier: <attribute that uniquely identifies it>
        attributes: [<attributeName>, <attributeName>]
        references:                    # entities in OTHER components this points to (optional)
          - entity: <OtherEntityName>
            owned_by: <OwningComponentName>
            relationship: <plain-language, e.g. "each Order belongs to one Customer">
```

Well-formedness rules (all must hold): each component name is unique; every `component:`/`owned_by` named anywhere is a declared component; no component depends on itself; `depends_on`/`dependents` are symmetric (if A depends_on B, B lists A in dependents); every entity is owned by exactly one component and has an identifier; every `references.entity` is declared under its `owned_by` component; the dependency graph is acyclic (call out any deliberate cycle in the Rationale). Infrastructure, databases, caches, queues, and third-party services are `external_dependencies` — never components.

**Part B — human-readable view (below the block).** Derive these sections from the catalogue — same data, presented for humans:

- **Component Diagram** — a `mermaid` graph, one node per component, one labelled edge per `depends_on`.
- **Component Summary** — a table: `| Component | Purpose | Depends On | Dependents | Entities Owned |`.
- **Entity Ownership** — a table: `| Entity | Owning Component | Identifier | Attributes | References |`.
- **External Dependencies** — a table: `| Component | Dependency | Kind | Purpose |`.
- **Rationale** — a table explaining why each component is a separate building block (distinct lifecycle, distinct concern, distinct data ownership, distinct change rate — pick what applies).

#### Component-boundary options (when >1 viable decomposition)

When a decomposition choice has more than one viable approach, present the
trade-off before recording the decision:

- Option A — <name>: pros / cons / reversibility
- Option B — <name>: pros / cons / reversibility
- Recommendation: <option> because <trade-off tied to responsibilities/change rate>

The team chooses at the gate (ownership stays with the team), then record the
chosen decomposition plus an **Alternatives Rejected** note in the Rationale
section of components.md.

When only one decomposition is viable, state why and skip the block.

### Step 5: Record Architecture Decisions (ADRs)

Create `<record>/inception/domain-design/decisions.md`. The `components.md` Rationale table is a quick per-component justification; `decisions.md` is the durable Architecture Decision Record log that the Inception phase rule requires. Record one ADR for every **significant** design choice made here — component-boundary decompositions, entity-ownership calls, cross-component interaction styles, and any deliberate dependency cycle.

Each ADR MUST follow this structure (per the Inception phase guardrails):

- **ADR-NNN: <short title>**
  - **Context** — the forces and constraints that made a decision necessary
  - **Decision** — what was chosen
  - **Consequences** — the resulting trade-offs, both positive and negative
  - **Alternatives Rejected** — the other viable options considered and why they were not chosen

Number ADRs sequentially (`ADR-001`, `ADR-002`, …). Where a decision came from a Step 4 component-boundary option block, its rejected options populate that ADR's **Alternatives Rejected**. If no significant decision was made (a single obvious decomposition with no trade-offs), state that explicitly in a single ADR rather than leaving the file empty.

### Step 6: Record Traceability

Create `<record>/inception/domain-design/traceability.json`. When
`stories.md` exists, enumerate every `USx.y`; otherwise enumerate every `FR`
from `requirements.md`. Map each upstream ID to the **component or entity**
in `components.md` that realizes it — those are the only identifiers this
stage's source of truth defines (it does not name services or public methods;
method- and API-level targets are pinned later in Contract Design and
Functional Design):

```json
{
  "stage": "domain-design",
  "upstream_ids": ["US1.1", "US1.2"],
  "coverage": [
    { "id": "US1.1", "status": "OK", "target": "AuthComponent" },
    { "id": "US1.2", "status": "GAP" }
  ]
}
```

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage domain-design --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 8: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :building_construction:
- Summary of components identified (count, key boundaries, entity ownership)
- Key boundary decisions highlighted (with a pointer to the ADR log in `decisions.md`)
- Review path: `<record>/inception/domain-design/`
- Structured approval question with options:
  - Approve (continue to next stage)
  - Request Changes (provide revision feedback)
  - Add Units Generation (if it was skipped in execution plan)

If "Add Units Generation" is selected, run
`bun .claude/tools/aidlc-utility.ts recompose --add units-generation`
before re-entering the approval flow.

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/domain-design/` (`components.md` and `decisions.md`) plus `traceability.json`.

Imports: `required-sections`, `upstream-coverage`, `traceability`.

Upstream targets: `requirements`, `stories`, `architecture`, `component-inventory`, `team-practices`.

`traceability` owns `traceability.json` and checks every story, or every
fallback functional requirement, is declared and covered.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
