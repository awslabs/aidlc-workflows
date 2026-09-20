# Branching Strategies

A menu of common branching strategies, what they look like, when to use them, and how AIDLC's Construction worktrees map onto each. When the orchestrator dispatches aidlc-pipeline-deploy-agent at Bolt boundaries, this file is the menu the agent surveys to map a team's affirmed branching strategy onto the `aidlc-worktree` tool's flags.

> **Reading practices:** see `knowledge/aidlc-shared/rules-reading.md` for empty-template detection, semantic-topic matching, and the active-space `project.md → team.md → org.md → hardcoded defaults` fallback chain. In the runbooks below, those files live under `aidlc/spaces/<active-space>/memory/`.
>
> See also `cicd-patterns.md` § "Branch Strategies" for the higher-level CI-flow context.

---

## Trunk-Based Development (default)

```
main ────────────────────────────────────────►
  ▲   ▲   ▲   ▲   ▲   ▲
  │   │   │   │   │   │   short-lived feature branches
  │   │   │   │   │   │   (1-2 days max), squash-merge to main
  bolt-1  bolt-3      bolt-5
      bolt-2  bolt-4
```

**Shape.** All work merges to `main` via short-lived feature branches. Long-lived branches don't exist. Feature flags gate incomplete work in production.

**When to use.** Default for most teams. Especially when CI pipeline duration is short (under 30 minutes) and observability is good enough to detect production issues quickly.

**Common problems.**
- Teams with infrequent releases find it hard to "hold" features for a release window. Feature flags are the answer, not branches.
- Teams without good test coverage shouldn't trunk-base — every commit hits production-shaped pipelines, so flaky tests block everyone.

**Worktree mapping.** Create: `{{INVOKE}} engine worktree create --slug <bolt-slug> --base main`. Merge: `--target main --strategy squash`. Each Bolt = one squash commit on `main`.

**Parallel Bolts.** Cleanest fit. Multiple Bolts can be in flight simultaneously; each branches from current `main`, each merges back without rebase contention because squash flattens history at merge time.

### Execution runbook

When dispatched for trunk-based:

1. Read `## Way of Working` from the active space's `project.md`, `team.md`, then `org.md` per `shared/rules-reading.md`; use hardcoded defaults only if all three are empty.
2. Resolve flags: `--base main --target main --strategy squash` for the default; deviate only if `team.md` explicitly says otherwise.
3. **Create**: invoke `{{INVOKE}} engine worktree create --slug <bolt-slug> --base main`.
4. **Merge** (after Bolt gate approval): caller must be on `main` at the main checkout. Invoke `{{INVOKE}} engine worktree merge --slug <bolt-slug> --target main --strategy squash --message "<commit message>"`.
5. Return the JSON envelope per § Response contract back to the orchestrator.

### Failure modes

- **Dirty tree on merge.** Local uncommitted changes on `main`; tool errors with the git message verbatim. Orchestrator's halt-and-ask offers retry/abort. Worktree preserved on retry; an explicit discard on abort sets the work aside before removing the live checkout and branch.
- **Conflict on squash.** Squash conflicts with concurrent `main` motion (e.g. another Bolt landed first). Tool exits non-zero with `{status: "conflict", conflict_files, detail}`. Orchestrator quotes `detail` to the user.
- **Branch already exists.** Pre-audit error; the tool refuses to clobber. Orchestrator should set the old attempt aside with `worktree discard` first only when authorized, or pick a different slug. Recover its files with the abort result's or doctor's `restore_operation`, invoking its engine route with the listed args exactly as argv, in the separate restored namespace. Rendered hints and commands are human display text only.

---

## GitHub Flow

```
main ────────────────────────────────────────►
  ▲       ▲       ▲       ▲
  │       │       │       │   feature branches with PRs
  │       │       │       │   (no time limit; can live longer than 1-2 days)
  feat-A  feat-B  feat-C  feat-D
```

**Shape.** `main` + indefinite feature branches. PRs merge to `main`. Branches can live longer than trunk-based — days to weeks for larger features. No `develop` or `release` branches.

**When to use.** Teams that want trunk-based discipline but need longer-lived feature branches. Open-source projects often use this.

**Common problems.**
- Branches that live too long accumulate merge debt. Discipline required to either land or close.
- Without feature flags, in-flight features block release of unrelated work.

**Worktree mapping.** Same base/target as trunk-based: `--base main --target main`. Strategy is usually `squash`, but teams that prefer to preserve the branch in history use `merge`. Team picks at affirmation; agent reads `team.md`.

### Execution runbook

When dispatched for GitHub Flow:

1. Read `## Way of Working` from the active space's `project.md`, `team.md`, then `org.md` (including any merge-style statement). The merge-strategy choice (squash vs merge) is what differs from trunk-based.
2. Resolve flags: `--base main --target main --strategy <squash|merge>` per affirmation; default to `squash`.
3. **Create**: `{{INVOKE}} engine worktree create --slug <bolt-slug> --base main`.
4. **Merge**: `{{INVOKE}} engine worktree merge --slug <bolt-slug> --target main --strategy <squash|merge> [--message "<msg>"]`. With `--strategy merge`, a no-fast-forward merge commit preserves the bolt branch's individual commits.
5. Return per § Response contract.

### Failure modes

- **Same as trunk-based**, plus:
- **Stale base for `--strategy merge`.** Long-lived bolt branches against a moving `main` produce conflicts. The tool reports the conflict envelope; the user resolves in the worktree (preserved on conflict) and re-invokes merge.

---

## GitFlow

```
main         ────────────────────────────────►
              ▲           ▲
              │           │   release/v1.0   release/v1.1
develop ─────┴───────────┴────────────────────►
  ▲   ▲   ▲       ▲   ▲
  │   │   │       │   │       feature branches off develop
  │   │   │       │   │
  feat-A feat-B   feat-C feat-D
                    ▲
                    │ hotfix/v1.0.1 (off main, merged to both)
```

**Shape.** Two long-lived branches (`main` = production, `develop` = integration), plus `feature/*`, `release/*`, `hotfix/*` short-lived branches. Releases cut from `develop` → `release/*` → `main` with version tags.

**When to use.** Teams with strict release management — quarterly releases, regulated deployments, stable production while integration continues. Common in enterprise + financial services.

**Common problems.**
- Long-lived `develop` accumulates merge debt against `main` over a release cycle. Painful merges at release-cut time.
- Hotfixes require dual-merging (to both `main` and `develop`) — easy to miss the second merge.

**Worktree mapping.** Feature Bolts: `--base develop --target develop`. Hotfix Bolts: `--base main --target main` (and the operator merges to `develop` separately — out of scope for `aidlc-worktree`). Strategy is usually `merge` to preserve branch history; `squash` is also valid.

### Execution runbook

When dispatched for GitFlow:

1. Read the active space's `## Way of Working`. Look for the integration-branch name (`develop` is the convention; teams sometimes use `integration` or `next`).
2. For feature Bolts: `--base <integration> --target <integration> --strategy <merge|squash>`. Default to `merge`.
3. For hotfix Bolts (rare in Construction; usually triggered by an out-of-band stage): `--base main --target main --strategy merge`. The operator separately merges the hotfix back to `<integration>` after `aidlc-worktree merge` succeeds. Out of scope for the tool.
4. **Create**: `{{INVOKE}} engine worktree create --slug <bolt-slug> --base <integration>`.
5. **Merge**: caller must be on `<integration>` at the main checkout. `{{INVOKE}} engine worktree merge --slug <bolt-slug> --target <integration> --strategy <merge|squash>`.
6. Return per § Response contract; if hotfix, include `notes: "manual merge to <integration> required"` so the orchestrator surfaces the follow-up.

### Failure modes

- **`<integration>` branch missing locally.** Pre-audit error; tool refuses to invent the branch.
- **Wrong cwd on merge.** Defensive HEAD check fails: `expected branch <integration>, found <actual>`. Caller must `cd` to the main checkout and `git checkout <integration>` first.
- **Hotfix merge to second target forgotten.** Out-of-scope for `aidlc-worktree`; orchestrator's aidlc-pipeline-deploy-agent dispatch should always include the second-target reminder in `notes`.

---

## Release Branches

```
main         ────────────────────────────────►
              ▲                       ▲
              │                       │
release/v1.0 ┴──── (frozen for stabilisation) ──────►
  ▲   ▲
  │   │   bug fixes only on release branch
  │   │
  fix-A fix-B
              │
              └──► merge release/v1.0 → main + tag v1.0.0
```

**Shape.** Trunk-based or GitHub Flow on `main`, with a release branch cut at code-freeze. Stabilisation work (bug fixes only) happens on the release branch; new features continue on `main`.

**When to use.** Teams shipping versioned software where release stability matters more than continuous deployment — desktop apps, embedded software, enterprise products with hard release dates.

**Common problems.**
- Bug fixes on release branch must be cherry-picked or merged back to `main` so they don't regress in the next release.
- Long stabilisation periods can block feature work waiting for the release branch to merge back.

**Worktree mapping.** Bolts on `main` use `--base main --target main`. Release-branch fix Bolts use `--base release/vX.Y --target release/vX.Y`. Strategy is `merge` typically (preserves the fix branch in history for traceability).

### Execution runbook

When dispatched for Release Branches:

1. Read the active space's `## Way of Working`. Look for the release-branch pattern (`release/vX.Y` is the convention).
2. Determine which line the Bolt belongs to from the Bolt's metadata (the orchestrator passes a `target_line: main | release/vX.Y` hint). Default to `main` when ambiguous.
3. **Create**: `{{INVOKE}} engine worktree create --slug <bolt-slug> --base <line>`.
4. **Merge**: caller on `<line>` at the main checkout. `{{INVOKE}} engine worktree merge --slug <bolt-slug> --target <line> --strategy merge`.
5. If the Bolt was a release-branch fix, include `notes: "consider cherry-pick to main"` in the response — the operator handles the cross-merge.
6. Return per § Response contract.

### Failure modes

- **Release branch missing locally.** Pre-audit error.
- **Bolt targeted release branch but main has diverged.** Bolt completes; orchestrator surfaces the cherry-pick reminder via the `notes` field.
- **Same as GitFlow** for wrong-cwd / dirty-tree / conflict cases.

---

## Monorepo

```
main ────────────────────────────────────────►
  ▲   ▲   ▲   ▲
  │   │   │   │   feature branches with path-based scope
  │   │   │   │
  pkg-a/feat-1  pkg-b/feat-2  pkg-c/refactor  shared/lib-update
```

**Shape.** Single repo holding multiple packages/services. Branches scoped by path (changes within `packages/auth/` are one Bolt; changes spanning packages need explicit cross-package coordination). Can run trunk-based, GitHub Flow, or any of the above on top.

**When to use.** Teams with multiple closely-coupled services that benefit from atomic cross-service changes. Tooling support required: Nx, Turborepo, Pants.

**Common problems.**
- CI must be path-aware (only test packages with changes). Monolithic CI defeats the purpose.
- Cross-package changes can't be parallelised cleanly — they require coordinated merges.

**Worktree mapping.** Same as the underlying strategy (trunk-based default). The path-awareness lives at the CI/test layer, not the worktree layer. Strategy is usually `squash` per package change.

### Execution runbook

When dispatched for Monorepo:

1. Resolve the underlying strategy (trunk-based default) per its runbook above.
2. The Bolt slug should encode the package scope (e.g. `auth-token-rotation` rather than `feature-1`) so `git worktree list` output stays diagnosable.
3. Create + merge identical to the underlying strategy.
4. Return per § Response contract.

### Failure modes

- **Cross-package Bolts.** When a Bolt's units span two packages, the merge succeeds but the cherry-pick / coordinate-with-other-package reminder is the operator's job. Surface in `notes` if known.
- **Same as the underlying strategy.**

---

## Response contract

When the orchestrator dispatches aidlc-pipeline-deploy-agent for a worktree create or merge, the agent invokes `aidlc-worktree` directly and reports the JSON envelope below back to the orchestrator. SKILL.md Step 0.5 / Step 6.75 then call `aidlc-worktree verify` as a deterministic backstop confirming the audit event landed.

### Create response (success)

```json
{
  "emitted": "WORKTREE_CREATED",
  "slug": "<bolt-slug>",
  "worktree_path": "/abs/path/.aidlc/worktrees/bolt-<slug>",
  "branch": "bolt-<slug>",
  "base": "<base-branch>",
  "audit_timestamp": "2026-05-18T12:34:56Z",
  "notes": "<optional follow-up reminders for the orchestrator>"
}
```

### Merge response (success)

```json
{
  "emitted": "WORKTREE_MERGED",
  "slug": "<bolt-slug>",
  "worktree_path": "/abs/path/.aidlc/worktrees/bolt-<slug>",
  "target": "<target-branch>",
  "strategy": "squash",
  "commit_sha": "<sha>",
  "audit_timestamp": "2026-05-18T12:34:56Z",
  "notes": "<optional follow-up reminders>"
}
```

If a merge error carries `[merge-succeeded:<sha>]` and says the
`SWARM_SOURCE_MERGED` post-result audit row failed, the Git merge already
landed but no aggregate source authority exists. Preserve the worktree and do
not retry the same merge command. Restart the stage attempt, or use
`AIDLC_SKIP_SOURCE_FRESHNESS=1` only after explicit human approval.

### Merge response (conflict)

```json
{
  "status": "conflict",
  "slug": "<bolt-slug>",
  "worktree_path": "/abs/path/.aidlc/worktrees/bolt-<slug>",
  "conflict_files": ["src/foo.ts", "src/bar.ts"],
  "detail": "Merge produced conflicts in worktree at <path>. Worktree preserved for inspection."
}
```

The orchestrator's halt-and-ask quotes the `detail` field verbatim. See `aidlc-common/protocols/stage-protocol-construction.md` § "Halt-and-ask on failure" and `skills/aidlc/SKILL.md` § "Halt-and-ask failure handling" for the full prompt shape and preservation invariant.

### Discard response

```json
{
  "emitted": "WORKTREE_DISCARDED",
  "slug": "<bolt-slug>",
  "worktree_path": "/abs/path/.aidlc/worktrees/bolt-<slug>",
  "reason": "agent-discard",
  "parked_ref": "refs/aidlc/parked/<bolt-slug>/20260518T123456Z",
  "parked_commit": "<snapshot-commit>",
  "parked_stamp": "20260518T123456Z",
  "parked_mode": "snapshot",
  "parked_repo": null,
  "audit_timestamp": "2026-05-18T12:34:56Z"
}
```

If the checkout, branch, and reviewed source refs are already gone (idempotent path), `emitted` is `null` and `reason` is `already-discarded` — no audit event is re-emitted.
That already-discarded response has no `parked_*` fields. A new discard keeps
`parked_ref` and `parked_commit` and adds the exact `parked_stamp`, `parked_mode`
(`snapshot`, `branch-tip`, or `evidence-only`), and `parked_repo` (`null` for the
project root, otherwise the sibling repository name).

Discard snapshots tracked files and non-ignored untracked files with a temporary
index and `commit-tree`; ignored untracked files are not backed up. Before audit
emission, it parks `/head`, a `/snapshot` marker pointing to the same commit,
and `/reviewed-source/<commit>` refs below the `parked_ref` namespace. If the
checkout is already gone but its branch remains, `/head` holds that branch tip
instead, with a matching `/branch-tip` marker rather than `/snapshot`.
Only then does it remove the live checkout and
branch and compare-delete the original reviewed source refs. If only reviewed
refs remain, `parked_mode` is `evidence-only` and `parked_commit` is the string `"-"`;
`parked_ref`, `parked_stamp`, and `parked_repo` still identify the saved evidence,
but there is no `/head` to restore.

### Abort response (success)

`bolt abort` success JSON includes `emitted: "BOLT_FAILED"`, `reason: "aborted"`,
the supplied `--reason` text in the additive `abort_reason` field, `failed_bolt`,
`slug`, `discarded`, and `parked_ref`. When nothing was parked, including without
`--discard`, `parked_ref` is `null`. Only a non-null `parked_ref` adds the returned
`parked_stamp`, `parked_mode`, and `parked_repo`.
For restorable attempts, `restore_operation` has route `worktree` and args
`["restore", "--slug", slug, "--parked", stamp, "--repo", repo ?? "."]`.
The repository selector is always present: the sibling name or `.` when
`parked_repo` is `null`. `restore_hint` is optional human display text rendered
from that operation by `renderEngineInvocation`, using the installed native or
source prefix, harness validation, and shell-safe argument quoting. If rendering
throws, the hint is omitted and `restore_hint_error` carries the reason; the
typed operation remains available. A missing hint is not evidence-only status.
Snapshot mode reports
`parked_excludes: ["ignored files", "eol/text=auto normalization"]`; branch-tip
mode reports `["uncommitted files (no working tree existed)"]` instead.
Evidence-only mode keeps the four descriptor fields but omits
`restore_operation`, `restore_hint`, `restore_hint_error`, and `parked_excludes`
because no restorable files were saved.

If a saved namespace is known but its discard descriptor is missing, the
fallback retains `parked_ref` and derives `parked_stamp` from its namespace
only when the stamp parses strictly; otherwise `parked_stamp` is `null`.
It reports `parked_mode: null` and `parked_repo: null`, since neither can be
inferred from legacy output, and omits `restore_operation`, `restore_hint`,
`restore_hint_error`, and `parked_excludes`. Instead, `recovery_hint` asks the
human to run doctor to list set-aside attempts and their exact restore commands.
The hint is plain guidance, not an executable operation. Unknown mode does not
justify a saved-files claim or restoration offer. If no namespace was saved,
`parked_ref` is `null`, with no `parked_stamp`, `parked_mode`, `parked_repo`,
`restore_operation`, `restore_hint`, `restore_hint_error`, `parked_excludes`, or
`recovery_hint`. The audit row
still uses `Reason: aborted`; the success JSON preserves the caller's text in
`abort_reason`.
Do not change the abort command or its human-consent requirement. Tell the human
the attempt was **set aside**. For branch-tip mode, say: "I kept its committed
work; there were no uncommitted files to save." For evidence-only mode, say:
"Nothing of its working files remained to save; only its review evidence was
kept." Omit the final restoration offer only when `restore_operation` is absent.
On a later human restore request, invoke its `worktree` route through
`{{INVOKE}} engine worktree <args...>`, passing each saved arg exactly as a
separate argv argument. Never join args into a shell command, execute the
display-only hint, or rebuild a slug-only selection. A rendering error does not
withdraw the restoration offer. Announce the returned `worktree_path` plainly.

### Restore or purge set-aside work

`{{INVOKE}} engine worktree restore --slug <bolt-slug> [--parked <stamp>]
[--raw] [--repo <name|.>] [--intent <intent>] [--space <space>]` restores the selected
attempt, or the latest parked `/head` when `--parked` is omitted. Stamps use UTC
`YYYYMMDDTHHMMSSZ` with optional numeric `-N` collision suffixes; latest selection
orders those suffixes numerically. Restore creates
`.aidlc/restored/bolt-<slug>-<stamp>` on `restore/bolt-<slug>-<stamp>`, never
touching the live `.aidlc/worktrees/bolt-<slug>` path or `bolt-<slug>` branch.
It does not resume the aborted lifecycle or restore active review authority.
Its JSON is `{restored: true, slug, parked_ref, worktree_path, branch,
reviewed_source_refs, raw_bytes, restore_mode}` with `materialized` added only in raw mode.
`reviewed_source_refs` counts retained parked reviewed refs, which are not copied into the active namespace.
An exact stamp present in only one repository selects that repository before
generic slug ambiguity. Selecting evidence-only storage, even with `--raw`,
refuses with `no restorable files were parked for <slug> <stamp>; only review evidence was kept`.
Classification checks the bare `--raw` flag first (`restore_mode: "raw-requested"`),
then `/snapshot` (`"snapshot"`), then `/branch-tip` (`"branch-tip"`). Legacy parks
have neither marker for either shape. An unmarked head is a snapshot only if the
commit author is exactly `AI-DLC`, its email is `aidlc@localhost`, and its subject
starts with `aidlc: parked bolt-<slug> at ` (`"legacy-snapshot"`); otherwise it is
a branch tip (`"legacy-branch-tip"`). The identity check ignores Git replacement objects.
Snapshots and explicit `--raw` report `raw_bytes: true`, bypass smudge/process
filters and working-tree-encoding conversions, and stream regular-file blobs
directly to disk; only symlink targets are buffered.
`materialized` counts regular files plus symbolic links written, excluding submodule gitlinks.
Both branch-tip modes use Git's ordinary checkout, applying filters and encoding
conversions, and report `raw_bytes: false`. A required failing filter fails the
restore with Git's message; `--raw` bypasses conversions after any remaining
restore checkout and branch have been removed.

Symbolic links are materialized as symlinks when `core.symlinks` is unset or true;
with `core.symlinks=false`, a mode-120000 entry is written as a regular file whose
bytes are the link target, exactly as Git checks it out.
Raw-restored filtered paths may appear modified under their own filter. Submodule
gitlinks become empty directories, not restored submodule checkouts. Git's
eol/`text=auto` normalization during parking remains a limit: normalized CRLF
bytes cannot be recovered. Together with ignored untracked files, this is the
explicit snapshot-mode `parked_excludes` boundary; tracked files matching ignore patterns
remain included. A regular file with a non-UTF-8 name and a `filter`, `text`,
`eol`, `ident`, or `working-tree-encoding` attribute (neither unspecified nor
unset) cannot currently be parked; discard refuses before teardown with:

```text
cannot park file with a non-UTF-8 name and a content-transforming attribute (<attr>=<value>): <name>; rename the file or unset its <attr> attribute
```

`{{INVOKE}} engine worktree purge --slug <bolt-slug> [--parked <stamp> |
--older-than <days>] [--repo <name|.>]` compare-deletes all matching parked refs.
With no selector it removes every stamp for the slug; `--parked` selects one
exact stamp. `--older-than` accepts nonnegative finite days, including fractions,
and selects only attempts strictly older than the threshold. Age comes from the
UTC `YYYYMMDDTHHMMSSZ` portion of the stamp, not its numeric `-N` collision suffix
or a commit date. The shared strict calendar parser rejects impossible dates
and times rather than normalizing them; age-filtered purge retains unparseable
stamps and reports them in `skipped_unparseable: [stamps]`. The two selectors
are mutually exclusive. Purge refuses while any corresponding restored checkout
exists or remains registered with Git, including moved checkouts. Its JSON is
`{purged: <number-of-refs>, slug, stamps: [...], skipped_unparseable: [...]}`.
`skipped_unparseable` is always present and is empty unless `--older-than`
retains unparseable stamps; exact-stamp and all-stamp purges can remove them.
For restore and purge, `--repo <name>` selects an existing sibling Git repository
and `--repo .` selects the project root, independently of the current intent's
repo list. Both `WORKTREE_CREATED` and `WORKTREE_DISCARDED` emit `Repo`: the
recorded sibling name, or `-` for the project root. A discard row preserves this
provenance even when its creation row is unavailable. Recovery admits valid Git
repositories named in the same slug's creation or discard audit `Repo` fields even when those
sibling names are symlinks: the framework may recover exactly where it recorded
the attempt's worktree or parking. That admission is slug-scoped; records for
other slugs never widen this slug's repository set. Intent membership alone,
current or historical, cannot admit a symlink. Intent-list candidates and
unrecorded discovered siblings must be real immediate child directories whose
canonical paths remain directly under the canonical workspace root
(`isWorkspaceRepoDir`). Arbitrary paths and symlink aliases without the
same-slug audit provenance are refused. These selectors do not change
live create/discard behavior. Restore and purge reject unknown and duplicate
flags before selection or mutation; `--raw` is a bare restore-only flag.

Doctor lists saved `/head` entries and evidence-only namespaces containing actual
reviewed source refs informationally, not as warnings or failures: slug, stamp,
age in days, mode (`snapshot`, `branch-tip`, `legacy`, or `evidence-only`),
existence of the canonical restored checkout, and typed recovery operations
for the exact stamp with an explicit repository selector. Every entry has
`purge_operation`; only restorable entries have `restore_operation`. Each has
route `worktree` and exact argv args, never a shell program. Optional
`restore_command` and `purge_command` are safe renderings for human display;
if rendering throws, the corresponding command is omitted and
`restore_command_error` or `purge_command_error` carries the reason while the
operation remains. Evidence-only entries have only the purge operation and its
command-or-error fields. Doctor applies the same slug-scoped audit provenance
and real-immediate-child boundary described above; an intent's repo list alone
does not admit a symlink, nor does a record for another slug. A moved checkout
may not show as restored there, but purge still checks its Git registration. Doctor and
purge share the strict stamp parser: impossible dates or times have
`age_days: null` in doctor's JSON and `unknown` in human-readable output. Restore and
purge add no audit events. See `aidlc-shared/worktree-info-schema.md` for the JSON
examples and recovery contract.

---

## How AIDLC reads strategy from team practices

The dispatch protocol described in this section is implemented by **SKILL.md Step 0** (worktree create) and **Step 6.5** (worktree merge). `aidlc-bolt complete --merge` orchestrates around the dispatch (forkState merge-back, forkAudit merge-back) but does not call `aidlc-worktree merge` directly — the dispatch lives in SKILL.md prose.

When a Bolt starts (Step 0) or completes (Step 6.5), the orchestrator dispatches a Task call to **aidlc-pipeline-deploy-agent** with two inputs:

1. The resolved `## Way of Working` statement from `aidlc/spaces/<active-space>/memory/{project,team,org}.md` (fallback chain in `shared/rules-reading.md`).
2. The Bolt's metadata (slug, source branch, optional target-line hint for release-branch teams).

The agent reads this file (`branching-strategies.md`) as the menu, matches the team's stated strategy to one of the five above, picks the right `aidlc-worktree` flags, invokes the tool, and returns the response envelope per § Response contract.

If the team's stated strategy doesn't map cleanly to the menu (e.g. "we use a hybrid"), the agent picks the closest fit and notes the deviation in the response's `notes` field; the orchestrator surfaces it in the audit log.

If none of `project.md`, `team.md`, or `org.md` provides a branching practice, the agent applies hardcoded defaults — trunk-based with squash, base `main`, target `main` — and emits `PRACTICES_SECTION_EMPTY` (advisory-only).

---

## Quick decision matrix

| You want... | Use |
|---|---|
| Default for a new project | Trunk-Based |
| OSS-style PRs with longer-lived branches | GitHub Flow |
| Enterprise release management | GitFlow |
| Versioned releases with stabilisation periods | Release Branches |
| Multiple services in one repo | Monorepo (on top of one of the above) |

If unsure, choose Trunk-Based. It's the lowest-overhead strategy with the strongest CI/CD ecosystem support, and AIDLC's Construction worktrees are designed for it as the default.
