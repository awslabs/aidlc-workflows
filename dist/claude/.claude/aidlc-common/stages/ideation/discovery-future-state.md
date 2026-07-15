---
slug: discovery-future-state
phase: ideation
execution: ALWAYS
condition: Chooses the problem framing and expresses the future state as testable options
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-design-agent
  - aidlc-architect-agent
mode: inline
produces:
  - future-state
  - assumptions-record
consumes:
  - artifact: current-state
    required: true
  - artifact: open-questions-record
    required: true
  - artifact: intent-statement
    required: true
  - artifact: design-language-record
    required: false
requires_stage:
  - discovery-current-state
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - discovery
inputs: Current state, open questions record, intent statement, design language record (if exists)
outputs: future-state.md, assumptions-record.md (under this stage's record dir, engine-resolved)
---

# Discovery Future State

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Two human decisions live in this stage: the framing — which problem the
initiative attacks — and the concept selection — which options proceed to
testing. The framing is the highest-leverage decision in the phase, because a
wrong framing wastes everything downstream.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `.claude/knowledge/aidlc-product-agent/`.
Load aidlc-design-agent persona from `agents/aidlc-design-agent.md` for the visual expression of options.
Load aidlc-architect-agent persona from `agents/aidlc-architect-agent.md` for feasibility perspective.

### Step 2: Load Prior Context

- Read the as-is picture from `<record>/ideation/discovery-current-state/current-state.md`
- Read the intent statement and open questions record from `<record>/ideation/intent-capture/`
- Read the design language record from `<record>/ideation/discovery-current-state/design-language-record.md` (if exists — a leaner composition may skip its capture; in that case express options in plain visual form and note that reactions may attach to the unfamiliar skin rather than to the idea)
- Load guardrails from `.claude/rules/`

### Step 3: Choose the Framing

Before showing any candidates, ask the person for their own reading of the
evidence, so the agent's material extends their thinking instead of replacing
its starting point.

Then generate a minimum of three candidate framings, each stated as who is
struggling, with what, toward what outcome. Structural distinctness is
produced by process, not expected from the model: build each candidate from a
structurally different starting point — a different struggling user, a
different constraint, a different business outcome. A candidate too similar to
one already offered does not count toward the minimum.

Present the candidates together with the strongest case AGAINST whichever
framing the evidence currently favors, so the leading option arrives already
challenged. Where the intent statement's record of what is already decided
shows part of the choice was made elsewhere, present pre-closed choices as
pre-closed and spend the person's judgment on what is genuinely open.

The person chooses through the structured question flow from
stage-protocol.md — this is a mid-stage decision through the questions
protocol, not this stage's exit gate. Record the chosen framing and WHICH
open-questions answers it rests on: the reframe trigger in experimentation
reads exactly that list when a test invalidates one of those answers.

### Step 4: Generate the Future-State Options

Create `<record>/ideation/discovery-future-state/future-state.md`: three to
five future-state options for the chosen framing. Each option is expressed
visually — a mock-up, storyboard, or diagram — in the captured design language
where the record exists, so reactions attach to the idea rather than to a
foreign skin. Each option lists its implied assumptions: the claims it only
works if true.

### Step 5: Write the Assumptions Record

Create `<record>/ideation/discovery-future-state/assumptions-record.md`. Each entry carries:

- **id** — `AS-<n>`
- **claim** — the statement that must be true
- **type** — desirability (do they want it), usability (can they use it), feasibility (can we build and run it), or viability (should we, given cost, legal exposure and the business case)
- **origin** — concept-implied, moved from the open questions, team-stated, or model-suggested; model-suggested entries are permanently marked as such
- **rests-on** — the open-questions entries and artifacts the claim depends on
- **disproved-if** — the observable condition that would refute it, mandatory and written before anything runs: a claim without a refutation condition is an opinion
- **test** — blank until experimentation composes one
- **status**, **evidence**, **disposition** — open until testing fills them

A question moves here from the open questions record exactly when two things
are true at once: a recorded decision changes if the answer changes, AND
neither the supplied materials, nor research, nor asking a person can settle
it. Questions that are merely hard to research stay put.

Rank the entries riskiest first: importance to the decision multiplied by how
weak the current evidence is. Flag at this stage's gate if a product-facing
record has no desirability or usability entries, because a plan that only
tests what is cheap to test lets a buildable but unwanted or unusable idea
through.

### Step 6: Choose the Concepts

The concept selection is a mid-stage structured question per stage-protocol.md
§3, before the exit gate. Present the options with the agent's recommendation
and each option's implied assumptions laid out. The person chooses which
options proceed to testing, and model-suggested assumptions are confirmed,
corrected, or discarded here. Write the selection, who made it, and when into
the future-state artifact's **Concept decision** section, and update the
assumptions record so only assumptions belonging to selected options remain
open.

### Step 7: Update State

Update `<record>/aidlc-state.md`:
- Mark discovery-future-state as `[x]` completed
- Update current stage and next stage

### Step 8: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :art:
- Summary: the chosen framing, the options generated, the recorded concept decision, and the riskiest assumptions now open
- Review path: `<record>/ideation/discovery-future-state/`
- Standard approval gate (Approve / Request Changes) — approval ratifies the recorded selections

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/discovery-future-state/`.
Sensor results do not print to the terminal on pass or fail — outcomes land
as `SENSOR_PASSED` / `SENSOR_FAILED` events in the audit shard under
`<record>/audit/`, and failure findings land under
`<record>/.aidlc-sensors/discovery-future-state/`.

The imported sensors check those outputs:

- **`required-sections`** verifies each output against its resolved template's H2 set (the framework default templates ship for `future-state` and `assumptions-record`), falling back to the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `current-state`, `open-questions-record`, `intent-statement`, and `design-language-record`; only those present on disk are checked).

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

- Prescriptive rule → `.claude/rules/aidlc-phase-<phase>.md` (phase-scoped)
  or `.claude/rules/aidlc-<org|team|project>.md` (cross-cutting)
- Verification check → new manifest at `.claude/sensors/aidlc-<id>.md`
  (capability descriptor only — no `applies_to`); add the new id to
  the relevant stage's `sensors: [...]` frontmatter list to wire it

If nothing surfaces or the user skips all, proceed to the gate. The memory.md
file stays in the artefact directory as part of the stage's permanent record.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file. Next time this stage runs, the new rules and
sensors load automatically.
