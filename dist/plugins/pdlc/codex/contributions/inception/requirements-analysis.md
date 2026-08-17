---
target: requirements-analysis
plugin: pdlc
adds:
  consumes:
    - artifact: pdlc-context-pack
      required: false
fragments:
  - anchor: after-step:2
    order: 100
---

## fragment: after-step:2

### Step 2b (pdlc): Read the discovery context pack, if one exists

Look for `pdlc-context-pack` in this record. It is the handoff artifact from a
`pdlc-discovery` run: the candidate use cases, the Agentic/Application split,
and — where those discovery stages ran — the prioritization outcome, the
PR/FAQ, the prototype evidence, and the product-strategy and go-to-market
decisions.

`required: false` is load-bearing. Most runs have no pack, because most teams
do not run product discovery in the same record — and #482's presence-split
means an absent pack whose producer was never in the plan reads as *absent by
design*, not as a missing input. Do not ask the user for one, and do not treat
its absence as a gap.

When a pack IS present:

- Read its `## Handoff Readiness` section FIRST. It states which discovery
  stages ran and which did not, so it tells you which of the pack's
  conclusions are backed by completed work and which questions discovery
  deliberately left for Inception to decide.
- Treat the pack's conclusions as confirmed inputs on the same footing as a
  `[Q<n>]` answer, and cite them by path — the pack is a record artifact, not
  the user's live testimony.
- Do NOT re-litigate a decision the pack records. If discovery chose one use
  case out of eight, requirements analysis scopes that one; reopening the
  choice discards work the user already approved at a gate.
- An upstream `[assumption]` in the pack stays an assumption here. Carry it
  into `## Assumptions & Open Questions` rather than promoting it to a
  requirement.

The pack narrows the clarifying questions in Step 7 rather than replacing them.
Discovery answers *which product, and why that one*; requirements analysis
still has to answer *what exactly it must do*.
