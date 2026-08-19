---
slug: delivery-planning
phase: inception
execution: ALWAYS
condition: Always executes — capstone Inception stage, produces the detailed execution plan for Construction and Operation
lead_agent: aidlc-delivery-agent
support_agents:
  - aidlc-architect-agent
mode: inline
summary_confirmation: required
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
  - artifact: contract-summary
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

Load aidlc-delivery-agent persona from `agents/aidlc-delivery-agent.md` and knowledge from `.claude/knowledge/aidlc-delivery-agent/`.
Load aidlc-architect-agent for build order validation.

### Step 2: Load Prior Context

Read all Inception phase artifacts:
- Requirements from `<record>/inception/requirements-analysis/`
- User stories from `<record>/inception/user-stories/`
- Domain design (component catalogue) from `<record>/inception/domain-design/components.md`
- Units from `<record>/inception/units-generation/`
- Inter-unit contracts from `<record>/inception/contract-design/contract-summary.md` (if produced) — contract ownership and open contract questions map onto Bolt sequencing and the walking skeleton
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

This stage plans the Bolt sequence — the order in which Units of Work are executed through Construction. 2.7 produces the dependency DAG (topology); this stage (2.9) chooses a path through it. Economic value cannot be derived from the DAG — that's a human value judgment.

**Definitions for this stage:**
- **Bolt** — per `stage-protocol.md` Glossary: "a deployable unit of work within Construction — one pass through stages 3.1–3.7." A Bolt wraps one or more Units of Work and runs once through the Construction stages.

These definitions are for YOU. They are not written to be read out, and the user
has not seen them. Every one of them names something that is about to appear in
the questions you ask and the artifacts you write, so the first time a term
reaches the user it carries its own one-clause definition, in the sentence that
uses it rather than as a separate glossary. "Bolt" is the one that matters most,
because it is the vocabulary of the whole next phase: its first user-facing
mention reads as a Bolt plus what a Bolt is (one build pass over a piece of the
work, ending in something that runs), and later mentions read as just "Bolt".
Same treatment for a scoring model you propose by name and for the walking
skeleton. A term whose definition would not survive being compressed to a clause
is a term to replace with plain words instead.
- **Confidence hypothesis** — the observable behaviour that shipping the Bolt validates or falsifies (e.g., "latency stays under 200ms under 1k-rps load," "users complete signup without support tickets," "the event pipeline survives a 10x burst").
- **WSJF** (Reinertsen / SAFe) — Weighted Shortest Job First. Sequence score = (user-business value + time criticality + risk-reduction value) ÷ job size. Higher score ships first.
- **Walking skeleton** (Cockburn) — the first Bolt is a minimal end-to-end slice touching every architectural layer that proves the architecture works; features come in later Bolts.

Create `<record>/inception/delivery-planning/delivery-planning-questions.md` with questions. Strategic questions (one answer per project):

- What should we build first: the riskiest parts, the most valuable parts, a thin end-to-end slice that proves the whole thing hangs together, or some mix? If a mix, say which approach applies where.
- Should we score and rank the work with a formal model (WSJF-style: value and urgency against size)? If so, how much weight goes on risk, on value, and on size?
- How big should one Bolt be: a single Unit of Work, several related Units bundled together, or thin slices that cut across Units?
- Can several Bolts be built at the same time, or do they need to go one after another?
- Is anything outside this team going to hold us up (APIs, data, approvals, another team's hand-off)? For each one, capture who owns it, how long it takes, which Bolt it blocks, and what we do if it slips.
- What worries you most about this build, so we tackle it early?

Per-Bolt questions (the aidlc-delivery-agent loops these during artifact generation, one set of answers per Bolt in the plan):

- Which Units of Work does this Bolt bundle?
- Is this Bolt the thin end-to-end slice (the walking skeleton)? If yes, which parts of the architecture does it prove out?
- What has to be true for this Bolt to count as done?
- What will shipping this Bolt tell us that we do not know yet?
- Which mob owns this Bolt? (References teams from 1.5 when 1.5 ran; when 1.5 was SKIP — mvp, workshop — default to aidlc-developer-agent for all Bolts.)

NOTE: Bolt sequencing is economic, not topological. Bolt order may deviate from 2.7's topological order when a risk-first or walking-skeleton-first argument justifies it. The deviation must be captured in `risk-and-sequencing-rationale.md`.

NOTE: This stage plans the Bolt sequence. It does NOT decide which AIDLC stages to run or at what depth — that is handled by the `/aidlc` skill's scope selection.

Follow stage-protocol.md question flow.

### Step 4: Collect and Analyze Answers

Validate the chosen Bolt sequence respects 2.7's dependency DAG (with aidlc-architect-agent input). Flag any deviation from topological order so it can be justified in the rationale artifact.

### Step 5: Generate Artifacts

Create four artifacts in `<record>/inception/delivery-planning/`. These are
documents the user opens and reads at the gate, so the same rule the questions
follow applies to the prose inside them: a term of art carries a one-clause
definition at its first appearance in that file, and each file stands alone (the
reader may open `team-allocation.md` without having read `bolt-plan.md`). "Bolt",
"mob", "walking skeleton", "Program Board", and any scoring model named by
initials all qualify. Gloss and move on; do not restructure the artifact around
the explanation.

- `bolt-plan.md` — the ordered sequence of Bolts. Each Bolt entry: included Unit(s) of Work, walking-skeleton marker if applicable, Definition of Done for that Bolt, confidence hypothesis ("what will shipping this Bolt prove?"), expected demo.
- `team-allocation.md` — Bolt-to-mob assignment. References teams from 1.5 when 1.5 ran (enterprise, feature). When 1.5 is SKIP (mvp, workshop), states that all Bolts are executed by aidlc-developer-agent (AI). When team count > 1, this is the Program Board analog.
- `risk-and-sequencing-rationale.md` — the why behind the Bolt ordering: WSJF-style scoring, risk-first argument, walking-skeleton-first argument, or value-first argument. References the heuristic used (Cohn, Reinertsen CD3, or SAFe WSJF).
- `external-dependency-map.md` — gated items (external APIs, data availability windows, approval lead times, external-team hand-offs) mapped to the Bolts that consume them. Lightweight or empty when fully AI-contained.

### Step 6: Phase Boundary Verification

Run the Inception → Construction completeness audit. Read every
`traceability.json` produced by the Inception stages that executed:

- `<record>/inception/user-stories/traceability.json`
- `<record>/inception/domain-design/traceability.json`
- `<record>/inception/units-generation/traceability.json`

(Contract Design produces no `traceability.json` — it owns formal contracts,
not requirement coverage — so it does not contribute to this phase-boundary
check.) Confirm there are no unresolved findings, including `GAP`, `ORPHAN`, invalid
targets, or missing upstream IDs. Consolidate the tables into
`<record>/verification/phase-check-inception.md` with a pass/fail verdict at
the top. If any finding remains, stop the transition and revisit the owning
stage before Construction begins.

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage delivery-planning --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

**Construction iteration.** Classify how the approved `bolt-plan.md` wants the
per-unit construction stages (functional-design, nfr-requirements, nfr-design,
infrastructure-design, code-generation) to iterate over Units of Work. A
unit-at-a-time or walking-skeleton-first plan typically calls for designing AND
building one unit completely before the next unit begins — the first working
code lands after one unit's design, honoring a skeleton-first sequence; a plan
that reasons stage-by-stage across all units does not. Only when the plan calls
for the unit-first order, record it:
`bun .claude/tools/aidlc-state.ts set-construction-iteration unit-major`.
The default is `stage-major` (each design stage runs for every unit, then the
next stage, with code-generation last), needs no write, and is byte-identical
to prior behaviour. Under `unit-major` the same per-stage gates still fire, but
late and in a cascade at the end of the block (one human approval per stage),
and the autonomous Construction swarm never fires (the walk owns
code-generation serially, in Bolt build order), so opt in when the plan
justifies per-unit coherence and early working code over parallel batch
builds.

### Step 8: Present Completion & Request Approval

Completion emoji: :calendar:
Review path: `<record>/inception/delivery-planning/`
Approval gate: Approve (proceed to Construction) / Request Changes.

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/delivery-planning/`.

The imported sensors check those outputs:

- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `requirements`, `stories`, `mockups`, `components`, `unit-of-work`, `unit-of-work-dependency`, `unit-of-work-story-map`, `contract-summary`, `team-practices`).

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
