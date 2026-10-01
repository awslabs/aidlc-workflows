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
  work through the stations and gates the outcome needs. Scope can be small or
  broad, but it must remain explicit, traceable, and bounded by the workflow.
- Tools for determinism, LLM for knowledge, human for judgement (the tenets in
  `AGENTS.md`). The engine and hooks own state, the observed prompt channel and
  its order, the person's words as the host delivers them, receipts, chains,
  and the audit trail. The agent owns reading the person, answering,
  applying instructions, and the station's work. The person owns judgement:
  what to build, whether it is right, trade-offs, and when to stop.
- The human drives. An explicit request is done and reported in one line.
  Guards aim at agent actions, name the exact next step, carry a human key, and
  fail toward the person's last recorded instruction when their own evidence is
  missing. Prior human judgement (a rule the team recorded in memory, a scope
  default, an unattended run) outranks one chat request and is reported as a
  fact with where to change it, not as a refusal.
- One owner per rule: each invariant is checked in one place.
- AI-DLC is a framework with one hand-authored methodology and contract that is
  projected consistently across supported harnesses. Adapters translate; they
  do not fork the lifecycle, decide policy, or drop what the engine or the
  person said.
- AI-DLC is a software factory: it turns the intent and selected scope into
  verified software and the artifacts needed to understand, operate, and evolve
  it. Decisions connect to implementation rather than becoming a disconnected
  set of commands, documents, or conversations.

Trace changes that weaken the intent-to-software chain or the tenets. Look for:

- a tool that reads the meaning of a person's words, or that refuses, re-asks,
  or demands confirmation of an explicit request (P1 when it blocks or loops
  that request);
- control state carried by the agent: a token or receipt the model must copy, a
  part count it must track, or flow decided by how a sentence of prose ends,
  where a typed field or an engine-held chain could carry it;
- a guard or recovery path with no human key, or whose own failure (a missing
  marker, a hash mismatch, lock contention) leads back to the same step: a dead
  end;
- a decision put to the person that knowledge or the tools can settle, or a
  prior human decision silently overridden by one request;
- a second enforcement point for a rule the base already checks elsewhere;
- harness-specific behavior that forks the lifecycle or drops engine or human
  output (notices, follow-ups, refusal reasons);
- an agent bypassing a lifecycle guarantee the person did not waive;
- output that stops before producing or validating the software outcome the
  intent requested.

Do not report a missing confirmation, a missing re-ask, or an agent reading a
reply in place of a tool: those are the intended direction. Exact answers such
as "Approve", an option number, or a slash command remain shortcuts a tool may
read.

Repository instructions, accepted design documents, and substantive
maintainer decisions define the exact direction for a change. Do
not report a philosophical preference or relitigate an accepted tradeoff.
A candidate requires a changed execution path and a specific consequence for
intent identity, scope, lifecycle continuity, harness consistency, the
person's control, traceability, or delivery of verified software. "Follows the
tenets" is never itself a finding, and neither is "violates the tenets" without
the traced path and the observable outcome for the person.
