---
slug: pdlc-product-strategy
number: 1.80
name: Product Strategy
plugin: pdlc
phase: ideation
execution: CONDITIONAL
condition: Execute when the run needs a stated strategy for the candidate it is carrying forward — a chosen segment, a positioning claim, a business model, and the metrics that would prove it. Skip when the handoff is a prototype brief only, or when the organisation already holds an approved strategy for this product and discovery is scoped to validating a use case inside it; say which at the gate rather than restating someone else's strategy as this run's finding.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - pdlc-product-strategy
  - pdlc-product-strategy-questions
consumes:
  - artifact: pdlc-use-cases
    required: true
  - artifact: pdlc-prfaq
    required: false
  - artifact: pdlc-prioritization-ranking
    required: false
  - artifact: pdlc-validation-results
    required: false
  - artifact: pdlc-build-decision
    required: false
requires_stage:
  - pdlc-use-case-intake
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
review_class: advisory
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - pdlc-discovery
required_sections:
  - "Vision"
  - "Target Market & Beachhead"
  - "Positioning"
  - "Differentiation"
  - "Business Model"
  - "Success Metrics"
  - "Strategic Risks"
  - "Assumptions & Open Questions"
inputs: pdlc-use-cases from pdlc-use-case-intake (required), plus pdlc-prfaq, pdlc-prioritization-ranking, pdlc-validation-results, and pdlc-build-decision where those stages ran
outputs: pdlc-product-strategy.md, pdlc-product-strategy-questions.md (under this stage's record dir, engine-resolved)
---

# Product Strategy

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Everything upstream decided WHAT to build. This stage decides **who it is for
first, what claim it makes against the alternatives, and how the business
sustains it** — the three questions an engineering team cannot answer for itself
and will otherwise answer by default.

A strategy is a set of choices that exclude other choices. "Enterprise and SMB,
self-serve and sales-led, freemium and annual contracts" is not a strategy; it is
a refusal to make one, and it costs the most at exactly the point where a team
must decide which of two features ships first. So every section of this artifact
names what it is choosing AGAINST. A positioning statement with no stated
alternative is a slogan.

This stage is also the most tempting place in discovery to write confident
fiction — market sizes, competitor weaknesses, willingness to pay. None of that
is knowable from a discovery session, and stating it anyway converts a guess into
an input the next ten decisions rest on. Every claim here traces to something the
user said or is marked as an assumption. There is no third option.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

Read `pdlc-terminology.md` (beachhead, PMF, positioning, Agentic vs
Application — the nouns this stage uses precisely) and
`pdlc-overconfidence-prevention.md` (why a market claim with no source must say
so) from that directory before writing anything.

### Step 2: Load Prior Context

- Read `pdlc-use-cases.md` from the `pdlc-use-case-intake` record dir —
  required. It names the candidates, their personas, and their class
- Read `pdlc-prfaq.md` from the `pdlc-envision` record dir where present. Its
  press release already contains a positioning attempt and its Internal FAQ
  already contains the "what has to be true" list — reuse both rather than
  re-deriving them, and where this stage disagrees with the PR/FAQ, say so
  explicitly instead of quietly overwriting it
- Read `pdlc-prioritization-ranking.md` where present. The top selection is the
  candidate this strategy is for; a strategy written for the whole candidate set
  is a company strategy, which is not what discovery produces
- Read `pdlc-validation-results.md` and `pdlc-build-decision.md` where present.
  A prototype that was built and shown to users is the only real evidence this
  run has, and it outranks every stated intention in this artifact
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

Name the subject before going further: which candidate (or which coherent group
of candidates) this strategy covers, and why that one. If the run produced no
ranking and no validation, the subject is whatever the user names — record that
the choice was stated rather than scored.

### Step 3: Generate the Strategy Questions

Create `<record>/ideation/pdlc-product-strategy/pdlc-product-strategy-questions.md`.

Start the file with a `## Sources` register. Every source is a top-level
Markdown list item using exactly one of these forms:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim product description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
- [artifact:pdlc-<name>] `<path to the upstream pdlc artifact>`
```

Register an `[artifact:…]` entry for every upstream artifact this strategy rests
on. An `[artifact:…]` entry must name a `pdlc-*.md` that actually exists under
this run's record dir.

Then create consecutively numbered `## Q<n>.` questions. Cover every group below
— this is the deepest question bank in the plugin, deliberately, because a thin
strategy is worse than none: it looks like a decision was made.

**Vision and time horizon**

- What does the world look like for these users in three years if this works —
  stated as their situation, not as the product's feature set?
- What would have to be true about the market, the technology, or the
  organisation for that to happen?
- What is the shortest honest version of the vision — one sentence, no
  adjectives?

**Target market and the beachhead**

- Who is the FIRST segment — narrow enough that a single message reaches all of
  them and a single product satisfies all of them?
- Why that segment first: acute pain, reachable channel, tolerable procurement,
  or an existing relationship?
- Which adjacent segments come second and third, and what does winning the
  beachhead unlock about them?
- Who is explicitly NOT a target in the first release, and what is the cost of
  saying no to them?
- How many of them are there, and is that number known, estimated, or unknown?

**The alternatives and the competitive picture**

- What do these users use today — including "a spreadsheet", "an analyst", and
  "nothing"?
- Which named alternatives has the user actually seen the segment evaluate?
- On what dimension does each alternative win, honestly?
- What would make a user switch, and what would make them switch back?

**Positioning and differentiation**

- Complete: "For **<segment>** who **<situation>**, **<product>** is the
  **<category>** that **<key benefit>**, unlike **<primary alternative>**, which
  **<limitation>**."
- Which category are we in, in the user's head, not in ours? A product with no
  category has to teach one, and that cost belongs in the plan
- What are the two or three differentiators, and for each: is it a durable
  advantage, a temporary lead, or a feature anyone can copy in a quarter?
- What advantage compounds — data, workflow lock-in, distribution, switching
  cost, regulatory position — or is there none yet? "None yet" is a legitimate
  and important answer

**Business model**

- How does this make or save money: subscription, usage, seat, transaction,
  internal cost avoidance, or enabling revenue elsewhere?
- Who pays, and is the payer the same person as the user? Where they differ,
  which one does the product serve when they conflict?
- What is the unit of value the price should track, and is it the same unit the
  cost tracks? A per-seat price on a per-token cost is a margin problem that
  arrives with success
- For an internal product: whose budget, and what is it displacing?
- What is the rough cost shape — where does spend go, and what grows with usage?

**Adoption and the path in**

- What is the first thing a new user does, and how long until they see value?
- What has to happen inside the buyer's organisation for adoption to stick —
  training, process change, integration, someone's job changing?
- What is the single biggest reason a signed-up user does not come back?

**Success metrics and PMF signals**

- What one metric would tell us this is working, and what value of it counts as
  working?
- What is that metric today, if known?
- Which two or three leading indicators move before it does?
- What would count as evidence of product-market fit for this segment — a
  retention shape, a usage frequency, a referral, a renewal?
- What result would make us stop, and who is allowed to call it?

**Strategic risks**

- What is the most likely way this fails that is nobody's fault — market timing,
  a platform shift, a dependency, a regulation?
- What are we assuming about the technology holding up, especially for an Agentic
  candidate where quality is probabilistic?
- What would a well-funded incumbent do in response, and how long would it take
  them?
- Which of these risks is testable cheaply, and which is only knowable by
  shipping?

Every question MUST include an explicit `Not known`, `Not measured`,
`Not yet decided`, or `Not applicable` option. A strategy the user cannot yet
speak to is recorded as an open question, never as a confident answer — an
invented market size is the single most durable piece of fiction a discovery run
can create, because every later document cites it. Use the [Answer]: tag format
from stage-protocol.md. Include A-E options with X (Other) as final option. Leave
all [Answer]: tags blank. Follow-up questions continue the same `Q<n>` numbering
so their source ids stay stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 4: Collect and Analyze Answers

After all answers are collected:

1. Confirm ALL [Answer]: tags are filled in
2. Run ambiguity detection and contradiction analysis. The contradictions that
   matter here are specific: a beachhead that is not the persona the pain was
   described for; a business model whose payer is not in the target segment; a
   differentiator that is also the primary alternative's headline feature; a
   success metric no one in the segment currently measures; a three-year vision
   the named first release cannot start toward
3. Create follow-up questions if needed

### Step 5: Write the Product Strategy

Apply this grounding contract:

1. Permitted sources are `[desc]`, confirmed `[Q<n>]` answers, `[scope]`,
   registered `[memory:M<n>]` entries, and registered
   `[artifact:pdlc-<name>]` entries.
2. Every substantive claim block — paragraph, list item, or table data row —
   carries one or more inline source tags.
3. Never invent a market size, a competitor name, a competitor weakness, a price,
   a willingness to pay, a growth rate, or an analyst figure. For a required but
   unresolved field write `Unknown (open question) [assumption]`.
4. Never turn an unselected option into an exclusion or a commitment.
5. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Create `<record>/ideation/pdlc-product-strategy/pdlc-product-strategy.md` with:

- A `## Summary` line — the subject candidate, the beachhead in five words, the
  business model in five words, and how many of this artifact's choices rest on
  assumptions rather than stated facts
- `## Vision` — the three-year outcome for these users in one paragraph, plus
  what has to be true for it, plus the shortest honest one-sentence form
- `## Target Market & Beachhead` — the first segment and why it is first; the
  second and third in order with what the beachhead unlocks; and an explicit
  **Not targeted first** list with the cost of each exclusion. Segment sizes are
  given only where the user stated them, each marked stated / estimated / unknown
- `## Positioning` — the completed positioning statement, the category claim, and
  a table of the real alternatives (including the workaround and doing nothing)
  with what each one wins on
- `## Differentiation` — two or three differentiators, each labelled **durable**,
  **temporary lead**, or **copyable**, with the reason. If nothing is durable
  yet, say that in one sentence; it is a finding, not a failure
- `## Business Model` — how value is captured, who pays, the unit the price
  tracks, the unit the cost tracks, and where those two diverge under success
- `## Success Metrics` — the one metric that would prove it, its target value and
  today's value where known, the leading indicators, the PMF signal for this
  segment, and the stop condition with who calls it
- `## Strategic Risks` — a table of risk, why it is plausible, how it would first
  show up, and whether it is cheaply testable or only knowable by shipping
- `## Assumptions & Open Questions`

Two rules on the prose itself. **Every choice names its alternative** — if a
section could be read without learning what was rejected, it has not made a
choice. And **an unknown is written as an unknown**: `Unknown (open question)
[assumption]` in the field, plus a line under Assumptions saying what would
resolve it and roughly what that would cost. A strategy with eight honest
unknowns is usable; one with eight invented certainties is a trap.

### Step 6: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-product-strategy --result awaiting-approval`.

### Step 7: Present Completion & Request Approval

Completion emoji: :compass:
Review path: this stage's engine-resolved record dir.
Present the positioning statement in full, the beachhead with what was excluded,
the business model in one line, the one success metric with its target, and the
count of choices resting on assumptions rather than stated facts. Name any
contradiction Step 4 found that the user chose to keep. Then the standard
2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. The imported
`required-sections` sensor checks that `pdlc-product-strategy.md` carries the
`Vision`, `Target Market & Beachhead`, `Positioning`, `Differentiation`,
`Business Model`, `Success Metrics`, `Strategic Risks`, and
`Assumptions & Open Questions` headings. `upstream-coverage` checks that the
consumed `pdlc-use-cases`, `pdlc-prfaq`, `pdlc-prioritization-ranking`,
`pdlc-validation-results`, and `pdlc-build-decision` were actually referenced
rather than merely declared — and the ones whose producing stage did not run read
as absent by design, not as a failure.

The `pdlc-evidence` sensor is deliberately NOT imported here. Its target set is
two files — `pdlc-prfaq.md` and `pdlc-prioritization-scoring.md` — and this stage
writes neither, so importing it would report a pass that checked nothing, which
is worse than no sensor at all. The grounding contract in Step 5 is the same
contract that sensor enforces upstream, and here it is the reviewer
(`aidlc-product-lead-agent`, `review_class: advisory`) who checks it.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
