---
slug: discovery-current-state
phase: ideation
execution: ALWAYS
condition: Builds the evidenced as-is picture the framing decision rests on
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-design-agent
  - aidlc-architect-agent
mode: inline
produces:
  - current-state
  - design-language-record
consumes:
  - artifact: intent-statement
    required: true
  - artifact: open-questions-record
    required: true
  - artifact: source-inventory
    required: false
requires_stage:
  - intent-capture
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - discovery
inputs: Intent statement, open questions record, source inventory (if exists), supplied materials
outputs: current-state.md, design-language-record.md (under this stage's record dir, engine-resolved)
---

# Discovery Current State

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

This stage works the open questions in any order, because this knowledge has
no reliable internal order: mine the supplied code and materials, capture the
design language, audit the standards, research the market, map the users and
their journeys. What governs is the evidence order, not a sequence. The agent
works alone first — mining supplied assets, desk research, standards checks.
Targeted questions to the person come second. The outside world comes third,
and only with a prepared ask that states what the first two sources
established and exactly what remains unanswered.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `.claude/knowledge/aidlc-product-agent/`.
Load aidlc-design-agent persona from `agents/aidlc-design-agent.md` for the design language capture.
Load aidlc-architect-agent persona from `agents/aidlc-architect-agent.md` for code mining and standards perspective.

### Step 2: Load Prior Context

- Read the intent statement and open questions record from `<record>/ideation/intent-capture/`
- Read the source inventory from `<record>/ideation/intent-capture/source-inventory.md` (if exists — a leaner composition may skip its producer; in that case work directly from whatever materials the person supplies and note the missing inventory in the current-state picture's source list)
- Check for existing `<record>/` artifacts from prior sessions
- Load guardrails from `.claude/rules/`

### Step 3: Work the Open Questions

Work the open entries in whatever order the materials make cheap, honoring
the evidence order above. Write every answer into the open questions record
with its source and a confidence grade. An answer derived from materials is
marked `unconfirmed` until the person validates it at this stage's playback
gate. When an answer changes, every entry that depends on it reopens — record
the reopening rather than silently overwriting. Ask the person ONLY what the
materials and research could not answer, using the [Answer]: tag format from
stage-protocol.md with the unified question flow (Guide Me / Edit File /
Chat).

### Step 4: Capture the Design Language Record

Create or extend `<record>/ideation/discovery-current-state/design-language-record.md` with five parts (matching the framework template's sections):

- **Component inventory** — every recurring interface component as the product names it, with variants, states, and source references
- **Design tokens** — the typed visual values named by role, kept machine-readable so a generated mock-up can be checked against them deterministically
- **UX patterns and principles** — navigation model, layout, feedback, error handling, voice — each stated only when observed on more than one screen or attested in a guideline
- **Source registry** — every source consulted, what it yielded, and conflicts with how each was resolved
- **Gaps** — what remains unknown or unconfirmed, kept as its own section so a reader sees the record's edges at a glance

Sourcing follows a fixed order: ask the team what exists and pull everything
provided, mine the application and the codebase for the rest (real values from
the style layer, real component usage from the code), and record what remains
as open questions rather than guessing. Nothing in the record is invented;
every value carries its provenance.

The record is one per product or brand and persists beyond this initiative.
If one already exists for this product, check its freshness and extend it
instead of capturing from scratch.

### Step 5: Assemble the As-Is Picture

Create `<record>/ideation/discovery-current-state/current-state.md`: the as-is
picture as a service blueprint, workflow diagram, or system diagram —
whichever fits the domain — grounded in the answered open questions and
carrying their sources. Diagrams follow ASCII diagram standards from
stage-protocol.md.

### Step 6: Update State

Update `<record>/aidlc-state.md`:
- Mark discovery-current-state as `[x]` completed
- Update current stage and next stage

### Step 7: Present Completion & Request Approval — the Playback Gate

Use stage-protocol.md completion template with completion emoji: :mag:
- Present the as-is picture; the person confirms it or corrects it
- Summary: what the materials answered, what the person answered, what stayed open, and every answer still marked `unconfirmed`
- Review path: `<record>/ideation/discovery-current-state/`
- Standard approval gate (Approve / Request Changes): Approve confirms the picture; Request Changes corrects it with feedback

This gate's job, stated plainly: catch a wrong current-state picture before
anything is built on top of it. It is also where answers derived from
materials — held as `unconfirmed` until now — are confirmed or corrected by
the person.

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/discovery-current-state/`.
Sensor results do not print to the terminal on pass or fail — outcomes land
as `SENSOR_PASSED` / `SENSOR_FAILED` events in the audit shard under
`<record>/audit/`, and failure findings land under
`<record>/.aidlc-sensors/discovery-current-state/`.

The imported sensors check those outputs:

- **`required-sections`** verifies each output against its resolved template's H2 set (the framework default templates ship for `current-state` and `design-language-record`), falling back to the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
- **`upstream-coverage`** verifies the output prose references each artefact declared in this stage's `consumes:` frontmatter. Failure mode: missing upstream references emit `SENSOR_FAILED` listing each unreferenced artefact (this stage consumes `intent-statement`, `open-questions-record`, and `source-inventory`; only those present on disk are checked).

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
