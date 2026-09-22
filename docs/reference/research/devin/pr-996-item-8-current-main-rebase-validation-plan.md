# PR #996 Item 8 — Current-main integration and exact-SHA validation plan

**Status:** in execution in the isolated worktree `/tmp/aidlc-item8-squash` (branch `item8-squash-integration`, base `3c54ec1a`); squash transplant staged, conflicts resolved, release metadata applied, deterministic gate in progress. No commit, branch rewrite, or push yet.

**Prepared:** 2026-09-22

**PR:** https://github.com/awslabs/aidlc-workflows/pull/996

**Review:** https://github.com/awslabs/aidlc-workflows/pull/996#pullrequestreview-5226026258

**Item:** 8 — validate the branch after rebasing onto current `main`

## 1. Objective

Rebuild the Devin harness contribution on the current authoritative `upstream/main`, resolve integration conflicts according to the repository's present architecture rather than the review's historical snapshot, and validate the exact rewritten commit locally and through the PR checks.

The result must preserve the same architectural principles as the Claude Code harness:

- shared behavior remains in `core/`;
- Devin translation and host configuration remain in `harness/devin/`;
- generated `dist/` and `dist-release/` files remain untracked and are never conflict-resolved by hand;
- the packager produces every harness deterministically from authored sources;
- shared contracts keep Claude and all existing harnesses working while Devin adds only a thin host boundary;
- deterministic tests do not depend on a locally installed Devin binary;
- live Devin acceptance is explicitly gated and reported separately from deterministic PASS results.

## 2. Scope and non-goals

### In scope

1. Move PR #996's final authored tree from `41d43efd953fcd63fd05d49e858daf061b4358e4` onto the current fetched `upstream/main`.
2. Resolve current-tree conflicts semantically, including architecture changes added to `main` after the review.
3. Publish the Devin harness as the next feature version from main: `2.10.0`, with synchronized authored version, README badge, and one new changelog entry containing only what PR #996 delivers.
4. Preserve every pre-existing release entry from `main` unchanged.
5. Integrate Devin with the new split neutral/native onboarding architecture.
6. Regenerate derived coverage metadata instead of hand-merging it.
7. Remove the retained evidence tree's whitespace errors while retaining the four owner-approved directories.
8. Re-run deterministic and live Devin validation against the exact rewritten SHA.
9. Scan the authoritative rewritten range with the repository's pinned Gitleaks configuration.
10. Update the PR with a first-person, untagged result that distinguishes current-tree state, rewritten PR history, retained evidence, skips, and live results.

### Not in scope

- Removing the four owner-retained attended-run directories. They remain the documented grandfathered exception unless the owner separately reverses that decision.
- Claiming global erasure of old GitHub objects. Replacing the PR branch removes superseded commits from the new PR range; it does not prove that GitHub immediately garbage-collected objects referenced by prior review commits or server-side logs.
- Adding unrelated `main` work to the new 2.10.0 changelog entry. Existing historical entries remain untouched; the new entry describes only the Devin harness and its directly delivered contracts, tests, documentation, and upgrade step.
- Treating a successful merge preview, deterministic fixture replay, skipped live gate, or earlier attended run as validation of the rewritten SHA.
- Resolving the Shared Testing Contract repair concern by deletion. The rebase must preserve its current observable compatibility behavior unless a separate fact-checked task changes that decision.

## 3. Fact-check record

### 3.1 Authoritative Git and PR state

Measured after `git fetch upstream main` on 2026-09-22:

| Fact | Observed result | Consequence |
| --- | --- | --- |
| Current PR head | `41d43efd953fcd63fd05d49e858daf061b4358e4` | This is the source tree to transplant. |
| Current `upstream/main` | `3c54ec1ac5d856e2bedb73434b8c403562030b3f` | Execution must fetch again and pin the then-current SHA before beginning; this value is evidence for the plan, not a forever target. |
| Merge base | `c6def6678b1ba1b7f1c3104c77c77801f33ac01c` | The branch and current main have diverged substantially. |
| Divergence | main-only 39 commits; branch-only 80 commits, of which 76 are non-merge commits | The review's “16 commits behind” count is historical and no longer true. |
| PR state | open, non-draft, `CONFLICTING` / `DIRTY`, review decision `CHANGES_REQUESTED` | This state comes from GitHub, not inference from local Git. |
| PR check rollup | Six metadata/label checks only; no packaging, typecheck, lint, smoke, unit, integration, or e2e checks | The review's check-coverage concern remains true for the current PR rollup even though current `main` now contains a fuller CI workflow. |
| Current-main change since merge base | 445 files, 80,590 insertions, 7,715 deletions | Conflict resolution must adopt current architecture rather than mechanically retain old branch code. |

The review's five-file conflict list was also historical. A current isolated three-way merge preview reports these **12** conflicts:

1. `AGENTS.md`
2. `README.md`
3. `core/aidlc-common/protocols/stage-protocol-reviewer.md`
4. `core/hooks/aidlc-plan-approval-guard.ts`
5. `core/templates/onboarding.md`
6. `core/tools/aidlc-config-diagnostics.ts`
7. `core/tools/aidlc-testing-posture.ts`
8. `docs/guide/15-troubleshooting.md`
9. `tests/.coverage-ratchet.json`
10. `tests/.coverage-registry.json`
11. `tests/unit/t149-codex-hook-adapter.test.ts`
12. `tests/unit/t265-plan-approval-guard.test.ts`

That list is a preflight only. Execution must repeat the isolated preview after the final fetch because `main` can move.

### 3.2 Why a literal commit-by-commit rebase is rejected

An isolated `git rebase upstream/main` trial stopped while replaying the original Devin feature commit `172cfd55`. Besides release-metadata conflicts, it produced dozens of modify/delete conflicts under old tracked `dist/<harness>/` trees. Current `main` intentionally removed those generated files from Git.

Replaying all 76 non-merge commits would therefore:

- repeatedly replay obsolete release bumps and old integration states;
- resurrect generated `dist/` content long enough to require manual deletion decisions;
- amplify conflict risk across four historical upstream merge commits;
- retain superseded broad evidence blobs in the rewritten PR commit sequence;
- validate historical intermediate states rather than the final authored contribution.

The selected strategy is a **curated squash transplant** of the final branch tree onto current `main`. This produces a branch whose parent is current `main`, keeps generated outputs absent, and limits conflict resolution to the final effective diff. The local pre-rewrite head is retained only as an unpushed backup ref for recovery.

### 3.3 Release metadata and owner decision

Both current branch head and current `upstream/main` contain:

```ts
export const AIDLC_VERSION = "2.9.0";
```

The README badge is `2.9.0`, and `CHANGELOG.md` already contains one `## [2.9.0] - 2026-09-15` entry. The feature branch has no final diff against current main in `core/tools/aidlc-version.ts` or `CHANGELOG.md`; only Devin support prose remains in `README.md`.

Current `AGENTS.md`, `CONTRIBUTING.md`, and `DEVELOPERS.md` say ordinary feature/fix/test/docs PRs leave the authored version, README badge, and changelog release entries unchanged, with release preparation normally handled separately. The owner explicitly designated PR #996 as a release-bearing feature and selected **2.10.0**, the next SemVer minor after main's 2.9.0. Execution must record that exception openly rather than claiming it follows the default policy.

The rewritten PR therefore updates exactly these synchronized release surfaces:

- `core/tools/aidlc-version.ts` → `AIDLC_VERSION = "2.10.0"`;
- README badge → `version-2.10.0`;
- one new topmost `CHANGELOG.md` heading, `## [2.10.0] - <execution date>`.

Every existing changelog entry, including 2.9.0, remains byte-for-byte present. The new 2.10.0 entry must describe only the Devin harness delivered in PR #996; it must not roll unrelated changes already present on main into this release note.

### 3.4 Devin official documentation and installed binary

Item 8 is primarily a Git integration issue; no Devin documentation can decide Git ancestry or repository release policy. The host-dependent validation assumptions were nevertheless checked independently:

| Surface | Official bundled docs | Installed binary observation |
| --- | --- | --- |
| Installed version | Bundled stable changelog currently tops out at `v3000.10.31` | `devin --version` reports `devin 3000.11.1 (cc4e349ca55e)`; this docs/binary lag must be recorded, not silently harmonized. |
| Scripted execution flags | Command reference documents `--config`, `--print`, `--export`, and `--respect-workspace-trust` | `devin --help` exposes those flags with matching purposes. |
| Rule loading | Official rules docs say project `AGENTS.md` is loaded automatically and `.devin/rules/*.md` supports `trigger: always_on` | `devin rules --help` exposes the rule registry commands; live load behavior remains an execution acceptance check. |
| Support floor | Official stable changelog contains `v3000.10.21` | Authored helper pins `DEVIN_MIN_VERSION = [3000, 10, 21]`; installed `3000.11.1` is above it. |

The onboarding conflict can therefore use current main's neutral root `AGENTS.md` plus a Devin-native `.devin/rules/aidlc-onboarding.md` carrying `trigger: always_on`. This follows the same split architecture used by other harnesses while using Devin's documented native load surface.

### 3.5 Current CI and whitespace state

Current `upstream/main` has a materially stronger `.github/workflows/ci.yml` than the review snapshot. Its deterministic gate runs:

- `bun run check` (packaging, two-build determinism, all typechecks, lint);
- smoke tests;
- four unit shards;
- deterministic integration + e2e with `--no-llm --parallel 8`;
- changelog preservation.

The current PR has not run those jobs according to its GitHub check rollup.

`git diff --check upstream/main...HEAD` currently fails only in the four retained Devin evidence directories: **543 trailing-whitespace findings plus one blank-line-at-EOF finding, 544 total across 11 files**. Ten files contain trailing whitespace; `reviewer-scope-run/12-hooks-health.txt` has the EOF finding. Retaining the directories and requiring a clean PR diff are compatible if those 11 files are transparently normalized and their manifests/provenance are updated.

## 4. Decisions

### D1 — Integration strategy

Use a curated squash transplant onto a freshly fetched and pinned `upstream/main`, not a literal replay of 76 commits and not a merge commit.

- Create an unpushed local backup ref at the old PR head.
- Create a temporary integration branch/worktree at the pinned main SHA.
- `git merge --squash` the backup ref into that worktree.
- Resolve only the final-tree conflicts.
- Commit the resulting authored change as a clean current-main contribution.
- Do not push the backup ref because it retains the superseded history and raw artifacts.

### D2 — Shared-core authority

For every shared `core/`, shared documentation, and cross-harness test conflict, current `main` supplies the architecture. Reapply only the final Devin contract that is still required at a documented harness seam. Never select an entire “ours” side merely because it contains Devin text.

### D3 — 2.10.0 feature release metadata

Treat PR #996 as the owner-designated 2.10.0 feature release for first-class Devin CLI support:

- set `core/tools/aidlc-version.ts` to `2.10.0`;
- set the README badge to `2.10.0`;
- preserve every existing changelog entry;
- prepend exactly one `## [2.10.0] - YYYY-MM-DD` entry using the execution date;
- include no unrelated feature, fix, workflow, or release-pipeline work from main in that entry.

Use this entry shape, adjusting wording only when exact final verification requires it:

```markdown
## [2.10.0] - YYYY-MM-DD

AI-DLC 2.10.0 adds first-class Devin CLI support as the eighth harness generated from the shared core. **Upgrade:** run `aidlc update`; to add Devin to a project, run `aidlc config --harness devin`, restart Devin CLI, then run `/aidlc --doctor`.

* Add the Devin CLI distribution with native skills, rules, agent profiles, hook wiring, project configuration, optional default-off MCP servers, onboarding, installation, and diagnostics.
* Translate Devin-native dispatch, question, lifecycle, session, and tool payloads at the adapter boundary so shared Plan Approval, stage-rule delivery, background-subagent tracking, and reviewer-scope contracts remain harness-neutral.
* Isolate imported compatibility configuration, require Devin CLI 3000.10.21 or later, and keep deterministic tests independent of whether Devin is installed while gating live CLI acceptance explicitly.
* Add Devin-specific user and harness-engineering guidance, version-scoped sanitized regression fixtures, and documented live acceptance results and limitations.
```

The heading, authored constant, and README badge must agree under `tests/unit/t68-version-changelog-sync.test.ts`. The changelog preservation guard must prove no pre-existing heading was removed.

### D4 — Onboarding architecture

Adopt current main's two-skeleton design:

- root `AGENTS.md` is neutral and byte-identical across harnesses that share it;
- Devin native setup is emitted to `.devin/rules/aidlc-onboarding.md`;
- the native file gets Devin frontmatter with `trigger: always_on`;
- `harness/devin/manifest.ts` uses `harnessDst: "rules/aidlc-onboarding.md"` and marks root `AGENTS.md` as `shared: "identical"`;
- neutral onboarding adds `.devin` and the Devin native onboarding path to the relevant inventory;
- compute the pre-rewrite `dist/devin/AGENTS.md` SHA-256 from `41d43efd` and add it as a legacy signature so an existing managed Devin install can migrate without treating the old generated onboarding as user-owned;
- update t331 to assert neutral root content separately from Devin-native content and to pin the native rule frontmatter/path.

This is the Claude-parity choice: one shared neutral source plus a thin native setup projection, not a Devin-specific fork of all onboarding prose.

### D5 — Retained evidence and whitespace

Keep the four owner-approved directories, but normalize the 544 whitespace defects:

- remove trailing spaces/tabs from the ten affected files;
- remove the extra EOF blank line from `reviewer-scope-run/12-hooks-health.txt`;
- recompute the affected run manifests;
- update each affected existing run README and DEVIN-14 with the exact transformation, old/new manifest hash, and the limitation that normalized files are sanitized historical evidence rather than untouched raw bytes;
- add no new evidence directory or raw export.

Do not suppress the findings with `.gitattributes` and do not weaken `git diff --check`.

### D6 — Coverage metadata

Delete conflict markers by regenerating, not by choosing either JSON side:

```bash
bun tests/gen-coverage-registry.ts
bun tests/gen-coverage-registry.ts --check
```

Review the regenerated ratchet delta to ensure counts rise or remain valid; do not lower a floor merely to pass.

### D7 — History and force-push boundary

The squash transplant rewrites the PR branch and requires a force-push. No force-push is authorized by this plan alone.

After all checks pass, present:

- old remote SHA;
- new exact SHA;
- pinned base SHA;
- `git range-diff`/tree-diff summary;
- Gitleaks result;
- exact `git push --force-with-lease=<old SHA>` command.

Execute it only after explicit approval. Use `--force-with-lease`, never plain `--force`.

The rewritten PR range will no longer replay deleted broad captures or old generated `dist/` commits. That is not a claim of global object erasure, and the four retained attended-run directories remain intentionally present in HEAD and history.

### D8 — Live-result honesty

Run live acceptance only after deterministic validation on the final SHA. Record the exact binary build and result per case. A skipped or credential-blocked case is `NOT RUN`, never PASS. Do not commit a new raw run tree.

## 5. Conflict-resolution map

The repeated preflight is authoritative at execution time. For the currently measured 12 conflicts, apply these rules:

| File | Resolution |
| --- | --- |
| `AGENTS.md` | Keep current-main split-onboarding policy. Add Devin only where the resulting architecture actually supports it; do not restore the old single-template statement. |
| `README.md` | Keep current-main provider-selection text and documentation link; retain the Devin harness row and support wording. Recompute the tool count from the final tree rather than choosing 71 or 73. Update only the synchronized release badge from `2.9.0` to `2.10.0`. |
| `core/aidlc-common/protocols/stage-protocol-reviewer.md` | Preserve main's swarm-unit lifecycle, main-workspace record location, worktree explanation, and cleanup rules. Add Devin to the enforcement-capable list and retain the Devin foreground/no-pending-background requirement. |
| `core/hooks/aidlc-plan-approval-guard.ts` | Start from current main's parser/guard structure. Reapply only branch semantics not already present: file-descriptor redirect artifacts, relevant cwd-change handling, and any still-required framework/Git checkpoint carve-outs. Preserve main's newer safety checks. Prove the combined behavior in t265 and the Devin adapter tests before accepting it. |
| `core/templates/onboarding.md` | Keep neutral current-main content. Add only neutral Devin inventory entries; move Devin prerequisites and host claims to the native harness skeleton output. |
| `core/tools/aidlc-config-diagnostics.ts` | Keep main's distribution symlink/path safety imports and wording. Add the Devin minimum-version import and Devin provider-menu case. Do not drop either safety checks or Devin diagnostics. |
| `core/tools/aidlc-testing-posture.ts` | Keep both `gitCommitSourceListing` and `isReadOnlyEngineProbe` imports. Preserve main's `contractProjectDir` for posture resolution while retaining repair telemetry against the actual `projectDir`/`planPath`; keep read-only-probe suppression and hash validation. Exercise parent/worktree and repair-observability tests together. |
| `docs/guide/15-troubleshooting.md` | Retain both current-main Bolt restoration guidance and the historical testing-contract-repair guidance; keep sections in the current guide structure. |
| `tests/.coverage-ratchet.json` | Regenerate after all source/test changes; do not hand-merge counts. |
| `tests/.coverage-registry.json` | Regenerate after all source/test changes; do not hand-merge units or counts. |
| `tests/unit/t149-codex-hook-adapter.test.ts` | Keep both the current-main PATH isolation helper and the branch's explicit-selection parser import/tests. This test protects Codex while shared ask-user handling gains Devin shapes. |
| `tests/unit/t265-plan-approval-guard.test.ts` | Keep both current-main restart/recovery fixtures and the branch's load-steering/early-exit fixtures. Resolve imports and helpers without deleting either test family. |

After these textual conflicts, audit every auto-merged shared file changed on both sides. An auto-merge is not proof that semantics compose. At minimum review the shared Plan Approval, reviewer-scope, lifecycle, packaging, harness matrix, test runner, and documentation-parity diffs.

## 6. Execution sequence

### Phase A — Freeze inputs and create recovery points

1. Require a clean authored worktree; do not discard local changes.
2. Fetch `upstream/main` and `origin/feat/devin-harness`.
3. Record `OLD_HEAD`, `OLD_REMOTE`, `BASE_SHA`, merge base, and divergence counts.
4. Refuse to continue if local HEAD differs from the expected remote without an explicit reconciliation decision.
5. Create an unpushed local backup ref such as `backup/pr-996-pre-item8-<short SHA>`.
6. Re-run an isolated merge preview and update this plan's conflict inventory if `main` moved.

### Phase B — Build the rewritten tree in isolation

1. Create a temporary worktree/branch at the pinned `BASE_SHA`.
2. Squash-merge the backup ref into it.
3. Resolve conflicts according to §5.
4. Keep all `dist/` and `dist-release/` paths untracked/deleted.
5. Apply the synchronized 2.10.0 version, badge, and Devin-only changelog entry in D3; preserve all older changelog entries.
6. Apply the split Devin onboarding migration in D4.
7. Normalize retained evidence according to D5 and recompute affected manifests.
8. Regenerate coverage metadata according to D6.
9. Search for conflict markers, stale old onboarding paths, stale harness counts, stale pre-rebase SHA claims, and any unrelated claim in the 2.10.0 entry.
10. Update DEVIN-14 with the rebase-validation result only after the exact final SHA and live results exist.

### Phase C — Focused semantic checks

Run packaging first so tests consume freshly generated projections:

```bash
bun scripts/package.ts
bun scripts/package.ts --check
bun tests/gen-coverage-registry.ts --check
bun test tests/unit/t68-version-changelog-sync.test.ts
bun test tests/unit/t149-codex-hook-adapter.test.ts
bun test tests/unit/t181-conductor-skill-parity.test.ts
bun test tests/unit/t239-documentation-parity.test.ts
bun test tests/unit/t265-plan-approval-guard.test.ts
bun test tests/unit/t294-config-diagnostics.test.ts
bun test tests/unit/t299-testing-posture-wiring.test.ts
bun test tests/unit/t328-plan-approval-runtime-authority.test.ts
bun test tests/unit/t331-devin-packaging.test.ts
bun test tests/unit/t332-devin-adapter.test.ts
bun test tests/unit/t334-devin-version.test.ts
bun test tests/unit/t345-doctor-devin-import-isolation.test.ts
bun test tests/integration/t121-stop-hook-enforce.test.ts
bun test tests/integration/t327-stop-hook-subagent-inflight.test.ts
bun test tests/integration/t328-authority-rebinding.test.ts
```

If current main renamed or split a test, use the then-current equivalent and record the substitution.

### Phase D — Current CI-equivalent deterministic gate

Use the current workflow's commands, not the review's old command list:

```bash
bun install --frozen-lockfile
bun run check
bun scripts/package.ts
bun tests/run-tests.ts --smoke
bun tests/run-tests.ts --unit
bun tests/run-tests.ts --integration --e2e --no-llm --parallel 8
```

Also require:

```bash
git diff --check upstream/main...HEAD
bun scripts/ci-changelog-guard.ts "$(git rev-parse upstream/main)"
git diff --unified=0 upstream/main...HEAD -- core/tools/aidlc-version.ts README.md CHANGELOG.md
git merge-base --is-ancestor upstream/main HEAD
git status --short
```

The release-surface diff must show exactly: `2.9.0` → `2.10.0` in the authored constant and badge, the Devin support changes in README, and one new Devin-only 2.10.0 changelog entry with every older entry retained. The final status must be clean after committing. `git diff --check` must report zero findings; no evidence-path exemption is allowed.

### Phase E — Gitleaks on the authoritative rewritten history

Current main pins Gitleaks `8.30.1` and SHA-256 `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` in `.github/workflows/security-scanners.yml`. Reuse that pinned, checksum-verified installation recipe rather than introducing a project dependency.

Run both:

```bash
gitleaks git --config=.gitleaks.toml --baseline-path=.gitleaks-baseline.json --log-opts="upstream/main..HEAD" .
gitleaks git --config=.gitleaks.toml --baseline-path=.gitleaks-baseline.json --log-opts="HEAD" .
```

The first answers what the rewritten PR adds; the second matches the repository workflow's reachable-history shape. Record scanner version, config/baseline hashes, exact SHA, and exit statuses. If the baseline changes during the rebase, review it rather than automatically accepting new exclusions.

### Phase F — Devin binary acceptance on the exact SHA

Record first:

```bash
devin --version
devin --help
devin rules list
devin skills list
devin mcp list
```

Redirect user configuration to a scratch location for probes whose purpose is project configuration isolation. Do not neutralize it for a test that explicitly measures user-layer behavior.

Run all existing gated Devin e2e files together:

```bash
AIDLC_DEVIN_EXEC_LIVE=1 bun test \
  tests/e2e/t-exec-devin-status.serial.test.ts \
  tests/e2e/t-exec-devin-config-imports.serial.test.ts \
  tests/e2e/t-exec-devin-mcp-headers.serial.test.ts
```

Then execute the attended acceptance matrix without committing raw transcripts:

1. exact-session Plan Approval: wrong-session response refused, matching native approval accepted, receipt retains approving session;
2. approved native `{ profile, task, is_background }` Code Generation dispatch gets exactly one rule bundle; unapproved dispatch remains blocked;
3. foreground child completion records one terminal event;
4. background launch records no completion, terminal `read_subagent` records one completion, repeated read is idempotent;
5. reviewer in-unit reads succeed and sibling reads/searches/writes are blocked, with conductor operations unaffected;
6. session restart/clear preserves only the documented receipt/session behavior;
7. split onboarding is present in `devin rules list`, and `/aidlc --status` still resolves from the shipped projection;
8. optional MCP interpolation passes against the local capture server;
9. authenticated Context7 is rerun only if an approved credential is supplied through the environment/secrets manager. Otherwise report `NOT RUN (credential unavailable)` and do not reuse or expose an old key.

For each case record: exact Git SHA, Devin version/build, OS, config isolation, PASS/FAIL/NOT RUN, and limitations. Store only compact sanitized facts/provenance in DEVIN-14; do not add another raw evidence tree.

### Phase G — Review rewritten result before publication

1. Compare the rewritten tree with the pre-rewrite final tree and explain every difference caused by current-main integration.
2. Confirm all Devin-authored surfaces still live under `harness/devin/` and shared logic under `core/`.
3. Confirm no generated `dist/` path is tracked.
4. Confirm the four retained evidence directories still exist and no fifth raw run was added.
5. Confirm deleted broad fixtures and old campaign files are absent from `upstream/main..HEAD`.
6. Confirm release metadata is synchronized at 2.10.0, every older changelog entry is preserved, and the new entry contains only PR #996's Devin delivery.
7. Record exact deterministic, live, scanner, and skipped results against the final SHA.

### Phase H — Approval, force-push, and PR response

Before any rewrite reaches the remote, present the exact lease-protected command and wait for explicit approval. The command must bind the expected old remote SHA, for example:

```bash
git push \
  --force-with-lease=refs/heads/feat/devin-harness:<OLD_REMOTE_SHA> \
  origin <REWRITTEN_LOCAL_BRANCH>:feat/devin-harness
```

After a successful push:

1. fetch the PR and verify GitHub reports the new head SHA;
2. verify the PR is no longer conflicting with its current base;
3. wait for current CI/security checks and report their actual conclusions;
4. if fork-workflow approval still prevents those checks, state that explicitly and preserve the local command evidence;
5. post a first-person, untagged PR comment covering:
   - historical claims that changed (39 behind at plan time, 12 current conflicts, not 16/five);
   - the squash-transplant rationale;
   - the owner-designated 2.10.0 feature version and Devin-only changelog scope;
   - onboarding migration and shared-core conflict decisions;
   - exact rewritten SHA and base SHA;
   - deterministic, live, Gitleaks, and skipped results;
   - retained evidence exception and whitespace sanitation;
   - the limited history claim (rewritten PR range, not global object erasure).

## 7. Acceptance criteria

Item 8 is complete only when all of the following are true:

- [ ] The PR branch's current main ancestor is the pinned fetched `upstream/main` SHA.
- [ ] GitHub reports the pushed exact SHA as the PR head and no base conflict remains.
- [ ] No generated `dist/` or `dist-release/` file is tracked.
- [ ] `core/tools/aidlc-version.ts`, the README badge, and the new changelog heading agree on 2.10.0.
- [ ] Every pre-existing changelog entry is preserved, and the new 2.10.0 entry describes only the Devin harness delivered by PR #996.
- [ ] Devin uses current main's split neutral/native onboarding architecture and the native rule is documented and binary-observed on the exact SHA.
- [ ] All shared conflict resolutions preserve current-main behavior plus the required thin Devin seam.
- [ ] Coverage metadata is regenerated and its check passes without lowering an unjustified ratchet.
- [ ] `git diff --check upstream/main...HEAD` is clean; all 544 retained-evidence whitespace findings are resolved with provenance updated.
- [ ] `bun run check`, smoke, unit, and deterministic integration/e2e gates pass.
- [ ] Focused Plan Approval, reviewer, lifecycle, Codex-parity, diagnostics, and Devin suites pass.
- [ ] Gitleaks passes for both the rewritten PR range and full history reachable from the exact SHA.
- [ ] Existing gated Devin e2e tests pass on the recorded binary, or any genuine blocker is reported as NOT RUN.
- [ ] Attended acceptance results are tied to the exact SHA and do not rely on raw committed transcripts.
- [ ] The four grandfathered evidence directories remain the only raw-run exception; no new raw run is committed.
- [ ] The force-push uses an explicit lease and occurs only after separate approval.
- [ ] The PR comment is first-person, untagged, and does not overclaim history purge, live coverage, CI status, or PR lifecycle state.

## 8. Risks and rollback

| Risk | Mitigation |
| --- | --- |
| `main` moves during execution | Pin a fetched base SHA, finish validation against it, then repeat the ancestry/conflict check immediately before push. Restart integration if the required base changed materially. |
| Squash loses convenient item-by-item branch archaeology | Preserve the old head in an unpushed local backup ref and retain the already-recorded old commit IDs in DEVIN research. Do not publish the backup because it defeats branch-history reduction. |
| Shared guard behavior regresses while resolving Devin conflicts | Base on current main, preserve both test families, run focused cross-harness tests before the full gate, and review auto-merges. |
| New onboarding split makes Devin-specific instructions undiscoverable | Emit an official `.devin/rules/*.md` always-on rule, pin it in t331, verify with `devin rules list`, and execute `/aidlc --status` live. |
| Evidence normalization weakens provenance | Make only whitespace/EOF transformations, recompute manifests, record old/new hashes and the transformation in existing run READMEs and DEVIN-14. |
| Force-push overwrites a newer remote update | Fetch immediately before push and use `--force-with-lease` bound to the recorded old remote SHA. |
| A green local gate is mistaken for GitHub CI | Report local and GitHub results separately and wait for authoritative check conclusions after push. |
| Bundled docs lag installed Devin | Record both versions; use official docs for documented contracts and direct binary execution for observed behavior. |

Rollback before push is deleting the temporary integration worktree/branch and returning to the untouched feature branch. After an approved push, rollback is another lease-protected push of the recorded old head and requires a new explicit approval; never perform it automatically.

## 9. Execution notes (running log)

Semantic integration findings the conflict markers alone did not surface:

- **`readConfigDiagnosticRecords` distribution allowlist** (`core/tools/aidlc-config-diagnostics.ts`): main gained a hard-coded supported-harness check (`distribution must name a supported harness`) that did not know `devin`; every Devin doctor run failed `Providers: could not read recorded answers`. Fixed by adding `devin` to the allowlist. Found by t331 test 9/9d (spawned doctor), not by any conflict marker.
- **Conductor SKILL parity (t181)**: Devin's `SKILL.md` carried the branch-era guard-recovery/settled-swarm text. Ported main's byte-identical block (Guard-recovery execution interaction split, Construction routing precedence paragraph, updated Settled swarm branch), the `run-stage` row's Construction-routing clause, the `ask` row's `interaction` phrasing, the reshape paragraph's interactive-session tail, and the missing Change Control paragraph (with the `.devin` tool path). Devin-specific bindings (`ask_user_question`, `run_subagent`, `/aidlc`, `bun .devin/tools/…`) preserved.
- **Workspace shell `.gitignore` (t157)**: main added the any-depth `**/aidlc/spaces/*/intents/**/.aidlc-engine/` ignore; ported into `harness/devin/dot-gitignore`.
- **Onboarding share list (t151)**: pin updated to six identical-sharing harnesses including `devin`.
- **Provider menu copy (t294)**: branch pinned pre-refactor wording; updated to main's `record the manual Devin CLI provider setup`.
- **Reviewer missing-record advisory (t332 case 23)**: main added a `perUnitReviewOwed` gate (live active-directive marker with a `unit`); the test now seeds that marker so the advisory can fire.
- **Mid-run hazard observed**: repackaging `dist/` while test tiers run can tear project seeding (t214 printed a stale grid count during the window, then passed standalone). Tier results are only trustworthy on a quiescent tree; failing files are re-run after the tree settles.
- **t78 `AUTO-recorded symlink abort hints` fails identically on unmodified `upstream/main` on this host** — pre-existing environment issue, not an integration regression.

Second unit-tier pass (settled-tree reconciliation in progress):

- **`modelHarness` literal allowlist** (`core/tools/aidlc-init.ts`): the parser's
  harness union lacked `devin` even though `ModelHarness`/`aidlc-model-policy.ts`
  already carried the record, so every first-run wizard flow that reached the
  models step threw `models policy is not supported for harness "devin"`.
  Fixed by adding `devin` to the literal union. Found by t299/t304.
- **Detection-fixture coverage is per-key, not per-file (t304)**: the literal
  `AIDLC_TEST_CONFIG_DETECTION_JSON` harness map omitted `devin`, so the seam
  let a REAL probe run for Devin only — the host's installed `devin 3000.11.1`
  was detected and the wizard auto-recommended it instead of showing the
  numbered picker. Lesson for every harness port: any literal detection
  fixture that omits the new harness silently falls through to the host probe.
  Fixed by adding `devin: { found: false, probed: true }` and renumbering the
  Kiro selections (Devin CLI is menu item 5; Kiro CLI/IDE moved to 6/7).
- **Legacy-signature inventories (t243)**: adding the Devin bullet to the
  shared neutral `AGENTS.md` changed its canonical hash
  (`6de1298…` → `3419bc9d…`). The superseded hash joined the authored
  `wholeFileHashes` of every `shared: "identical"` manifest (codex, kiro,
  kiro-ide, cursor, opencode); Copilot's exclusive AGENTS.md embeds the same
  skeleton so its `7a3a1998…` variant also became legacy. Devin's manifest now
  declares `shared: "identical"` + the union of all sibling AGENTS.md
  inventories and `shared: "union"` + the union `.gitignore` inventory, so a
  Devin install recognizes root files any other harness shipped.
- **Reviewer-scope roster pin (t279)**: updated to seven enforcing harnesses
  (Devin added) and eight SKILL.md files.
- **Pre-existing host failures confirmed identical on pristine
  `upstream/main`**: t78 (`AUTO-recorded symlink abort hints`), t240 test 5
  (installed `opencode` has no `debug agent` subcommand), t332-preview
  (3 preview-pipeline cases), t83 (`legacy same-slug same-stamp attempts`).
- **Repackage-window collateral, green standalone**: t214, t324.

Live Devin binary facts for the acceptance record (this host):
`devin 3000.11.1 (cc4e349ca55e)`; `devin rules list`, `devin skills list`, and
`devin mcp list` all execute (no MCP servers configured locally).

- **Devin `-p` permission mode (live e2e, 3000.11.1)**: the default `auto`
  mode auto-approves only read-only tools, and print mode cannot show a
  prompt, so any exec call not matching the project's `Exec(...)` allow rules
  auto-rejects — including the model's exploratory `ls`/`cat` calls while it
  discovers the skill. `smart` still lets a fast-model judge decline
  non-allowlisted calls, so it flakes the same way. `runDevin`/`runDevinAsync`
  now pass `--permission-mode dangerous` — the analogue of copilot's
  `--allow-all-tools` — with the read-only contract preserved as an on-disk
  assertion.
- **Status "scaffolds nothing" assertion too strict**: the PreToolUse hooks
  write `intents/.aidlc-engine/hooks-health/*.last` heartbeats and the
  session lifecycle writes `aidlc/.aidlc-sessions/` + `active-space` on every
  session, all gitignored runtime scratch. The assertion now checks for the
  real contract: no `intents.json`, no `active-intent` cursor, no intent
  record dirs. Result on 3000.11.1: status/config-imports/mcp-headers e2e —
  4/4 pass.

## Final validation record

Base: `3c54ec1a` (fetched upstream/main tip). Validation ran on commit `8efc3d6d` on `item8-squash-integration` (`/tmp/aidlc-item8-squash`); the only subsequent change was appending this record to the plan file. Gitleaks was re-run on the amended head (`upstream/main..HEAD`, 1 commit, no leaks).

- **Determinism**: `bun run check` PASS — package emission byte-identical across two clean builds for all 8 harnesses (claude, codex, copilot, cursor, devin, kiro, kiro-ide, opencode); `tsc --noEmit` clean on all three configs; Biome lint infos only, no errors.
- **Coverage**: registry regenerated via `bun scripts/gen-coverage-registry.ts`; `--check` passes; ratchet held (no unjustified reduction).
- **Unit tier (settled tree)**: 345 files, 8730 executed — 3 failed files / 5 assertions, ALL pre-existing host failures reproduced identically on pristine `upstream/main`: t240 test 5 (host opencode lacks `debug agent`), t332-preview-release-pipeline (3 preview cases), t83 (legacy same-slug same-stamp). Zero merge-attributable failures.
- **Integration+e2e tier**: 214 files — 1 failure: t78 (symlink abort hints), pre-existing on pristine main on this host. TUI/live gates skipped by design.
- **Devin live e2e (3000.11.1, exact SHA)**: 4/4 PASS — t-exec-devin-status (no-state status renders, no workflow scaffolding), t-exec-devin-config-imports (2), t-exec-devin-mcp-headers.
- **Binary observation on exact SHA**: `devin rules list` in `dist/devin` shows `aidlc-onboarding [Devin] always-on`, `aidlc [Devin] always-on`, and the neutral `AGENTS [Standard]` — split onboarding confirmed live.
- **Gitleaks 8.30.1** (pinned, checksum-verified): `upstream/main..HEAD` — 1 commit, no leaks; `HEAD` full history — 521 commits, no leaks.
- **Hygiene**: 0 tracked `dist/`/`dist-release/` files; `git diff --check upstream/main...HEAD` clean; 544 whitespace findings resolved; CHANGELOG 279→280 headings (only `2.10.0` added, Devin-only); version/badge/changelog all `2.10.0`.
- **Evidence**: four grandfathered attended-run dirs retained; 157 evidence files; no fifth raw run; deleted campaign fixtures absent from the rewritten range.
