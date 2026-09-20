# `aidlc-worktree info` and `list` — Output Schema

Pinned output contracts for `info` and `list`, plus Bolt identity and recovery rules. The orchestrator's halt-and-ask prose at `SKILL.md` reads `info` to interpolate the worktree path and branch name into the structured-question prompt body for code-generation-failure halt-and-ask.

This schema is the contract between the tool (deterministic) and the LLM (prose composition). Future changes to the JSON shape must update this file in the same commit.

## Bolt identity

New Bolts are scoped to the selected intent's registry UUID. `<id8>` is its
eight-character lowercase hex suffix (`idSuffix(uuid)`), the same identity used
by Unit claims at `refs/heads/claim/<id8>/<unit>`. Unit names, `--slug`, audit
`Bolt slug`, state `Bolt Refs`, and `Unit Progress` remain unchanged.

| Surface | New shape |
|---------|-----------|
| Worktree directory | `<projectDir>/.aidlc/worktrees/bolt-<id8>_<slug>` |
| Branch (also directory basename) | `bolt-<id8>_<slug>` |
| Retained reviewed source | `refs/aidlc/reviewed-source/<id8>/<slug>/<commit>` |
| Parked recovery refs | `refs/aidlc/parked/<id8>/<slug>/<stamp>/…` |

The `_` separator cannot occur in a Bolt slug (`[a-z][a-z0-9-]*`), so new names
cannot be mistaken for legacy names: `bolt-abcdef01-api` is a legacy slug,
while `bolt-abcdef01_api` carries intent identity `abcdef01`. The `bolt-` prefix
remains compatible with `bolt-*` branch rules. This prevents same-named Units in
parallel intents from colliding in one checkout or across worktrees of one clone
([#1252](https://github.com/awslabs/aidlc-workflows/issues/1252)).

Pre-upgrade legacy `bolt-<slug>` Bolts keep their directory, branch, and legacy
`refs/aidlc/reviewed-source/<slug>/<commit>` and
`refs/aidlc/parked/<slug>/<stamp>/…` namespaces through merge, discard, and purge
to completion. No new Bolt is created in the old shape. Legacy resolution uses
the selected intent's own `WORKTREE_CREATED`, `WORKTREE_MERGED`, and
`WORKTREE_DISCARDED` rows for the slug. Their causal frontier must contain exactly
one row, ordered by timestamp and same-shard append order, not shard filename;
an unreadable shard or ambiguous frontier resolves to the namespaced identity.
That row must name the legacy `Worktree path` and `Bolt slug`, and a
`WORKTREE_CREATED` must also name the legacy `Branch name`.

For a live legacy directory, readable `worktree-meta.json` must corroborate the
audit. An `intentRecord` matching the selected intent permits any of those three
frontier events: merge/discard rows are audit-of-intent, not proof that cleanup
completed. Pre-P7 metadata without `intentRecord` requires an open creation
(`WORKTREE_CREATED` on the frontier); a later merge/discard row may belong to a
reused legacy name. Missing or unreadable metadata, or an `intentRecord` naming
another intent, never authorizes the live legacy Bolt. With no legacy directory,
any of the three matching frontier events permits cleanup-only resolution;
`merge`, `discard`, and `purge` still verify Git state before deletion. Otherwise
the namespaced identity applies. Neither directory existence nor the number of
intents in a space or workspace proves ownership. `doctor` reports both shapes.

Restore and purge admit namespaced and legacy parked attempts only when the
selected intent's own `WORKTREE_DISCARDED` rows recorded their exact `Parked ref`
and stamp. Unknown parks are ignored; requesting an unrecorded `--parked` stamp
refuses:

```text
parked attempt <stamp> is not recorded by intent <record>
```

If a legacy directory is absent and no durable Git evidence remains, `create`
uses the namespaced identity. If its branch or retained refs remain, it refuses:

```text
Legacy Bolt <slug> left branch <bolt-slug>[ and <n> retained refs] behind; run discard --slug <slug> under its intent to park and clean them before creating a new Bolt.
```

The existing `Worktree directory already exists: <dir>` refusal applies only
when that directory exists. Discard with no evidence for the selected identity
returns `already-discarded` only if this checkout has no same-slug Bolt directory
under another identity; otherwise it exits non-zero:

```text
no Bolt <slug> belongs to intent <record>; this checkout holds <name> (intent <id8>|legacy) at <path> — select that intent to discard it
```

Creation without an intent registry UUID fails closed:

```text
Intent record <relative record dir> has no registry identity (uuid); adopt or re-create the intent before Construction. Bolt worktrees are named by intent so parallel intents cannot collide.
```

Identity-resolving commands (`create`, `merge`, `discard`, `restore`, `purge`)
also require a registry UUID before legacy lookup. Adopt or re-create an orphan
intent before using those commands; do not infer its UUID from a directory name.
`list` remains an inventory independent of the active intent; `verify` and
`info` remain audit lookups that need no registry identity.

The `<id8>` is the whole of a Bolt's intent authority, so two registered intents
whose uuids share their last eight hex characters (a 2^-32 event per pair) refuse
every identity-resolving command rather than share names and recovery refs:

```text
Intent record <relative record dir> shares its eight-character uuid suffix with another registered intent, so its Bolt names would collide; re-create one of the two intents before Construction.
```

Before cleanup deletes a Bolt branch or its retained/parked refs, that branch
must be checked out at its own Bolt directory or nowhere. If another worktree
owns it, cleanup refuses, names the owner path on stderr, and records
`(checked out in another worktree of this repository)` in the audit. Do not
delete the foreign checkout to bypass the refusal.

A cleanup-only swarm merge also requires a `WORKTREE_CREATED` row matching the
resolved Bolt path. With the legacy directory gone, discard checks a remaining
branch against the tip saved by this intent's latest legacy `WORKTREE_DISCARDED`
row (`Parked ref` plus `/branch-tip`, falling back to `/head`). A different tip refuses:

```text
legacy branch <name> tip does not match this intent's recorded discard; leaving it for inspection
```

If the frontier is `WORKTREE_CREATED`, discard has not started and proceeds
through ordinary Git checks. Cleanup admits retained reviewed-source refs only
when their suffix is a 40–64-character lowercase hex commit. Parked-source refs
require a valid stamp and exactly one of these suffixes:
`<stamp>/head`, `<stamp>/snapshot`, `<stamp>/branch-tip`, or
`<stamp>/reviewed-source/<40–64-character lowercase hex commit>`.
Other refs are skipped, never deleted.

Swarm commands follow the session's active workflow. Pass `--intent`/`--space`
only when they resolve to that workflow; a mismatch refuses before mutation or
audit emission:

```text
swarm commands follow the session's active workflow (${ambient.space}/${ambient.intent}); switch to ${explicit.space}/${explicit.intent} instead of passing --intent/--space
```

## Usage

```
{{INVOKE}} engine worktree info --slug <kebab-slug>
```

The slug is the kebab-case Bolt identifier threaded through every worktree command for that Bolt (`create`, `verify`, `merge`, `discard`, `restore`, `purge`). See `SKILL.md` per-Bolt loop "Slug derivation" paragraph for the `name → slug` transformation.

## Exit codes

| Exit | Meaning | stdout | stderr |
|------|---------|--------|--------|
| 0 | Hit — JSON emitted | JSON object (see below) | (empty) |
| 1 | No `WORKTREE_CREATED` for slug (or audit absent), or malformed block | (empty) | one-line error message |

The exit-code contract mirrors `verify`'s semantics: non-zero is the halt signal. The orchestrator's prose treats any non-zero exit as "no worktree to render" and falls back to the carve-out failure shape (verify-failed or dev-rejection). Surface an identity refusal rather than inventing a branch or path from the slug.

## JSON output shape (exit 0)

```json
{
  "slug": "onboarding-wizard",
  "path": "/Users/dev/project/.aidlc/worktrees/bolt-7c31e9a0_onboarding-wizard",
  "branch_name": "bolt-7c31e9a0_onboarding-wizard",
  "intent_id8": "7c31e9a0",
  "audit_timestamp": "2026-05-18T12:34:56Z",
  "merge_held": false
}
```

Field semantics:

- **`slug`** — echoes the input `--slug` flag verbatim. The bare kebab-case identifier (e.g. `onboarding-wizard`) remains the human/audit identity; it is not the directory or branch name. See SKILL.md per-Bolt loop "Slug derivation" for the `name → slug` transformation. The orchestrator uses this field to confirm correlation, not to pick a different one.
- **`path`** — absolute filesystem path at `<projectDir>/.aidlc/worktrees/bolt-<id8>_<slug>`. New `WORKTREE_CREATED` rows store `**Worktree path**:` project-relative; `info` resolves it against the project root. Legacy absolute rows and provenance-matched legacy Bolt paths remain accepted. The user `cd`s here to inspect a paused Bolt.
- **`branch_name`** — actual git branch name, quoted verbatim from the audit's `**Branch name**:` field. New branches use `bolt-<id8>_<slug>`; pre-upgrade legacy branches retain `bolt-<slug>`. Never construct it from `slug`.
- **`intent_id8`** — intent UUID suffix from the audited branch or metadata's `intentId8`; `null` for historical legacy Bolts without that identity.
- **`audit_timestamp`** — ISO 8601 timestamp of the matching `WORKTREE_CREATED` block. Useful for the orchestrator to reason about freshness; not currently surfaced in the AUQ prompt.
- **`merge_held`** — boolean reflecting the `Merge-Held` field in the per-Bolt forked state at `<path>/<record>/aidlc-state.md` (`true` only if the file exists AND the field reads `true`; absence resolves to `false`). The orchestrator reads this on resume to decide whether dispatching `aidlc-bolt complete --merge --slug <slug>` is safe. The held state is set by `aidlc-bolt hold-merge --slug <slug>` before a multi-failure halt-and-ask sequence opens and cleared by `aidlc-bolt release-merge --slug <slug>` once all sibling AUQs resolve.

## Most-recent semantics

`info` returns the **most-recent** `WORKTREE_CREATED` for the slug — meaning the latest by audit-log position (end-to-start walk via `findLatestEvent`). When a slug has been created → discarded → re-created within the same workflow, the second create's path is what `info` returns. This matches the user's mental model: "the live worktree for slug X."

The retry-then-fail scenario (code-gen fails, user picks Retry, code-gen fails again) does not create a new `WORKTREE_CREATED` — Retry re-runs the existing worktree per the SKILL.md per-Bolt loop. So `info`'s output is stable across retry attempts. Pinned by `tests/worktree/t11-halt-and-ask-retry-correlation.sh`.

## `list` output

`{{INVOKE}} engine worktree list` reports parsed Bolt directories under the
project's `.aidlc/worktrees/`; it can include multiple intents with the same
slug. Unparseable directory names are skipped.

```json
{
  "worktrees": [
    {
      "slug": "payments",
      "worktree_path": "/Users/dev/project/.aidlc/worktrees/bolt-7c31e9a0_payments",
      "branch": "bolt-7c31e9a0_payments",
      "intent_id8": "7c31e9a0",
      "legacy": false
    },
    {
      "slug": "payments",
      "worktree_path": "/Users/dev/project/.aidlc/worktrees/bolt-4b829d10_payments",
      "branch": "bolt-4b829d10_payments",
      "intent_id8": "4b829d10",
      "legacy": false
    },
    {
      "slug": "onboarding-wizard",
      "worktree_path": "/Users/dev/project/.aidlc/worktrees/bolt-onboarding-wizard",
      "branch": "bolt-onboarding-wizard",
      "intent_id8": null,
      "legacy": true
    }
  ]
}
```

Each row keeps `slug`, absolute `worktree_path`, and `branch`. `intent_id8` is
parsed from the directory basename, or `null` for legacy names; `legacy` is
`true` only for the pre-upgrade shape. A listed legacy directory is not evidence
that the selected intent owns it: lifecycle commands still check provenance.

## Worktree metadata repository provenance

New `.aidlc/worktree-meta.json` files keep `version: 1` and add `intentId8`
(e.g. `7c31e9a0`) and `branch` (e.g. `bolt-7c31e9a0_onboarding-wizard`). Both are
optional when reading pre-upgrade metadata. `intentRecord` remains the relative
intent record dir used for legacy ownership checks.

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

The new parked namespace is `refs/aidlc/parked/<id8>/<slug>/<stamp>`, where `stamp` is UTC
`YYYYMMDDTHHMMSSZ`, with a numeric `-N` suffix for collisions. `/head` points to
the snapshot commit with its raw working-tree blobs, with a `/snapshot` marker
pointing to that same commit. Snapshot parks also save the original branch OID
at `/branch-tip`, so a cleanup-only retry can compare the remaining branch
without mistaking saved uncommitted changes for its tip. If the checkout is
already gone but its branch remains, `/head` instead preserves that tip, whose
blobs are ordinary committed forms, with `/branch-tip` pointing to the same
commit. `/reviewed-source/<commit>` preserves each
reviewed source ref. The discard JSON keeps `parked_ref` (the namespace prefix,
not its `/head` ref) and `parked_commit` (the snapshot commit or branch tip), and
adds `parked_stamp` (the exact stamp), `parked_mode` (`snapshot`, `branch-tip`, or
`evidence-only`), and `parked_repo` (`null` for the project root, otherwise the
sibling repository name). If only reviewed source refs remain to park,
`parked_mode` is `evidence-only`, `parked_commit` is the string `"-"`, and no `/head` exists
to restore; `parked_ref`, `parked_stamp`, and `parked_repo` still identify the
saved evidence.
The already-discarded response is unchanged and has no `parked_*` fields.

Successful `bolt abort` JSON retains `reason: "aborted"` and echoes the supplied
`--reason` text in the additive `abort_reason` field. It always includes
`parked_ref`, which is `null` when nothing was parked, including without
`--discard`. Only a non-null `parked_ref` adds the discard descriptor's
`parked_stamp`, `parked_mode`, and `parked_repo`.
For a restorable attempt, `restore_operation` is an `EngineInvocation` from
`aidlc-guard-operation.ts`: `{ route: string; args: readonly string[] }`. Its
route is `worktree`, and its args are
`["restore", "--slug", slug, "--parked", stamp, "--repo", repo ?? ".", "--intent", recordDirName, "--space", space]`.
The repository selector is always present: the sibling name or
`.` when `parked_repo` is `null`. `recordDirName` is the owning intent's record
directory name and `space` is its space. This selects the exact saved attempt,
repository, and intent, not a later attempt with the same slug or another active
intent after a workflow switch.

`restore_hint` is optional human display text, rendered from that operation by
`renderEngineInvocation`. The renderer selects the installed native or source
prefix, validates the harness directory, and quotes every argument safely for
the selected shell. If rendering throws, abort omits the hint and returns the
reason in `restore_hint_error`; `restore_operation` remains available. A missing
hint does not mean that only evidence was saved. An evidence-only abort keeps
all four descriptor fields but omits `restore_operation`, `restore_hint`,
`restore_hint_error`, and `parked_excludes`. The exclusions follow the mode:

| `parked_mode` | `parked_excludes` |
|---|---|
| `snapshot` | `["ignored files", "eol/text=auto normalization"]` |
| `branch-tip` | `["uncommitted files (no working tree existed)"]` |
| `evidence-only` | Absent; only review evidence was kept, with no restorable files |

If a saved namespace is known but its discard descriptor is missing, the
fallback retains `parked_ref` and derives `parked_stamp` from its namespace
only when the stamp parses strictly; otherwise `parked_stamp` is `null`.
It reports `parked_mode: null` and `parked_repo: null`, since neither can be
inferred from the legacy output, and omits `restore_operation`, `restore_hint`,
`restore_hint_error`, and `parked_excludes`. Instead, `recovery_hint` asks the
human to run doctor to list set-aside attempts and their exact restore commands.
The hint is plain guidance, not an executable operation. Unknown mode does not
establish what files were saved, so do not make a saved-files claim or offer
restoration from this fallback. When no namespace was saved, `parked_ref` is
`null`; `parked_stamp`, `parked_mode`, `parked_repo`, `restore_operation`,
`restore_hint`, `restore_hint_error`, `parked_excludes`, and `recovery_hint` are absent.
A result with a snapshot descriptor for
`aidlc/spaces/default/intents/260918-onboarding/` (UUID suffix `7c31e9a0`) looks like:

```json
{
  "emitted": "BOLT_FAILED",
  "reason": "aborted",
  "abort_reason": "stale review recovery exhausted",
  "failed_bolt": "Onboarding Wizard",
  "slug": "onboarding-wizard",
  "discarded": true,
  "parked_ref": "refs/aidlc/parked/7c31e9a0/onboarding-wizard/20260918T123456Z",
  "parked_stamp": "20260918T123456Z",
  "parked_mode": "snapshot",
  "parked_repo": null,
  "restore_operation": {
    "route": "worktree",
    "args": ["restore", "--slug", "onboarding-wizard", "--parked", "20260918T123456Z", "--repo", ".", "--intent", "260918-onboarding", "--space", "default"]
  },
  "restore_hint": "bun {{HARNESS_DIR}}/tools/aidlc-worktree.ts restore --slug onboarding-wizard --parked 20260918T123456Z --repo . --intent 260918-onboarding --space default",
  "parked_excludes": ["ignored files", "eol/text=auto normalization"]
}
```

The audit `BOLT_FAILED` field remains `Reason: aborted`; the success JSON's
`abort_reason` carries the caller's text. Abort arguments and the human-consent
requirement are unchanged. In spoken text, call this attempt **set aside**, not
deleted or completed. For `snapshot`, describe the saved tracked and non-ignored
untracked files and the exclusions above. For `branch-tip`, say: "I kept its
committed work; there were no uncommitted files to save." For `evidence-only`,
say: "Nothing of its working files remained to save; only its review evidence
was kept." Offer restoration only when `restore_operation` is present. On a
later human restore request, invoke its `worktree` route through
`{{INVOKE}} engine worktree <args...>`, passing each saved `args` element exactly
as a separate argv argument. Never join the args into a shell command, execute
`restore_hint`, or reconstruct a slug-only selection. The hint is human display
text only; a rendering error does not withdraw the restoration offer. Announce
the returned `worktree_path` plainly.

### Restore a set-aside attempt

```
{{INVOKE}} engine worktree restore --slug <slug> [--parked <stamp>] [--raw] [--repo <name|.>] [--intent <intent>] [--space <space>]
```

Without `--parked`, restore selects the latest parked `/head`, ordering timestamp
suffixes numerically (`-10` is newer than `-2`). With it, restore selects that
exact stamp. An exact stamp present in only one repository selects that
repository before checking for a slug shared across repositories. If selection
is still ambiguous, `--repo <name>` selects an existing sibling Git repository
and `--repo .` selects the project root. Both `WORKTREE_CREATED` and
`WORKTREE_DISCARDED` emit `Repo`: the recorded sibling name, or `-` for the project
root. A discard row preserves this provenance even when its creation row is
unavailable. Recovery admits valid Git repositories named in the same slug's
creation or discard audit `Repo` fields even when those sibling names are symlinks: the framework may recover
exactly where it recorded the attempt's worktree or parking. That admission is
slug-scoped; a record for another slug never widens this slug's repository set.
Membership in a current or historical intent's repo list alone cannot admit a
symlink. Intent-list candidates and unrecorded discovered siblings must be real
immediate child directories whose canonical paths remain directly under the
canonical workspace root (`isWorkspaceRepoDir`). Arbitrary paths and symlink
aliases without the same-slug audit provenance are refused.
These explicit restore/purge selectors work independently of the current
intent's repo list; live create/discard selector behavior is unchanged. Use the
intent/space selectors when needed to resolve workspace context. Restore and
purge reject unknown flags and duplicate flags before selection or mutation;
`--raw` is a bare restore-only flag. Restore
creates `.aidlc/restored/bolt-<id8>_<slug>-<stamp>` on branch
`restore/bolt-<id8>_<slug>-<stamp>`, never reusing or changing the live
`.aidlc/worktrees/bolt-<id8>_<slug>` path or `bolt-<id8>_<slug>` branch. Restoring files does
not resume an aborted Bolt or reinstate its review authority. Parked reviewed
source refs remain in the parked namespace, not copied back into active refs.
Legacy restores retain `.aidlc/restored/bolt-<slug>-<stamp>` and the legacy
`restore/bolt-<slug>-<stamp>` branch; they do not create a new live legacy Bolt.

Restore decides its mode in order: the bare `--raw` flag writes stored blobs
byte-exact for any park; otherwise `/snapshot` selects byte-exact materialization,
then `/branch-tip` selects Git's ordinary checkout. Legacy parks have neither
marker for either shape. An unmarked head is a snapshot only when its commit
author is exactly `AI-DLC`, its email is `aidlc@localhost`, and its subject starts
with the legacy subject `aidlc: parked bolt-<slug> at `; all other unmarked heads use ordinary
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
  "parked_ref": "refs/aidlc/parked/7c31e9a0/onboarding-wizard/20260918T123456Z",
  "worktree_path": "/Users/dev/project/.aidlc/restored/bolt-7c31e9a0_onboarding-wizard-20260918T123456Z",
  "branch": "restore/bolt-7c31e9a0_onboarding-wizard-20260918T123456Z",
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
any remaining restore checkout and its reported `branch`.

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
{{INVOKE}} engine worktree purge --slug <slug> [--parked <stamp> | --older-than <days>] [--repo <name|.>] [--intent <intent>] [--space <space>]
```

Purge compare-deletes all parked refs for the selected intent's Bolt, just the
selected stamp when `--parked` is supplied, or only attempts strictly older than the
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
for recorded saved heads; `evidence-only` for recorded review evidence without
`/head`; `unrecorded` without unambiguous discard provenance), whether
the owning repository registers a Git worktree at its canonical
`.aidlc/restored/bolt-<id8>_<slug>-<stamp>` path on the exact
`restore/bolt-<id8>_<slug>-<stamp>` branch, and, for recorded attempts, typed
recovery operations with exact `--parked <stamp>` and explicit `--repo <name>`
or `--repo .` args, followed by `--intent <record-dir-name> --space <space>`.
Recorded entries have `purge_operation`; only recorded restorable entries have
`restore_operation`. Their optional rendered commands are human display text.
If safe rendering fails, the corresponding command is omitted and its error
field explains why; the operation remains. Evidence-only entries expose only
the purge operation and its command-or-error fields. Unrecorded entries expose
neither operation nor command/error fields. Doctor uses the same slug-scoped recovery
repository candidate set described above.
The `legacy` inventory mode does not classify the commit identity; restore
performs that distinction when invoked. A checkout moved elsewhere may not
appear as restored in this inventory, but purge still checks Git worktree
registrations and refuses to delete its refs.

Doctor inventories both namespaced and legacy attempts. Namespaced attempts
resolve their owning intent through the registry UUID suffix; legacy attempts
require a single owner's exact `WORKTREE_DISCARDED` `Parked ref` provenance and
retain the legacy restored path and branch. Recovery operations require the
owner's own `WORKTREE_DISCARDED` rows to record the matching slug and exact
`Parked ref`, for namespaced and legacy refs alike. Unrecorded attempts,
including unknown or ambiguous owners and unattributed legacy parks, remain
visible as `mode: "unrecorded"`, never authorized through the active intent.
Their JSON `note` is `no WORKTREE_DISCARDED row records this parked attempt; inspect refs/aidlc/parked/<...> manually`.
Each available operation carries the owning record-directory name and space,
so it remains bound to that intent after a workflow switch.

The public doctor's JSON exposes `data.parked_attempts`, an array of objects:

| Field | Meaning |
|---|---|
| `slug`, `stamp` | Exact Bolt identifier and saved namespace stamp |
| `age_days` | Whole elapsed UTC days from the stamp, ignoring `-N`; future stamps show `0`, and invalid calendar timestamps show `null` (`unknown` in text) |
| `mode` | `snapshot`, `branch-tip`, or `legacy` for recorded saved heads; `evidence-only` for recorded reviewed source refs without `/head`; `unrecorded` without unambiguous discard provenance |
| `repo` | Sibling repository name, or `null` for the project root |
| `restored_path`, `restored_exists` | Canonical restore path and whether the owning repository registers a checkout resolving to that path on the exact `restore/bolt-<id8>_<slug>-<stamp>` branch (legacy: `restore/bolt-<slug>-<stamp>`) |
| `restore_operation` | `EngineInvocation` with route `worktree` and args `["restore", "--slug", slug, "--parked", stamp, "--repo", repo ?? ".", "--intent", recordDirName, "--space", space]`; absent for `evidence-only` and `unrecorded` |
| `purge_operation` | `EngineInvocation` with route `worktree` and args `["purge", "--slug", slug, "--parked", stamp, "--repo", repo ?? ".", "--intent", recordDirName, "--space", space]`; absent for `unrecorded` |
| `restore_command` | Optional safe rendering of `restore_operation` for human display, not execution input; absent without the operation or on rendering failure |
| `restore_command_error` | Rendering failure reason when `restore_command` is omitted but `restore_operation` exists |
| `purge_command` | Optional safe rendering of `purge_operation` for human display, not execution input; absent without the operation or on rendering failure |
| `purge_command_error` | Rendering failure reason when `purge_command` is omitted but `purge_operation` exists |
| `note` | Manual-inspection guidance for `unrecorded` attempts, including their exact parked ref prefix; absent for recorded attempts |

Conductors invoke a selected operation's engine route with each listed arg as
its own argv argument, never by joining strings for a shell. Rendering uses the
same native/source selection, harness validation, and shell-safe argument
quoting as abort hints; an invalid harness directory cannot suppress the typed
operations or turn a restorable entry into an evidence-only one.

Doctor uses the same strict calendar parser as age-filtered purge, so an
impossible date or time yields `age_days: null` and human-readable `unknown`.
The rounded display age is informational; purge compares the timestamp against
the exact `--older-than` threshold rather than rounding the elapsed age.

## Stderr error messages

Audit lookup failures use these stable messages; identity refusals follow [Bolt identity](#bolt-identity) above:

```
error: no WORKTREE_CREATED audit entry for slug <slug> (audit log absent)
error: no WORKTREE_CREATED audit entry for slug <slug>
error: malformed WORKTREE_CREATED block at <timestamp> (missing Worktree path or Branch name field)
```

The third (malformed-block) case is the audit-of-intent reconciliation surface: doctor handles flagging and remediation; `info` just refuses to guess.

## AUQ prompt rendering — long-path fallback

The orchestrator interpolates `path` and `branch_name` into the structured question prompt body, which renders at full terminal width and wraps gracefully (multi-line wrap is supported on macOS Claude Code; verified manually before each release).

If a future surface (Windows PowerShell, mosh, narrow tmux pane) clips long paths in `question`, the documented fallback is to truncate with leading-ellipsis at directory boundaries while preserving the `bolt-<id8>_<slug>` tail:

```
.../project/.aidlc/worktrees/bolt-7c31e9a0_onboarding-wizard
```

This fallback is **not currently implemented** — current shipping behaviour assumes graceful wrap. If a regression surfaces, add a `--max-path-display <chars>` flag to `info` and have the orchestrator truncate per the rule above.

## Related files

- Implementation: `{{HARNESS_DIR}}/tools/aidlc-worktree.ts` (`handleInfo` handler)
- Test: `tests/unit/t72-worktree-info.sh`
- Caller: `{{HARNESS_DIR}}/skills/aidlc/SKILL.md` (per-Bolt-loop halt-and-ask flow)
- Audit emitter that produces the `WORKTREE_CREATED` entries `info` reads: `aidlc-worktree.ts` `handleCreate` (also in this file at `~line 154`)
- Audit-format spec: `{{HARNESS_DIR}}/knowledge/aidlc-shared/audit-format.md` `WORKTREE_CREATED` row
