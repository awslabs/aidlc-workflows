---
name: pdlc-discovery
plugin: pdlc
depth: Standard
keywords: []
description: Product discovery (AI-PLC) — use-case intake through developer handoff
skeleton: off
runner: true
review_cap: advisory
---

# pdlc-discovery scope

Standard depth for the product-manager side of the lifecycle. It runs the
AI-PLC discovery arc — intake and categorization of the candidate use cases,
then the handoff pack that a developer picks up in Inception — and nothing
else. No inception, construction, or operation stages execute under this
scope, because discovery deliberately ends at a handoff boundary rather than
flowing into implementation in the same workspace.

## Why these stages, why skip those

Discovery answers "which product should we build, and why that one" — a
question with no code in it. Running requirements-analysis, code-generation,
or deployment here would force a PM to make engineering commitments before
the product bet is chosen, which is the failure mode the AI-PLC methodology
exists to prevent. So this scope keeps the initialization spine (a workspace
and state file still have to exist) plus the `pdlc-*` ideation stages, and
skips everything downstream.

The handoff is an artifact, not a stage: `pdlc-context-pack` is written here
and consumed by core's `requirements-analysis` at `required: false` in
whatever scope the engineering team later runs. Both directions work
standalone — a PM can finish discovery with no developer in the room, and a
developer can run `feature` or `mvp` with no discovery pack present.

## Membership

No keyword triggers. This scope is invoked explicitly
(`/aidlc pdlc-discovery`) rather than inferred from free text, so it never
shadows a core scope in keyword inference and never competes with a
core-shipped discovery path for the same phrases.

`review_cap: advisory` caps every review under this scope to a single
advisory pass. Discovery artifacts are hypotheses being explored, not
specifications being verified; an adversarial refute-and-fix loop against a
PR/FAQ argues the author out of ideas that were the point of the exercise.
