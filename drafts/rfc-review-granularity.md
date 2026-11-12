# [RFC]: Opt-in `review_granularity` (stage | phase) — run Ideation/Inception reviews as one grouped pass per reviewer at the phase boundary

## Summary

Add a `review_granularity` setting with values `stage` (the default — today's
behavior, byte for byte) and `phase`. Under `phase`, the agent review passes of
Ideation and Inception stages are deferred and run **grouped**: each reviewer's
deferred reviews run together at that reviewer's last in-plan stage of the
phase (the anchor), covering all of its stages' artifacts in one pass. Human
approval gates are untouched — every stage still ends at its gate; only the
agent review moves. Construction reviews (per-Unit, entangled with convergence
checkpoints, loop-back, and swarm merging) always stay per stage, as do
`--single` isolated runs.

On the `mvp` scope this turns eight review dispatches into three (one in
Ideation; two in Inception, one per reviewer).

## Motivation

"v2 is too heavy" is recurring field feedback, and the per-stage review pass is
a large share of the prose-phase wall clock. A field partner in Korea patched
their install to run the review once per phase and reported, on an MVP-scope
engagement:

- review time/cost down roughly 55%,
- total workflow time/cost down roughly 16%,
- defect detection tended to *improve* — reviewing a phase's artifacts
  together gives the reviewer cross-artifact context (a story that drops a
  requirement, a design that drifts from the contract), which per-stage
  reviews structurally lack.

Teams should not each have to maintain a private patch for this. The right
shape is a supported, opt-in switch in the existing configuration mechanism,
so the default stays exactly as shipped and the trade-off is a deliberate
choice.

## Proposal

**Setting.** `review_granularity: stage | phase`, plumbed exactly like
`review_cap`:

- optional scope frontmatter key (`review_granularity: phase` in a custom
  scope), validated like `review_cap`;
- a per-work `Review Granularity` state field set through the shared setter
  (`config set review-granularity <stage|phase>` / `config-change
  --review-granularity`), audited as `REVIEW_GRANULARITY_CHANGED`;
- one resolver (`resolveReviewGranularity`: state field > scope frontmatter >
  `stage`).

The existing review *level* machinery is untouched: `review_cap` and
`--review` keep deciding whether and how strongly reviews run; granularity
only decides **where**. A scope capped to `none` (e.g. `express`) stays
reviewless in both modes.

**Phase mode mechanics.** One new pure function (`phaseReviewRole`) computes,
from the same inputs every boundary already reads (scope grid, state
EXECUTE/SKIP overrides and checkboxes, the effective review class), whether an
Ideation/Inception stage reviews in place, is **deferred**, or is its
reviewer's **anchor**:

- a deferred stage's `run-stage` directive simply omits the reviewer block
  (the same shape as a `none` resolution), and its gate owes no receipt;
- the anchor's directive carries its normal reviewer block plus
  `review_covers` (the completed deferred stages); the conductor records one
  review request **per covered stage**, dispatches the reviewer **once** with
  all artifacts, and records one verdict per stage;
- the anchor's gate precondition re-enters the existing per-stage receipt
  check for each covered stage, so a grouped review that was skipped or went
  stale refuses with that stage's exact next step.

Because receipts stay per stage, write-freeze, stale-receipt recovery, and
the backward-jump → forward-replay flow are unchanged. Editing a reviewed
artifact later invalidates that one stage's receipt, not the whole phase's;
mixed histories (granularity flipped mid-run) resolve naturally because a
covered stage that already holds a fresh receipt is not re-reviewed.

**Trade-off, stated up front.** A defect in an early artifact is caught at the
phase boundary instead of at that stage's gate, after later artifacts were
built on it. The repair path is the existing jump/replay with per-stage
artifact reuse, but it costs more than catching the defect early. The docs
recommend `phase` for cost/speed-sensitive work on smaller scopes (workshops,
POCs, MVPs) and `stage` for larger scopes or unstable requirements. The human
reading every artifact at every gate is unchanged in both modes.

## Measurement approach

So the two modes can be compared on real runs (and so this RFC's numbers can
be independently reproduced), the review command appends one JSON line per
request and per terminal verdict to `audit/review-metrics.jsonl` in the
intent's record: timestamp, stage, reviewer, iteration, effective granularity,
verdict, and findings counts. It is advisory-only (a failed append never
blocks a receipt; nothing reads it back; audit shard readers ignore non-`.md`
files). Duration per pass = a verdict row's timestamp minus its matching
request row's; a workshop diffs the two files across a stage-mode and a
phase-mode run.

This is deliberately a thin slice of #2795's proposed timing ledger, with
compatible intent: if/when the full per-Unit ledger lands, these rows can fold
into it.

## Relationship to existing discussions

- **#1209 (fast-lane scope / express-plus):** its proposed `gates:
  per-stage|phase` switch collapses **human approval gates**. This RFC moves
  only the **agent review pass** and keeps every human gate — an orthogonal
  axis using the same scope-owned-switch pattern (#1151 lineage). A lean scope
  like `express-plus` could set `review_granularity: phase` alongside its
  other switches.
- **#1059 (weighted rubric / measured gate):** orthogonal — it changes how a
  reviewer scores; this changes where the pass runs. The grouped pass feeds
  the same verdict path, so a rubric would apply unchanged.
- **#2795 (code-generation cost):** this RFC deliberately excludes
  Construction. Per #2795's analysis, Construction cost is dominated by
  repeated builds, not review dispatch count, and its reviews are entangled
  with convergence checkpoints, loop-back, and swarm paths that already have
  their own rules (e.g. autonomous swarm reviews are exempt from
  `review_cap`).

## Backward compatibility

- Default is `stage`; with the setting untouched, behavior is unchanged
  (pinned by the existing review-class and reviewer-ordering tests).
- No shipped scope sets `phase`; it is reachable only by explicit opt-in.
- One new audit event (`REVIEW_GRANULARITY_CHANGED`), one new directive field
  (`review_covers`, emitted only at a phase-mode anchor), one new metrics file
  that nothing reads back.

## Prior art / offer

The implementation exists against the current `core/` model (one new tool
module owning the resolution and grouping, directive emit + gate precondition
reading it, protocol §12a addition, setter plumbing, docs, and unit +
real-CLI flow tests), and a PR can follow if the direction is agreeable.
Credit for the field experiment and the phase-grouping observation goes to a
field partner in Korea.
