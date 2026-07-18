---
slug: delivery-planning
phase: inception
execution: ALWAYS
condition: Always executes — capstone Inception stage, produces the detailed execution plan for Construction and Operation
lead_agent: aidlc-delivery-agent
support_agents:
  - aidlc-architect-agent
mode: inline
produces:
  - bolt-plan
  - team-allocation
  - risk-and-sequencing-rationale
  - external-dependency-map
  - delivery-planning-questions
consumes:
  - artifact: requirements
    required: true
  - artifact: stories
    required: false
  - artifact: mockups
    required: false
  - artifact: components
    required: true
  - artifact: unit-of-work
    required: true
  - artifact: unit-of-work-dependency
    required: true
  - artifact: unit-of-work-story-map
    required: false
  - artifact: team-practices
    required: false
requires_stage:
  - units-generation
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - workshop
inputs: All Inception artifacts (requirements, stories, mockups, architecture, units)
outputs: bolt-plan.md, team-allocation.md, risk-and-sequencing-rationale.md, external-dependency-map.md, delivery-planning-questions.md (under this stage's record dir, engine-resolved)
---

# Delivery Planning

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-delivery-agent persona from `agents/aidlc-delivery-agent.md` and knowledge from `.aidlc/knowledge/aidlc-delivery-agent/`.
Load aidlc-architect-agent for build order validation.

### Step 2: Load Prior Context

Read all Inception phase artifacts:
- Requirements from `<record>/inception/requirements-analysis/`
- User stories from `<record>/inception/user-stories/`
- Application design from `<record>/inception/application-design/`
- Units from `<record>/inception/units-generation/`
- Team formation from `<record>/ideation/team-formation/` (if exists)

**If practices-discovery executed**, resolve three sections from
`aidlc/spaces/<active-space>/memory/{project,team,org}.md` using the
most-specific non-empty statement:
- `## Way of Working` — base/target branch and merge strategy for Construction worktrees
- `## Walking Skeleton` — whether the first Bolt should be a minimal end-to-end slice (gated, separate user approval) or a regular Bolt
- `## Deployment` — parallel-vs-serial Bolt execution stance and approval-gate preferences

Use these affirmed practices when populating `bolt-plan.md`. If no narrower
statement exists (including when practices-discovery was skipped), use the
active space's `memory/org.md` defaults.

### Step 3: Generate Clarifying Questions

This stage plans the Bolt sequence — the order in which Units of Work are executed through Construction. 2.7 produces the dependency DAG (topology); 2.8 chooses a path through it. Economic value cannot be derived from the DAG — that's a human value judgment.

**Definitions for this stage:**
- **Bolt** — per `stage-protocol.md` Glossary: "a deployable unit of work within Construction — one pass through stages 3.1–3.7." A Bolt wraps one or more Units of Work and runs once through the Construction stages.
- **Confidence hypothesis** — the observable behaviour that shipping the Bolt validates or falsifies (e.g., "latency stays under 200ms under 1k-rps load," "users complete signup without support tickets," "the event pipeline survives a 10x burst").
- **WSJF** (Reinertsen / SAFe) — Weighted Shortest Job First. Sequence score = (user-business value + time criticality + risk-reduction value) ÷ job size. Higher score ships first.
- **Walking skeleton** (Cockburn) — the first Bolt is a minimal end-to-end slice touching every architectural layer that proves the architecture works; features come in later Bolts.

Create `<record>/inception/delivery-planning/delivery-planning-questions.md` with questions. Strategic questions (one answer per project):

- Which sequencing heuristic applies: risk-first, value-first, walking-skeleton-first, or hybrid? If hybrid, name which heuristics apply to which Bolts.
- Is a WSJF-style scoring model used? If so, what weightings on risk, value, and job size?
- What is Bolt granularity — one Unit per Bolt, bundled related Units per Bolt, or thin slices that span Units?
- Can multiple Bolts run in parallel through Construction, or is the pipeline strictly sequential?
- Are there external dependencies (APIs, data availability, approvals, external-team hand-offs)? For each gated item capture: owner, lead time, which Bolt it blocks, mitigation/workaround.
- What are the key risk items that should be tackled earliest?

Per-Bolt questions (the aidlc-delivery-agent loops these during artifact generation, one set of answers per Bolt in the plan):

- Which Units of Work does this Bolt bundle?
- Is this Bolt the walking skeleton? If yes, which architectural layers does it prove?
- What is the Definition of Done for this Bolt?
- What is the confidence hypothesis for this Bolt — what will shipping it prove?
- Which mob owns this Bolt? (References teams from 1.5 when 1.5 ran; when 1.5 was SKIP — mvp, workshop — default to aidlc-developer-agent for all Bolts.)

NOTE: Bolt sequencing is economic, not topological. Bolt order may deviate from 2.7's topological order when a risk-first or walking-skeleton-first argument justifies it. The deviation must be captured in `risk-and-sequencing-rationale.md`.

NOTE: This stage plans the Bolt sequence. It does NOT decide which AIDLC stages to run or at what depth — that is handled by the `/aidlc` skill's scope selection.

Follow stage-protocol.md question flow.

### Step 4: Collect and Analyze Answers

Validate the chosen Bolt sequence respects 2.7's dependency DAG (with aidlc-architect-agent input). Flag any deviation from topological order so it can be justified in the rationale artifact.

### Step 5: Generate Artifacts

Create four artifacts in `<record>/inception/delivery-planning/`:

- `bolt-plan.md` — the ordered sequence of Bolts. Each Bolt entry: included Unit(s) of Work, walking-skeleton marker if applicable, Definition of Done for that Bolt, confidence hypothesis ("what will shipping this Bolt prove?"), expected demo.
- `team-allocation.md` — Bolt-to-mob assignment. References teams from 1.5 when 1.5 ran (enterprise, feature). When 1.5 is SKIP (mvp, workshop), states that all Bolts are executed by aidlc-developer-agent (AI). When team count > 1, this is the Program Board analog.
- `risk-and-sequencing-rationale.md` — the why behind the Bolt ordering: WSJF-style scoring, risk-first argument, walking-skeleton-first argument, or value-first argument. References the heuristic used (Cohn, Reinertsen CD3, or SAFe WSJF).
- `external-dependency-map.md` — gated items (external APIs, data availability windows, approval lead times, external-team hand-offs) mapped to the Bolts that consume them. Lightweight or empty when fully AI-contained.

### Step 6: Phase Boundary Verification

Run Inception → Construction verification check:
- Requirements → Stories → Architecture alignment
- All stories trace to requirements
- Architecture covers all stories
- Write results to `<record>/verification/phase-check-inception.md`

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .aidlc/tools/aidlc-orchestrate.ts report --stage delivery-planning --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

**Construction iteration.** Classify how the approved `bolt-plan.md` wants the
inline construction DESIGN stages (functional-design, nfr-requirements,
nfr-design, infrastructure-design) to iterate over Units of Work. A
unit-at-a-time or walking-skeleton-first plan typically calls for authoring one
unit's four design documents consecutively before the next unit begins; a plan
that reasons stage-by-stage across all units does not. Only when the plan calls
for the unit-first order, record it:
`bun .aidlc/tools/aidlc-state.ts set-construction-iteration unit-major`.
The default is `stage-major` (each design stage runs for every unit, then the
next stage), needs no write, and is byte-identical to prior behaviour. Under
`unit-major` the same four per-stage design gates still fire, but late and in a
cascade at the end of the design block (one human approval per stage), so opt in
only when the plan justifies the per-unit design coherence.

### Step 8: Present Completion & Request Approval

Completion emoji: :calendar:
Review path: `<record>/inception/delivery-planning/`
Approval gate: Approve (proceed to Construction) / Request Changes.

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/delivery-planning/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `requirements`, `stories`, `mockups`, `components`, `unit-of-work`, `unit-of-work-dependency`, `unit-of-work-story-map`, `team-practices`).

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
- Verification check → new manifest at `.aidlc/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

Even when nothing surfaces, still ask the mandatory "Anything to add for next time?" question from stage-protocol.md section 13. Do not infer "Nothing to add." Only after the human answers that question may you proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
