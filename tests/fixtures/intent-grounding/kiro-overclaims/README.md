# Captured Kiro unsupported claims

These three Markdown files preserve the content of a captured Kiro intent-capture
result, including its offered options and recorded answers. This is a
deliberately bad, test-only fixture for two specific unsupported inferences:

- `intent-statement.md` says the application is "not aimed at teams or external
  product customers." Q2 confirms "A. Individual end users managing their own
  personal tasks"; it does not confirm that exclusion. The unselected options
  "B. Internal team members coordinating shared work" and "C. External customers
  of a product" are offered choices, not authority for negative claims.
- `stakeholder-map.md` says developer and end-user needs "are aligned under one
  person." Q5 confirms "A. Just me — I decide scope and priorities", which
  establishes decision-making authority, not developer/end-user identity. Q2's
  "D. Just me (developer/personal use)" was offered but not selected.

Positive controls must put the supporting statement in a confirmed answer.
For example, an explicit audience exclusion can support that exclusion, and an
explicit developer/end-user identity statement can support that identity.
Selecting Q2's personal-use option would supply different evidence from merely
leaving it among the options. Q5's decision-making answer alone remains
insufficient for an identity claim.

The [intent-capture stage](../../../../core/aidlc-common/stages/ideation/intent-capture.md)
allows confirmed answers as sources, forbids turning unselected options into
exclusions or requirements, and specifies how to handle unsupported content.
The [claim-sources sensor contract](../../../../core/sensors/aidlc-claim-sources.md)
checks citation structure and source registration; satisfying those checks does
not establish support for these two inferences.

This fixture preserves the counterexample rather than correcting its artifacts.
It is not a general semantic-entailment fixture, an expected successful workflow
output, or evidence that a live journey passed.
