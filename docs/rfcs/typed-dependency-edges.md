# [RFC]: Typed dependency edges for selective invalidation propagation

Revision 2 — supersedes the initial draft after maintainer round-1 review
([#1001](https://github.com/awslabs/aidlc-workflows/issues/1001#issuecomment-5521355176)).
Naming change (`sensitivity` → `recheck_if`) and added content on always-
recheck classes, byte-identical re-runs, and the advisory-message contract.

## Summary

Follow-up to #716 (detection substrate, merged as 2.6.62) and #881 (scope-
aware resolver, schema-3 receipts). This RFC proposes the smallest change to
the merged propagation algorithm that lets consumer declarations tell the
engine what class of change should trigger a recheck, so that harmless
producer edits stop cascading pessimistically. Concretely: add an optional
`recheck_if` field on `consumes` entries (`edited` | `files-added-or-removed`
| `changed`), carry it through schema-3 completion receipts, and filter
direct-edge propagation by the producer's observed change class.

Backward-compatible by construction — an absent `recheck_if` on an existing
receipt row is treated as `changed`, exactly the pre-RFC "any change
propagates" behavior. Unknown values fail loudly at graph compile.

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
ignore the signal (undermining #716) or land expensive full-suffix re-
executions they did not need.

This RFC gives the detector the missing distinction one step at a time:
what does the consumer say it needs to be rechecked for? A traceability
step that only observes whether specific files exist and a code-generation
step that reads bytes should not react identically to the same producer
edit.

Nothing in this RFC touches the resolver, receipt schema owner, migration
contract, or audit-authority contract from #716 / #881. Only the fields
consumed by direct-edge propagation change.

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

### Schema addition — `Consume.recheck_if`

```ts
export interface Consume {
  artifact: string;
  required: boolean;
  conditional_on?: "brownfield" | "greenfield";
  recheck_if?: "edited" | "files-added-or-removed" | "changed"; // NEW
}
```

Values are past-tense facts about the input artifact. The stage author
reads the line aloud and predicts the behavior without consulting this
RFC:

- **`edited`** — recheck when the input's bytes changed. Mirrors
  `contentHash` movement on the producer's output.
- **`files-added-or-removed`** — recheck when the input's file set
  changed (a rename is remove + add). Mirrors `structureHash` movement.
- **`changed`** — recheck on any change. Top of the lattice; equivalent
  to omitting the field, but written down. An author uses this to
  make intentional strictness visible; advisories name the effective
  policy the same way (`policy: changed, default`).

Omission means `changed`. A recorded fact must not change meaning
underneath the workflow that recorded it, so a schema-3 receipt row
written before this RFC lands (which cannot carry `recheck_if`) is
interpreted as `changed` — bit-identical to the pre-RFC behavior for
those rows.

**Unknown values fail loudly at graph compile** — never fall back to the
default. Absence is meaningful (the pre-RFC row), invalid presence is
an error naming the state file and the allowed values.

**Reserved future value.** A `created-or-deleted` slot is anticipated
for the schema-4 `read_scope` follow-up but is not accepted today.
Accepting a value that silently means something else until schema-4
lands would be a scheduled behavior change. The grammar (past-tense
verb phrase) is designed to make that addition read cleanly when it
arrives.

### Receipt path

`ArtifactBasis` gains an optional `recheck_if` on INPUT rows only.
`captureInputBasis` copies the declaration through when present. Output
rows are unchanged — `recheck_if` is a consumer property, not a producer
property.

### Propagation change

`propagateStageInvalidation` gains an optional
`producerOutputChanges: Map<producer_slug, Map<artifact, { filesAddedOrRemoved, edited }>>`
computed by `inspectStageValidity` from receipt vs current output basis.
The per-edge predicate becomes:

```
if edge.recheck_if in {"edited", "files-added-or-removed"} AND producerOutputChanges is provided:
  changes = producerOutputChanges[current.slug][edge.artifact]
  if changes is known:
    edited                     → fire iff changes.edited
    files-added-or-removed     → fire iff changes.filesAddedOrRemoved
otherwise (changed / omitted): fire on any producer stale (pre-RFC behavior)
```

Transitive hops (nodes queued via an earlier propagation, not themselves
in `directReasons`) have no concrete change info and continue
pessimistically. This is intentional MVP scope: a false-negative at hop
N+1 is impossible because the producer at hop N is by definition marked
stale by hop N-1's propagation.

### Always-recheck classes (never declarable, documented so nobody asks)

Three change classes always trigger direct recheck of the producing
stage regardless of any consumer `recheck_if`, because they affect the
identity of the stage itself:

1. **Own outputs mutated** after completion — the receipt's output basis
   no longer matches the current output basis on the producing stage
   itself. Directly stale.
2. **Graph-contract change** on the producing stage (the fingerprinted
   subset relevant to artifact validity moved). Directly stale.
3. **Project-type change** (brownfield ↔ greenfield). Directly stale.

`recheck_if` only narrows how a producer's direct stale flag propagates
onward through observed consumer edges. It never masks direct staleness
of the producer itself, and it never governs 1–3. If tolerance to any of
these is ever wanted, that belongs in the #878 policy discussion, not
here.

### Emergent property — byte-identical re-execution never flags consumers

A producer that re-executes and writes byte-identical outputs moves
neither `structureHash` nor `contentHash`. Its direct-stale check
passes, `computeProducerOutputChanges` records
`{filesAddedOrRemoved: false, edited: false}` for every output artifact,
and no consumer edge fires regardless of its declared `recheck_if`.

**The trigger is a changed result, not a re-run.** This holds for the
default and every declared value, and it holds without a `changed`
consumer opt-in — because at hop 0 the producer itself is not stale, so
propagation never starts. Written down here so nobody proposes an "if
producer re-ran, mark all consumers stale" shortcut later.

### Advisory-message contract

When an edge fires under the default (`changed` or omitted) and its
declared consumer read pattern would obviously narrow to a specific
class, the advisory teaches the narrowing move rather than just naming
the fact. Example:

```
[validity] "code-generation" needs revalidation because
"design" was edited (contentHash moved).
Policy on this edge: changed (default).
If this stage only depends on the file list of "design", declare
  recheck_if: files-added-or-removed
on its consume of "design" to skip on future edited-only changes.
```

An edge that already declared `edited` or `files-added-or-removed` and
still fires does not carry the narrowing hint — it already narrowed.
The exact message wording lives with the implementation, not this RFC;
the contract is: **the message names the effective policy and, when
narrowing is possible, tells the author which value would silence it.**

### Deterministic A/B evidence (from `tests/unit/t330-selective-propagation.test.ts`)

Fixture: Producer `A` → four consumers:
- `B` (`recheck_if: edited`)
- `C` (`recheck_if: files-added-or-removed`)
- `D` (undeclared, pessimistic)
- `E` (`recheck_if: changed`, explicit pessimistic)

| Payload | Producer change class | Baseline propagation | Candidate propagation |
| --- | --- | --- | --- |
| P1 · edited-only (typo in an appendix section) | edited ✓, files ❌ | B, C, D, E | **B, D, E** — C skipped |
| P2 · files-added-or-removed (new unit instance) | edited ❌, files ✓ | B, C, D, E | **C, D, E** — B skipped |
| P3 · both (semantic reshape + rewrite) | edited ✓, files ✓ | B, C, D, E | B, C, D, E |
| P4 · byte-identical re-run | edited ❌, files ❌ | (empty) | (empty) |
| No declaration on any edge | (any) | B, C, D, E | B, C, D, E (identical) |

Consumer `E` (`changed`) is identical to `D` (undeclared) across every
payload — the explicit spelling of the default matches its own semantics.

The existing propagation test (`t310-stage-validity-propagation.test.ts`)
continues to pass 29/29 (61 assertions) with the additive parameters,
confirming the pre-RFC caller contract is preserved.

## Immediate follow-up (not this RFC)

- **`read_scope` (schema-4 receipts)** — Section-scoped fingerprints so a
  consumer that reads only `## API` of a design document is not disturbed
  by an edit to `## Appendix`. This RFC's `edited` trigger is whole-
  artifact, so the "typo in the appendix still propagates to a byte-
  reading consumer" case is not solved by `recheck_if` alone. Section-
  scoped basis needs a schema-4 receipt (structure/content hashes per
  declared section), a `read_scope` field on `consumes`, and a section-
  aware diff.
  
  Composition note: `read_scope` should compose with the `edited` trigger
  scoped to specific sections, not become a fourth enum value.

- **`edge_kind` on `requires_stage`** — The current propagation
  deliberately excludes `requires_stage` because it cannot distinguish
  semantic from ordering-only edges. A typed distinction
  (`semantic` | `ordering`) would let the engine propagate through
  semantic requires-edges too, catching stales that currently slip
  through when a stage depends on another's output without declaring a
  consume. Deferred until a real missed-propagation case appears; the
  schema slot is worth reserving alongside `read_scope`.

Both follow-ups sit on top of the substrate this RFC lands. Neither
reopens this RFC's contract.

## Acceptance criteria

- Stages that declare no `recheck_if` route identically to pre-RFC
  (guarded by t310 and the no-declaration case in t330).
- Producer edited-only change with a `files-added-or-removed` consumer
  does not propagate to that consumer.
- Producer files-added-or-removed change with an `edited` consumer does
  not propagate to that consumer.
- Consumer `recheck_if: changed` behaves identically to omission.
- Producer byte-identical re-execution flags no consumer.
- Own-output mutation, graph-contract change, and project-type change
  always mark the producer directly stale (never masked by any consumer
  declaration).
- Unknown `recheck_if` value at graph compile is a validation error
  naming the file and the allowed values.
- Legacy schema-2 receipts and receipt-less completions continue to
  fail-open exactly as today.
- Receipt bytes are byte-identical for stages whose consumes did not
  gain a `recheck_if` declaration.
- Generated harness trees remain package-parity clean.

## Validation plan

Reuse the existing validity fixtures for direct drift, transitive
propagation, optional absent inputs, cycles, reopened roots, legacy
receipts, unavailable capture, effective-plan awareness (schema-3), and
untracked histories. Extend for:

- The four payload classes above (edited-only, files-only, both, byte-
  identical) with mixed-`recheck_if` consumers, covering both the
  direct-edge filter and the transitive pessimism boundary.
- A conditional consume that declares `recheck_if` and is skipped by
  `conditional_on` on the active project type — the declaration does
  not resurrect a filtered-out edge.
- A required-optional-mix producer whose optional artifact appears for
  the first time (files-added-or-removed change on producer output) — an
  `edited` consumer still propagates because appearance shows in both
  hashes.
- A schema validation case: `recheck_if: invalid-token` at graph compile
  produces a specific error message and no default fallback.
- End-to-end filesystem case: real audit shards, real files,
  `recheck_if` declared on a subset of consumers, mutation applied to
  one artifact.
- Advisory message case: an edge that fires under the default (`changed`
  or omitted) whose consume could have declared a narrower value
  produces the teaching hint; an edge that fires under `edited` or
  `files-added-or-removed` does not.

## Alternatives considered

- **Do nothing; wait for `read_scope` to solve everything.** Rejected —
  a whole-artifact filter still eliminates the "traceability /
  approval-handoff / existence-check" consumer classes that appear in
  real graphs. `recheck_if` is a real subset win and the schema slot
  that `read_scope` will reuse.
- **Bundle `read_scope` into this RFC.** Rejected for scope discipline:
  section-scoped basis requires a schema-4 receipt, a section-aware
  diff, and per-stage declaration of read regions. Landing `recheck_if`
  first isolates the receipt-vs-diff change from the section-model
  change.
- **Bundle `edge_kind` into this RFC.** Rejected because no current
  stage exhibits the "missing propagation via requires_stage" it would
  catch. The design slot is worth reserving but should be motivated by
  a real case before landing.
- **Compute change class in the caller and pass in already-filtered
  edges.** Rejected because it splits the propagation contract across
  two modules and complicates transitive-hop handling. Filtering inside
  `propagateStageInvalidation` keeps the algorithm inspectable in one
  place.
- **A `nothing` / `never` value that permanently silences a consumer
  edge.** Rejected — a one-word permanent alarm silencer is waiver-
  adjacent, and any permanent authority to skip a recheck belongs in
  the #878 policy discussion where it is audit-visible.

## Drawbacks

- Adds one optional field to the consumer-facing schema. Stage authors
  need to decide whether to annotate. Omission = today's behavior, so
  annotation is a per-edge opt-in with strictly reducing false
  positives.
- Transitive propagation remains pessimistic. Consumers deep in the
  graph see the same cascade they see today. The change is meaningful
  primarily at direct-edge boundaries.
- The MVP does not close the "typo in a specific section" case that
  motivated the follow-up direction. That waits for `read_scope`.

## Additional context

- Merged detection substrate: #716 (2.6.62).
- Effective-plan / schema-3 correction: #881 (2.6.77).
- Enforcement RFC (open): #878. Sequencing update posted after
  maintainer round-1 review here.
- PoC branch and evidence: `stage-validity-typed-edges` on
  `djoo-lgcns/aidlc-workflows`, draft PR #1002 and test
  `tests/unit/t330-selective-propagation.test.ts` (10/10 pass,
  deterministic).

## Decisions requested (revision 2)

The four decisions from revision 1 are resolved by maintainer round-1
(comment 5521355176). Remaining open item:

1. **Test-slot renumber.** Draft PR #1002's `t330-selective-propagation`
   collides with #1000's reserved `t328–t332` block (which includes
   `t330-authority-rebinding`). After #1000 merges, this file will move
   to the next free slot. No design consequence; noted here for the
   PR-round tracker.

All content changes from round 1 are folded into this revision:

- Field renamed `sensitivity` → `recheck_if`; values renamed to past-
  tense facts (`edited`, `files-added-or-removed`); `changed` added as
  the explicit spelling of the default.
- Unknown values fail loudly at graph compile.
- Reserved future value (`created-or-deleted`) documented as future
  work, not accepted today.
- Migration: no active reclassification; old rows stay pessimistic
  until natural re-completion mints a fresh receipt.
- Sequencing: `read_scope` (schema-4) is next; `edge_kind` on
  `requires_stage` waits for a demonstrated missed-propagation case.
- Always-recheck classes (own outputs, graph contract, project type)
  documented as never-declarable.
- Emergent property (byte-identical re-execution never flags consumers)
  documented and pinned in t330.
- Advisory-message contract (name the effective policy; teach the
  narrowing move when narrowing is possible).
