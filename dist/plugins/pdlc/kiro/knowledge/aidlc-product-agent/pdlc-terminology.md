# pdlc terminology

Domain vocabulary for the `pdlc-discovery` scope. Reference material, not
procedure — the stages own the procedure and cite this file for the nouns.

The audience for this scope is product managers and business leaders, not
engineers. Several words below mean something narrower here than in general
usage, and two of them collide with AI-DLC's own vocabulary. Both cases are
called out.

## The method

**Working Backwards.** Starting from the customer outcome and reasoning back to
what must be built, rather than starting from a capability and looking for who
might want it. The mechanism that forces it is writing the launch announcement
first — you cannot write a press release for a product whose customer you cannot
name.

**PR/FAQ.** The artifact that carries a Working Backwards proposal: a mock press
release announcing the launch as though it happened, followed by two FAQ
sections. Written before the work starts, and rewritten as understanding
improves. Its power and its danger are the same property — it is written in the
confident past tense about something that does not exist.

**Customer FAQ.** The questions the customer asks: what is this, how is it
different from what I do today, what does adopting it cost me, what does it
replace, when can I have it. Written in the customer's words, about the
customer's concerns.

**Internal FAQ.** The questions the business asks: why this, why now, why us;
what has to be true; what the biggest risk is; how we would learn early that it
is failing; what we are choosing not to do. This is where a PR/FAQ earns its
keep. An Internal FAQ with no uncomfortable question in it has not been written,
only advertised.

## Classifying a candidate

**Agentic.** The system decides its own next step. Multi-step reasoning toward a
goal whose path is not known in advance, tool or API selection at runtime,
iteration until a condition is met, or delegation across specialised roles.

**Application.** The system executes a path the designers fixed. This includes
software with an AI feature inside it — a summariser, a classifier, a semantic
search box — where the control flow is still authored rather than chosen.

**The discriminator is control flow, not model usage.** "Calls an LLM" does not
make something Agentic; "chooses what to do next" does. When a candidate is
genuinely both — an authored application wrapping an agentic core — classify by
where the product risk sits, and say so in the reason.

Why it matters here: the class selects the scoring framework in
`pdlc-prioritization`. The two frameworks exist because the classes fail for
different reasons (see `pdlc-prioritization-frameworks.md`), so a misclassified
candidate is scored against the wrong risks.

## Market and customer

**ICP — ideal customer profile.** The specific, describable customer the product
is for: role, context, and the pain they already feel. Not a segment, not a
market size. If the ICP cannot be named concretely enough that you could go find
three of them this week, discovery is not finished.

**Beachhead.** The first, deliberately narrow market you win completely before
expanding. Chosen for winnability and for the reference value of winning it, not
for size. A beachhead that is "everyone who has this problem" is not a beachhead.

**Job to be done.** The progress the customer is trying to make, stated
independently of any solution. "Get an accurate quote to a client before they
call the competitor," not "a faster quoting tool."

**Pain point.** Something that costs the customer time, money, error rate, or
risk today, described as they experience it. A pain point is not the absence of
your solution: "they have no AI assistant" is not a pain, "they re-key the same
order into three systems and it takes 40 minutes" is.

**PMF — product-market fit.** The state where the market pulls the product out of
you rather than you pushing it. It is an observation about demand, never a
milestone you can plan or declare. Nothing in discovery establishes PMF; discovery
chooses which bet is worth making.

**Positioning.** Who the product is for, what category it competes in, and why it
beats the alternative for that customer. The alternative is usually the
workaround, not a competitor.

## Scoring

**Criterion.** One dimension a candidate is judged on, scored 0-10.

**Weight.** How much a criterion counts toward the total, as a percentage.
Weights are agreed BEFORE scores are seen; agreeing them afterwards is how a
ranking gets reverse-engineered from a preferred answer.

**Weighted total.** `Σ(score × weight) / 100`, which lands back on a 0-10 scale.

**Rationale.** The stated reason for a score. A score without one cannot be
checked or argued with, which makes it decoration. The `pdlc-evidence` sensor
enforces the presence of a rationale column; only a human can judge whether the
rationale is any good.

**Evidence basis.** How many of a candidate's criteria rest on something the user
actually stated versus on an assumption. A candidate ranking first on four
assumptions and two facts is a research task, not a first-place candidate.

**Candidate set.** All the things being compared, from any entry point — use
cases the user brought, solutions derived from pain points, or both merged. The
do-nothing baseline belongs in the set.

## Prototyping

**Prototype.** Here: a local, throwaway demonstration built to answer one
question about a candidate. Runs on localhost, is never exposed to a network,
and is never a step toward production. Deliberately narrower than the general
usage.

**Portable prototype spec.** A single self-describing `PROTOTYPE-*.md` that
carries everything needed to build the prototype elsewhere, by someone who was
not in the discovery session. It is also a valid entry point: a spec handed in
from another workspace can skip discovery entirely.

**Handoff pack.** `pdlc-context-pack` — the one artifact that leaves this scope.
A navigable summary that states each conclusion and points at the artifact
holding the working, never a concatenation of them.

## Two collisions with AI-DLC's own vocabulary

**"Use case."** In this scope, a use case is a *candidate being considered* — an
entry in the register that gets scored and ranked. It is not a UML use case, and
it is not an AI-DLC user story. It has no acceptance criteria and no Given/When/
Then; those arrive downstream in core Inception, after a candidate is chosen.

**"Discovery."** In this scope, discovery means the product-manager work of
choosing which product to build. AI-DLC also uses "discovery" for
practices-discovery (learning how a team works) and for reverse-engineering an
existing codebase. Different activities, same word — say which one you mean.

Core AI-DLC nouns this scope uses unchanged, and does not redefine: **stage**,
**scope**, **artifact**, **record dir**, **gate**, **sensor**. A **unit of work**
and a **Bolt** are Construction concepts and appear nowhere in discovery.
