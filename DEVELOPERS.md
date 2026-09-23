# Development and releases

Changes reach users through this sequence:

**Pull request → AI review and PR checks → merge to `main` → nightly preview
and end-to-end tests → stable release.**

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
  types, lint, smoke tests, unit shards, native-terminal units, production-guard
  contracts, and operating-system isolation. The full integration and E2E
  matrix runs at the preview stage.
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

Once the checks and review feedback are addressed, a maintainer merges the PR.
The merged commit becomes eligible for preview testing and publication.

The `ci.yml` workflow has PR, manual-dispatch, and reusable
workflow triggers, but no push-to-`main` trigger. Merging does not automatically
rerun that entire test gate. The other workflows have their own triggers:

- [Markdownlint](.github/workflows/markdownlint.yml) and
  [Security Scanners](.github/workflows/security-scanners.yml) run on pushes
  to `main`.
- [Deploy Documentation](.github/workflows/docs.yml) builds and deploys when
  documentation or its build inputs change on `main`.
- Preview Release calls CI again for its selected source commit.

## 3. Let the nightly preview run

[Preview Release](.github/workflows/preview-release.yml) runs daily at
**22:00 Europe/Lisbon**. A maintainer can also start it from GitHub Actions
using **Run workflow** on `main`, or:

```bash
gh workflow run preview-release.yml --ref main
```

For a new source commit, the workflow:

1. Selects a commit from `main` and runs the reusable CI gate.
2. Calls [Full Suite](.github/workflows/full-suite.yml) for smoke/unit tests,
   deterministic integration and E2E tests on Linux, macOS, and Windows,
   native-terminal validation, and the enabled live test families.
3. Builds the release assets, checks native binaries and installer lifecycles,
   verifies checksums, and generates build provenance.
4. Publishes a GitHub **prerelease** for preview users after the gates pass.
   Preview publication leaves stable release discovery unchanged.

Live model tests depend on `AIDLC_NIGHTLY_LIVE=1` and the provisioned test
environment. The `full-suite-result` artifact records the tested commit in
`sha`, the verdict in `passed`, and any `excluded` families or `disabledLegs`.
Read those fields when assessing coverage: a passing configured matrix can
still have exclusions.

The preview workflow skips publication and testing when the latest published
preview already uses the same source commit.
For changed source the [planner](scripts/plan-preview-release.ts) allocates
`vX.Y.Z-preview.YYYYMMDD.N`, where `X.Y.Z` is
the next patch after the source version, the date is UTC, and `N` is a build
counter. This stamps the artifacts without editing source release metadata.
Publication rechecks that the selected commit is still the tip of `main`;
if `main` advances during the run, start a new preview from the new tip.

To try a published preview, follow the
[preview-channel instructions](docs/guide/18-install-and-lifecycle.md#release-channels).

## 4. Release to production from tested source

The production channel is **stable**. Maintainers select source that has
passed preview validation and publish it through the
[Release workflow](.github/workflows/release.yml). Stable assets are rebuilt
from that verified commit with the stable version; the workflow does not
rename or republish the preview binaries.

1. **Prepare the release in a PR.** Choose the stable version and update
   `core/tools/aidlc-version.ts`, the README badge, and the matching changelog
   entry together. Summarize changes since the previous stable release and
   include any upgrade instructions. Review and merge this PR to `main`.
2. **Obtain evidence for the final commit.** Wait for, or manually start, a
   preview on that commit. Confirm the run succeeds and its `full-suite-result`
   artifact contains `full-suite-result.json` with the exact commit SHA and
   `passed: true`. The release-preparation commit needs its own evidence;
   evidence from before the metadata change cannot satisfy the release gate.
3. **Push the matching stable tag.** Tag the verified commit as `vX.Y.Z`,
   matching the version in its `core/tools/aidlc-version.ts`. It must be
   contained in `main`. Tag that exact commit even if `main` has since advanced.
4. **Monitor Release.** The tag push starts validation, deterministic tests,
   native builds, installer checks, and provenance generation. Publication
   runs through the `release` environment; complete any approval configured
   there.
5. **Verify publication.** Confirm the workflow succeeds and the stable GitHub
   Release contains the binaries, runtime archives, installers, `version.json`,
   checksums, and provenance bundle.

If the evidence artifact is missing or expired, or an unchanged preview would
skip testing, renew it by dispatching Full Suite **from `main`** for the intended
commit:

```bash
gh workflow run full-suite.yml --ref main -f 'ref=<intended-release-sha>'
```

The stable gate also accepts this successful manual run when its artifact
matches the tag SHA and has `passed: true`. It reports excluded families and
disabled live jobs as warnings. A passing PR check alone cannot satisfy this
gate.

See [Creating a release](docs/reference/19-supply-chain-security.md#creating-a-release)
for tagging commands, asset details, and recovery guidance. The
[`release-pr.yml` workflow](.github/workflows/release-pr.yml) is a dispatcher
for the legacy `v1` line; it does not prepare releases for `main`.
