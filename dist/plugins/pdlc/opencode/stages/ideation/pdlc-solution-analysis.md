---
slug: pdlc-solution-analysis
number: 1.30
name: Solution Analysis
plugin: pdlc
phase: ideation
execution: CONDITIONAL
condition: Execute when pdlc-envision produced a pain-point analysis and a PR/FAQ — this stage turns stated pain into named, comparable solution candidates. Skip when the user arrived with the candidate set already in hand (Path B), because there is nothing left to derive.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - pdlc-identified-solutions
  - pdlc-solution-analysis-questions
consumes:
  - artifact: pdlc-pain-point-analysis
    required: true
  - artifact: pdlc-prfaq
    required: false
  - artifact: pdlc-use-cases
    required: false
requires_stage:
  - pdlc-envision
sensors:
  - required-sections
  - upstream-coverage
scopes:
  - pdlc-discovery
required_sections:
  - "Identified Solutions"
  - "Pain Coverage"
  - "Assumptions & Open Questions"
inputs: pdlc-pain-point-analysis and pdlc-prfaq from pdlc-envision, plus any candidate use cases already registered by pdlc-use-case-intake
outputs: pdlc-identified-solutions.md, pdlc-solution-analysis-questions.md (under this stage's record dir, engine-resolved)
---

# Solution Analysis

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

A pain admits more than one solution, and the first one anyone names is rarely
the best one. This stage takes the pain-point analysis and derives a SET of
distinct solution candidates from it, at comparable depth, so the next stage has
something to score rather than one option to rubber-stamp.

"Distinct" is the load-bearing word. Two candidates that differ only in
implementation detail are one candidate; two that differ in which pain they
remove, or in who they serve, are two. A set of near-duplicates produces a
ranking that looks rigorous and decides nothing.

This stage does not choose. It also does not rank. It ends with every candidate
described well enough to be scored fairly against the others.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

Read `pdlc-terminology.md` for the Agentic/Application discriminator this stage
applies, and `pdlc-overconfidence-prevention.md` for why a candidate the user
never mentioned must be marked as derived rather than reported.

### Step 2: Load Prior Context

- Read `pdlc-pain-point-analysis.md` from the `pdlc-envision` record dir —
  required. Without a stated pain there is nothing to solve, and a solution set
  built from the PR/FAQ alone inherits the PR/FAQ's confident tense
- Read `pdlc-prfaq.md` from the same dir where present. Its Internal FAQ names
  the constraints and the "what has to be true" list that bound the solution
  space
- Read `pdlc-use-cases.md` from the `pdlc-use-case-intake` record dir where
  present. Candidates the user already named are part of the set, not
  competitors to it — carry them forward by name rather than re-deriving them
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 3: Derive the Candidate Set

For each pain point, ask what different shapes of solution would remove it.
Cover, at minimum, these directions before settling on a set:

- **The obvious one** — what the user or the PR/FAQ already implies
- **A smaller one** — the least that would materially help, often a workflow or
  a report rather than a system
- **A different mechanism** — automate the work, remove the work, or move the
  work to someone for whom it is cheap
- **Buy or reuse** — an existing tool, an internal system, or a vendor already
  in the estate
- **Do nothing differently** — keep the workaround. Name it explicitly; it is
  the baseline every score is implicitly measured against

Collapse near-duplicates. Then classify each surviving candidate:

- **Agentic** — the system decides its own next step: multi-step reasoning
  toward a goal whose path is not known in advance, tool selection at runtime,
  iteration until a condition is met, or delegation across specialised roles
- **Application** — the system executes a path the designers fixed, including
  software with an AI feature inside it whose control flow is still authored

The discriminator is control flow, not model usage. "Calls an LLM" is
Application; "chooses what to do next" is Agentic. The class decides which
scoring framework the prioritization stage applies to the candidate, so record
the one-line reason alongside it — an unexplained class is an unauditable input.

### Step 4: Ask Only What Cannot Be Derived

Create `<record>/ideation/pdlc-solution-analysis/pdlc-solution-analysis-questions.md`.

Start the file with a `## Sources` register, using the same entry forms as the
upstream pdlc stages:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim product description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
- [artifact:pdlc-<name>] `<path to the upstream pdlc artifact>`
```

Then ask only the questions the upstream artifacts cannot answer. This stage is
downstream of a full elicitation, so a long question list here means the
previous stage's answers were not read. Typically:

- **Is the derived set complete** — present it and ask what is missing
- **Is any candidate already ruled out**, and by what constraint
- **Which candidates are the same thing** in the user's eyes, even where they
  look different on paper
- **Where a class is genuinely ambiguous** — an authored application wrapping an
  agentic core — which side the product risk sits on

Every question MUST include an explicit `None`, `Nothing missing`, or
`Not sure` option. Use the [Answer]: tag format from stage-protocol.md. Include
A-E options with X (Other) as final option. Leave all [Answer]: tags blank.
Follow-up questions continue the same `Q<n>` numbering so their source ids stay
stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

### Step 5: Write the Identified Solutions

Apply this grounding contract:

1. Permitted sources are `[desc]`, confirmed `[Q<n>]` answers, `[scope]`,
   registered `[memory:M<n>]` entries, and registered
   `[artifact:pdlc-<name>]` entries — the pain-point analysis, the PR/FAQ, and
   the intake register are cited by artifact, not restated as new findings.
2. Every substantive claim block carries one or more inline source tags.
3. A candidate this stage derived rather than the user named carries the
   `[artifact:…]` tag of the pain it came from. A candidate whose value or
   effort the user never spoke to carries `Unknown (open question)
   [assumption]` rather than a guess.
4. Never invent a vendor, a cost, an integration, or an existing internal
   system. If "buy or reuse" has no known candidate, say so.
5. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Create `<record>/ideation/pdlc-solution-analysis/pdlc-identified-solutions.md`
with:

- A `## Summary` line giving the totals — N candidates, X Agentic, Y
  Application, and whether the do-nothing baseline is among them
- `## Identified Solutions` — one `### <Name>` per candidate, carrying What it
  is (two sentences, capability level not component level), Pains it removes,
  Target users, Key capabilities needed, Classification (Agentic or
  Application) with its reason, Known constraints and dependencies, and Origin
  (user-named or derived, with the source)
- `## Pain Coverage` — a table of pain point × candidates that address it. A
  pain with no candidate is a finding, not an omission: state it
- `## Assumptions & Open Questions`

### Step 6: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-solution-analysis --result awaiting-approval`.

### Step 7: Present Completion & Request Approval

Completion emoji: :bulb:
Review path: this stage's engine-resolved record dir.
Present the candidate count with its Agentic/Application split, the pains with
no candidate against them, and which candidates the user named versus which this
stage derived. Then the standard 2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. No template
currently resolves for them, so the imported `required-sections` sensor enforces
only a structural floor of at least two `##` headings. The heading list in Step 5
remains an authoring requirement, not a sensor-enforced heading check.
`upstream-coverage` checks that the consumed `pdlc-pain-point-analysis`,
`pdlc-prfaq`, and `pdlc-use-cases` were actually referenced rather than merely
declared.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
