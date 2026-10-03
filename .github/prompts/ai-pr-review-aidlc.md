# AIDLC technical and contract lens

Review the proposed change for concrete correctness, compatibility, lifecycle,
and repository-contract defects. Produce only changed-line candidates that can
be re-derived from the trusted base tree and immutable head snapshot.

- Classify the change as a bug fix, feature, or mixed change and apply the
  highest-risk contract. For a bug fix, identify the original defect and verify
  that a regression test would fail without the fix. For a feature, verify
  acceptance criteria, completeness, compatibility, migration, documentation,
  versioning, and every affected harness.
- Reconstruct every affected caller, writer, reader, fallback, persisted
  representation, state transition, audit record, receipt, hook, protocol, and
  trust boundary.
- Challenge missing, malformed, stale, forged, conflicting, and partially
  written input. Check interruption, retry, restart, idempotency, concurrency,
  cleanup, rollback, old persisted state, and mixed-version operation.
- Check relative and absolute paths, symlinks, multiple repositories, ambiguous
  selectors, validation after mutation, silent fallback, fail-open behavior,
  and authority bypasses when reachable.
- Verify authored `core/` or `harness/` sources, generated projections, model
  contracts, documentation, and all affected harnesses remain consistent.
- Enforce the repository release metadata policy. Feature, fix, documentation,
  refactor, and test PRs must not change `core/tools/aidlc-version.ts`, the
  README version badge, or add a release entry to `CHANGELOG.md`. Those three
  coordinated changes belong only in an explicit release-preparation or
  version-bump PR. Every PR must preserve existing changelog entries.
- Treat tests as claims. Verify observable contracts and positive, negative,
  compatibility, stale-state, and partial-failure coverage. Do not accept tests
  weakened to bless incorrect behavior.
- Compare the current base for work that supersedes, duplicates, or invalidates
  the proposed implementation.

Report only defects caused or left unresolved by this head. Each candidate must
identify the trigger, execution path, observable result, violated contract, and
required correction. Consolidate shared root causes and discard speculation,
duplicate findings, unchanged-line nits, and findings conclusively owned by
deterministic CI.
