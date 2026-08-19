---
slug: pdlc-use-case-intake
number: 1.10
name: Use Case Intake
plugin: pdlc
phase: ideation
execution: ALWAYS
condition: Entry point of the pdlc-discovery scope — establishes the candidate use-case set every later discovery stage scores, specs, and packs.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
summary_confirmation: required
produces:
  - pdlc-use-cases
  - pdlc-use-case-intake-questions
consumes: []
requires_stage: []
sensors:
  - required-sections
scopes:
  - pdlc-discovery
required_sections:
  - "Agentic Use Cases"
  - "Application Use Cases"
  - "Assumptions & Open Questions"
inputs: User's product description ($ARGUMENTS or <record>/audit/<host>-<clone>.md), and the candidate use cases the user already holds
outputs: pdlc-use-cases.md, pdlc-use-case-intake-questions.md (under this stage's record dir, engine-resolved)
---

# Use Case Intake

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Discovery starts from a SET, not a single idea. This stage captures every
candidate use case the user is weighing, at equal depth, and sorts each into
Agentic or Application — the split that decides which scoring framework the
prioritization stage applies. It deliberately does not rank, choose, or
critique: an intake that argues collapses the option set before it has been
measured.

The number of use cases is whatever the user has. Three and eleven are both
normal; one is normal too (the set is then trivially its own top pick).

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

### Step 2: Load Prior Context

- Read the user's product description from $ARGUMENTS or `<record>/audit/<host>-<clone>.md`
- Check for existing `<record>/` artifacts from prior sessions and resume rather than re-asking
- Load guardrails from
  `aidlc/spaces/<active-space>/memory/{org,team,project}.md`

### Step 3: Generate the Intake Questions

Create `<record>/ideation/pdlc-use-case-intake/pdlc-use-case-intake-questions.md`.

Start the file with a `## Sources` register. Every source is a top-level
Markdown list item using exactly one of these forms:

```markdown
- [desc] Initial description: "<JSON-escaped verbatim product description>"
- [scope] Workflow-selected scope: `<scope>`.
- [memory:M<n>] `aidlc/spaces/<active-space>/memory/{org,team,project}.md#<exact H2 heading>`: "<JSON-escaped exact single-line rule>"
```

The register is the complete permitted-source universe for this stage. Do not
register background knowledge, common practice, or an inference as a source.

Then create consecutively numbered `## Q<n>.` questions. Ask first how many
use cases the user is weighing, then — per use case — cover:

- **Name** — a short handle the rest of discovery will refer to it by
- **Problem it solves** — the customer pain, not the feature
- **Target users / personas** — who experiences that pain
- **Business value** (High / Medium / Low, with the reason)
- **Technical complexity** (High / Medium / Low, with the reason)
- **Type** — Agentic or Application, or `Not sure` (Step 5 classifies it)
- **Key capabilities needed** — two or three, at capability not component level
- **Constraints or dependencies** — including `None identified`

Every question MUST include an explicit `Not yet defined`, `None`,
`Not identified`, or `Not applicable` option as appropriate, so a thin
candidate is never padded with invented detail to fill the form. Use the
[Answer]: tag format from stage-protocol.md. Include A-E options with X
(Other) as final option. Leave all [Answer]: tags blank. Follow-up questions
continue the same `Q<n>` numbering so their source ids stay stable.

Then follow the unified question flow from stage-protocol.md section 3: offer Guide Me / Edit File / Chat modes.

Accept bulk input. A user who pastes a table, a numbered list, or a paragraph
per use case has answered the questions — parse what they gave, fill the
[Answer]: tags on their behalf, and ask only about the fields that are
genuinely missing. Do not make them re-type structured answers they already
supplied in another shape.

### Step 4: Collect and Analyze Answers

After all answers are collected:

1. Confirm ALL [Answer]: tags are filled in
2. Run ambiguity detection and contradiction analysis — in particular, two
   candidates that solve the same pain for the same persona are one use case
   with two implementations; surface that rather than carrying both forward
3. Create follow-up questions if needed

### Step 5: Classify Agentic vs Application

Classify each use case. Record the classification and the one-line reason —
the prioritization stage reads the class to pick its scoring framework, so an
unexplained class is an unauditable input.

- **Agentic** — the system decides its own next step. Multi-step reasoning
  toward a goal whose path is not known in advance, tool or API selection at
  runtime, iteration until a condition is met, or delegation across
  specialised roles.
- **Application** — the system executes a path the designers fixed. Includes
  software with an AI feature inside it (a summariser, a classifier, a
  semantic search box) where the control flow is still authored, not chosen.

The discriminator is control flow, not model usage. "Calls an LLM" does not
make a use case Agentic; "chooses what to do next" does. When a candidate is
genuinely both — an authored application wrapping an agentic core — classify
by where the product risk sits and say so in the reason.

### Step 6: Generate the Use Case Register

Apply this grounding contract:

1. Permitted sources are only `[desc]`, confirmed `[Q<n>]` answers (including
   follow-ups), `[scope]`, and registered `[memory:M<n>]` entries.
2. Every substantive claim block — a paragraph, list item, or table data row —
   MUST carry one or more inline source tags.
3. Never invent a persona, capability, constraint, or value/complexity rating.
   For a required but unresolved field write
   `Unknown (open question) [assumption]`; omit optional fields.
4. Never turn an unselected option into an exclusion or a requirement.
5. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Create `<record>/ideation/pdlc-use-case-intake/pdlc-use-cases.md` with:

- A `## Summary` line giving the totals — N use cases, X Agentic, Y Application
- `## Agentic Use Cases` — one `### <Name>` per use case, carrying
  Description, Target Users, Business Value, Technical Complexity, Key
  Capabilities, Constraints, and Classification Reason
- `## Application Use Cases` — same structure
- `## Assumptions & Open Questions`

Both class headings are required even when one class is empty; write
`None in this set.` under an empty heading. An absent heading reads as an
oversight, and the prioritization stage keys off both.

### Step 7: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-use-case-intake --result awaiting-approval`.

### Step 8: Present Completion & Request Approval

Completion emoji: :clipboard:
Review path: this stage's engine-resolved record dir.
Present the totals and the per-class list, then the standard 2-option approval
(Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. No template
currently resolves for them, so the imported `required-sections` sensor enforces
only a structural floor of at least two `##` headings. The `Agentic Use Cases`,
`Application Use Cases`, and `Assumptions & Open Questions` lists in Step 6
remain authoring requirements, not sensor-enforced heading checks.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
