# `aidlc-worktree info` — Output Schema

Pinned schema and exit-code contract for the `info` subcommand. The orchestrator's halt-and-ask prose at `SKILL.md` reads this output to interpolate the worktree path and branch name into the structured-question prompt body for code-generation-failure halt-and-ask.

This schema is the contract between the tool (deterministic) and the LLM (prose composition). Future changes to the JSON shape must update this file in the same commit.

## Usage

```
{{INVOKE}} engine worktree info --slug <kebab-slug>
```

The slug is the kebab-case Bolt identifier threaded through every worktree command for that Bolt (`create`, `verify`, `merge`, `discard`, `restore`, `purge`). See `SKILL.md` per-Bolt loop "Slug derivation" paragraph for the `name → slug` transformation.

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
- **`path`** — absolute filesystem path of the worktree hosting the Bolt at `<projectDir>/.aidlc/worktrees/bolt-<slug>`. New `WORKTREE_CREATED` rows store the `**Worktree path**:` project-relative; `info` resolves it against the project root. Legacy absolute rows remain accepted. The user `cd`s here to inspect a paused Bolt.
- **`branch_name`** — git branch name on which the worktree sits at `bolt-<slug>`, parsed from `**Branch name**:`. Quoted from audit for source-of-truth consistency.
- **`audit_timestamp`** — ISO 8601 timestamp of the matching `WORKTREE_CREATED` block. Useful for the orchestrator to reason about freshness; not currently surfaced in the AUQ prompt.
- **`merge_held`** — boolean reflecting the `Merge-Held` field in the per-Bolt forked state at `<path>/aidlc-docs/aidlc-state.md` (`true` only if the file exists AND the field reads `true`; absence resolves to `false`). The orchestrator reads this on resume to decide whether dispatching `aidlc-bolt complete --merge --slug <slug>` is safe. The held state is set by `aidlc-bolt hold-merge --slug <slug>` before a multi-failure halt-and-ask sequence opens and cleared by `aidlc-bolt release-merge --slug <slug>` once all sibling AUQs resolve.

## Most-recent semantics

`info` returns the **most-recent** `WORKTREE_CREATED` for the slug — meaning the latest by audit-log position (end-to-start walk via `findLatestEvent`). When a slug has been created → discarded → re-created within the same workflow, the second create's path is what `info` returns. This matches the user's mental model: "the live worktree for slug X."

The retry-then-fail scenario (code-gen fails, user picks Retry, code-gen fails again) does not create a new `WORKTREE_CREATED` — Retry re-runs the existing worktree per the SKILL.md per-Bolt loop. So `info`'s output is stable across retry attempts. Pinned by `tests/worktree/t11-halt-and-ask-retry-correlation.sh`.

## Worktree metadata repository provenance

New `.aidlc/worktree-meta.json` files store `gitCommonDirHash`, a 64-character
SHA-256 hex digest of the canonical Git common-directory path. The raw machine
path is not persisted. Merge validation hashes the selected checkout and
worktree common directories and compares the digests.

Migration remains compatible with older metadata carrying plaintext
`gitCommonDir`: readers hash that stored value before comparison. New metadata
must not write both fields.

## Recoverable discard, restore, and purge

`{{INVOKE}} engine worktree discard --slug <slug>` sets aside the working-tree
snapshot and reviewed source refs before emitting `WORKTREE_DISCARDED`, then
removes the live checkout and branch and compare-deletes the original reviewed
source refs. A temporary Git index and `commit-tree` capture tracked files and
non-ignored untracked files; ignored untracked files are not backed up.
Regular files with configured clean filters or `working-tree-encoding` retain raw
bytes, bypassing those transformations.

The parked namespace is `refs/aidlc/parked/<slug>/<stamp>`, where `stamp` is UTC
`YYYYMMDDTHHMMSSZ`, with a numeric `-N` suffix for collisions. `/head` points to
the snapshot commit with its raw working-tree blobs, with a `/snapshot` marker
pointing to that same commit. If the checkout is already gone but its branch
remains, `/head` instead preserves the branch tip, whose blobs are ordinary
committed forms, with a `/branch-tip` marker pointing to the same commit.
New parks with `/head` create exactly one of these two markers. `/reviewed-source/<commit>` preserves each
reviewed source ref. The discard JSON keeps `parked_ref` (the namespace prefix,
not its `/head` ref) and `parked_commit` (the snapshot commit or branch tip), and
adds `parked_stamp` (the exact stamp), `parked_mode` (`snapshot`, `branch-tip`, or
`evidence-only`), and `parked_repo` (`null` for the project root, otherwise the
sibling repository name). If only reviewed source refs remain to park,
`parked_mode` is `evidence-only`, `parked_commit` is `null`, and no `/head` exists
to restore; `parked_ref`, `parked_stamp`, and `parked_repo` still identify the
saved evidence.
The already-discarded response is unchanged and has no `parked_*` fields.

Successful `bolt abort` JSON echoes the supplied `--reason` text in `reason`.
Without `--discard`, it has no `parked_*` fields or `restore_hint`. With
`--discard` and a saved namespace, it echoes the discard descriptor's
`parked_ref`, `parked_stamp`, `parked_mode`, and `parked_repo`.
For a restorable attempt, `restore_hint` is the install's rendered worktree
invocation plus ` restore --slug <slug> --parked <stamp> --repo <name|.>`.
It always includes `--repo <name>` for a sibling or `--repo .` when `parked_repo`
is `null`. This selects the exact saved attempt and repository, not a later
attempt with the same slug. An evidence-only abort keeps all four descriptor
fields but omits both `restore_hint` and `parked_excludes`. The exclusions follow
the mode:

| `parked_mode` | `parked_excludes` |
|---|---|
| `snapshot` | `["ignored files", "eol/text=auto normalization"]` |
| `branch-tip` | `["uncommitted files (no working tree existed)"]` |
| `evidence-only` | Absent; only review evidence was kept, with no restorable files |

If a saved namespace is known but its discard descriptor is missing, the
fallback reports `parked_stamp`, `parked_mode`, and `parked_repo` as `null`, a
`restore_hint` ending in ` restore --slug <slug> --repo .` without an exact
stamp, and the snapshot-style exclusions. Unknown mode does not establish that a snapshot was
saved; do not make a saved-files claim from this fallback. With `--discard` but
no saved namespace, `parked_ref`, `parked_stamp`, `parked_mode`, and `parked_repo`
are all `null`, and `restore_hint` and `parked_excludes` are absent. A result with
a snapshot descriptor looks like:

```json
{
  "emitted": "BOLT_FAILED",
  "reason": "stale review recovery exhausted",
  "failed_bolt": "Onboarding Wizard",
  "slug": "onboarding-wizard",
  "discarded": true,
  "parked_ref": "refs/aidlc/parked/onboarding-wizard/20260918T123456Z",
  "parked_stamp": "20260918T123456Z",
  "parked_mode": "snapshot",
  "parked_repo": null,
  "restore_hint": "{{INVOKE}} engine worktree restore --slug onboarding-wizard --parked 20260918T123456Z --repo .",
  "parked_excludes": ["ignored files", "eol/text=auto normalization"]
}
```

The audit `BOLT_FAILED` field remains `Reason: aborted`; only the success JSON
reason echoes the caller's text. Abort arguments and the human-consent
requirement are unchanged. In spoken text, call this attempt **set aside**, not
deleted or completed. For `snapshot`, describe the saved tracked and non-ignored
untracked files and the exclusions above. For `branch-tip`, say: "I kept its
committed work; there were no uncommitted files to save." For `evidence-only`,
say: "Nothing of its working files remained to save; only its review evidence
was kept." Offer restoration only when `restore_hint` is present. On a later
restore request, the conductor must execute that saved hint verbatim and
announce the returned `worktree_path` plainly.

### Restore a set-aside attempt

```
{{INVOKE}} engine worktree restore --slug <slug> [--parked <stamp>] [--raw] [--repo <name|.>] [--intent <intent>] [--space <space>]
```

Without `--parked`, restore selects the latest parked `/head`, ordering timestamp
suffixes numerically (`-10` is newer than `-2`). With it, restore selects that
exact stamp. An exact stamp present in only one repository selects that
repository before checking for a slug shared across repositories. If selection
is still ambiguous, `--repo <name>` selects an existing sibling Git repository
and `--repo .` selects the project root. Siblings must be real immediate child
directories, not symlinks, whose canonical paths remain directly under the
canonical workspace root; arbitrary paths and symlink aliases are refused.
These explicit restore/purge selectors work independently of the current
intent's repo list; live create/discard selector behavior is unchanged. Use the
intent/space selectors when needed to resolve workspace context. Restore and
purge reject unknown flags and duplicate flags before selection or mutation;
`--raw` is a bare restore-only flag. Restore
creates `.aidlc/restored/bolt-<slug>-<stamp>` on branch
`restore/bolt-<slug>-<stamp>`, never reusing or changing the live
`.aidlc/worktrees/bolt-<slug>` path or `bolt-<slug>` branch. Restoring files does
not resume an aborted Bolt or reinstate its review authority. Parked reviewed
source refs remain in the parked namespace, not copied back into active refs.

Restore decides its mode in order: the bare `--raw` flag writes stored blobs
byte-exact for any park; otherwise `/snapshot` selects byte-exact materialization,
then `/branch-tip` selects Git's ordinary checkout. Legacy parks have neither
marker for either shape. An unmarked head is a snapshot only when its commit
author is exactly `AI-DLC`, its email is `aidlc@localhost`, and its subject starts
with `aidlc: parked bolt-<slug> at `; all other unmarked heads use ordinary
checkout. This identity check reads the original commit, ignoring Git replacement
objects. Byte-exact materialization bypasses smudge/process filters and
working-tree-encoding conversions. Ordinary checkout applies these conversions;
a required failing filter fails the restore with Git's error.
Regular-file blobs stream directly to disk rather than
being buffered in memory; only symlink targets are buffered. Raw-restored paths
may show as modified under their own filter.
Executable files retain their modes. Symbolic links are materialized as symlinks
when `core.symlinks` is unset or true; with `core.symlinks=false`, a mode-120000
entry is written as a regular file whose bytes are the link target, exactly as
Git checks it out. Submodule gitlinks become empty directories; submodule
checkouts are not restored. Git's
eol/`text=auto` normalization during parking is the explicit limit: CRLF bytes
normalized at park time are not recoverable.
A regular file with a non-UTF-8 name and a `filter`, `text`, `eol`, `ident`, or
`working-tree-encoding` attribute (neither unspecified nor unset) cannot currently
be parked; discard refuses before teardown with the attribute-specific message:

```text
cannot park file with a non-UTF-8 name and a content-transforming attribute (<attr>=<value>): <name>; rename the file or unset its <attr> attribute
```

The live attempt remains intact. Names without these attributes can be saved
normally. The `ignored files` exclusion means ignored untracked files, not
tracked files that happen to match an ignore pattern.

```json
{
  "restored": true,
  "slug": "onboarding-wizard",
  "parked_ref": "refs/aidlc/parked/onboarding-wizard/20260918T123456Z",
  "worktree_path": "/Users/dev/project/.aidlc/restored/bolt-onboarding-wizard-20260918T123456Z",
  "branch": "restore/bolt-onboarding-wizard-20260918T123456Z",
  "reviewed_source_refs": 1,
  "materialized": 12,
  "raw_bytes": true,
  "restore_mode": "snapshot"
}
```

`reviewed_source_refs` counts the retained reviewed source refs in that parked
namespace. `raw_bytes` is `true` for byte-exact materialization (a snapshot or
explicit `--raw`) and `false` for Git's ordinary checkout. `materialized` is
present only when `raw_bytes` is `true`; it counts regular files plus symbolic
links written, excluding submodule gitlinks. Selecting an evidence-only
namespace, even with `--raw`, refuses with
`no restorable files were parked for <slug> <stamp>; only review evidence was kept`.
A raw materialization failure leaves the partial checkout in place
and reports its path. Before retrying a failed Git checkout with `--raw`, remove
any remaining restore checkout and its `restore/bolt-<slug>-<stamp>` branch.

`restore_mode` records why that behavior was selected:

| Value | Selection | `raw_bytes` |
|---|---|---|
| `raw-requested` | Explicit `--raw`, overriding markers and legacy identity | `true` |
| `snapshot` | `/snapshot` marker present | `true` |
| `branch-tip` | `/branch-tip` marker present, without `/snapshot` | `false` |
| `legacy-snapshot` | Neither marker; tool-authored snapshot identity matches | `true` |
| `legacy-branch-tip` | Neither marker; snapshot identity does not match | `false` |

### Purge parked refs

```
{{INVOKE}} engine worktree purge --slug <slug> [--parked <stamp> | --older-than <days>] [--repo <name|.>]
```

Purge compare-deletes all parked refs for the slug, just the selected stamp
when `--parked` is supplied, or only attempts strictly older than the
`--older-than <days>` threshold. Days must be nonnegative and finite; fractions
are accepted. The timestamp is the UTC `YYYYMMDDTHHMMSSZ` part of the stamp,
independent of any `-N` collision suffix and of commit dates. The shared strict
calendar parser rejects impossible dates and times rather than normalizing
them. With `--older-than`, unparseable stamps are retained and reported in
`skipped_unparseable: [stamps]`. An attempt exactly at the age threshold is
retained. `--older-than` and `--parked` are mutually exclusive.

Purge refuses if any corresponding restored checkout still exists or is
registered with Git, including a moved checkout; remove that checkout explicitly
before purging its recovery refs. It never removes the live Bolt checkout or
branch. The JSON reports the number of refs deleted, not the number of snapshots:

```json
{
  "purged": 3,
  "slug": "onboarding-wizard",
  "stamps": ["20260918T123456Z"],
  "skipped_unparseable": []
}
```

`skipped_unparseable` is always present; it is empty unless `--older-than`
retains unparseable stamps. Without an age filter, explicit-stamp and all-stamp
purges can remove those stamps. The `stamps` list contains only selected stamps.

Restore and purge emit no new audit events; the Worktree taxonomy stays at seven.

### Doctor inventory

Doctor shows a **Parked attempts** informational section in ordinary and verbose
reports, omitted when no saved `/head` or actual `/reviewed-source/<commit>`
entries exist. These entries are neither warnings nor failures. Each reports
its slug, exact stamp, age in days, mode (`snapshot`, `branch-tip`, or `legacy`
for saved heads; `evidence-only` when only reviewed source refs remain), whether
its canonical `.aidlc/restored/bolt-<slug>-<stamp>` checkout exists, and exact
rendered recovery commands with `--parked <stamp>` and an explicit `--repo <name>`
or `--repo .`. Evidence-only entries have a purge command but no restore command.
Doctor applies the same real-immediate-child repository boundary to discovered
and audit-derived sibling candidates, ignoring symlinks and out-of-root paths.
The `legacy` inventory mode does not classify the commit identity; restore
performs that distinction when invoked. A checkout moved elsewhere may not
appear as restored in this inventory, but purge still checks Git worktree
registrations and refuses to delete its refs.

The public doctor's JSON exposes `data.parked_attempts`, an array of objects:

| Field | Meaning |
|---|---|
| `slug`, `stamp` | Exact Bolt identifier and saved namespace stamp |
| `age_days` | Whole elapsed UTC days from the stamp, ignoring `-N`; future stamps show `0`, and invalid calendar timestamps show `null` (`unknown` in text) |
| `mode` | `snapshot`, `branch-tip`, or `legacy` for saved heads; `evidence-only` for reviewed source refs without `/head` |
| `repo` | Sibling repository name, or `null` for the project root |
| `restored_path`, `restored_exists` | Canonical restore path and whether it exists |
| `restore_command` | Rendered exact-stamp, explicit-repository restore command; absent for `evidence-only` |
| `purge_command` | Rendered exact-stamp, explicit-repository purge command; present for every listed mode |

Doctor uses the same strict calendar parser as age-filtered purge, so an
impossible date or time yields `age_days: null` and human-readable `unknown`.
The rounded display age is informational; purge compares the timestamp against
the exact `--older-than` threshold rather than rounding the elapsed age.

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

- Implementation: `{{HARNESS_DIR}}/tools/aidlc-worktree.ts` (`handleInfo` handler)
- Test: `tests/unit/t72-worktree-info.sh`
- Caller: `{{HARNESS_DIR}}/skills/aidlc/SKILL.md` (per-Bolt-loop halt-and-ask flow)
- Audit emitter that produces the `WORKTREE_CREATED` entries `info` reads: `aidlc-worktree.ts` `handleCreate` (also in this file at `~line 154`)
- Audit-format spec: `{{HARNESS_DIR}}/knowledge/aidlc-shared/audit-format.md` `WORKTREE_CREATED` row
