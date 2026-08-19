# Overconfidence prevention

Reference for every `pdlc-discovery` stage, cited explicitly by `pdlc-envision`
and `pdlc-prioritization`. Ported from the AI-PLC source's
`overconfidence-prevention` rules.

**Read the enforcement note first.** A plugin cannot ship phase guardrails — the
`memory/` subtree is not projected into an install, so nothing here is loaded as
a rule. This file has force only where a stage's prose names it and only where a
sensor checks the resulting shape. That is why `pdlc-envision` and
`pdlc-prioritization` cite it by name in Step 1 and why the `pdlc-evidence`
sensor exists. Everywhere else it is advice a reader has to choose to follow.

## The problem this addresses

Product discovery produces artifacts whose *form* is confident regardless of how
much is actually known.

A press release is written in the past tense about a launch that has not
happened. A weighted score is a number, and numbers read as measurements. A
persona has a name and a job title. A market size has a unit. None of these forms
have a way to express "we do not know this yet," so the uncertainty is not
softened — it is deleted, silently, by the act of writing.

Six weeks later the document is the record. Nobody remembers which figures came
from a customer conversation and which were needed to make a paragraph work. The
team builds on the whole thing at equal confidence, and discovers the difference
only when a decision that rested on an invented number turns out to be wrong.

This is not a diligence failure. It is a property of the artifacts, and it has to
be designed against.

## The rule

**Every substantive claim is either sourced or marked. There is no third option.**

Sourced means it traces to something specific and re-readable: the user's own
description, a filled answer in this stage's questions file, a rule in the space
memory layer, or an upstream `pdlc-*` artifact that exists on disk. An entry in
`## Assumptions & Open Questions` is marked only when it carries
`[assumption]`. Outside that section, `[assumption]` is valid only in
`Unknown (open question) [assumption]`; each such in-body marker requires a
non-`None.` entry in the assumptions section.

An unsourced, unmarked claim is a fabrication regardless of how reasonable it is.
Plausibility is not provenance — plausible-and-wrong is the failure mode, since
implausible claims get caught.

## The tag vocabulary

| Tag | Resolves to |
|---|---|
| `[desc]` | the user's verbatim initial description, registered in `## Sources` |
| `[scope]` | the workflow-selected scope, registered in `## Sources` |
| `[Q<n>]` | a **filled** answer under `## Q<n>.` in this stage's sibling questions file |
| `[memory:M<n>]` | a rule in `aidlc/spaces/<active-space>/memory/{org,team,project}.md`, registered in `## Sources` |
| `[artifact:pdlc-<name>]` | an upstream `pdlc-<name>.md` that exists under this run's record dir, registered in `## Sources` |
| `[assumption]` | nothing — it declares the absence of a source. Every `## Assumptions & Open Questions` entry carries it; outside that section it is valid only in `Unknown (open question) [assumption]`, with a corresponding non-`None.` assumptions entry |

`[artifact:…]` is what stops the tag discipline becoming re-interrogation. A
score that follows from the intake register cites the register; the user answered
that question once, at the stage that asked it, and the tag says where.

## The seven failure modes

**1. The invented quote.** A customer quote in a press release that nobody said.
The most common fabrication in this flow, and the most damaging, because a quote
is evidence by form. Use only the user's words from an answer; omit a composed
illustration rather than presenting it as a quote.

**2. The unsourced metric.** "Reduces processing time by 60%." Where did 60 come
from? If the user did not say it and no document holds it, it is either an
assumption or it is not in the artifact.

**3. The midpoint default.** Scoring a criterion 5 because the answer is unknown.
This is the quietest failure of all: it produces a complete, professional-looking
table where the unknowns are invisible and the weighted total is arithmetic
performed on nothing. Score it, write the rationale as
`Unknown (open question) [assumption]`, and record the open question as a
`[assumption]` entry in the assumptions section so the gap survives into the
ranking.

**4. The invented persona.** A named user with a title, a workflow, and
frustrations that came from pattern-matching rather than from the user. Personas
must be traceable to a stated answer or marked as hypotheses.

**5. The rejected option turned into a constraint.** The user picked option B, so
the artifact records "the team has ruled out A and C." They did not rule anything
out; they chose one thing. An unselected option is silence, not exclusion.

**6. The upgraded hedge.** An upstream artifact said "possibly," the downstream
artifact says "will." Each step is small and defensible; the chain converts an
open question into a commitment nobody made. Never soften or strengthen an
upstream hedge — an upstream `[assumption]` is still an assumption downstream.

**7. The confident absence.** Writing a section as though its stage ran, when it
did not. An absent upstream artifact is a fact about the run, not a gap to fill.
Say what is missing, plainly, where a reader will look for it.

## What this costs, and why it is worth it

Tagging makes artifacts noisier to read and slower to write. That is real, and it
is the price of a record that stays trustworthy after the session that produced
it is forgotten.

The compensation is concrete: an artifact that distinguishes fact from assumption
lets a reader see, at a glance, where the risk actually is — and it lets the next
stage decide what to go and find out instead of inheriting a confident document
with no idea which parts to test. A prioritization ranking that reports "first
place, four of six criteria assumed" has told the team something a clean ranking
never could.

## Saying "I don't know" well

A stage that asks a question the user cannot answer has learned something. Record
it as an open question with what would resolve it and who would know, then
continue. Do not:

- fill the gap with a reasonable-sounding value,
- silently drop the field so the gap is invisible,
- or block the stage on it.

Every question in these stages offers an explicit `Not known` /
`Not yet defined` / `Not measured` option for exactly this reason. Those answers
are answers.

## What a sensor can and cannot do

The `pdlc-evidence` sensor checks that a tag is present and that it resolves to
something real. It cannot check that the cited source actually supports the
claim — that is the reviewer's judgment (`aidlc-product-lead-agent`, at
`review_class: advisory`).

So a fully tagged artifact is not a verified artifact. It is an artifact where
every claim's origin is inspectable, which is the precondition for verification
rather than a substitute for it.
