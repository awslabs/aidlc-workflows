---
slug: intent-capture
phase: ideation
execution: ALWAYS
condition: First stage of every workflow — establishes the initiative's foundation
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-architect-agent
mode: inline
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
produces:
  - intent-statement
  - stakeholder-map
  - intent-capture-questions
consumes: []
requires_stage: []
sensors:
  - claim-sources
  - required-sections
  - upstream-coverage
scopes:
  - enterprise
  - feature
  - mvp
  - poc
inputs: User's project description ($ARGUMENTS), scope selection
outputs: intent-statement.md, stakeholder-map.md, intent-capture-questions.md (under this stage's record dir, engine-resolved)
---

# Intent Capture & Framing

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `.claude/knowledge/aidlc-product-agent/`.
Load aidlc-architect-agent persona from `agents/aidlc-architect-agent.md` for technical context perspective.

### Step 2: Load Prior Context

- Read user's project description from $ARGUMENTS or `<record>/audit/<host>-<clone>.md`
- Check for existing `<record>/` artifacts from prior sessions
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 3: Generate Clarifying Questions

Create `<record>/ideation/intent-capture/intent-capture-questions.md`.

Start the file with a `## Sources` register. Every source is a top-level
Markdown list item using exactly one of these forms:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim project description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
```

The sensor verifies `[desc]` and `[scope]` against `aidlc-state.md`. It resolves
each memory path against the active space's stage-loaded `org.md`, `team.md`, or
`project.md` and requires the quoted rule to exactly match a visible entry under
the named H2. Entries inside comments or code fences are not sources.

The register is the complete permitted-source universe for this stage. Do not
register background knowledge, common practice, or an inference as a source.

Then create consecutively numbered `## Q<n>.` questions covering:
- What business problem are we solving?
- Who is the customer (internal/external)? What pain are they experiencing?
- What does success look like? What metrics matter?
- What is the trigger for this initiative (market pressure, tech debt, regulation, opportunity)?
- Who are the key stakeholders and what does each care about?
- Who decides scope or priority, and who influences those decisions?
- Are there communication requirements or a reporting cadence?
- The workflow was started with the scope in `[scope]`; does that scope match
  the user's intended product boundary?

Every question MUST include an explicit `Not yet defined`, `None`,
`Not identified`, or `Not applicable` option as appropriate so a narrow intent
never forces the user to select invented detail.
The scope question MUST distinguish confirming the workflow-selected scope
from defining a different product boundary. Use the [Answer]: tag format from
stage-protocol.md. Include A-E options with X (Other) as final option. Leave
all [Answer]: tags blank. Follow-up questions continue the same `Q<n>`
numbering so their source ids remain stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 4: Collect and Analyze Answers

After all answers collected:
1. Confirm ALL [Answer]: tags are filled in
2. Run ambiguity detection and contradiction analysis
3. Create follow-up questions if needed

### Step 5: Generate Artifacts

Apply this grounding contract to both artifacts:

1. Permitted sources are only `[desc]`, confirmed `[Q<n>]` answers (including
   follow-ups), `[scope]`, and registered `[memory:M<n>]` entries.
2. Every substantive claim block — a paragraph, list item, or table data row —
   MUST carry one or more inline source tags.
3. `[scope]` proves only workflow-selected scope. Label it
   `workflow-selected`; use the scope-confirmation question's `[Q<n>]` tag for
   any user-confirmed product boundary.
4. Never turn an unselected option into an exclusion or requirement.
5. Unsupported content is omitted or elicited with a follow-up. If it is
   useful to preserve but cannot be confirmed, put it only under
   `## Assumptions & Open Questions` and tag each entry `[assumption]`.
6. Each artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Create `<record>/ideation/intent-capture/intent-statement.md` containing:
- **Problem Statement** — What business problem is being solved
- **Target Customer** — Who benefits and how
- **Success Metrics** — Measurable outcomes
- **Initiative Trigger** — Why now
- **Initial Scope Signal** — Show the workflow-selected scope separately from
  the user-confirmed product boundary

Create `<record>/ideation/intent-capture/stakeholder-map.md` containing:
- Key stakeholders and their interests
- Decision-makers vs. influencers
- Communication requirements

Every stakeholder and communication row carries its source tag in a `Source`
column. Never invent a stakeholder role, interest, authority, or communication
requirement. For required but unresolved fields, write
`Unknown (open question) [assumption]`; omit optional fields.

### Step 6: Resolve Assumptions

If both `## Assumptions & Open Questions` sections contain `None.`, continue.
Otherwise:

1. Append or reset `## Assumption Confirmation` in
   `intent-capture-questions.md`, listing every assumption and these options:
   `A. Accept assumptions` and `B. Convert to follow-up questions`, followed
   by a blank `[Answer]:`.
2. Present those two options as a structured question, log it through the
   standard question decision/answer pair, END YOUR TURN, and wait.
3. On `Accept assumptions`, fill the confirmation answer exactly as
   `[Answer]: A. Accept assumptions` and retain the `[assumption]` labels.
   Acceptance does not turn an assumption into fact.
4. On `Convert to follow-up questions`, fill that answer, append consecutively
   numbered `Q<n>` follow-ups, collect and confirm their answers, revise both
   artifacts, reset `## Assumption Confirmation`, and repeat this step if any
   assumptions remain.

Do not invoke the reviewer or proceed to completion while an assumption
confirmation `[Answer]:` is blank.

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`bun .claude/tools/aidlc-orchestrate.ts report --stage intent-capture --result <outcome>`.
The engine owns all lifecycle transitions and advancement.

### Step 8: Present Completion & Request Approval

Use stage-protocol.md completion template with completion emoji: :bulb:
- Summary of intent statement and stakeholder map
- Review path: `<record>/ideation/intent-capture/`
- Standard approval gate (Approve / Request Changes)

## Sensors

This stage's outputs are markdown artefacts under `<record>/ideation/intent-capture/`.

The imported sensors check those outputs:

- **`claim-sources`** verifies every claim block has a resolvable source tag,
  source-register values match state and the three stage-loaded active-memory
  files, each artifact has `## Assumptions & Open Questions`, and retained
  assumptions exactly match a completed human confirmation. It validates
  structure and source resolution, not whether a source semantically entails
  the claim.
- **`required-sections`** verifies the output contains the registry default (≥2 H2 headings). Failure mode: missing headings emit `SENSOR_FAILED` with detail at `<record>/.aidlc-sensors/<stage-slug>/required-sections-<iso>.md`.
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
