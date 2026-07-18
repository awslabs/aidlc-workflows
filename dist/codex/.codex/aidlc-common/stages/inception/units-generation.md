---
slug: units-generation
phase: inception
execution: ALWAYS
condition: Always executes when in scope. Produces the dependency DAG that Stage 2.8 Delivery Planning consumes for Bolt sequencing. In the compiled scope grid, 2.7 and 2.8 travel together — both EXECUTE or both SKIP per scope.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-delivery-agent
mode: inline
reviewer: aidlc-architecture-reviewer-agent
reviewer_max_iterations: 2
produces:
  - unit-of-work
  - unit-of-work-dependency
  - unit-of-work-story-map
consumes:
  - artifact: components
    required: true
  - artifact: component-methods
    required: true
  - artifact: services
    required: true
  - artifact: component-dependency
    required: true
  - artifact: decisions
    required: true
  - artifact: requirements
    required: true
  - artifact: stories
    required: false
requires_stage:
  - application-design
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - workshop
inputs: <record>/inception/application-design/ (all design artifacts), <record>/inception/requirements-analysis/requirements.md, <record>/inception/user-stories/stories.md (if produced)
outputs: unit-of-work.md, unit-of-work-dependency.md, unit-of-work-story-map.md (under this stage's record dir, engine-resolved)
---

# Units Generation

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

NOTE: **Stage 2.7 produces the dependency DAG (topology). Stage 2.8 chooses the economic path through it (Bolt sequence).** 2.7 MUST NOT recommend an implementation order or identify a critical path — those are 2.8's economic-sequencing decisions. This stage describes what can depend on what; 2.8 decides what to ship first and why.

---

## Steps

### PART 1: Planning

### Step 1: Load Agent Personas

Load aidlc-architect-agent persona from `agents/aidlc-architect-agent.md` and knowledge from `.codex/knowledge/aidlc-architect-agent/`.
Load aidlc-delivery-agent persona from `agents/aidlc-delivery-agent.md` and knowledge from `.codex/knowledge/aidlc-delivery-agent/` for feasibility validation and prioritization.

### Step 2: Load Prior Context

- Read all artifacts from `<record>/inception/application-design/` (components.md, component-methods.md, services.md, component-dependency.md, decisions.md)
- Read `<record>/inception/requirements-analysis/requirements.md`
- Read `<record>/inception/user-stories/stories.md` (if produced)

### Step 3: Create Decomposition Plan with Questions

Create `<record>/inception/units-generation/units-generation-questions.md` with questions using [Answer]: tag format:
- Unit boundary strategy (by service, by feature, by domain, by deployment target)
- Unit granularity preference (coarse-grained vs. fine-grained)
- Dependency ordering preferences (strict topological only, or allow parallelism between independent units)
- Integration points and contracts between units (APIs, shared data, events)
- Deployment model (monolithic deploy, independent deploy, hybrid)

NOTE: Do NOT ask about implementation order priorities (value-first, risk-first, walking-skeleton-first). Those are economic-sequencing decisions that belong to Stage 2.8 Delivery Planning.

### Step 4: Collect and Analyze Answers

Collect answers following stage-protocol.md §3 question flow (offer interaction mode choice, collect answers, write back to file).
- MANDATORY ambiguity analysis: scan for vague language, contradictions, missing details
- Create follow-up questions if ANY ambiguity found
- Resolve all ambiguities before proceeding

### Step 5: Get Plan Approval

Present the decomposition plan to the user as a structured question:
- Summarize the approach: unit boundary strategy, estimated unit count, dependency structure, and the proposed kind per unit (service/spec/ui/packaging/library) so the human confirms the design-artifact scope each unit will carry into Construction
- Options: Approve Plan / Revise Plan

---

### PART 2: Generation

### Step 6: Execute Plan — Generate Unit Artifacts

Based on the approved plan, generate 3 artifacts in `<record>/inception/units-generation/`:

**unit-of-work.md:**
- Unit definitions (name, description, boundaries)
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

The fenced block lists every unit with its direct dependencies (the unit names it depends on) and, optionally, each unit's `kind`. Independent units carry `depends_on: []`. Name each unit exactly once; every name in a `depends_on` list must be a declared unit; no unit may depend on itself; the edges must be acyclic. Each `kind:`, when present, must be one of `service | spec | ui | packaging | library` (an invalid value fails the edge-block sensor at this gate); omit it to keep the unit on the full construction design-artifact matrix:

```yaml
units:
  - name: <unit-name>
    kind: service
    depends_on: []
  - name: <another-unit>
    kind: spec
    depends_on: [<unit-name>]
```

NOTE: This artifact describes topology only. It does NOT pick a single "recommended build order" or identify a critical path — those are economic decisions made in 2.8 using this DAG as input.

**unit-of-work-story-map.md:**
- Each user story mapped to its implementing unit(s)
- Stories that span multiple units (cross-cutting concerns)
- Story implementation order within each unit
- Coverage verification: every story assigned, every unit has stories

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .codex/tools/aidlc-orchestrate.ts report --stage units-generation --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 8: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :wrench:
- Summary of units defined (with each unit's kind), dependencies mapped, stories assigned
- Review path: `<record>/inception/units-generation/`
- Structured approval question with options: Approve (continue to Construction phase) / Request Changes

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/units-generation/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings), and — for `unit-of-work-dependency.md` specifically — that the required fenced `yaml` edge block is present, well-formed, and cycle-free. Failure mode: missing headings or an absent/malformed/cyclic edge block emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `components`, `component-methods`, `services`, `component-dependency`, `decisions`, `requirements`, `stories`).

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
