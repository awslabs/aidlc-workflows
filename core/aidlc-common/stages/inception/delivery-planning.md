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
  - classic
  - workshop
inputs: All Inception artifacts (requirements, stories, mockups, architecture, units)
outputs: bolt-plan.md, team-allocation.md, risk-and-sequencing-rationale.md, external-dependency-map.md, delivery-planning-questions.md (under this stage's record dir, engine-resolved)
---

# Delivery Planning

## Steps

### Step 1: Load Prior Context

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

### Step 2: Generate Clarifying Questions

This stage plans the Bolt sequence — the order in which Units of Work are executed through Construction. 2.7 produces the dependency DAG (topology); this stage (2.9) chooses a path through it. Economic value cannot be derived from the DAG — that's a human value judgment.

**Definitions for this stage:**
- **Bolt** — per `stage-protocol.md` Glossary: the planned Construction delivery slice from this stage (2.9): one or more Units with a Definition of Done, a confidence hypothesis, and ownership. The engine does not consume `bolt-plan.md` for Unit grouping or walk order; runtime batches come from `unit-of-work-dependency.md`. A **Batch** is the group of Units that build concurrently (runtime; from that 2.7 artifact).

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
- **Walking skeleton** (Cockburn) — the first DAG Unit delivers the smallest working end-to-end slice through the relevant integration points. Its applicable design stages and Code Generation finish before later Units; a real integrated check and human checkpoint approval demonstrate the result.

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
- Which mob owns this Bolt? (References teams from 1.5 when 1.5 ran; when 1.5 was SKIP — mvp, classic — default to aidlc-developer-agent for all Bolts.)

NOTE: Bolt sequencing records the economic rationale, while the engine consumes
the actual Unit DAG and iteration choice. When skeleton-on applies, confirm that
the first resolved DAG Unit is the smallest working integrated slice, name its
expected demo and the real project check that will prove it end to end, and make
its prerequisites explicit. If the decomposition cannot support that slice,
revisit Units Generation before Construction. Reordering only `bolt-plan.md`
does not change the Unit the engine builds first; never describe the first
design-stage review as a shipped skeleton.

NOTE: This stage plans the Bolt sequence. It does NOT decide which AIDLC stages to run or at what depth — that is handled by the `/aidlc` skill's scope selection.

Follow stage-protocol.md question flow.

### Step 3: Collect and Analyze Answers

Validate the chosen Bolt sequence respects 2.7's dependency DAG (with aidlc-architect-agent input). Flag any deviation from topological order so it can be justified in the rationale artifact.

### Step 4: Generate Artifacts

Create four artifacts in `<record>/inception/delivery-planning/`. These are
documents the user opens and reads at the gate, so the same rule the questions
follow applies to the prose inside them: a term of art carries a one-clause
definition at its first appearance in that file, and each file stands alone (the
reader may open `team-allocation.md` without having read `bolt-plan.md`). "Bolt",
"mob", "walking skeleton", "Program Board", and any scoring model named by
initials all qualify. Gloss and move on; do not restructure the artifact around
the explanation.

- `bolt-plan.md` — the ordered sequence of Bolts. Each Bolt entry: included Unit(s) of Work, walking-skeleton marker if applicable, Definition of Done for that Bolt, confidence hypothesis ("what will shipping this Bolt prove?"), expected demo.
- `team-allocation.md` — Bolt-to-mob assignment. References teams from 1.5 when 1.5 ran (enterprise, feature). When 1.5 is SKIP (mvp, classic), states that all Bolts are executed by aidlc-developer-agent (AI). When team count > 1, this is the Program Board analog.
- `risk-and-sequencing-rationale.md` — the why behind the Bolt ordering: WSJF-style scoring, risk-first argument, walking-skeleton-first argument, or value-first argument. References the heuristic used (Cohn, Reinertsen CD3, or SAFe WSJF).
- `external-dependency-map.md` — gated items (external APIs, data availability windows, approval lead times, external-team hand-offs) mapped to the Bolts that consume them. Lightweight or empty when fully AI-contained.

### Step 5: Phase Boundary Verification

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

### Step 6: Completion Handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage delivery-planning --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never perform one in prose, and never narrate this bookkeeping to the user.

**Construction iteration.** Read the recorded choice before recommending a
change. New workflows start with `Construction Checkpoints: enabled` and
`Construction Iteration: unit-major` with `Construction Execution: serial`:
each Unit's applicable design stages and Code Generation run serially, followed
by its verified completion checkpoint.
An explicit stage-major choice remains valid. To enable later Code Generation
batches, obtain the human's execution choice, set iteration to stage-major, then
run `{{INVOKE}} engine state set-construction-execution swarm`. This works with
either gated or autonomous completion approval; the autonomy answer never changes
execution order. Unit-major stays serial and refuses a contradictory swarm
setting; select serial before returning to unit-major. For checkpoint-enabled work,
skeleton-on always completes the first DAG Unit's full integrated slice before
later Units, under either iteration order.

Preserve an existing explicit choice. If the human approves changing iteration,
record it with `{{INVOKE}} engine state set-construction-iteration <unit-major|stage-major>`.
Do not silently migrate a legacy workflow: without the checkpoint field it keeps
its prior first-stage review and late stage-gate cascade. Team-owned work keeps
its own per-stage or unit-end `unit_gate` policy. Plan Approval and summary
confirmation remain required under either order and autonomy choice.

**Construction staffing.** After classifying iteration, ask:

> "How do you want to staff Construction? I can run the work from this session
> using the execution settings you chose, or each of your teams can own a Unit
> and approve its work independently."

The several-teams choice requires the unit-first order above. If the plan is not
already unit-major, explain that prerequisite and confirm switching. For an
explicit swarm setting, first record
`{{INVOKE}} engine state set-construction-execution serial`, then record
`bun {{HARNESS_DIR}}/tools/aidlc-state.ts set-construction-iteration unit-major`,
then
`bun {{HARNESS_DIR}}/tools/aidlc-state.ts set-unit-ownership team`. Team ownership
requires the workspace root itself to be the source Git repository; intents with
recorded sibling repos must remain solo.
For the one-session choice, leave the field absent (the byte-identical default)
or record `set-unit-ownership solo`.

**Team check-in rhythm.** Only after team ownership is selected, ask:

> "While a team builds their unit, how often should I check in for approval?
> After each stage is the safer default: a wrong turn is caught before the next
> stage builds on it. Once at the end means fewer interruptions: one review
> after the unit's design and code are complete."

Record the answer with
`bun {{HARNESS_DIR}}/tools/aidlc-state.ts set-unit-gate-rhythm per-stage` or
`... unit-end`. If the field is absent under team ownership, `per-stage` is the
default. These names are tool vocabulary; present the plain-language choices,
not the field or enum names.

### Step 7: Present Completion & Request Approval

Completion emoji: :calendar:
Review path: `<record>/inception/delivery-planning/`
Approval gate: Approve (proceed to Construction) / Request Changes.

## Sensors

This stage's outputs are markdown artefacts under `<record>/inception/delivery-planning/`.

Imports: `required-sections`, `upstream-coverage`.

Upstream targets: `requirements`, `stories`, `mockups`, `components`, `unit-of-work`, `unit-of-work-dependency`, `unit-of-work-story-map`, `contract-summary`, `team-practices`.

## Learn

Follow stage-protocol.md §13: maintain `<record>/<phase>/<stage>/memory.md`
under the four standard headings while working; before the approval gate,
surface candidates with `aidlc-learnings.ts`;
still ask the mandatory "Anything to add for next time?" question, and persist confirmed selections
with the tool. The memory file stays in the artefact directory, and the stage
file remains immutable.
