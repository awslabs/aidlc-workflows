# Summary

Implements RFC #3413: an opt-in `review_granularity` setting (`stage` | `phase`, default `stage` — today's behavior byte for byte). Under `phase`, Ideation and Inception agent review passes are deferred and run grouped: one pass per reviewer at that reviewer's last in-plan stage of the phase (the anchor), covering its deferred stages' artifacts together. Human approval gates are unchanged; Construction and `--single` runs are unaffected. On `mvp`, reviewer dispatches across ideation+inception drop 8 → 3; a real-model micro-benchmark of the Inception product-lead group measured −36.6% wall clock and −63.1% tokens with identical seeded-defect detection (details and methodology on the RFC).

## Changes

- **One owner for the new rule.** New module `core/tools/aidlc-review-granularity.ts`: `resolveReviewGranularity` (state `Review Granularity` field > scope `review_granularity:` frontmatter > `stage`) and `phaseReviewRole` (stage | deferred | anchor + covered stages), computed from the same inputs every boundary reads (scope grid, state EXECUTE/SKIP overrides, checkboxes, effective review class). `aidlc-lib.ts` gains no new top-level declarations (only the `ScopeMetadata.reviewGranularity` field and its frontmatter parse/validation beside `review_cap`).
- **Directive emit** (`aidlc-orchestrate.ts`): a deferred stage's `run-stage` directive omits the reviewer block (the existing `none`-resolution shape); the anchor's carries `review_covers` (`{slug, name}` per covered completed stage; stages already holding a fresh receipt are filtered out). New optional `run-stage` field registered and shape-validated in `aidlc-directive.ts`.
- **Gate precondition** (`aidlc-state.ts` `verifyReviewerPrecondition`): a deferred stage owes no receipt at its own gate; the anchor's gate re-enters the same precondition per covered stage, so a missing or stale grouped review refuses with that stage's exact request command. Receipts stay per stage — write-freeze, staleness, recovery, and jump/replay are untouched.
- **Protocol** (`stage-protocol-reviewer.md` §12a, new "Phase review (`review_covers`)" subsection): one request per covered stage, ONE reviewer dispatch over all artifacts, one verdict per stage, findings tagged per artifact, all findings presented at the anchor's gate; user-facing narration unchanged.
- **Settings plumbing** (mirrors `review`): `config set review-granularity <stage|phase>` / `config-change --review-granularity` through the shared setter (`aidlc-guard-switch.ts`), kept-for-next-work included; optional `intent-create --review-granularity` flag; status output shows the value when `phase`; new audit event `REVIEW_GRANULARITY_CHANGED` (registry, label map, state-machine tables, and the 131→132 count mentions updated).
- **Measurement**: `aidlc-log.ts review` appends one JSON line per request and per terminal verdict to `audit/review-metrics.jsonl` (timestamp, stage, reviewer, iteration, effective granularity, verdict, findings counts). Advisory-only: best-effort append, nothing reads it back, audit shard readers ignore non-`.md` files.
- **Docs**: user guide `13-customization.md` (new "Review granularity" section: what it does, when to use `phase`, the late-detection trade-off, how to enable) and `10-state-and-audit.md`; harness-engineering `04-scopes.md` (frontmatter key); reference `06-hooks-and-tools.md` (new module, emitter lists) and `12-state-machine.md` (event row, setting lists); `aidlc-shared/audit-format.md` registry row.

Per the release metadata policy, no version bump and no CHANGELOG entry in this PR.

## User experience

**Before:** every reviewer-bearing Ideation/Inception stage runs its own agent review pass before its gate — 8 reviewer dispatches on an `mvp` run — and the only dial is the review level (`review_cap` / `--review`), which trades strength, not placement.

**After (default):** identical — nothing changes unless a person or scope opts in.

**After (`/aidlc config set review-granularity phase`):** intermediate stages run straight to their (unchanged) approval gates without a review brief; at each reviewer's last stage of the phase the person hears the usual "let me have this checked over" once, and the gate then presents all of that reviewer's findings together, tagged per artifact — 3 dispatches on the same `mvp` run. The setter answers in plain words with the way back (`config set review-granularity stage`), `--status` shows the value, and a skipped or stale grouped review refuses at the anchor's gate naming the exact stage and command. A defect found late in an early artifact is repaired through the existing backward-jump → forward-replay flow with per-stage artifact reuse; the docs recommend `phase` for cost/speed-sensitive smaller scopes and `stage` for larger or unstable work.

## Checklist

If an item does not apply, leave it unchecked.

* [x] I have reviewed the [contributing guidelines](https://github.com/awslabs/aidlc-workflows/blob/main/CONTRIBUTING.md)
* [x] I have performed a self-review of this change
* [x] Changes have been tested
* [x] Changes are documented
* [ ] If this change adds an input to any fingerprint, epoch, or receipt identity, the description names the human-visible change it detects

## Test plan

- `bun test tests/unit/t-review-granularity.test.ts` — resolver precedence (state override > scope > default), grouping roles (defer/anchor/covers), plan sensitivity (a skip moves the anchor), construction/per-unit/capped-scope/single-member exclusions, setter CLI (state field, `REVIEW_GRANULARITY_CHANGED` row, plain-words line, invalid-value refusal before mutation).
- `bun test tests/unit/t-review-granularity-flow.test.ts` — real dist CLI end to end: deferred directive drops the reviewer block and the anchor carries `review_covers`; a deferred gate opens and approves with no receipt; the anchor gate refuses until every covered receipt is recorded (naming the stage and command) and then opens; the logger accepts a request for a covered completed stage; `review-metrics.jsonl` rows carry the granularity in both modes.
- Regression: all 49 review/reviewer/gate-related unit test files pass (933 cases, `bash tests/run-tests.sh --unit --filter review`); smoke tier passes; `bun scripts/package.ts --check` (byte-identical double build), full typecheck, and lint pass; the audit-event drift test (t48) passes against the updated tables.
- Manual verification script and measurements are posted on RFC #3413 (dispatch-count walk and the real-model benchmark).

## Acknowledgment

By submitting this pull request, I confirm that you can use, modify, copy, and redistribute this contribution, under the terms of the [project license](https://github.com/awslabs/aidlc-workflows/blob/main/LICENSE).
