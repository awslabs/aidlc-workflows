---
slug: retrospective
name: Retrospective & Code Documentation
phase: operation
execution: CONDITIONAL
condition: >
  Execute near the end of the Operation cycle, before Feedback & Optimization,
  when a delivery-level retrospective is worthwhile — to consolidate durable
  code documentation and codify lessons about the codebase now that it has been
  built and proven in an environment, and (secondarily) to harvest and promote
  AI-DLC process learnings from the stage diaries. Skipped when the
  retrospective ceremony is off, or when no code was generated this delivery.
lead_agent: aidlc-architect-agent
support_agents:
  - aidlc-developer-agent
  - aidlc-quality-agent
mode: inline
summary_confirmation: required
produces:
  - codebase-orientation
  - architecture-decision-record
  - known-limitations-register
  - code-lessons
  - promotion-log
  - org-promotion-proposal
  - retrospective-questions
consumes:
  - artifact: code-summary
    required: true
  - artifact: cross-unit-traceability
    required: false
  - artifact: build-and-test-summary
    required: false
  - artifact: build-test-results
    required: false
requires_stage:
  - performance-validation
sensors:
  - required-sections
scopes:
  - enterprise
  - feature
  - workshop
inputs: The delivery's code artifacts (code-summary, cross-unit-traceability, build-and-test-summary, build-test-results), the per-unit traceability records, all stage diaries (<record>/*/*/memory.md), and the intent's audit shards
outputs: codebase-orientation.md, architecture-decision-record.md, known-limitations-register.md, code-lessons.md, promotion-log.md, org-promotion-proposal.md, retrospective-questions.md (code-documentation artifacts written to the customer's workspace; promotion/process artifacts under this stage's record dir, engine-resolved)
---

# Retrospective & Code Documentation

This stage runs near the end of the Operation cycle, immediately before Feedback
& Optimization. It runs once per delivery — now that the code has been built and
proven in an environment — and has **two lanes, code first**.

**Lane 1 (primary): document the code and codify lessons about the codebase.**
Working *with the customer*, consolidate the per-unit code artifacts into
durable, customer-owned documentation — an architecture/decision record, a
codebase orientation guide, a known-limitations & tech-debt register, and
lessons specific to *this* code. These are the customer's deliverable and are
written where their code lives.

**Lane 2 (secondary): promote AI-DLC process learnings.** Aggregate the
per-stage Learnings Ritual (`stage-protocol-learnings.md` §13) across the
delivery and promote kept candidates through the existing deterministic
`engine learnings persist` path into `project.md` / `team.md`, emitting a
team→org promotion *proposal* artifact. It never writes `org.md` and introduces
no parallel store.

The two lanes are distinct on purpose: **lessons about the code** (the
deliverable) vs. **lessons about the process** (methodology). The stage's
headline value is Lane 1.

## Steps

### Step 1: Load Prior Context

- Read the delivery's code artifacts: `code-summary` (required),
  `cross-unit-traceability`, `build-and-test-summary`, and
  `build-test-results` — the record of what was built, how units integrate, and
  how they were verified. Read the per-unit `traceability` records from the
  construction record dir (`<record>/construction/*/`) for the
  requirement→code map; it is produced per stage, so it is read from the record
  dir rather than as a single resolved input.
- Read every stage diary for this intent at `<record>/<phase>/<stage>/memory.md`
  (Interpretations / Deviations / Tradeoffs / Open questions).
- Read the active method chain (`aidlc/spaces/<active-space>/memory/` —
  `org.md`, `team.md`, `project.md`) so process-learning candidates can be
  checked for redundancy against what is already a rule.

### Step 2: Co-author Code Documentation with the Customer  [Lane 1 — primary]

Working with the customer, consolidate the code artifacts and build-time context
into durable documentation, written to the customer's workspace alongside their
code:

- **`architecture-decision-record`** — the significant design decisions of this
  delivery and *why* each was made (options considered, the choice, the
  tradeoff). Grounded in `code-summary` and the Deviations/Tradeoffs diary
  entries, not invented.
- **`codebase-orientation`** — how the units fit together: the load-bearing
  modules, entry points, the map from `cross-unit-traceability`. The doc a new
  maintainer reads first.
- **`known-limitations-register`** — shortcuts taken, deferred work, tech debt,
  and assumptions a maintainer must not break. Drawn from Deviations/Tradeoffs
  and any failing/skipped items in `build-test-results`.
- **`code-lessons`** — reusable patterns and pitfalls specific to *this*
  codebase ("next time in this repo, do X / avoid Y"). These are lessons about
  the code, distinct from the AI-DLC process learnings in Lane 2.

Present drafts for the customer's review; capture verbatim where they add or
correct. Do not paraphrase a decision into something they did not say.

### Step 3: Cluster & Rank Process-Learning Candidates  [Lane 2 — secondary]

- Group recurring diary entries across stages. A cluster is a set of entries
  expressing the same interpretation, deviation, or tradeoff about the
  *process*, not the code.
- Rank clusters by recurrence (how many stages/units raised it) and breadth.
- **Parked Open questions stay parked** — research items, never promotion
  candidates (unchanged §13 rule).
- Drop clusters already covered by an existing rule in the method chain.

### Step 4: Generate Questions

Create the questions file surfacing both lanes:
- **Lane 1:** the code-documentation drafts, for the customer to confirm,
  correct, or extend.
- **Lane 2:** for each ranked process-learning cluster — the candidate practice
  line (verbatim from the diary), its routed destination heading (testing →
  `## Testing Posture`, prohibition → `## Forbidden`, general → `## Corrections`),
  and a widen affordance (promote to `team.md`, or mark org-worthy for a
  framework proposal).

Follow stage-protocol.md question flow.

### Step 5: Admission Conflict-Check  [Lane 2]

For each kept process-learning candidate, compare the proposed practice line
against `org.md`'s matching `## <section>` — the single-line variant of the
admission check in `stage-protocol-learnings.md`. On a conflict, surface the org
sentence inline; the human revises, skips, or escalates. Only conflict-clear or
escalated candidates proceed to the write. (Lane 1 code docs are customer-owned
and are not subject to this check.)

### Step 6: Persist

- **Code documentation (Lane 1)** → written to the customer's workspace as the
  delivery's documentation. This is a deliverable, not AI-DLC memory; it does
  not touch the tier files.
- **Project / team process learnings (Lane 2)** → persist through the
  deterministic writer `{{INVOKE}} engine learnings persist`, into `project.md`
  (default) or `team.md` (widened). Same locked, audited, `cid:`-deduped path as
  §13 — never hand-edit a memory file, and never introduce a new tier file.
- **Org-worthy candidates (Lane 2)** → write the `org-promotion-proposal`
  artifact only: a markdown document framed as a proposal against `org.md`
  (problem, proposed rule, evidence of recurrence). This stage **never** writes
  `org.md` — org changes remain release-gated; the proposal is an input to that
  release.
- Record every promotion (and every skip, with reason) in `promotion-log`.

### Step 7: Completion Handoff

Hand completion to `stage-protocol.md` via
`{{INVOKE}} engine orchestrate report --stage retrospective --result <outcome>`.
That `report` call owns every lifecycle transition and advancement; never
perform one in prose, and never narrate this bookkeeping to the user.

### Step 8: Present Completion & Request Approval

Completion emoji: :mag:
Review path: `<record>/operation/retrospective/`
Approval gate: Approve / Request Changes / Skip Promotions.

On approval, the code documentation is part of the delivery, and any persisted
process learnings are live for the next workflow's compile (the resolver picks
them up automatically). The org-promotion-proposal, if any, is left for a human
to carry into a framework contribution.

## Sensors

This stage's outputs are markdown artefacts under `<record>/operation/retrospective/`.

Imports: `required-sections`.

This stage deliberately omits `upstream-coverage`: its process-learning inputs
are the per-stage `memory.md` diaries and the audit shards, which are not
`consumes` artifact edges, so there are no upstream artifact targets to cover.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working and run the ritual before the approval gate, applying its bootstrap,
`single: true`, per-unit, and gate-revision exemptions. When the module is absent,
skip both the diary and the ritual. This stage aggregates the same ritual across
the intent (Lane 2); it does not replace the per-stage capture.
