# `aidlc-worktree info` — Output Schema

Pinned schema and exit-code contract for the `info` subcommand. The orchestrator's halt-and-ask prose at `SKILL.md` reads this output to interpolate the worktree path and branch name into the structured-question prompt body for code-generation-failure halt-and-ask.

This schema is the contract between the tool (deterministic) and the LLM (prose composition). Future changes to the JSON shape must update this file in the same commit.

## Usage

```
bun .aidlc/tools/aidlc-worktree.ts info --slug <kebab-slug>
```

The slug is the kebab-case Bolt identifier threaded through every per-Bolt worktree command (`create`, `verify`, `merge`, `discard`). See `SKILL.md` per-Bolt loop "Slug derivation" paragraph for the `name → slug` transformation.

## Exit codes

| Exit | Meaning | stdout | stderr |
|------|---------|--------|--------|
| 0 | Hit — JSON emitted | JSON object (see below) | (empty) |
| 1 | Miss — no `WORKTREE_CREATED` for slug, OR malformed block | (empty) | one-line error message |

The exit-code contract mirrors `verify`'s semantics: non-zero is the halt signal. The orchestrator's prose treats any non-zero exit as "no worktree to render" and falls back to the carve-out failure shape (verify-failed or dev-rejection) — but in practice this is unreachable for the wired invocation path (code-generation failure at Step 1 always has `WORKTREE_CREATED` in audit by Step 0).

## JSON output shape (exit 0)

```json
{
  "slug": "onboarding-wizard",
  "path": "/Users/dev/project/.aidlc/worktrees/bolt-onboarding-wizard",
  "branch_name": "bolt-onboarding-wizard",
  "audit_timestamp": "2026-05-18T12:34:56Z",
  "merge_held": false
}
```

Field semantics:

- **`slug`** — echoes the input `--slug` flag verbatim. The slug is the bare kebab-case identifier (e.g. `onboarding-wizard`); the `bolt-` prefix on `path` and `branch_name` is added by `lib.ts:139` `worktreePath()` and the `aidlc-worktree create --slug <slug>` invocation. See SKILL.md per-Bolt loop "Slug derivation" paragraph for the `name → slug` transformation that produced the bare slug. The orchestrator uses this field to confirm correlation, not to pick a different one.
- **`path`** — absolute filesystem path of the per-Bolt worktree at `<projectDir>/.aidlc/worktrees/bolt-<slug>`, parsed from the most-recent matching `WORKTREE_CREATED`'s `**Worktree path**:` field. The user `cd`s here to inspect a paused Bolt.
- **`branch_name`** — git branch name on which the worktree sits at `bolt-<slug>`, parsed from `**Branch name**:`. Quoted from audit for source-of-truth consistency.
- **`audit_timestamp`** — ISO 8601 timestamp of the matching `WORKTREE_CREATED` block. Useful for the orchestrator to reason about freshness; not currently surfaced in the AUQ prompt.
- **`merge_held`** — boolean reflecting the `Merge-Held` field in the per-Bolt forked state at `<path>/aidlc-docs/aidlc-state.md` (`true` only if the file exists AND the field reads `true`; absence resolves to `false`). The orchestrator reads this on resume to decide whether dispatching `aidlc-bolt complete --merge --slug <slug>` is safe. The held state is set by `aidlc-bolt hold-merge --slug <slug>` before a multi-failure halt-and-ask sequence opens and cleared by `aidlc-bolt release-merge --slug <slug>` once all sibling AUQs resolve.

## Most-recent semantics

`info` returns the **most-recent** `WORKTREE_CREATED` for the slug — meaning the latest by audit-log position (end-to-start walk via `findLatestEvent`). When a slug has been created → discarded → re-created within the same workflow, the second create's path is what `info` returns. This matches the user's mental model: "the live worktree for slug X."

The retry-then-fail scenario (code-gen fails, user picks Retry, code-gen fails again) does not create a new `WORKTREE_CREATED` — Retry re-runs the existing worktree per the SKILL.md per-Bolt loop. So `info`'s output is stable across retry attempts. Pinned by `tests/worktree/t11-halt-and-ask-retry-correlation.sh`.

## Stderr error messages

Three stable messages the orchestrator can route on (though it rarely needs to — exit code is sufficient):

```
error: no WORKTREE_CREATED audit entry for slug <slug> (audit log absent)
error: no WORKTREE_CREATED audit entry for slug <slug>
error: malformed WORKTREE_CREATED block at <timestamp> (missing Worktree path or Branch name field)
```

The third (malformed-block) case is the audit-of-intent reconciliation surface: doctor handles flagging and remediation; `info` just refuses to guess.

## AUQ prompt rendering — long-path fallback

The orchestrator interpolates `path` and `branch_name` into the structured question prompt body, which renders at full terminal width and wraps gracefully (multi-line wrap is supported on macOS Claude Code; verified manually before each release).

If a future surface (Windows PowerShell, mosh, narrow tmux pane) clips long paths in `question`, the documented fallback is to truncate with leading-ellipsis at directory boundaries while preserving the `bolt-<slug>` tail:

```
.../project/.aidlc/worktrees/bolt-onboarding-wizard
```

This fallback is **not currently implemented** — current shipping behaviour assumes graceful wrap. If a regression surfaces, add a `--max-path-display <chars>` flag to `info` and have the orchestrator truncate per the rule above.

## Related files

- Implementation: `.aidlc/tools/aidlc-worktree.ts` (`handleInfo` handler)
- Test: `tests/unit/t72-worktree-info.sh`
- Caller: `.aidlc/skills/aidlc/SKILL.md` (per-Bolt-loop halt-and-ask flow)
- Audit emitter that produces the `WORKTREE_CREATED` entries `info` reads: `aidlc-worktree.ts` `handleCreate` (also in this file at `~line 154`)
- Audit-format spec: `.aidlc/knowledge/aidlc-shared/audit-format.md` `WORKTREE_CREATED` row
