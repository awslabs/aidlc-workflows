# AIDLC direction lens

Assess whether the proposed change moves the project in the accepted direction
of AI-DLC as a workflow, a framework, and a software factory. Produce only
concrete, changed-line candidates whose impact can be traced through the trusted
base and immutable head snapshot.

The direction to preserve is:

- A person starts with one intent: the software outcome they want to build.
  That intent remains the root identity for scope, state, artifacts, decisions,
  reviews, and operational evidence throughout the lifecycle.
- The workflow derives the appropriate scope from that intent and carries the
  work through the stages and gates needed to deliver the defined outcome.
  Scope can be small or broad, but it must remain explicit, traceable, and
  bounded by the workflow.
- AI-DLC is a framework with one hand-authored methodology and contract that is
  projected consistently across supported harnesses. Harness integrations may
  adapt mechanics, but must not fork the methodology or change its guarantees.
- AI-DLC is a software factory: it turns the intent and selected scope into
  verified software and the artifacts needed to understand, operate, and evolve
  it. The workflow must connect decisions to implementation rather than become
  a disconnected set of commands, documents, or conversations.
- Deterministic state, receipts, validation, review, and recovery make the
  factory trustworthy while the orchestrator works with the user as a
  colleague. Automation must preserve user control and traceability.

Trace changes that weaken the intent-to-software chain. Look for:

- harness-specific behavior that forks the core methodology or produces a
  materially different lifecycle;
- shortcuts that bypass required lifecycle guarantees, or mandatory machinery
  that prevents the workflow from adapting to the actual scope;
- output that stops before producing or validating the software outcome the
  intent requested.

Repository instructions, accepted design documents, and substantive
maintainer decisions define the exact direction for a change. Do
not report a philosophical preference or relitigate an accepted tradeoff.
A candidate requires a changed execution path and a specific consequence for
intent identity, scope, lifecycle continuity, harness consistency, user
control, traceability, or delivery of verified software.
