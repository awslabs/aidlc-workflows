# Development and releases

Changes reach users through this sequence:

**Pull request → AI review and PR checks → merge to `main` → optional preview
validation or stable release.**

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
update those together in a release-preparation PR.

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

For explicitly approved live testing before merge, a maintainer can run:

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
and `opencode`. Scoped verification preserves the selected family's shard
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
Normal Full Suite runs keep `live_verification=false`, the main-source gate,
all required jobs, and the ordinary `full-suite-result` artifact.

## 3. Let the nightly preview run

[Preview Release](.github/workflows/preview-release.yml) runs daily at
**22:00 Europe/Lisbon**. A maintainer can also start it from GitHub Actions
using **Run workflow** on `main`, or:

```bash
gh workflow run preview-release.yml --ref main
```

The workflow:

1. Selects a commit from `main` and runs packaging, type, lint and shell checks.
2. Calls [Full Suite](.github/workflows/full-suite.yml) for smoke tests, eight
   independent unit shards per OS,
   deterministic integration and E2E tests on Linux, macOS, and Windows,
   native-terminal validation, production guards and required live test families.
3. Builds the release assets, checks native binaries and installer lifecycles,
   verifies checksums, and generates build provenance.
4. Publishes a GitHub **prerelease** for preview users after the gates pass.
   Preview publication leaves stable release discovery unchanged.

PR CI and Full Suite share
[one deterministic test definition](.github/workflows/deterministic-tests.yml).
Each call owns its checkout. Deterministic integration and isolated E2E run
as separate jobs per OS, each with eight workers and a fresh Bun runner process;
unit files stay serial within each independent shard. Default PR CI includes
Linux integration; E2E runs in Full Suite and expanded manual CI.

Live model tests are required for preview publication and use the existing
`ai-pr-review` environment's `AWS_AI_PR_REVIEW_ROLE_ARN`. The `full-suite-result` artifact records the tested
commit, run identity, release purpose, coverage policy, job outcomes and
excluded families.
Required preview jobs must all succeed; disabled live jobs fail preview
readiness.
Documented provider exclusions remain explicit, so a successful job matrix is
not a claim that every possible test ran.

When the latest published preview already uses the same source commit, the
workflow still runs its checks and tests, then skips the publication build chain.
For changed source the [planner](scripts/plan-preview-release.ts) allocates
`vX.Y.Z-preview.YYYYMMDD.N`, where `X.Y.Z` is
the next patch after the source version, the date is UTC, and `N` is a build
counter. This stamps the artifacts without editing source release metadata.
Publication rechecks that the selected commit is still the tip of `main`;
if `main` advances during the run, start a new preview from the new tip.

To try a published preview, follow the
[preview-channel instructions](docs/guide/18-install-and-lifecycle.md#release-channels).

## 4. Release to production from an approved source

The production channel is **stable**. Stable publication does not require a
preview run or a Full Suite artifact. Maintainers select a release-preparation
commit on `main` whose required branch checks passed and publish it through the
[Release workflow](.github/workflows/release.yml). Stable assets are rebuilt
from that commit; the workflow does not rename or republish preview binaries.

1. **Prepare the release in a PR.** Choose the stable version and update
   `core/tools/aidlc-version.ts`, the README badge, and the matching changelog
   entry together. Summarize changes since the previous stable release and
   include any upgrade instructions. Review and merge this PR to `main`.
2. **Confirm the release commit.** Verify that the release-preparation PR passed
   its required branch checks and select its exact commit on `main`.
3. **Push the matching stable tag.** Tag that commit as `vX.Y.Z`, matching the
   version in `core/tools/aidlc-version.ts`. The commit must be contained in
   `main`, but it does not need to remain the tip.
4. **Monitor Release.** The tag push validates the tag and source, runs contract
   checks, builds native assets, and checks installers, lifecycle flows,
   checksums, and provenance. It does not repeat the source
   smoke/unit/integration/E2E tiers. Publication runs through the `release`
   environment; complete any approval configured there.
5. **Verify publication.** Confirm the workflow succeeds and the stable GitHub
   Release contains the binaries, runtime archives, installers, `version.json`,
   checksums, and provenance bundle.

Preview remains available for additional cross-platform and live validation,
but its result is not consumed by the stable workflow. A missing or expired
`full-suite-result` requires no recovery action before tagging.

See [Creating a release](docs/reference/19-supply-chain-security.md#creating-a-release)
for tagging commands, asset details, and recovery guidance. The
[`release-pr.yml` workflow](.github/workflows/release-pr.yml) is a dispatcher
for the `v1` line; it does not prepare releases for `main`.
