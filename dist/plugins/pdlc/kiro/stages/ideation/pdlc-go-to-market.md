---
slug: pdlc-go-to-market
number: 1.85
name: Go-to-Market
plugin: pdlc
phase: ideation
execution: CONDITIONAL
condition: Execute when a product strategy exists and the handoff needs a launch plan — how the first users are reached, what they are told, what they are charged, and how the launch is judged. Skip when the run stops at a prototype brief, and skip for an internal tool whose entire distribution is "the team is told at standup", saying so at the gate rather than manufacturing a channel plan for an audience of twelve.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - pdlc-gtm-plan
  - pdlc-go-to-market-questions
consumes:
  - artifact: pdlc-product-strategy
    required: true
  - artifact: pdlc-prfaq
    required: false
  - artifact: pdlc-validation-results
    required: false
requires_stage:
  - pdlc-product-strategy
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
review_class: advisory
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - pdlc-discovery
required_sections:
  - "Launch Objective"
  - "Audience & Messaging"
  - "Channels"
  - "Pricing & Packaging"
  - "Launch Sequence"
  - "Enablement & Support"
  - "Launch Metrics"
  - "Launch Risks"
  - "Assumptions & Open Questions"
inputs: pdlc-product-strategy from pdlc-product-strategy (required), plus pdlc-prfaq and pdlc-validation-results where those stages ran
outputs: pdlc-gtm-plan.md, pdlc-go-to-market-questions.md (under this stage's record dir, engine-resolved)
---

# Go-to-Market

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

The strategy chose a segment and a claim. This stage turns that into the
mechanics of arriving: which specific people hear about it, through what route,
in what words, at what price, in what order, and how the team will know within
weeks rather than quarters whether the arrival worked.

A go-to-market plan fails in one of two ways, and they look nothing alike. The
first is a plan with no route — a positioning statement, a launch date, and no
answer to "how does the tenth user find out". The second is a plan that is all
route and no capacity: five channels, three audiences, a pricing experiment, and
one person to run it. This stage is written to catch both, which is why every
channel carries an owner and every activity carries an effort estimate.

Nothing here is invented. A channel the user has no access to is not a channel,
a price the user has not thought about is an open question, and a launch date
nobody has committed to is a placeholder that says so.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

Read `pdlc-terminology.md` (beachhead, PMF, positioning) and
`pdlc-overconfidence-prevention.md` (why a channel or a conversion figure with no
basis must say so) from that directory before writing anything.

### Step 2: Load Prior Context

- Read `pdlc-product-strategy.md` from the `pdlc-product-strategy` record dir —
  required. The beachhead, the positioning statement, the differentiators, the
  business model, and the success metric are all decided there and are INPUTS
  here, not open questions again. Where this stage finds a strategy choice
  unworkable in practice — a segment with no reachable channel, a price the
  chosen channel cannot carry — do not silently re-decide it: state the conflict,
  and put it to the user at the gate
- Read `pdlc-prfaq.md` from the `pdlc-envision` record dir where present. Its
  press release is the first draft of the launch message and its Customer FAQ is
  the first draft of the objection handling — reuse both
- Read `pdlc-validation-results.md` where present. What real users said to a
  prototype is better message-testing evidence than anything this stage can
  reason its way to
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 3: Generate the Go-to-Market Questions

Create `<record>/ideation/pdlc-go-to-market/pdlc-go-to-market-questions.md`.

Start the file with a `## Sources` register. Every source is a top-level
Markdown list item using exactly one of these forms:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim product description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
- [artifact:pdlc-<name>] `<path to the upstream pdlc artifact>`
```

Register an `[artifact:…]` entry for the product strategy and for every other
upstream artifact this plan draws on.

Then create consecutively numbered `## Q<n>.` questions. Do not re-ask what the
strategy already decided; ask what it deliberately left open. Cover:

**The launch objective**

- What is this launch FOR — learning, revenue, retention, a reference customer, a
  competitive response, or an internal mandate? Name one primary objective; a
  launch optimised for two is optimised for neither
- What is the launch date or window, and is it committed, targeted, or notional?
- What does "launched" mean concretely — publicly available, available to a named
  list, or in production for one team?

**Audience and messaging**

- Inside the beachhead, who are the three distinct people in the decision — the
  user, the buyer, the blocker — and what does each one need to hear first?
- What is the one sentence each of them repeats to the next person?
- What are the top three objections the user has already heard in real
  conversations, and what is the honest answer to each?
- What must the message NOT claim, given what is actually built at launch? An
  Agentic product especially: what is the honest statement of its failure rate
  and its supervision requirement?

**Channels and route to the first users**

- How will the first ten users hear about this — by name, if the user knows them?
- Which channels does the organisation already have working: an existing customer
  base, a mailing list, a sales team, a partner, a community, a marketplace
  listing, an internal comms path?
- Which channel is the user proposing that does NOT exist yet, and what would it
  take to build it?
- Who owns each channel, and what capacity do they actually have?
- For an internal product: how does the first team get told, trained, and
  transitioned?

**Pricing and packaging**

- What is the price at launch, and is it decided, indicative, or unknown?
- What is the packaging — one tier, a free entry point, a pilot, a per-seat or
  per-usage unit?
- Is there a free or pilot stage, and what specifically must a user do in it for
  the team to count it a success?
- What does the first invoice look like from the buyer's side, and who has to
  approve it?
- For an internal product: is there internal chargeback, and does it change
  behaviour?

**Launch sequence**

- What are the phases — private pilot, limited availability, general availability
  — and what is the entry and exit criterion for each?
- What must be TRUE before the first external user is let in: legal, security
  review, support cover, data handling, accessibility?
- What is the smallest first phase that still teaches something?
- What is the rollback story if the launch goes badly — and does it exist?

**Enablement and support**

- Who answers a user's question in week one, and how do users reach them?
- What does the user-facing documentation have to cover on day one, and who
  writes it?
- What does an internal team need in order to sell, deploy, or support it?
- What feedback route exists, and who reads it?

**Metrics and the judgment**

- What is the launch metric and the number that counts as success, in what window?
- Which leading indicator moves in week one, before the launch metric can?
- What is the pre-agreed signal to pause, slow, or roll back?
- What is being measured only because it is easy to measure? Name it and cut it

**Risks**

- What is the most likely reason the launch underperforms that is nothing to do
  with the product?
- What single dependency, person, or approval could delay it, and by how long?
- What reputational or compliance exposure does the launch create that the
  prototype did not?

Every question MUST include an explicit `Not known`, `Not decided`,
`No channel yet`, or `Not applicable` option. A launch plan that reports a
channel, a price, or a conversion rate the user never stated is worse than an
incomplete one, because it will be resourced. Use the [Answer]: tag format from
stage-protocol.md. Include A-E options with X (Other) as final option. Leave all
[Answer]: tags blank. Follow-up questions continue the same `Q<n>` numbering so
their source ids stay stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 4: Collect and Analyze Answers

After all answers are collected:

1. Confirm ALL [Answer]: tags are filled in
2. Run ambiguity detection and contradiction analysis. The ones that matter here:
   a channel that does not reach the beachhead the strategy chose; a price the
   chosen channel cannot process; a launch date earlier than the stated
   preconditions allow; a launch metric that cannot be measured with what is
   built; more parallel activities than there are named owners; a message that
   claims a capability the prototype did not demonstrate
3. Create follow-up questions if needed

### Step 5: Write the Go-to-Market Plan

Apply this grounding contract:

1. Permitted sources are `[desc]`, confirmed `[Q<n>]` answers, `[scope]`,
   registered `[memory:M<n>]` entries, and registered
   `[artifact:pdlc-<name>]` entries.
2. Every substantive claim block — paragraph, list item, or table data row —
   carries one or more inline source tags.
3. Never invent a channel, a partner, a conversion rate, a customer-acquisition
   cost, a price, a date, or a named launch customer. For a required but
   unresolved field write `Unknown (open question) [assumption]`.
4. Never promote an idea the user floated into a commitment. A channel the user
   said they might try is written as a candidate, not as the plan.
5. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Create `<record>/ideation/pdlc-go-to-market/pdlc-gtm-plan.md` with:

- A `## Summary` line — the primary launch objective, the first audience, the
  first channel, the launch window with its confidence (committed / targeted /
  notional), and how many elements of the plan rest on assumptions
- `## Launch Objective` — the one primary objective, what "launched" concretely
  means, and what this launch is explicitly NOT trying to achieve
- `## Audience & Messaging` — a table of audience (user / buyer / blocker) ×
  what they need to hear × the one sentence they repeat × their top objection and
  its honest answer. Plus a short **Do not claim** list: what the launch message
  must not assert given what exists at launch
- `## Channels` — a table of channel × who it reaches × exists today or must be
  built × owner × effort. Order by first-user reach, not by ambition. A channel
  with no owner is not in the plan; list it under Assumptions instead
- `## Pricing & Packaging` — the launch price with its confidence, the packaging,
  any free or pilot stage with its explicit success criterion, and what the first
  invoice looks like from the buyer's side
- `## Launch Sequence` — the phases in order, each with entry criteria, exit
  criteria, and the preconditions that must be true before external users arrive
  (legal, security, support, data handling). Include the rollback story, or state
  plainly that there is none
- `## Enablement & Support` — who answers week-one questions, what documentation
  must exist on day one and who writes it, what internal teams need, and where
  feedback lands
- `## Launch Metrics` — the launch metric with its target and window, the leading
  indicators, the pause/rollback signal, and the metrics deliberately not tracked
- `## Launch Risks` — a table of risk × how it first shows up × the mitigation ×
  the owner. Include the dependency-and-approval delays, not only market risks
- `## Assumptions & Open Questions`

Keep the plan sized to the team that has to run it. If the number of parallel
activities exceeds the number of named owners, say so in one sentence under
Assumptions and propose what to drop — an over-scoped launch plan does not
under-deliver evenly, it fails at whichever piece was least owned.

### Step 6: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-go-to-market --result awaiting-approval`.

### Step 7: Present Completion & Request Approval

Completion emoji: :rocket:
Review path: this stage's engine-resolved record dir.
Present the launch objective, the first channel and who owns it, the price with
its confidence level, the launch metric with its target, and the count of plan
elements resting on assumptions. Name explicitly any strategy choice this stage
found unworkable in practice, and any activity with no owner. Then the standard
2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. The imported
`required-sections` sensor checks that `pdlc-gtm-plan.md` carries the
`Launch Objective`, `Audience & Messaging`, `Channels`, `Pricing & Packaging`,
`Launch Sequence`, `Enablement & Support`, `Launch Metrics`, `Launch Risks`, and
`Assumptions & Open Questions` headings. `upstream-coverage` checks that the
consumed `pdlc-product-strategy`, `pdlc-prfaq`, and `pdlc-validation-results`
were actually referenced rather than merely declared — the optional two read as
absent by design when their producing stage did not run.

The `pdlc-evidence` sensor is deliberately NOT imported here. Its target set is
`pdlc-prfaq.md` and `pdlc-prioritization-scoring.md`; this stage writes neither,
so importing it would report a pass over a file it never opened. Step 5's
grounding contract is the same discipline, checked here by the reviewer
(`aidlc-product-lead-agent`, `review_class: advisory`).

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
