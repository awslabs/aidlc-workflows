---
slug: pdlc-context-pack
number: 1.90
name: Developer Context Pack
plugin: pdlc
phase: ideation
execution: ALWAYS
condition: Exit point of the pdlc-discovery scope — always executes, because a discovery run that produces no handoff has produced nothing an engineering team can act on.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - pdlc-context-pack
consumes:
  - artifact: pdlc-use-cases
    required: true
  - artifact: pdlc-pain-point-analysis
    required: false
  - artifact: pdlc-prfaq
    required: false
  - artifact: pdlc-identified-solutions
    required: false
  - artifact: pdlc-prioritization-scoring
    required: false
  - artifact: pdlc-prioritization-ranking
    required: false
  - artifact: pdlc-prototype-spec
    required: false
  - artifact: pdlc-design-context
    required: false
  - artifact: pdlc-prototype-build-log
    required: false
  - artifact: pdlc-iteration-log
    required: false
  - artifact: pdlc-validation-results
    required: false
  - artifact: pdlc-build-decision
    required: false
  - artifact: pdlc-product-strategy
    required: false
  - artifact: pdlc-gtm-plan
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
  - "Use Cases"
  - "Handoff Readiness"
  - "Assumptions & Open Questions"
inputs: pdlc-use-cases from pdlc-use-case-intake (required), plus every other pdlc-* discovery artifact written under this run's record dir (all optional — a stage that did not run is a fact about the run)
outputs: pdlc-context-pack.md (under this stage's record dir, engine-resolved)
---

# Developer Context Pack

MANDATORY: Follow stage-protocol.md for approval gates, question format, and completion messages.

Discovery ends at a handoff boundary, not at a build. This stage assembles one
readable artifact that an engineering team can pick up cold — in a different
workspace, on a different day, with none of this session's context — and start
Inception from.

The pack is a NAVIGABLE SUMMARY, not a concatenation. Every discovery artifact
stays where it was written and keeps being the record of its own stage; the
pack states each conclusion, says which artifact holds the working, and points
at it. Copying artifacts wholesale into the pack creates a second copy that
drifts from the first, and a reader who cannot tell which one is current.

## Steps

### Step 1: Load Agent Personas

Load aidlc-product-agent persona from `agents/aidlc-product-agent.md` and knowledge from `{{HARNESS_DIR}}/knowledge/aidlc-product-agent/`.

### Step 2: Inventory What Discovery Actually Produced

Read every `pdlc-*` artifact present under this run's record dir. Not every
discovery stage runs on every run — a PM who arrived with use cases already in
hand skips the pain-point work; a run that stops at handoff builds no
prototype. Record which stages ran and which did not.

The full set to look for, by producing stage:

| Producing stage | Artifacts | Present when |
|---|---|---|
| `pdlc-use-case-intake` | `pdlc-use-cases` | always — it is the scope's entry point |
| `pdlc-envision` | `pdlc-pain-point-analysis`, `pdlc-prfaq` | the run started from customer pain (Path A) |
| `pdlc-solution-analysis` | `pdlc-identified-solutions` | a PR/FAQ existed to derive candidates from |
| `pdlc-prioritization` | `pdlc-prioritization-scoring`, `pdlc-prioritization-ranking` | more than one candidate was in play |
| `pdlc-prototype-spec` | `pdlc-prototype-spec`, `pdlc-design-context`, and one portable `prototypes/<slug>/PROTOTYPE-<slug>.md` per candidate | the run intended to prototype |
| `pdlc-prototype-build` | `pdlc-prototype-build-log`, `pdlc-iteration-log` | prototypes were actually built and run |
| `pdlc-prototype-validation` | `pdlc-validation-results`, `pdlc-build-decision` | prototypes were put in front of someone |
| `pdlc-product-strategy` | `pdlc-product-strategy` | the handoff needed a stated strategy |
| `pdlc-go-to-market` | `pdlc-gtm-plan` | the handoff needed a launch plan |

The `*-questions.md` files are NOT part of the pack. They are the provenance
target that upstream source tags resolve against, they stay where they were
written, and summarising them here would flatten the distinction between what a
user answered and what a stage concluded.

The portable `PROTOTYPE-<slug>.md` files are the exception to the pack's
point-at-it rule in one direction only: name their paths prominently, because
they are the one thing a developer can be handed on its own. Do not copy their
contents in.

An absent upstream artifact is a FACT ABOUT THE RUN, not a gap to fill. Never
reconstruct a missing conclusion from the artifacts that are present, and
never write a section as though its stage ran. Say what is absent, plainly.

### Step 3: Assemble the Pack

Apply this grounding contract:

1. Permitted sources are the `pdlc-*` discovery artifacts under this run's
   record dir, and nothing else. The pack introduces no new conclusions — if a
   claim is not in an upstream artifact, it does not belong here.
2. Every conclusion states the artifact it came from, by path.
3. Never soften or upgrade an upstream hedge. An upstream `[assumption]` is
   still an assumption in the pack.
4. The artifact MUST contain `## Assumptions & Open Questions`. Write `None.`
   when there are none.

Create `<record>/ideation/pdlc-context-pack/pdlc-context-pack.md` with:

- `## Use Cases` — the candidate set and its Agentic/Application split, from
  `pdlc-use-cases`. Required: intake always runs.
- `## Handoff Readiness` — required. See Step 4.
- `## Assumptions & Open Questions` — required.

Then, for each discovery stage that ran, one further section stating its
conclusion and pointing at its artifact. What each one contributes when present:

- **Pain points and the PR/FAQ** (`pdlc-envision`) — the customer problem in the
  customer's terms, and the launch the team is working backwards from. Carry the
  PR/FAQ's Internal FAQ risks forward; they are the part an engineering team
  needs and the part a summary usually drops
- **Candidate solutions** (`pdlc-solution-analysis`) — the option set that was
  considered, including the do-nothing baseline. A handoff that shows only the
  chosen option cannot be argued with
- **Scoring and ranking** (`pdlc-prioritization`) — the ranking, the criteria and
  weights it used, and how many criteria rested on assumptions. The evidence
  basis travels with the rank or the rank means nothing
- **Prototype specs and design context** (`pdlc-prototype-spec`) — the portable
  `PROTOTYPE-<slug>.md` paths, what each prototype was to demonstrate, and the
  brand and device context. These are directly handable
- **What was built** (`pdlc-prototype-build`) — what runs, what was faked, what
  is known broken, and the provider used (`mock` or a real one). Never carry a
  credential value, a variable value, or anything resembling one into the pack
- **What validating it showed** (`pdlc-prototype-validation`) — the evidence base
  (who saw it, how many, how), the criteria met and not met, and the build
  decision with its confidence and its reversal condition
- **Strategy** (`pdlc-product-strategy`) — the beachhead, the positioning
  statement, the business model, and the success metric with its target
- **Go-to-market** (`pdlc-gtm-plan`) — the launch objective, the first channel
  and its owner, the pricing posture, and the launch metric

Omit the section for a stage that did not run; Step 4 records the omission where
a reader will look for it.

### Step 4: State Handoff Readiness Honestly

Under `## Handoff Readiness`, write:

- **Ran** — the discovery stages that executed, with their artifact paths
- **Did not run** — the stages that did not, each with the reason (a scope
  configuration, a user decision at a gate, or an upstream that was skipped)
- **What Inception can rely on** — the conclusions that are backed by a
  completed stage
- **What Inception must decide** — the questions discovery leaves open,
  including everything the omitted stages would have answered

Enumerate all nine discovery stages under one of the two lists — nothing is
silently omitted from both. The stages to account for are
`pdlc-use-case-intake`, `pdlc-envision`, `pdlc-solution-analysis`,
`pdlc-prioritization`, `pdlc-prototype-spec`, `pdlc-prototype-build`,
`pdlc-prototype-validation`, `pdlc-product-strategy`, and `pdlc-go-to-market`.
Whether a stage is in the "ran" list is decided by whether its artifacts are
present in this run's record dir — never by whether this file says it should be.

Say what each absence costs, not merely that it happened. A run with no
prioritization hands over an unranked option set, so Inception inherits the
choice. A run with no prototype hands over untested assumptions, so the
first sprint carries the risk the prototype would have retired. A run with no
strategy hands over a build with no stated segment, positioning, or success
metric — and an engineering team that is not given those will infer them from the
backlog. A run with no go-to-market plan hands over a product with no route to
its first user.

A reader deciding whether they have enough to start reads this section first.
A handoff that overstates its own completeness costs more than one that admits
a gap: the team discovers the gap anyway, later, having already built on it.

### Step 5: Open the Approval Gate

Run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts report --stage pdlc-context-pack --result awaiting-approval`.

### Step 6: Present Completion & Request Approval

Completion emoji: :package:
Review path: this stage's engine-resolved record dir.
Tell the user where the pack is, that it is the artifact to hand to the
engineering team, and that core's `requirements-analysis` reads it
automatically when it is present in the same record. Then the standard
2-option approval (Approve / Request Changes).
STOP for the human response. Report Approve with
`--result approved --user-input "<exact choice>"`; report
Request Changes with `--result rejected --user-input "<feedback>"`, revise the
artifacts, then report `--result revised` before re-presenting.

## Sensors

This stage's outputs are markdown artefacts under its record dir. The imported `required-sections` sensor checks the `Use Cases`, `Handoff Readiness`, and `Assumptions & Open Questions` headings; `upstream-coverage` checks that the consumed discovery artifacts were read.

Every consume except `pdlc-use-cases` is `required: false`, and that is the whole
design of this stage expressed in frontmatter: an upstream stage that did not run
reads as **absent by design**, not as a coverage failure. So a thin run — intake
straight to pack — passes both sensors, and the honesty about what is missing is
carried by `## Handoff Readiness` rather than by a sensor finding.

The `pdlc-evidence` sensor is deliberately NOT imported. Its target set is
`pdlc-prfaq.md` and `pdlc-prioritization-scoring.md`; this stage writes neither.
The pack also introduces no claims of its own — every line traces to an upstream
artifact by construction — so the tag discipline it would check belongs upstream,
where the claims are actually made.

## Learn

While running this stage, maintain a running log in
`<record>/<phase>/<stage>/memory.md` (create on stage start if absent).
Append entries under: Interpretations, Deviations, Tradeoffs, Open questions —
each with an ISO 8601 timestamp.

Stage files are immutable framework artefacts — the ritual writes into the
harness, not into this file.
