# Development and releases

Changes reach users through this sequence:

**Pull request → AI review and PR checks → merge to `main` → published preview
→ stable promotion.**

`main` is the integration branch. A merge makes a change available for the next
preview; publishing a stable release is a separate maintainer decision. This
guide covers the current `main` release line. For local setup and the
edit/build/test loop, see the [Contributing Guide](docs/reference/11-contributing.md)
and [contribution guidelines](CONTRIBUTING.md).

## 1. Open a pull request

Branch from the latest `main`, make a focused change, validate it locally, and
open a PR targeting `main`. Explain the problem, resulting behavior, and what
you tested.

Ordinary PRs leave the version in `core/tools/aidlc-version.ts`, the README
version badge, and release entries in `CHANGELOG.md` unchanged. Maintainers
update those together during preview promotion and its metadata synchronization PR.

Two kinds of feedback arrive before merge:

- **CI checks** run on PR creation, new commits, and reopening. The
  [CI workflow](.github/workflows/ci.yml) checks deterministic packaging,
  types, lint, Linux smoke tests, unit shards and integration, plus
  production-guard checks. The focused native-terminal and operating-system
  isolation checks on Linux arm64, macOS and Windows run in the merge queue.
  The full cross-platform and live matrix runs at the preview stage.
- **AIDA, the AI reviewer**, reviews eligible PRs automatically. The
  [AI review workflow](.github/workflows/ai-pr-review.yml) supports open,
  non-draft PRs from branches in this repository targeting `main`; fork PRs
  are currently skipped. Mark a draft ready for review to start review.
  Pushing fixes triggers another review. PR edits and eligible maintainer
  review activity can also trigger it.

Respond to the findings and fix failing checks. AIDA reports an advisory next
decision: `author/change` asks the author to address gaps; `maintainer/merge`
hands the merge decision to a maintainer. AIDA does not approve or merge PRs.
Read the decision even when the review check is green: it can still ask for
changes. The [PR guidelines](CONTRIBUTING.md#submitting-your-pr) explain its
labels and review criteria.

### Dependency updates

[Dependabot](.github/dependabot.yml) checks the root Bun dependencies
(`package.json` and `bun.lock`), the uv documentation dependencies
(`pyproject.toml` and `uv.lock`), and GitHub Actions weekly. Minor and patch
updates are grouped by ecosystem; major updates get separate PRs. Each
ecosystem has a limit of three open version-update PRs. These PRs follow the
same checks and merge queue as other changes.

Version updates become active when the configuration is merged into the
default branch, `main`. To check the setting, open **Settings → Advanced
Security → Dependabot version updates**. To inspect update jobs, open
**Insights → Dependency graph → Dependabot**. Dependabot security updates
have a separate setting under **Settings → Advanced Security**.

## 2. Merge to `main`

Once the checks and review feedback are addressed, a maintainer adds the PR to
the merge queue. The queue runs the CI workflow on the queued merge commit,
including the cross-OS checks that PR pushes skip, and squash-merges it. The
merged commit becomes eligible for preview testing and publication.

The `ci.yml` workflow has PR, merge-queue, manual-dispatch, and reusable
workflow triggers, but no push-to-`main` trigger. CI does not run again on
`main` after the queue merges. The other workflows have their own triggers:

- [Markdownlint](.github/workflows/markdownlint.yml) and
  [Security Scanners](.github/workflows/security-scanners.yml) run on pushes
  to `main`.
- [Deploy Documentation](.github/workflows/docs.yml) builds and deploys when
  documentation or its build inputs change on `main`.
- Preview Release runs contract checks and Full Suite for its selected source
  commit, without repeating the PR CI test matrix.
- [Merge queue runner notice](.github/workflows/merge-queue-notice.yml) runs
  after each merge-queue CI run. When the queue dropped a PR only because a
  GitHub-hosted runner failed, it comments on the PR so the author knows it
  was not their change and a maintainer can add it back; it never changes the
  queue.

For explicitly approved full-suite testing before merge, a maintainer can run:

```bash
gh workflow run full-suite.yml --ref '<candidate-branch>' \
  -f 'ref=<exact-workflow-head-sha>' -f full_verification=true
```

This runs the full declared matrix, including native obligations, deterministic
tiers, production guards and all hosted live/release-contract jobs. Inspect
`full-suite-verification-result/full-suite-result.json` for
`purpose: "full-verification"`, `passed: true`, and no omitted jobs.
The result is PR validation, not release evidence. The flag is manual-only,
requires source equality with the selected workflow head, and cannot be combined
with `live_verification` or family/file filters.

For live-only testing before merge, use:

```bash
gh workflow run full-suite.yml --ref '<candidate-branch>' \
  -f 'ref=<exact-workflow-head-sha>' -f live_verification=true
```

To repeat only Codex coverage, use:

```bash
gh workflow run full-suite.yml --ref '<candidate-branch>' \
  -f 'ref=<exact-workflow-head-sha>' -f live_verification=true \
  -f verification_family=codex
```

The family choices are `all` (default), `claude-sdk`, `claude-tui`, `codex`,
`copilot`, and `opencode`. Scoped verification preserves the selected family's shard
identities and skips Windows release contracts. It cannot be requested for an
ordinary release-purpose run or through a reusable-workflow call.

This manual-only mode requires the source SHA to equal the selected workflow
head. It executes the selected hosted live coverage, including release contracts
when the family is `all`, using the existing isolated credential flow.
Native/deterministic/production-guard jobs are intentionally skipped. It does
not replace the ordinary CI checks. A newer dispatch on the same branch with
the same family and test selection cancels the older run, so redispatch after
each push instead of cancelling the previous head's run by hand.
Inspect `full-suite-live-verification-result/full-suite-result.json` for
`purpose: "live-verification"`, `verificationFamily`, and the live job results.
A successful run still has `complete: false` and is not consumed by stable
publication, even when run on `main`.
Normal Full Suite runs keep both verification flags false and accept the
requested ref, including an unmerged branch. They run all required jobs and
produce the ordinary `full-suite-result` artifact. For example:

```bash
gh workflow run full-suite.yml --ref '<candidate-branch>' \
  -f 'ref=<candidate-branch-or-sha>'
```

Every job uses the resolved commit SHA. Stable publication separately requires
a published preview whose source is on `main`; an unmerged candidate run is not
a published preview.

To reproduce a deterministic failure on one fresh runner, dispatch the shared
deterministic workflow directly:

```bash
gh workflow run deterministic-tests.yml --ref '<candidate-branch>' \
  -f 'ref=<exact-source-sha>' -f runner=windows-latest -f tier=unit \
  -f unit-shard=1/1 -f 'diagnostic_filter=^t-tui-runtime$'
```

The manual-only `diagnostic_filter` is a filename regex. The unit tier requires
`unit-shard=N/M`; use `1/1` to select all unit files before filtering, or `7/12`
without a filter to repeat a whole unit shard. For smoke, integration or e2e,
omit `unit-shard`; its default is empty. Each dispatch uses one runner, closes
model gates, checks out the immutable source and retains sanitized logs under
`ci-deterministic-probe-<OS>`. These diagnostics do not qualify a full suite or
a release. Existing CI and Full Suite callers cannot pass this filter.

## 3. Let the nightly preview run

[Preview Release](.github/workflows/preview-release.yml) runs daily at
**22:00 Europe/Lisbon**. A maintainer can also start it from GitHub Actions
using **Run workflow** on `main`, or:

```bash
gh workflow run preview-release.yml --ref main
```

The workflow:

1. Selects a commit from `main` and runs packaging, type, lint and shell checks.
2. Dispatches [Full Suite](.github/workflows/full-suite.yml) as a separate run for native-terminal
   validation, required live harness shards and release-contract tests.
   Deterministic tiers and production guards run in PR/merge CI and remain
   available through manual `full_verification`.
3. Builds the release assets, checks native binaries and installer lifecycles,
   checks that an install of the last stable release updates to the new build
   with every harness project's hooks, refresh and doctor still working
   (`update-from-previous`), verifies checksums, and generates build provenance.
4. Publishes a GitHub **prerelease** for preview users after the gates pass.
   Preview publication leaves stable release discovery unchanged.

A failing Full Suite does not stop steps 3 and 4. The **Release tests** job
summary and the `preview-test-report` artifact list the failed legs, failed
jobs, and failing test cases. The published preview's notes open with a warning
and end with the same report. Full Suite retains its failed status in its own
run. **Release result** requires successful preview publication (or an
intentional skip), without requiring Full Suite to pass.

A failing `update-from-previous` job does not stop the preview either: the run
turns red, and the notes open with a warning and gain a line in the report. In
a stable release it holds publication back, like the lifecycle checks. Its log
names the harness and step that failed. Rerun the job only for a passing
problem such as a download that failed. A stable release runs on its tagged
commit, so a fault in the build needs the fix on `main` and a new
preview, version and promotion; the next nightly preview runs the check again
on its own.

PR/merge CI and manual Full Suite `full_verification` share
[one deterministic test definition](.github/workflows/deterministic-tests.yml).
Each call owns its checkout. Default PR CI includes Linux integration; the merge
queue and expanded manual CI also run deterministic E2E. Ordinary nightly and
release Full Suite runs do not repeat those tiers or production-guard jobs.

Hosted live coverage uses 27 jobs: on each existing OS, two Claude SDK shards
(five on Linux), three Claude TUI shards, one Codex shard, one Copilot CLI shard
and one opencode shard. Each shard runs
at most two files concurrently, restoring the checkout and application home
between files and retrying only a failed file after confirmed cleanup. Platform
preparation is independent, so Linux and Windows do not wait for macOS.

Live model tests are required Full Suite jobs and use the existing
`ai-pr-review` environment's `AWS_AI_PR_REVIEW_ROLE_ARN`. The `full-suite-result` artifact records the tested
commit, run identity, release purpose, coverage policy, job outcomes and
excluded families.
Required Full Suite jobs must all succeed for the suite to pass; disabled live
jobs fail it.
Documented provider exclusions remain explicit, so a successful job matrix is
not a claim that every possible test ran.

When the latest published preview already uses the same source commit, or was
built from a newer commit that contains it (an older run, retried or queued), the
workflow still runs its checks and tests, then skips the publication build chain
and publishes nothing.
For changed source the [planner](scripts/plan-preview-release.ts) allocates
`vX.Y.Z-preview.YYYYMMDD.N`, where `X.Y.Z` is
the next patch after the source version, the date is UTC, and `N` is a build
counter. This stamps the artifacts without editing source release metadata.
A run tests and publishes the commit it was started on. `main` receives merges
constantly, so planning and publication require only that the commit is still
on `main`, not that it is the tip, even if `main` moves before a runner picks
the run up. A revert does not stop it: to withdraw a commit a preview is
testing, cancel that run.

To try a published preview, follow the
[preview-channel instructions](docs/guide/18-install-and-lifecycle.md#release-channels).

## 4. Promote a preview to production

Stable releases start from the **commit that produced a published preview**.
The promotion adds one commit containing the version, README badge, CHANGELOG
entry and publication controls. Later product changes on `main` are excluded.
The stable binaries are rebuilt with the final version; preview assets are not
renamed or reused.

1. **List previews.** Run **Promote preview** on `main` with all inputs empty.
   Its summary lists every published preview, source commit, compatibility with
   the current release tooling and recorded warnings. Incompatible previews stay
   listed with the reason; preparation rejects them before reserving a version.
   A published preview is not automatically an approved preview.
   You can also list them locally:

   ```bash
   bun scripts/release-promotion.ts list --repository awslabs/aidlc-workflows
   ```

2. **Choose the preview, version and notes.** Review the preview's existing test
   report and the manual Kiro release-journey results for its source commit,
   one for `kiro` and one for `kiro-ide`. Record both and the source SHA in the
   selected preview's release notes. Reuse existing results for that SHA; if
   missing, run the
   [Kiro journey](docs/reference/09-testing.md#nightly-full-suite-matrix-and-provisioning)
   on that source before selecting it. Put the stable release notes in a
   file, starting with `Compatibility: refresh only`, `Compatibility: refresh
   plus a step`, or `Compatibility: breaking for scripts`, followed by the
   summary, upgrade instructions and flat bullets. Then dispatch:

   ```bash
   gh workflow run promote-release.yml --ref main \
     -f preview=v2.11.1-preview.20261016.1 \
     -f version=2.11.1 -F notes=@release-notes.md
   ```

   The same fields are available in Actions. GitHub's input choices are static,
   so the preview tag is a text field and the empty dispatch provides the live
   list. Supply all three fields to promote; a partial submission names the
   missing fields and creates no tag. The stable version may be a patch, minor
   or major; it must be newer than the source version and published stable releases.

3. **Follow the Release run.** Preparation creates the stable tag and explicitly
   dispatches `release.yml` on it. That preserves the tag and source identity
   expected by installed clients' provenance checks. The stable build checks
   the metadata-only relationship, packaging determinism, native binaries,
   installers, lifecycle flows, upgrades, checksums and provenance. It does not
   rerun PR CI or Full Suite. Existing test failures remain recorded and appear
   in the release notes; selecting a preview is the maintainer's release
   decision, not a new passing test result. The `release` environment's existing
   publication approval still applies.

4. **Record the version on main.** After publication, **Prepare main version
   update** pushes `release-metadata/vX.Y.Z` and provides a link to open its PR.
   Open and merge that metadata-only PR through the normal branch checks. It
   keeps later product changes and README content on `main`. It never moves
   `main` back to the preview or downgrades a newer source version. If needed,
   rerun just this step or run:

   ```bash
   bun scripts/release-promotion.ts sync --tag v2.11.1 \
     --repository awslabs/aidlc-workflows
   ```

A retry before publication reuses a reserved tag only when its verified preview,
version and notes match. A different decision needs a different version; tags
and published assets are never overwritten. A failed build can be retried with
`gh workflow run release.yml --ref vX.Y.Z`. Preparation success means the build
was dispatched, not that publication succeeded.

See [Creating a release](docs/reference/19-supply-chain-security.md#creating-a-release)
for the source and provenance contract. `release-pr.yml` remains a dispatcher
for the `v1` line.
