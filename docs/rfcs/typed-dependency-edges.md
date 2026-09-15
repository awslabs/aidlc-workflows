# [RFC]: Typed dependency edges for selective invalidation propagation

## Summary

Follow-up to #716 (detection substrate, merged as 2.6.62) and #881 (scope-aware
resolver, schema-3 receipts). This RFC proposes the smallest change to the
existing propagation algorithm that lets consumer declarations tell the engine
what a stage actually depends on, so that harmless producer edits stop
cascading pessimistically. Concretely: add an optional `sensitivity` field on
`consumes` entries (`structure` | `content`), carry it through schema-3
completion receipts, and filter direct-edge propagation by the producer's
observed change class. Backward-compatible by construction — undeclared
sensitivity keeps pre-PoC "any change propagates" behavior.

Section-scoped basis (`read_scope`, requiring schema-4 receipts) is
deliberately deferred to an immediate follow-up so this RFC stays a small,
evidence-backed step over the merged detector.

## Motivation

The merged detector correctly reports drift, but its propagation is a
worst-case cascade: any change to a completed producer marks every completed
consumer as `needs-revalidation`. On the current graph (139 consume edges
across 33 stages, with `requirements` alone reaching 9 consumers), a single
byte edit to a widely-consumed artifact fans out broadly, most of it usually
harmless. Because the detector is authoritative, workflows either learn to
ignore the signal (undermining #716) or land expensive full-suffix re-executions
they did not need.

The reviewer already predicted this class of pain when they asked #878 to
defer enforcement pending "meaningful change" semantics. This RFC gives the
detector the missing distinction one step at a time: what does the consumer
say it cares about? A traceability step that only observes existence and a
code-generation step that reads bytes should not react identically to the same
producer edit.

This RFC keeps the resolver, receipt schema owner, migration contract, and
audit-authority contract from #716 / #881 untouched. Only the fields consumed
by direct-edge propagation change.

## Inherited contract

Treated as fixed substrate from the merged behavior:

- `inspectStageValidity` remains read-only and deterministic.
- Schema-3 STAGE_COMPLETED receipts remain the only tracked basis. Schema-2
  and receipt-less completions remain untracked and fail open.
- Direct-stage drift detection (basis diff) is unchanged.
- The transitive propagation shape (BFS over `observed_input_edges`) is
  preserved. Only the per-edge fire predicate changes.
- Advisory routing: enforcement still gated by #878.
- Per-render statusline inspection remains out of scope.
- The maintainer follow-up on untracked-only histories (`/aidlc --status`
  only) remains intact.

## Detailed proposal

### Schema addition — `Consume.sensitivity`

```ts
export interface Consume {
  artifact: string;
  required: boolean;
  conditional_on?: "brownfield" | "greenfield";
  sensitivity?: "structure" | "content"; // NEW
}
```

- `content` (default when interpreting a stale receipt whose consume declared
  nothing): consumer depends on the bytes. Propagate when the producer's
  `contentHash` for this artifact changed.
- `structure`: consumer depends only on the file set / paths / kinds.
  Propagate when the producer's `structureHash` changed.
- Absent on a receipt (legacy schema-2 or schema-3 receipt captured before
  this RFC lands): treated as pessimistic (any hash change propagates),
  keeping the exact pre-RFC behavior for those rows.

Schema-3 receipts remain wire-compatible: the new field appears only on rows
whose stage declared it. Stages that declare nothing continue to write the
same bytes they wrote yesterday.

### Receipt path

`ArtifactBasis` gains an optional `sensitivity` on INPUT rows only.
`captureInputBasis` copies the declaration through when present. Output rows
are unchanged — sensitivity is a consumer property, not a producer property.

### Propagation change

`propagateStageInvalidation` gains an optional
`producerOutputChanges: Map<producer_slug, Map<artifact, { structure, content }>>`
computed by `inspectStageValidity` from receipt vs current output basis. The
per-edge predicate becomes:

```
if edge.sensitivity && producerOutputChanges is provided:
  changes = producerOutputChanges[current.slug][edge.artifact]
  if changes is known:
    propagate iff (edge.sensitivity == "content" ? changes.content : changes.structure)
```

Transitive hops (nodes queued via an earlier propagation, not themselves in
`directReasons`) have no concrete change info and continue pessimistically.
This is intentional MVP scope: a false-negative at hop N+1 is impossible
because the producer at hop N is by definition marked stale by hop N-1's
propagation.

### Deterministic A/B evidence (from `tests/unit/t330-selective-propagation.test.ts`)

Fixture: Producer `A` → three consumers `B` (`sensitivity: content`), `C`
(`sensitivity: structure`), `D` (undeclared).

| Payload | Producer change class | Baseline propagation | Candidate propagation |
| --- | --- | --- | --- |
| P1 · content-only edit (e.g. typo in an appendix section) | structure ❌, content ✓ | B, C, D | **B, D** — C skipped |
| P2 · structure-only edit (e.g. new unit instance added) | structure ✓, content ❌ | B, C, D | **C, D** — B skipped |
| P3 · both (semantic reshape + rewrite) | structure ✓, content ✓ | B, C, D | B, C, D |
| No declaration anywhere | (any) | B, C, D | B, C, D (identical) |

The existing propagation test (`t310-stage-validity-propagation.test.ts`)
continues to pass 29/29 (61 assertions) with the additive parameters,
confirming the pre-RFC caller contract is preserved.

## Immediate follow-up (not this RFC)

- **`read_scope` (schema-4 receipts)** — Section-scoped fingerprints so a
  `content`-sensitive consumer that reads only `## API` of a design document
  is not disturbed by an edit to `## Appendix`. This RFC's `contentHash` is
  whole-artifact, so the "typo in the appendix still propagates to code
  generation" case is not solved by sensitivity alone. Section-scoped basis
  needs a schema-4 receipt (structure/content hashes per declared section),
  a `read_scope` field on `consumes`, and a section-aware diff.

- **`edge_kind` on `requires_stage`** — The current propagation deliberately
  excludes `requires_stage` because it cannot distinguish semantic from
  ordering-only edges (see the comment in `aidlc-validity.ts`). A typed
  distinction (`semantic` | `ordering`) would let the engine propagate
  through semantic requires-edges too, catching stales that currently slip
  through when a stage depends on another's output without declaring a
  consume. Deferred because no current stage exhibits the missed-propagation
  case; the schema slot is worth reserving alongside `read_scope`.

Both follow-ups sit on top of the substrate this RFC lands. Neither reopens
this RFC's contract.

## Acceptance criteria

- Stages that declare no sensitivity route identically to pre-RFC (guarded
  by t310 and the no-declaration case in t330).
- Producer content-only change with a structure-sensitive consumer does not
  propagate to that consumer.
- Producer structure-only change with a content-sensitive consumer does not
  propagate to that consumer.
- Legacy schema-2 receipts and receipt-less completions continue to
  fail-open exactly as today.
- Receipt bytes are byte-identical for stages whose consumes did not gain a
  sensitivity declaration.
- Generated harness trees remain package-parity clean.

## Validation plan

Reuse the existing validity fixtures for direct drift, transitive
propagation, optional absent inputs, cycles, reopened roots, legacy
receipts, unavailable capture, effective-plan awareness (schema-3), and
untracked histories. Extend for:

- The three payload classes above (content-only, structure-only, both) with
  mixed-sensitivity consumers, covering both the direct-edge filter and the
  transitive pessimism boundary.
- A conditional consume that declares sensitivity and is skipped by
  `conditional_on` on the active project type — sensitivity does not
  resurrect a filtered-out edge.
- A required-optional-mix producer whose optional artifact appears for the
  first time (presence change on producer output) — content-sensitive
  consumers still propagate because appearance shows in both hashes.
- End-to-end filesystem case: real audit shards, real files, sensitivity
  declared on a subset of consumers, mutation applied only to one artifact.

## Alternatives considered

- **Do nothing; wait for `read_scope` to solve everything.** Rejected
  because a whole-artifact filter still eliminates the "presence-only" and
  "structure-only" consumer classes that appear in real graphs (traceability,
  approval-handoff, existence-checks). Sensitivity is a real subset win and
  the schema slot that read_scope will reuse.
- **Bundle `read_scope` into this RFC.** Rejected for scope discipline:
  section-scoped basis requires a schema-4 receipt, a section-aware diff,
  and per-stage declaration of read regions. Landing sensitivity first
  isolates the receipt-vs-diff change from the section-model change.
- **Bundle `edge_kind` into this RFC.** Rejected because no current stage
  exhibits the "missing propagation via requires_stage" it would catch. The
  design slot is worth reserving but should be motivated by a real case
  before landing.
- **Compute change class in the caller and pass in already-filtered edges.**
  Rejected because it splits the propagation contract across two modules
  and complicates transitive-hop handling. Filtering inside
  `propagateStageInvalidation` keeps the algorithm inspectable in one place.

## Drawbacks

- Adds one optional field to the consumer-facing schema. Stage authors need
  to decide whether to annotate. Undeclared = today's behavior, so
  annotation is a per-edge opt-in with strictly reducing false positives.
- Transitive propagation remains pessimistic. Consumers deep in the graph
  see the same cascade they see today. The change is meaningful primarily
  at direct-edge boundaries.
- The MVP does not close the "typo in a specific section" case that motivated
  the follow-up direction. That waits for `read_scope`.

## Additional context

- Merged detection substrate: #716 (2.6.62).
- Effective-plan / schema-3 correction: #881 (2.6.77).
- Enforcement RFC (open): #878.
- PoC branch and evidence: `feat/typed-dependency-edges` on
  `djoo-lgcns/aidlc-workflows`, commit `88655294` and test
  `tests/unit/t330-selective-propagation.test.ts` (7/7 pass, deterministic).

## Decisions requested

1. **Default sensitivity when absent from a schema-3 receipt row.** This RFC
   proposes "pessimistic (any change propagates)" to preserve the exact
   pre-RFC behavior for existing rows. Alternative: default to `content`,
   which would silently change propagation for the small class of edges
   whose only difference is structure (rename with same bytes). Preserving
   pre-RFC behavior seems safer; confirm.
2. **Reserved values in `sensitivity`.** Should we reserve `presence` in
   the union now for the schema-4 `read_scope` follow-up (so authors can
   already annotate presence-only edges, treated as `structure` until
   schema-4 lands)? Or keep the union minimal and add later?
3. **Receipt migration.** Should schema-3 receipts written before this RFC
   lands be re-classified as pessimistic at inspection time, or wait for
   normal re-completion to acquire a sensitivity field? Proposal: wait for
   re-completion (no active migration; consistent with #716's fail-open
   contract).
4. **Follow-up sequencing agreement.** Do we agree that `read_scope`
   (schema-4) is the next step after this RFC, and that `edge_kind` on
   `requires_stage` waits for a real missed-propagation case? This affects
   how #878's decision on "block all known drift" evolves — a smaller
   detected-stale set narrows the barrier's scope.
