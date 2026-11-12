# feat: opt-in `review_granularity` (stage | phase) for Ideation/Inception reviews

RFC: #<rfc-issue-number>

## What this does

Adds a `review_granularity` setting (`stage` | `phase`, default `stage`).
Under `phase`, Ideation and Inception agent review passes are deferred and run
grouped — one pass per reviewer at that reviewer's last in-plan stage of the
phase (the anchor), covering its deferred stages' artifacts together. Human
approval gates are unchanged; Construction and `--single` runs are unaffected.
Default behavior is byte-for-byte today's.

Motivated by recurring "v2 is too heavy" field feedback; a field partner in
Korea measured roughly 55% lower review time/cost and 16% lower total
workflow time/cost on an MVP-scope run, with defect detection tending to
improve from the cross-artifact context. On `mvp`, review dispatches drop
8 → 3.

## How it works

- **One owner.** New module `core/tools/aidlc-review-granularity.ts`:
  `resolveReviewGranularity` (state `Review Granularity` field > scope
  `review_granularity:` frontmatter > `stage`) and `phaseReviewRole`
  (stage | deferred | anchor + covered stages), computed from the same inputs
  every boundary reads (scope grid, state EXECUTE/SKIP overrides, checkboxes,
  effective review class). `aidlc-lib.ts` gains no new declarations.
- **Directive emit** (`aidlc-orchestrate.ts`): a deferred stage's `run-stage`
  directive omits the reviewer block (the existing `none`-resolution shape);
  the anchor's carries `review_covers` (`{slug, name}` per covered stage,
  already-receipted stages filtered out). New optional `run-stage` field
  validated in `aidlc-directive.ts`.
- **Gate precondition** (`aidlc-state.ts` `verifyReviewerPrecondition`): a
  deferred stage owes no receipt at its own gate; the anchor's gate re-enters
  the same precondition per covered stage, so a missing/stale grouped review
  refuses with that stage's exact request command. Receipts stay **per
  stage**: freeze, staleness, recovery, and jump/replay are untouched.
- **Protocol** (`stage-protocol-reviewer.md` §12a, new "Phase review"
  subsection): one request per covered stage, ONE reviewer dispatch over all
  artifacts, one verdict per stage; findings tagged per artifact; all findings
  presented at the anchor's gate; user-facing narration unchanged.
- **Settings plumbing** (mirrors `review`): `config set review-granularity
  <stage|phase>` / `config-change --review-granularity` through the shared
  setter (`aidlc-guard-switch.ts`), kept-for-next-work included; optional
  intent-create flag; scope frontmatter key validated beside `review_cap`;
  status line shows the value when `phase`; new audit event
  `REVIEW_GRANULARITY_CHANGED` (131 → 132, registry + state-machine tables
  updated).
- **Measurement**: `aidlc-log.ts review` appends one JSON line per request and
  per terminal verdict to `audit/review-metrics.jsonl` (timestamp, stage,
  reviewer, iteration, effective granularity, verdict, findings counts).
  Advisory-only: best-effort append, nothing reads it back, shard readers
  ignore non-`.md` files.

## Compatibility

- Default `stage`; no shipped scope opts in; existing behavior unchanged
  (existing review-class/ordering tests still pin it).
- New directive field appears only at a phase-mode anchor.
- Mixed histories are safe: flipping to `phase` mid-run defers from the next
  stage on; a covered stage with a fresh receipt is not re-reviewed; flipping
  back restores per-stage reviews from the next stage on.

## Tests

- `tests/unit/t-review-granularity.test.ts` — resolver precedence, grouping
  (defer/anchor/covers), plan sensitivity (skips move the anchor), construction
  and capped-scope exclusions, setter CLI (state field, audit row, plain-words
  line, invalid-value refusal).
- `tests/unit/t-review-granularity-flow.test.ts` — real dist CLI end to end:
  deferred directive drops the reviewer block and the anchor carries
  `review_covers`; a deferred gate approves with no receipt; the anchor gate
  refuses until every covered receipt is recorded (naming the stage and
  command) and then opens; the logger accepts requests for covered completed
  stages; metrics rows carry the granularity in both modes.
- `bun scripts/package.ts --check` (determinism), full typecheck, biome lint,
  and the audit-event drift test (t48) pass.

## Docs

- User guide: `13-customization.md` (new "Review granularity" section: what it
  does, when to use `phase`, the late-detection trade-off, how to enable),
  `10-state-and-audit.md` (metrics file; event count).
- Harness engineering: `04-scopes.md` (frontmatter key).
- Reference: `06-hooks-and-tools.md` (new module; emitter lists),
  `12-state-machine.md` (event row; setting lists), event-count mentions.
- Knowledge: `aidlc-shared/audit-format.md` (registry row).

Per the release metadata policy, no version bump and no CHANGELOG entry in
this PR.
