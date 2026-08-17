---
slug: pdlc-prototype-validation
number: 1.70
name: Prototype Validation
plugin: pdlc
phase: ideation
execution: CONDITIONAL
condition: Execute when prototypes were built and have been or can be put in front of someone whose opinion changes the decision. Skip when no prototype was built, and skip when the prototypes exist but nobody has seen them yet — a validation written from the builder's own impressions is a review of the code, not evidence about the idea; say which at the gate.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - pdlc-validation-results
  - pdlc-build-decision
  - pdlc-prototype-validation-questions
consumes:
  - artifact: pdlc-prototype-build-log
    required: true
  - artifact: pdlc-iteration-log
    required: false
  - artifact: pdlc-prototype-spec
    required: false
  - artifact: pdlc-prioritization-ranking
    required: false
requires_stage:
  - pdlc-prototype-build
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - pdlc-discovery
required_sections:
  - "Validation Method"
  - "Feedback by Prototype"
  - "Success Criteria Assessment"
  - "Findings"
  - "Decision"
  - "Winner"
  - "Not Chosen"
  - "Conditions & Next Steps"
  - "Assumptions & Open Questions"
inputs: pdlc-prototype-build-log from pdlc-prototype-build (required), plus pdlc-iteration-log, pdlc-prototype-spec, and pdlc-prioritization-ranking where present
outputs: pdlc-validation-results.md, pdlc-build-decision.md, pdlc-prototype-validation-questions.md (under this stage's record dir, engine-resolved)
---

# Prototype Validation

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

The prototypes exist to change somebody's mind, or to fail to. This stage records
what actually happened when people saw them, judges each prototype against the
success criterion its own spec set BEFORE it was built, and then makes the one
decision discovery exists to inform: build, do not build, build something else,
or go get more evidence.

Two failure modes to defend against, and they pull in opposite directions. The
first is treating enthusiasm as evidence — a demo is a persuasive medium, people
are polite, and "this is great" said in a room is not a commitment to use it. The
second is treating a single "no" as a verdict, when what was rejected may have
been the prototype's fake data or its unfinished screen rather than the idea.

The defence against both is the same: the criterion was written down first, the
feedback is recorded as what was said and observed rather than as a conclusion,
and the decision names what would change it.

More than one prototype may have been built. This stage compares them; it does
not assume there is one candidate to accept or reject. "None of the three" is a
legitimate and valuable outcome, and so is "two of them are the same product".

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

Read `pdlc-overconfidence-prevention.md` (why "users loved it" needs a source and
a count) and `pdlc-terminology.md` (PMF, and the Agentic/Application distinction
that changes what counts as validated) from that directory before writing
anything.

### Step 2: Load Prior Context

- Read `pdlc-prototype-build-log.md` from the `pdlc-prototype-build` record dir —
  required. It says what was built, what was faked, and what is known broken. What
  was faked is essential context for reading feedback: a complaint about response
  quality on the mock path is a complaint about canned text
- Read `pdlc-iteration-log.md` from the same dir where present. Its
  `## Outstanding Defects` list is the set of things a viewer may have reacted to
  that are not the idea
- Read each `PROTOTYPE-<slug>.md` where present — the success criterion was
  written there before the build, and this stage judges against that criterion,
  not against one invented now
- Read `pdlc-prioritization-ranking.md` where present. Where validation reverses
  the ranking, that is the single most valuable finding discovery can produce, and
  it must be stated as a reversal rather than quietly replacing the old order
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 3: Establish What Evidence Actually Exists

Before collecting feedback, settle what kind of evidence this is, because it caps
what the decision can claim:

- **Who saw it** — real users of the described kind, internal proxies,
  stakeholders, or nobody yet?
- **How many**, exactly? Three is three, not "several"
- **How they saw it** — driving it themselves, watching a walkthrough, or reading
  a description?
- **Whether they were told what was faked**
- **Whether anyone with the pain was in the room.** A prototype validated only by
  people who would fund it has been validated for fundability

Write the answers down. Every conclusion this stage reaches is bounded by them: a
prototype shown to two internal stakeholders can produce a decision, but not one
that claims users want it.

### Step 4: Ask the Validation Questions

Create `<record>/ideation/pdlc-prototype-validation/pdlc-prototype-validation-questions.md`.

Start the file with a `## Sources` register, using the same entry forms as the
other pdlc stages:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim product description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
- [artifact:pdlc-<name>] `<path to the upstream pdlc artifact>`
```

Then create consecutively numbered `## Q<n>.` questions. Cover:

**The evidence base** — every item in Step 3, asked explicitly, including the
count and whether anyone with the pain participated.

**Per prototype, what happened**

- What did the viewer DO first, without being told? Where they hesitated is the
  finding, not what they said about it afterwards
- What did they say, in their own words? Quote rather than summarise — a summary
  of feedback is already an interpretation
- What did they try that the prototype could not do?
- What did they ignore entirely? An ignored feature is a louder result than a
  criticised one
- Did they ask when they could have it, ask what it costs, or offer to be a pilot?
  Those are the only enthusiasm signals with any weight
- What did they misunderstand, and was the misunderstanding about the prototype
  or about the idea?

**Against the criterion**

- The spec said this prototype must demonstrate one thing and named an observable
  success criterion. Was it met — yes, no, or not tested?
- If not tested, what stopped it: a defect, the fake data, the audience, or time?

**Comparison across prototypes**

- Which one produced the strongest reaction, and was it the reaction the team
  hoped for?
- Did any two turn out to be the same product in the viewer's eyes?
- Did anything reverse the prioritization ranking?

**The decision**

- Build, do not build, build something else, or gather more evidence?
- If build: which one, and what does the first real version have to include that
  the prototype faked?
- If not: is the candidate dead, parked with a trigger, or blocked on something
  nameable?
- What would change this decision, and how would we know?

Every question MUST include an explicit `Not tested`, `Nobody said`,
`Not observed`, or `Not applicable` option — and use them freely. The most
common way this artifact goes wrong is filling a feedback field with what the
builder expected the viewer to feel. Use the [Answer]: tag format from
stage-protocol.md. Include A-E options with X (Other) as final option. Leave all
[Answer]: tags blank. Follow-up questions continue the same `Q<n>` numbering so
their source ids stay stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 5: Write the Validation Results

Apply this grounding contract to both artifacts this stage writes:

1. Permitted sources are `[desc]`, confirmed `[Q<n>]` answers, `[scope]`,
   registered `[memory:M<n>]` entries, and registered
   `[artifact:pdlc-<name>]` entries.
2. Every substantive claim block — paragraph, list item, or table data row —
   carries one or more inline source tags.
3. Never invent a participant, a quote, a count, a reaction, or a metric. Never
   upgrade "one person said" into "users said". Where nobody spoke to something,
   write `Not observed [assumption]` and leave it at that.
4. Separate OBSERVATION from INTERPRETATION everywhere. "Clicked Export three
   times, then stopped" is an observation; "found Export confusing" is an
   interpretation. Both belong here, labelled, never merged.
5. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Create `<record>/ideation/pdlc-prototype-validation/pdlc-validation-results.md`
with:

- A `## Summary` line — N prototypes validated, how many participants and of what
  kind, and how many spec criteria were met, not met, and not tested
- `## Validation Method` — everything Step 3 established: who saw it, how many,
  how, whether they were told what was faked, and whether anyone with the pain
  participated. State plainly what this evidence base cannot support
- `## Feedback by Prototype` — one `### <Candidate>` each, with Observed
  behaviour, Verbatim comments, What they tried that did not work, What they
  ignored, Enthusiasm signals (asked for it, asked the price, offered to pilot),
  and Misunderstandings with whether each was about the prototype or the idea
- `## Success Criteria Assessment` — a table: Candidate, the spec's observable
  criterion, Met / Not met / Not tested, and the evidence for that judgment. Where
  not tested, the reason
- `## Findings` — the conclusions that hold across prototypes, each traceable to
  observations above, including any reversal of the prioritization ranking and any
  two candidates that turned out to be one
- `## Assumptions & Open Questions`

### Step 6: Write the Build Decision

Create `<record>/ideation/pdlc-prototype-validation/pdlc-build-decision.md` with:

- `## Decision` — exactly one of **Build**, **Do not build**, **Build something
  else**, or **Gather more evidence** — with the reasoning in a short paragraph
  and the date. A decision that is really a deferral is written as
  `Gather more evidence` with what evidence, not as a soft `Build`
- `## Winner` — the selected candidate, why it beat the others on this evidence,
  and what the first real version must include that the prototype faked. Where
  the decision is not `Build`, write `None selected.` and say why
- `## Not Chosen` — every other candidate with its reason and its disposition:
  dead, parked with a named trigger, or blocked on something nameable. A candidate
  parked with no trigger is dead; say so rather than leaving a comforting maybe
- `## Conditions & Next Steps` — what has to be true for the decision to hold,
  what happens next, who owns it, and what would REVERSE the decision. Name the
  reversal condition even when the decision is enthusiastic; a decision no
  evidence could reverse was not made from evidence
- `## Assumptions & Open Questions`

State the decision's confidence honestly, in one line, keyed to the evidence base
in `## Validation Method`. Two internal viewers and one met criterion is a real
basis for a next step and a poor basis for a roadmap commitment, and the reader
of the handoff pack cannot tell the difference unless this file says.

### Step 7: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-prototype-validation --result awaiting-approval`.

### Step 8: Present Completion & Request Approval

Completion emoji: :white_check_mark:
Review path: this stage's engine-resolved record dir.
Present the evidence base in one line (who, how many, how), the criteria met and
not met per prototype, the decision with its confidence, and what would reverse
it. Name any ranking reversal explicitly. Then the standard 2-option approval
(Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. The imported
`required-sections` sensor checks that `pdlc-validation-results.md` carries the
`Validation Method`, `Feedback by Prototype`, `Success Criteria Assessment`,
`Findings`, and `Assumptions & Open Questions` headings, and that
`pdlc-build-decision.md` carries `Decision`, `Winner`, `Not Chosen`,
`Conditions & Next Steps`, and `Assumptions & Open Questions`.
`upstream-coverage` checks that the consumed `pdlc-prototype-build-log`,
`pdlc-iteration-log`, `pdlc-prototype-spec`, and `pdlc-prioritization-ranking`
were actually referenced rather than merely declared.

The `pdlc-evidence` sensor is deliberately NOT imported. Its target set is
`pdlc-prfaq.md` and `pdlc-prioritization-scoring.md`, and this stage writes
neither — importing it would report a pass over a file it never opened. The
observation-versus-interpretation rule in Step 5 is the discipline that matters
here, and no sensor can tell the two apart. This stage declares no reviewer
either, so that check belongs to the human at the gate: Step 8 presents the
evidence base first for exactly that reason.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
