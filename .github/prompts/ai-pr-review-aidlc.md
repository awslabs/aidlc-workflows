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
- Challenge the inputs a normal run produces: missing, stale, or old-format
  state after an upgrade; an interrupted, retried, or resumed session; a second
  chat on the same work; a Windows or CRLF checkout; a team clone; mixed
  release versions across a team. Do not report forged records, hand-made
  files, races between processes, or failing disks and writes (out of scope in
  the shared contract).
- Check relative and absolute paths, links the person's own setup uses (a
  dotfiles link, a linked worktree), multiple repositories, ambiguous
  selectors, validation after mutation, and silent fallback where a normal run
  reaches them. A guard that fails toward the person's last instruction is the
  intended design (AGENTS.md, Guards), not a defect.
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

Report only defects this head causes or makes worse; a gap the base already
has is a "Pre-existing:" P2 at most (shared contract). Each candidate must
identify the trigger, execution path, observable result, violated contract, and
suggested fix. Consolidate shared root causes and discard speculation,
duplicate findings, unchanged-line nits, and findings conclusively owned by
deterministic CI.
