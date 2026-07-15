---
slug: intent-capture
phase: ideation
execution: ALWAYS
condition: First stage of every workflow — establishes the initiative's foundation
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-architect-agent
mode: inline
produces:
  - intent-statement
  - stakeholder-map
  - intent-capture-questions
  - source-inventory
  - open-questions-record
consumes: []
requires_stage: []
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - poc
  - discovery
inputs: User's project description or the asks they point at ($ARGUMENTS), supplied materials, scope selection
outputs: intent-statement.md, stakeholder-map.md, intent-capture-questions.md, source-inventory.md, open-questions-record.md (under this stage's record dir, engine-resolved)
---

# Intent Capture & Framing

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Starting an initiative is a human act. The person describes what to build, or
points at one or more asks — a stakeholder request, a hunch, a support theme, a
mandate — in whatever form they exist in the team's tools. This stage works
from what the person brings before it asks anything: supplied materials answer
questions first, and the questionnaire covers only what remains. It never
solicits ideas and adds no submission channel — the team's asks live in the
team's tools, and this stage consumes what the person brings.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.
Load aidlc-architect-agent persona from `agents/aidlc-architect-agent.md` for technical context perspective.

### Step 2: Load Prior Context

- Read user's project description from $ARGUMENTS or `<record>/audit/<host>-<clone>.md`
- Check for existing `<record>/` artifacts from prior sessions
- Load guardrails from `{{HARNESS_DIR}}/rules/`

### Step 3: Collect the Asks and Materials

The description in $ARGUMENTS may be the whole input, or the person may have
more. Create `<record>/ideation/intent-capture/intent-capture-questions.md`
(the stage's questions file) and open it with one multi-select intake
question, using the [Answer]: tag format from stage-protocol.md with a blank
tag:

> Beyond the description, does this initiative start from anything you can
> point at, or anything already fixed? (select all that apply)
> A. Asks I can paste or point at (tickets, exports, notes, links — whatever form they exist in)
> B. Supporting materials (process documents, prior analyses, data extracts, a reachable running product, a design system or brand guidelines)
> C. A mandate — something already decided elsewhere that this must honor
> D. A decide-by date (a steering meeting, a contract renewal, a budget cycle)
> E. None of these — the description is the whole input
> X. Other (please specify)

Follow the unified question flow from stage-protocol.md section 3. Gather the
selected items through follow-up questions written into the same questions
file, each with a blank [Answer]: tag, before ending any turn that waits on
the person. Record declines as declines; never nag. When E is the answer,
skip ahead after recording the empty inventory in Step 4 — the questionnaire
path is unchanged.

When the person brings asks or materials: before drafting anything, add one
follow-up question asking for their own reading — what they believe the asks
amount to and what matters most — and record the answer verbatim. Give this
question no A-E options (only the mandatory X), so the agent suggests no
candidate readings. The agent's synthesis comes after and never before, so
the person's thinking sets the starting point.

### Step 4: Generate the Source Inventory

Create `<record>/ideation/intent-capture/source-inventory.md`: one row per
supplied material — what it is, where it lives, and which questions it looks
likely to answer. When nothing was supplied, record "None" — the empty
inventory is itself a fact the record keeps. When materials WERE supplied,
suggest, once, what else would typically complement them ("a process this
size usually has an SOP — can you share it?"), as a follow-up question in the
questions file with a blank [Answer]: tag; record declines under "Suggested
but not supplied", and note anything no supplied or pending material covers
under "Gaps". When the person declined at Step 3, suggest nothing.

### Step 5: Generate Clarifying Questions

Append to `<record>/ideation/intent-capture/intent-capture-questions.md` the
stage's clarifying questions:
- What business problem are we solving?
- Who is the customer (internal/external)? What pain are they experiencing?
- What does success look like? What metrics matter?
- What is the trigger for this initiative (market pressure, tech debt, regulation, opportunity)?

Before appending, check the asks and supplied materials for answers. Where a
material answers a question, do NOT ask it: write the answer into the open
questions record (Step 7) with its source named and status `unconfirmed`, for
the person to confirm or correct at this stage's approval gate rather than
re-typing what their documents already say. Append only the questions that
remain unanswered. With no materials supplied, every question is appended,
exactly as before.

Use the [Answer]: tag format from stage-protocol.md. Include A-E options with X (Other) as final option. Leave all [Answer]: tags blank.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 6: Collect and Analyze Answers

After all answers collected:
1. Confirm ALL [Answer]: tags are filled in
2. Run ambiguity detection and contradiction analysis
3. Create follow-up questions if needed

Every answer keeps its source label: the person's answers stay in the
questions file, and material-derived answers live in the open questions
record with their source, marked `unconfirmed` until the gate. If the asks or
materials contradict the chosen scope materially (this is really a bugfix, a
committed build, not what the scope assumes), say so plainly and offer the
framework's own paths — the composer (`/aidlc compose`) to reshape the
workflow, or a restart under the right scope — rather than proceeding
silently.

### Step 7: Generate Artifacts

Create `<record>/ideation/intent-capture/intent-statement.md` containing:
- **Problem Statement** — What business problem is being solved
- **Target Customer** — Who benefits and how
- **Success Metrics** — Measurable outcomes
- **Initiative Trigger** — Why now
- **Initial Scope Signal** — Early indication of scope (enterprise, feature, mvp, poc, discovery, etc.)

When the person brought asks, add:
- **Where This Came From** — one row per ask: who asked, how often, what they
  said (verbatim where short), and the source. The owner's reading from
  Step 3, verbatim. Several asks can feed one initiative; an ask that turns
  out to contain two problems is split into two rows and noted.

When a mandate or a decide-by date exists, add:
- **Already Decided** — any mandate: what is already decided, by whom, and
  where that was recorded, so later choices present as genuinely open or
  pre-closed, never staged.
- **Decide-By Date** — the date and what it is anchored to. Absent is fine.

One section of this artifact is written later, by another stage: on a
discovery run that commits, the decision stage adds a **What Discovery
Validated** section (the chosen framing, the recorded exclusions, a pointer
to the decision pack) so the statement delivery reads reflects what was
validated, not the day-one guess. This stage never writes that section.

Create `<record>/ideation/intent-capture/stakeholder-map.md` containing:
- Key stakeholders and their interests
- Decision-makers vs. influencers
- Communication requirements

Create `<record>/ideation/intent-capture/open-questions-record.md`. Seed it
from three places, in order:

1. Each ask's framing questions — is this real, who needs it, what would it
   take — with any answers the asks already contain, their sources and
   confidence
2. Answers found in the supplied materials (mark each `unconfirmed` until a
   person validates it at a gate)
3. This stage's own clarifying questions with the answers collected above

Each entry carries: id (`OQ-<n>`), the question, the decision its answer
informs, origin (starter, derived, raised, user), status (open, answered,
deferred, reopened), depends-on ids, and the answer with source and confidence
where one exists. With nothing supplied beyond the description, the record
holds the clarifying questions and the person's answers — the same knowledge
the stage always captured, now in a form later stages can consume.

### Step 8: Update State

Update `<record>/aidlc-state.md`:
- Mark intent-capture as `[x]` completed
- Update current stage and next stage

### Step 9: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :bulb:
- Summary of intent statement and stakeholder map; where asks or materials
  were supplied, also the owner's reading, what the materials already
  answered, what remains open, and any mandate or decide-by date
- List every `unconfirmed` material-derived answer from the open questions
  record in the summary: this gate is where the person confirms or corrects
  them. Approve confirms them as read; Request Changes corrects them with
  feedback
- Review path: `<record>/ideation/intent-capture/`
- Standard approval gate (Approve / Request Changes)

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/intent-capture/`.
Sensor results do not print to the terminal on pass or fail — outcomes land
as `SENSOR_PASSED` / `SENSOR_FAILED` events in the audit shard under
`<record>/audit/`, and failure findings land under
`<record>/.aidlc-sensors/intent-capture/`.

The imported sensors check those outputs:

- **`required-sections`** verifies each output against its resolved template's H2 set where a framework default template ships (`source-inventory`, `open-questions-record`), falling back to the registry default (≥2 H2 headings) for the rest (`intent-statement` deliberately ships no template — its conditional sections must never become required headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. This stage declares no upstream artefacts; the sensor still runs but reports zero unreferenced inputs by default.

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

- Prescriptive rule → `{{HARNESS_DIR}}/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `{{HARNESS_DIR}}/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `{{HARNESS_DIR}}/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
