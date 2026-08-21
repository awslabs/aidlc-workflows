---
slug: pdlc-prioritization
number: 1.40
name: Use Case Prioritization
plugin: pdlc
phase: ideation
execution: CONDITIONAL
condition: Execute when the candidate set holds more than one entry — intake's use cases, solution analysis's derived candidates, or both. Skip when there is exactly one candidate, which is trivially its own top pick, and say so at the gate rather than scoring a set of one.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - pdlc-prioritization-scoring
  - pdlc-prioritization-ranking
  - pdlc-prioritization-questions
consumes:
  - artifact: pdlc-use-cases
    required: true
  - artifact: pdlc-identified-solutions
    required: false
requires_stage:
  - pdlc-use-case-intake
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
review_class: advisory
sensors:
  - required-sections
  - upstream-coverage
  - pdlc-evidence
scopes:
  - pdlc-discovery
required_sections:
  - "Agentic Scoring"
  - "Application Scoring"
  - "Ranking"
  - "Top Selection"
  - "Assumptions & Open Questions"
inputs: pdlc-use-cases from pdlc-use-case-intake (required), pdlc-identified-solutions from pdlc-solution-analysis where it ran
outputs: pdlc-prioritization-scoring.md, pdlc-prioritization-ranking.md, pdlc-prioritization-questions.md (under this stage's record dir, engine-resolved)
---

# Use Case Prioritization

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

This is where discovery commits. Everything upstream widened the option set;
this stage narrows it, on the record, against criteria stated before the scores
were known.

Two scoring frameworks live here, not one, because Agentic and Application
candidates fail for different reasons. An Application candidate fails when the
data is not there or nobody uses it. An Agentic candidate fails when nobody can
tell whether a run was good, or when being wrong is expensive and irreversible.
Scoring both on one sheet of criteria makes the wrong risks invisible for
whichever class is in the minority. The class comes from upstream —
`pdlc-use-case-intake` classified the use cases and `pdlc-solution-analysis`
classified its derived candidates — and the discriminator is control flow, not
model usage: "calls an LLM" is Application, "chooses what to do next" is
Agentic.

A weighted score is an argument written as a number. Its worth is entirely in
the rationale beside it: a 7 with a reason can be disagreed with, and a 7 without
one cannot even be checked. So every criterion carries its own rationale, every
rationale carries a source tag, and the `pdlc-evidence` sensor checks both.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

Read `pdlc-prioritization-frameworks.md` (the two frameworks, their criteria,
their weights, and what each score band means),
`pdlc-overconfidence-prevention.md` (why a score with no basis must say so), and
`pdlc-terminology.md` from that directory before scoring anything.

### Step 2: Load Prior Context

- Read `pdlc-use-cases.md` from the `pdlc-use-case-intake` record dir —
  required. It is the candidate register and it carries each candidate's class
- Read `pdlc-identified-solutions.md` from the `pdlc-solution-analysis` record
  dir where present, and merge its candidates into the same set. A run that came
  through Path A scores solutions; a run that came through Path B scores use
  cases; a run that did both scores the union, once, with duplicates collapsed
- Read `pdlc-prfaq.md` where present — its Internal FAQ names the constraints
  that bound several criteria
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

Count the candidates. If exactly one survives, do not score it: report at the
gate that the set is trivially its own top pick and that scoring one candidate
against six criteria manufactures precision the decision does not have.

### Step 3: Confirm the Frameworks Before Scoring

Criteria and weights are agreed BEFORE the scores are seen. Agreeing them after
is how a ranking gets reverse-engineered from a preferred answer.

**Agentic framework** — for candidates where the system chooses its own next
step:

| Criterion | Weight | What a 10 means |
|---|---|---|
| Decision Value | 25 | The choosing itself is the value — a human making the same call would be slow, inconsistent, or unavailable |
| Task Boundedness | 20 | Success is checkable: there is a stopping condition a machine can recognise |
| Tool & Data Access | 15 | Every system the agent must reach already exists and is reachable with permissions the team can get |
| Cost of Being Wrong | 15 | A wrong autonomous action is cheap and reversible — 0 means irreversible and expensive |
| Human Oversight Fit | 15 | There is a natural approval point that catches errors without erasing the benefit |
| Evaluation Feasibility | 10 | Good runs can be told from bad ones repeatedly, without a human grading each one |

**Application framework** — for candidates where the control flow is authored,
including software with an AI feature inside it:

| Criterion | Weight | What a 10 means |
|---|---|---|
| User Value | 25 | It materially changes the user's day, and the user says so |
| Frequency & Reach | 20 | Many users, often — value multiplies rather than accrues once |
| Technical Feasibility | 15 | Buildable with the team, platforms, and skills already in place |
| Data Readiness | 15 | The data exists, is accessible, is clean enough, and is permitted for this use |
| Time to First Value | 15 | A user sees something real in weeks, not quarters |
| Strategic Fit | 10 | It moves the business where it already said it was going |

Both frameworks total 100. Score each criterion 0-10; the weighted total is
`Σ(score × weight) / 100`, which lands back on a 0-10 scale so the two
frameworks' totals are comparable in magnitude even though their criteria are
not.

Present both frameworks and ask the user to confirm or adjust the weights for
their situation. A team under a delivery deadline legitimately raises Time to
First Value; a regulated team legitimately raises Cost of Being Wrong. Record
any change, with its reason — an adjusted weight is a decision, and an
unrecorded one is invisible in the ranking it produced.

### Step 4: Generate the Scoring Questions

Create `<record>/ideation/pdlc-prioritization/pdlc-prioritization-questions.md`.

Start the file with a `## Sources` register. Every source is a top-level
Markdown list item using exactly one of these forms:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim product description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
- [artifact:pdlc-<name>] `<path to the upstream pdlc artifact>`
```

Register an `[artifact:…]` entry for every upstream artifact you scored from —
`pdlc-use-cases`, and `pdlc-identified-solutions` and `pdlc-prfaq` where they
exist. A criterion answered from the intake register cites that register; it does
not need to be re-asked. That is the point of the tag: it separates "the user
told us this earlier" from "we made it up now".

Then create consecutively numbered `## Q<n>.` questions covering, at minimum:

- **Weight confirmation** for each framework in play (Step 3)
- **Every criterion the upstream artifacts do not answer.** Intake captured
  business value and technical complexity; it did not capture Data Readiness,
  Cost of Being Wrong, or Evaluation Feasibility. Those must be asked, per
  candidate, or scored as assumptions
- **How many candidates advance** — the default is three, because three is what
  the prototype stages can carry in parallel; ask rather than assume
- **Any candidate the user wants excluded from scoring outright**, and why

Every question MUST include an explicit `Not known`, `Not measured`, or
`Not applicable` option. A criterion the user cannot speak to is scored as an
assumption and declared as one — never silently averaged to 5. Use the
[Answer]: tag format from stage-protocol.md. Include A-E options with X (Other)
as final option. Leave all [Answer]: tags blank. Follow-up questions continue the
same `Q<n>` numbering so their source ids stay stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 5: Write the Scoring

Apply this grounding contract to both this artifact and the ranking:

1. Permitted sources are `[desc]`, confirmed `[Q<n>]` answers, `[scope]`,
   registered `[memory:M<n>]` entries, and registered
   `[artifact:pdlc-<name>]` entries.
2. Every substantive claim block — paragraph, list item, or table data row —
   carries one or more inline source tags. A scoring row is a claim block: its
   rationale cell carries the tag.
3. A score with no user-sourced or artifact-sourced basis is still written, but
   its rationale begins `Unknown (open question)` and carries `[assumption]`.
   Never average, never default to the midpoint silently, and never omit the
   criterion to avoid the problem.
4. Never invent a measurement, a user count, a cost, a vendor, or a compliance
   position to justify a score.
5. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   only when there are no open questions and no rationale using
   `Unknown (open question) [assumption]`. Every entry in that section carries
   `[assumption]`.

Create `<record>/ideation/pdlc-prioritization/pdlc-prioritization-scoring.md`
with:

- A `## Summary` line — N candidates scored, the Agentic/Application split, and
  how many criteria across the whole exercise rest on assumptions rather than
  stated facts
- `## Agentic Scoring` — one `### <Candidate>` per Agentic candidate, each with
  a table in exactly this shape:

  ```markdown
  | Criterion | Weight | Score | Rationale |
  |---|---|---|---|
  | Decision Value | 25 | 8 | <why, with a source tag> |
  ```

  followed by the weighted total and the arithmetic that produced it
- `## Application Scoring` — the same, per Application candidate, with the
  Application criteria
- `## Assumptions & Open Questions`

Both class headings are required even when one class is empty; write
`None in this set.` under an empty heading. An absent heading reads as an
oversight, and the ranking keys off both.

Show the arithmetic. A weighted total a reader cannot recompute is a number they
have to trust, and this stage's whole purpose is producing numbers that do not
need to be trusted.

### Step 6: Write the Ranking

Create `<record>/ideation/pdlc-prioritization/pdlc-prioritization-ranking.md`
with:

- `## Ranking` — every candidate in weighted-total order, in one table across
  both classes, carrying Candidate, Class, Weighted Total, Evidence Basis
  (`<n> of 6 criteria sourced`), and the one-line reason it sits where it sits
- `## Top Selection` — the candidates that advance (default three), each with
  what it would take to prototype it and what the prototype would have to show
  to be judged a success
- `## Assumptions & Open Questions` — including, explicitly, any candidate whose
  rank rests mostly on assumed scores. A candidate that ranks first on four
  assumptions and two facts is not a first-place candidate; it is a research
  task, and saying so here is cheaper than discovering it after a prototype

Where two candidates are within one point of each other, say that the ranking
does not separate them and name what evidence would. A ranking that reports a
distinction the scores do not support is worse than a tie.

### Step 7: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-prioritization --result awaiting-approval`.

### Step 8: Present Completion & Request Approval

Completion emoji: :bar_chart:
Review path: this stage's engine-resolved record dir.
Present the ranking table, the selected top candidates, any pair the scores do
not separate, and the count of criteria resting on assumptions. Say plainly which
weights the user changed and what that did to the order. Then the standard
2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. No template
currently resolves for them, so the imported `required-sections` sensor enforces
only a structural floor of at least two `##` headings. The scoring and ranking
heading lists in Steps 5 and 6 remain authoring requirements, not
sensor-enforced heading checks. `upstream-coverage` checks that the consumed
`pdlc-use-cases` and `pdlc-identified-solutions` were actually referenced.

The imported `pdlc-evidence` sensor fires on
`pdlc-prioritization-scoring.md` — the highest-value target in the whole plugin,
because six weighted criteria scored 0-10 is precisely where an invented number
is indistinguishable from a measured one. It checks that every substantive claim
block carries an inline source tag which resolves (`[Q<n>]` to a filled answer in
`pdlc-prioritization-questions.md`; `[desc]`, `[scope]`, `[memory:<id>]`, and
`[artifact:pdlc-<name>]` to a visible entry in that file's `## Sources`
register, with `[artifact:…]` additionally resolving to a file that exists), that
`[assumption]` appears outside `## Assumptions & Open Questions` only in
`Unknown (open question) [assumption]`, that each such marker requires a
non-`None.` entry in that section, that every entry there carries
`[assumption]`, and that every scoring table has a rationale column with no
empty cells and a source tag in each rationale cell. It is advisory, and it
deliberately does not check whether a score is the RIGHT score or whether the
weighted totals add up — that is the reviewer's judgment.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
