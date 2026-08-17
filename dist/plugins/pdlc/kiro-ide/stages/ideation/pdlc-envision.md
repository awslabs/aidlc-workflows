---
slug: pdlc-envision
number: 1.20
name: Envision & PR/FAQ
plugin: pdlc
phase: ideation
execution: CONDITIONAL
condition: Execute when the user arrives with customer pain rather than a candidate list (Path A) — no solution has been named yet, or the named ones need a stated customer problem to be judged against. Skip when the user already holds a candidate set and only needs it scored, and skip when a PR/FAQ was handed in from a prior run.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - pdlc-pain-point-analysis
  - pdlc-prfaq
  - pdlc-envision-questions
consumes: []
requires_stage: []
reviewer: aidlc-product-lead-agent
reviewer_max_iterations: 2
review_class: advisory
sensors:
  - required-sections
  - pdlc-evidence
scopes:
  - pdlc-discovery
required_sections:
  - "Pain Points"
  - "Press Release"
  - "Customer FAQ"
  - "Internal FAQ"
  - "Assumptions & Open Questions"
inputs: The customer pain the user describes ($ARGUMENTS or <record>/audit/<host>-<clone>.md), plus any candidate use cases already registered by pdlc-use-case-intake
outputs: pdlc-pain-point-analysis.md, pdlc-prfaq.md, pdlc-envision-questions.md (under this stage's record dir, engine-resolved)
---

# Envision & PR/FAQ

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Working Backwards starts at the customer, not at the product. This stage takes
the pain the user can describe, states it as a problem worth solving, and then
writes the launch announcement for the solved version — a PR/FAQ — so the team
can read the outcome before committing to build anything toward it.

The PR/FAQ is the highest-risk artifact in discovery, because its form is
confident by construction. It is written in the past tense about a launch that
has not happened, and every sentence therefore reads as fact. That is what makes
it useful for alignment and dangerous as a record: a made-up adoption number in
a press release is indistinguishable, on the page, from a measured one.

So this stage carries a grounding contract, and the `pdlc-evidence` sensor
checks it. A claim either traces to something the user said or is marked as an
assumption. There is no third option.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

Read `pdlc-prfaq-format.md` (the section-by-section PR/FAQ reference),
`pdlc-overconfidence-prevention.md` (why this stage is tagged at all), and
`pdlc-terminology.md` (PR/FAQ, beachhead, PMF, Agentic vs Application) from that
directory before writing anything.

### Step 2: Load Prior Context

- Read the user's description of the pain from $ARGUMENTS or
  `<record>/audit/<host>-<clone>.md`
- Read `pdlc-use-cases.md` from the `pdlc-use-case-intake` record dir if it is
  present. It is not required here — on Path A the user has pain, not
  candidates — but where it exists it names personas and constraints this stage
  should reuse rather than re-elicit
- Check for existing `<record>/` artifacts from prior sessions and resume rather
  than re-asking
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 3: Generate the Envision Questions

Create `<record>/ideation/pdlc-envision/pdlc-envision-questions.md`.

Start the file with a `## Sources` register. Every source is a top-level
Markdown list item using exactly one of these forms:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim product description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
- [artifact:pdlc-<name>] `<path to the upstream pdlc artifact>`
```

The register is the complete permitted-source universe for this stage. Do not
register background knowledge, industry common sense, or an inference as a
source. An `[artifact:…]` entry must name a `pdlc-*.md` that actually exists
under this run's record dir — the sensor checks.

Then create consecutively numbered `## Q<n>.` questions covering:

- **Who has the pain** — the specific person or role, not a market segment
- **What the pain is** — what they do today, and what it costs them in time,
  money, error rate, or risk
- **How they work around it now** — the incumbent, even when the incumbent is a
  spreadsheet or nothing
- **Why the workaround is not enough** — the trigger that makes this worth
  changing now
- **What "solved" looks like from their side** — the observable difference in
  their day
- **The one metric that would prove it worked**, and whether any current value
  of it is known
- **Who else must say yes** — the buyer, the approver, the blocker
- **What is already decided** — constraints, platforms, deadlines, existing
  commitments

Every question MUST include an explicit `Not yet defined`, `None`,
`Not identified`, `Not measured`, or `Not applicable` option as appropriate. A
pain the user cannot yet quantify is a real answer; padding it with an invented
figure is the failure this stage is built to prevent. Use the [Answer]: tag
format from stage-protocol.md. Include A-E options with X (Other) as final
option. Leave all [Answer]: tags blank. Follow-up questions continue the same
`Q<n>` numbering so their source ids stay stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 4: Collect and Analyze Answers

After all answers are collected:

1. Confirm ALL [Answer]: tags are filled in
2. Run ambiguity detection and contradiction analysis — in particular, a pain
   described for one role but measured on another role's metric is two pains,
   and a "pain" that is only the absence of a chosen solution is not yet a pain
3. Create follow-up questions if needed

### Step 5: Write the Pain Point Analysis

Apply the grounding contract in Step 6 to this artifact too.

Create `<record>/ideation/pdlc-envision/pdlc-pain-point-analysis.md` with:

- `## Pain Points` — one `### <short handle>` per distinct pain, carrying Who
  experiences it, What it costs them, Today's workaround, Why the workaround is
  insufficient, and Severity (High / Medium / Low) with the reason
- `## Assumptions & Open Questions`

Rank nothing here. Severity is a property the user stated; ordering the pains
against each other is the prioritization stage's job, on a framework, with
scores that can be argued with.

### Step 6: Write the PR/FAQ

Apply this grounding contract to `pdlc-prfaq.md` and
`pdlc-pain-point-analysis.md`:

1. Permitted sources are only `[desc]`, confirmed `[Q<n>]` answers (including
   follow-ups), `[scope]`, registered `[memory:M<n>]` entries, and registered
   `[artifact:pdlc-<name>]` entries.
2. Every substantive claim block — a paragraph, list item, or table data row —
   MUST carry one or more inline source tags.
3. Never invent a customer name, a quote, a metric, a price, a date, or an
   adoption figure. For a required but unresolved field write
   `Unknown (open question) [assumption]`; omit optional fields.
4. A quote attributed to a customer or a leader is either the user's own words
   from an answer, or it is written as an illustrative quote and tagged
   `[assumption]`. Never present a composed quote as a real one.
5. Never turn an unselected option into an exclusion or a requirement.
6. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Create `<record>/ideation/pdlc-envision/pdlc-prfaq.md` with:

- `## Press Release` — headline, sub-headline, and the announcement itself: who
  it is for, the problem it removes, what they can now do, and how they start.
  Write it in the past tense of a launch that happened
- `## Customer FAQ` — what the customer asks: what is this, how is it different
  from what I do today, what does it cost me to adopt, what does it replace,
  what happens to my existing data or process, when can I have it
- `## Internal FAQ` — what the business asks: why this, why now, why us; what
  has to be true for it to work; what the biggest risk is; how we would know
  early that it is failing; what we are choosing not to do
- `## Assumptions & Open Questions`

The Internal FAQ is where the honesty lives. A PR/FAQ whose Internal FAQ has no
uncomfortable question in it has not been written yet — it has been advertised.

### Step 7: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-envision --result awaiting-approval`.

### Step 8: Present Completion & Request Approval

Completion emoji: :newspaper:
Review path: this stage's engine-resolved record dir.
Present the pain points by severity, the press-release headline, and the count
of claims carried as assumptions rather than sourced facts — the last number is
the one a reader needs and will not otherwise ask for. Then the standard
2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. The imported
`required-sections` sensor checks that `pdlc-pain-point-analysis.md` carries the
`Pain Points` and `Assumptions & Open Questions` headings, and that
`pdlc-prfaq.md` carries `Press Release`, `Customer FAQ`, `Internal FAQ`, and
`Assumptions & Open Questions`.

The imported `pdlc-evidence` sensor fires on `pdlc-prfaq.md` and checks that
every substantive paragraph, list item, and table row carries an inline source
tag which resolves — `[Q<n>]` to a filled answer in
`pdlc-envision-questions.md`, `[desc]`/`[scope]`/`[memory:<id>]`/`[artifact:…]`
to a visible entry in that file's `## Sources` register — and that
`[assumption]` appears only under `## Assumptions & Open Questions`. It is
advisory: it checks that a source was named and exists, never whether the source
supports the claim. That judgment is the reviewer's.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
