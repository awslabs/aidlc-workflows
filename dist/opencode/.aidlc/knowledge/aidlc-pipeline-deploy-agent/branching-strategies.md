# Branching Strategies

A menu of common branching strategies, what they look like, when to use them, and how AIDLC's Construction worktrees map onto each. When the orchestrator dispatches aidlc-pipeline-deploy-agent at Bolt boundaries, this file is the menu the agent surveys to map a team's affirmed branching strategy onto the `aidlc-worktree` tool's flags.

> **Reading practices:** see `knowledge/aidlc-shared/rules-reading.md` for empty-template detection, semantic-topic matching, and the `team.md → org.md → hardcoded defaults` fallback chain. This file does not duplicate that protocol.
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

**Worktree mapping.** Create: `bun .aidlc/tools/aidlc-worktree.ts create --slug <bolt-slug> --base main`. Merge: `--target main --strategy squash`. Each Bolt = one squash commit on `main`.

**Parallel Bolts.** Cleanest fit. Multiple Bolts can be in flight simultaneously; each branches from current `main`, each merges back without rebase contention because squash flattens history at merge time.

### Execution runbook

When dispatched for trunk-based:

1. Read `team.md` `## Branching` per `shared/rules-reading.md`. If empty, fall back to `org.md`, then to hardcoded defaults.
2. Resolve flags: `--base main --target main --strategy squash` for the default; deviate only if `team.md` explicitly says otherwise.
3. **Create**: invoke `bun .aidlc/tools/aidlc-worktree.ts create --slug <bolt-slug> --base main`.
4. **Merge** (after Bolt gate approval): caller must be on `main` at the main checkout. Invoke `bun .aidlc/tools/aidlc-worktree.ts merge --slug <bolt-slug> --target main --strategy squash --message "<commit message>"`.
5. Return the JSON envelope per § Response contract back to the orchestrator.

### Failure modes

- **Dirty tree on merge.** Local uncommitted changes on `main`; tool errors with the git message verbatim. Orchestrator's halt-and-ask offers retry/abort. Worktree preserved on retry; user explicitly discards on abort.
- **Conflict on squash.** Squash conflicts with concurrent `main` motion (e.g. another Bolt landed first). Tool exits non-zero with `{status: "conflict", conflict_files, detail}`. Orchestrator quotes `detail` to the user.
- **Branch already exists.** Pre-audit error; the tool refuses to clobber. Orchestrator should run `discard` first (rare) or pick a different slug.

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

1. Read `team.md` `## Branching` (and `## Merge style` if present). The merge-strategy choice (squash vs merge) is what differs from trunk-based.
2. Resolve flags: `--base main --target main --strategy <squash|merge>` per affirmation; default to `squash`.
3. **Create**: `bun .aidlc/tools/aidlc-worktree.ts create --slug <bolt-slug> --base main`.
4. **Merge**: `bun .aidlc/tools/aidlc-worktree.ts merge --slug <bolt-slug> --target main --strategy <squash|merge> [--message "<msg>"]`. With `--strategy merge`, a no-fast-forward merge commit preserves the bolt branch's individual commits.
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

1. Read `team.md` `## Branching`. Look for the integration-branch name (`develop` is the convention; teams sometimes use `integration` or `next`).
2. For feature Bolts: `--base <integration> --target <integration> --strategy <merge|squash>`. Default to `merge`.
3. For hotfix Bolts (rare in Construction; usually triggered by an out-of-band stage): `--base main --target main --strategy merge`. The operator separately merges the hotfix back to `<integration>` after `aidlc-worktree merge` succeeds. Out of scope for the tool.
4. **Create**: `bun .aidlc/tools/aidlc-worktree.ts create --slug <bolt-slug> --base <integration>`.
5. **Merge**: caller must be on `<integration>` at the main checkout. `bun .aidlc/tools/aidlc-worktree.ts merge --slug <bolt-slug> --target <integration> --strategy <merge|squash>`.
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

1. Read `team.md` `## Branching`. Look for the release-branch pattern (`release/vX.Y` is the convention).
2. Determine which line the Bolt belongs to from the Bolt's metadata (the orchestrator passes a `target_line: main | release/vX.Y` hint). Default to `main` when ambiguous.
3. **Create**: `bun .aidlc/tools/aidlc-worktree.ts create --slug <bolt-slug> --base <line>`.
4. **Merge**: caller on `<line>` at the main checkout. `bun .aidlc/tools/aidlc-worktree.ts merge --slug <bolt-slug> --target <line> --strategy merge`.
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

The orchestrator's halt-and-ask quotes the `detail` field verbatim. See `aidlc-common/protocols/stage-protocol.md` § "Halt-and-ask on failure" and `skills/aidlc/SKILL.md` § "Halt-and-ask failure handling" for the full prompt shape and preservation invariant.

### Discard response

```json
{
  "emitted": "WORKTREE_DISCARDED",
  "slug": "<bolt-slug>",
  "worktree_path": "/abs/path/.aidlc/worktrees/bolt-<slug>",
  "reason": "agent-discard",
  "audit_timestamp": "2026-05-18T12:34:56Z"
}
```

If the worktree was already gone (idempotent path), `emitted` is `null` and `reason` is `already-discarded` — no audit event is re-emitted.

---

## How AIDLC reads strategy from team practices

The dispatch protocol described in this section is implemented by **SKILL.md Step 0** (worktree create) and **Step 6.5** (worktree merge). `aidlc-bolt complete --merge` orchestrates around the dispatch (forkState merge-back, forkAudit merge-back) but does not call `aidlc-worktree merge` directly — the dispatch lives in SKILL.md prose.

When a Bolt starts (Step 0) or completes (Step 6.5), the orchestrator dispatches a Task call to **aidlc-pipeline-deploy-agent** with two inputs:

1. The contents of `.aidlc/rules/aidlc-team.md`'s `## Way of Working` section (or `aidlc-org.md` if `aidlc-team.md` is empty — fallback chain in `shared/rules-reading.md`).
2. The Bolt's metadata (slug, source branch, optional target-line hint for release-branch teams).

The agent reads this file (`branching-strategies.md`) as the menu, matches the team's stated strategy to one of the five above, picks the right `aidlc-worktree` flags, invokes the tool, and returns the response envelope per § Response contract.

If the team's stated strategy doesn't map cleanly to the menu (e.g. "we use a hybrid"), the agent picks the closest fit and notes the deviation in the response's `notes` field; the orchestrator surfaces it in the audit log.

If neither `aidlc-team.md` nor `aidlc-org.md` provides branching practice, the agent applies hardcoded defaults — trunk-based with squash, base `main`, target `main` — and emits `PRACTICES_SECTION_EMPTY` (advisory-only).

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
