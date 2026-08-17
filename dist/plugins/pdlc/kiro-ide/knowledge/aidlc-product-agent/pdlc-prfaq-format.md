# PR/FAQ format

Reference for `pdlc-envision`. The stage owns the procedure and the grounding
contract; this file describes the artifact's shape, what each part is for, and
how each part fails.

A PR/FAQ is one document with three parts: a mock press release, a Customer FAQ,
and an Internal FAQ. Target length is two to three pages in total — one page of
press release, one to two of FAQ. Length is a design constraint, not a style
preference: a proposal that needs six pages to be understood has not been
understood.

## Part 1 — the press release

Written as though the launch already happened. Present tense for what customers
can now do, past tense for the announcement itself. No jargon a customer would
not use. No feature list.

| Element | One line | How it fails |
|---|---|---|
| **Headline** | What the customer can now do, in under ten words | Names the technology instead of the outcome ("Agentic AI Platform for Quoting") |
| **Sub-headline** | Who it is for, in one sentence | "For everyone" — if the customer is not narrow, the product is not designed |
| **Opening paragraph** | The launch, the customer, and the single most important benefit | Opens with the company rather than the customer |
| **Problem paragraph** | What the customer does today and what it costs them | States the absence of your product as the problem |
| **Solution paragraph** | How the product removes that cost — mechanism, not architecture | Turns into a component diagram in prose |
| **Customer quote** | One customer, in their own voice, on the specific relief | An invented quote presented as a real one — the single most common fabrication in this artifact |
| **Leader quote** | Why the company built it, in one sentence | Says nothing that could be false |
| **Getting started** | The first concrete step a customer takes | Vague availability ("coming soon to select customers") |

Two rules that carry most of the weight:

**Write the problem before the solution, and make it hurt.** If the problem
paragraph could be deleted without the reader losing anything, there is no
problem — there is an idea looking for one.

**Every number is either sourced or marked.** A press release attracts numbers:
adoption, time saved, error reduction, price. Each one is either something the
user stated (tag it) or an illustration (mark it `[assumption]`). A made-up
figure in a press release is indistinguishable on the page from a measured one,
and six weeks later nobody remembers which it was.

## Part 2 — the Customer FAQ

The questions a customer asks. Five to eight of them. Written in the customer's
framing, answered without hedging.

Cover at least:

- What is this, in one sentence I would repeat to a colleague?
- How is it different from what I do today?
- What does adopting it cost me — money, time, disruption?
- What does it replace, and what happens to what I already have?
- Who in my organisation has to agree?
- When can I have it, and what does the first week look like?

A Customer FAQ full of questions no customer would ask is a features list in
disguise. If you cannot imagine a specific person asking it, cut it.

## Part 3 — the Internal FAQ

The questions the business asks. This is the section that determines whether the
PR/FAQ is worth anything, because it is the only part with an incentive to be
uncomfortable.

Cover at least:

- **Why this, why now, why us?** What changed to make this the right moment.
- **What has to be true?** The assumptions the whole proposal rests on, stated
  so they can be tested. Each one is a candidate for the first prototype.
- **What is the biggest risk?** One risk, named specifically. "Execution risk"
  is not an answer.
- **How would we know early that this is failing?** The leading indicator, not
  the lagging one. Revenue is a lagging indicator of everything.
- **What are we choosing not to do?** The candidates rejected and the reason.
- **What do we not know?** Openly. This section is the honest twin of the
  press release's confident tense.

Optional but usually worth it: what it costs to build and run, what the
regulatory or privacy exposure is, and what the exit looks like if it does not
work.

## Working with a PR/FAQ

**It is a thinking tool, not a deliverable.** The output that matters is the
argument, not the document. If writing it changed nobody's mind about anything,
either the proposal was already understood or the writing was too safe.

**Iterate it.** A first draft that survives unchanged is a warning sign. Expect
the headline to change once the Internal FAQ is written, because the Internal FAQ
is where the proposal meets resistance.

**Do not let it become a commitment.** A PR/FAQ is a proposal about a future that
may not happen. Downstream stages score it, prototype against it, and sometimes
kill it. That is the process working.

## Provenance discipline

`pdlc-envision` requires an inline source tag on every substantive paragraph,
list item, and table row, plus an `## Assumptions & Open Questions` section, and
the `pdlc-evidence` sensor checks it. The reason is specific to this artifact:
the PR/FAQ's form makes assertion cheap and verification impossible. Tags restore
the distinction the form erases. See `pdlc-overconfidence-prevention.md`.
