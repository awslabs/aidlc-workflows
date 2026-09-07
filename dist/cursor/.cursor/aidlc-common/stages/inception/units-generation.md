---
slug: units-generation
phase: inception
execution: ALWAYS
condition: Always executes when in scope. Produces the dependency DAG that Stage 2.9 Delivery Planning consumes for Bolt sequencing. In the compiled scope grid, 2.7 (Units Generation) and 2.9 (Delivery Planning) travel together — both EXECUTE or both SKIP per scope.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-delivery-agent
mode: inline
summary_confirmation: required
reviewer: aidlc-architecture-reviewer-agent
review_artifact: unit-of-work
reviewer_max_iterations: 2
review_class: advisory
produces:
  - unit-of-work
  - unit-of-work-dependency
  - unit-of-work-story-map
  - traceability
consumes:
  - artifact: components
    required: true
  - artifact: decisions
    required: false
  - artifact: requirements
    required: true
  - artifact: stories
    required: false
requires_stage:
  - domain-design
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
inputs: <record>/inception/domain-design/components.md, <record>/inception/requirements-analysis/requirements.md, <record>/inception/user-stories/stories.md (if produced)
outputs: unit-of-work.md, unit-of-work-dependency.md, unit-of-work-story-map.md, traceability.json (under this stage's record dir, engine-resolved)
---

# Units Generation

NOTE: **Stage 2.7 produces the dependency DAG (topology). Stage 2.9 Delivery Planning chooses the economic path through it (Bolt sequence).** 2.7 MUST NOT recommend an implementation order or identify a critical path — those are 2.9's economic-sequencing decisions. This stage describes what can depend on what; 2.9 decides what to ship first and why.

---

## Steps

### PART 1: Planning

### Step 1: Load Prior Context

- Read the component catalogue from `<record>/inception/domain-design/components.md` (the fenced `yaml` block plus the diagram, summary, and rationale)
- Read the Architecture Decision Records from `<record>/inception/domain-design/decisions.md` (if produced) — the boundary/ownership ADRs constrain how components may be grouped into units (a decision to keep two components separately deployable, for instance, forbids bundling them into one unit)
- Read `<record>/inception/requirements-analysis/requirements.md`
- Read `<record>/inception/user-stories/stories.md` (if produced)

### Step 2: Create Decomposition Plan with Questions

Create `<record>/inception/units-generation/units-generation-questions.md` with questions using [Answer]: tag format:
- Unit boundary strategy (by service, by feature, by domain, by deployment target)
- Unit granularity preference (coarse-grained vs. fine-grained)
- Dependency ordering preferences (strict topological only, or allow parallelism between independent units)
- Integration points and contracts between units (APIs, shared data, events)
- Deployment model (monolithic deploy, independent deploy, hybrid)

NOTE: Do NOT ask about implementation order priorities (value-first, risk-first, walking-skeleton-first). Those are economic-sequencing decisions that belong to Stage 2.9 Delivery Planning.

### Step 3: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file).
- MANDATORY ambiguity analysis: scan for vague language, contradictions, missing details
- Create follow-up questions if ANY ambiguity found
- Resolve all ambiguities before proceeding

### Step 4: Get Plan Approval

Present the decomposition plan to the user as a structured question:
- Summarize the approach: unit boundary strategy, estimated unit count, dependency structure, and the proposed kind per unit (service/spec/ui/packaging/library) so the human confirms the design-artifact scope each unit will carry into Construction
- Options: Approve Plan / Revise Plan

---

### PART 2: Generation

### Step 5: Execute Plan — Generate Unit Artifacts

Based on the approved plan, generate 4 artifacts in `<record>/inception/units-generation/` (the three Unit artifacts below plus `traceability.json`, whose contents are specified at the end of this step):

**unit-of-work.md:**
- Unit definitions (name, description, boundaries)
- A stable short ID `U{n}` for every Unit and its construction directory name `u{n}-{description}`. Include both in a table (`Unit ID` and `Directory`) so downstream tools can join story-map IDs to filesystem paths.
- Unit responsibilities (what each unit owns and delivers)
- Deployment model per unit (standalone, shared, embedded)
- Relative complexity estimate per unit (S/M/L/XL)
- Unit kind per unit: `service` | `spec` | `ui` | `packaging` | `library` (what the unit IS, which drives which construction design artifacts apply to it: a spec owes no scalability doc, a packaging unit no business-logic model). `service` = a deployed executable; `spec` = a contract/schema consumed in place; `ui` = a frontend surface; `packaging` = build/distribution artefacts; `library` = reusable code with no standalone runtime. Omit only if none genuinely fits; an untagged unit receives the full design-artifact matrix.
- Implementation notes and constraints per unit

**unit-of-work-dependency.md:**
- Dependency DAG between units (directed edges: "A depends on B"). Must be cycle-free.
- Integration points between units (APIs, shared data, events)
- Parallel development opportunities (sets of units with no dependency between them — multiple valid topological orderings exist)
- A REQUIRED fenced `yaml` edge block (below) — the machine-readable mirror of the prose DAG. The downstream batch fan-out is computed from this block, not the prose, so it must be present, well-formed, and cycle-free. The `required-sections` sensor checks it at this stage's gate.

The fenced block lists every unit with its direct dependencies (the unit names it depends on) and, optionally, each unit's `kind`. Independent units carry `depends_on: []`. Author new Unit names as lowercase path-segment identifiers: a lowercase letter followed by lowercase letters, digits, or hyphens, with a maximum of 64 characters. The runtime also preserves safe legacy single-segment names beginning with a digit or containing uppercase letters, underscores, or dots; autonomous swarms map those names to deterministic internal Bolt slugs while retaining the original Unit identity in directives and audit records. Do not rename an in-flight legacy Unit merely to normalize its spelling. Name each unit exactly once; every name in a `depends_on` list must be a declared unit; no unit may depend on itself; the edges must be acyclic. Each `kind:`, when present, must be one of `service | spec | ui | packaging | library` (an invalid value fails the edge-block sensor at this gate); omit it to keep the unit on the full construction design-artifact matrix:

```yaml
units:
  - name: <unit-name>
    kind: service
    depends_on: []
  - name: <another-unit>
    kind: spec
    depends_on: [<unit-name>]
```

NOTE: This artifact describes topology only. It does NOT pick a single "recommended build order" or identify a critical path — those are economic decisions made in 2.9 (Delivery Planning) using this DAG as input.

**unit-of-work-story-map.md:**
- Each user story mapped by `USx.y` ID to its implementing Unit `U{n}` ID and directory name
- Stories that span multiple units (cross-cutting concerns)
- Story implementation order within each unit
- Coverage verification: every story assigned, every unit has stories

Create `<record>/inception/units-generation/traceability.json`. When
`stories.md` exists, enumerate every `USx.y`; otherwise enumerate every `FR`.
Each `OK` target is one Unit ID or construction directory that also appears on
the story's row in `unit-of-work-story-map.md`:

```json
{
  "stage": "units-generation",
  "upstream_ids": ["US1.1", "US1.2"],
  "coverage": [
    { "id": "US1.1", "status": "OK", "target": "U1" },
    { "id": "US1.2", "status": "GAP" }
  ]
}
```

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .cursor/tools/aidlc-orchestrate.ts report --stage units-generation --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

### Step 7: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :wrench:
- Summary of units defined (with each unit's kind), dependencies mapped, stories assigned
- Review path: `<record>/inception/units-generation/`
- Structured approval question with options: Approve (continue to Construction phase) / Request Changes

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/units-generation/`.

Imports: `required-sections`, `upstream-coverage`, `traceability`.

Upstream targets: `components`, `decisions`, `requirements`, `stories`.

For `unit-of-work-dependency.md`, `required-sections` also requires a
well-formed, cycle-free fenced `yaml` edge block. `traceability` owns
`traceability.json`, derives the Unit set, and verifies every story maps to
its declared target Unit.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
