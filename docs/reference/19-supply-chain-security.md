# Release supply chain

AI-DLC uses `.github/workflows/promote-release.yml` to select a published
preview's source, `.github/workflows/release.yml` to build and publish its stable
release, and `.github/workflows/preview-release.yml` to produce nightly previews.
Publication uses the repository's `GITHUB_TOKEN`; no additional credential is
needed. Only the preview's Full Suite uses the live model environment.

## Release trigger

Run **Promote preview** on `main`. An empty dispatch lists all published previews
with their source, manifest compatibility and warnings. A promotion supplies `preview`, `version` and
reviewed release `notes`; [DEVELOPERS.md](../../DEVELOPERS.md#4-promote-a-preview-to-production)
has the commands. Preview publication may have succeeded despite test failures;
selection is the maintainer's decision, with those failures still recorded.

`scripts/release-promotion.ts` checks that the selected release is a published
prerelease, its annotated tag's source trailer agrees with its commit and
repository, and that commit is on `main`. Before creating a release commit or
reserving a tag, it downloads the preview's `version.json` and applies the same
manifest contract as the final asset verifier, bound to that preview and source.
An incompatible historical preview stays in the list with its rejection reason;
the maintainer must select a compatible preview. It prepares one child commit with:

- the chosen stable version in `core/tools/aidlc-version.ts` and README;
- the new CHANGELOG entry, preserving all previous entries;
- the complete workflow tree, promotion script, preview tag parser and shared
  manifest verifier from the
  immutable main snapshot checked out during preparation;
- `.github/release-promotion.json`, binding the preview, source, controls,
  version, notes, date and recorded warnings.

The workflow tree is copied in full, including deletions, so its files match
reviewed main content and do not require an additional workflow-writing token.
The product source, dependencies, build scripts and harnesses otherwise remain
those of the preview. Carrying publication controls lets an older preview use
the current release process. The candidate's source and controls commits must
both be ancestors of `main`; the release commit itself need not be on `main`.
Validation checks its single parent, the complete changed-file set, exact
metadata contents, file modes and the exact control blobs. It runs again before
signing and publication. An arbitrary tag on `main` cannot release.

Preparation pushes the stable tag without force and dispatches `release.yml`
explicitly on that tag, because a `GITHUB_TOKEN` push does not trigger another
push workflow. The tagged workflow checks the event ref, checkout and tag SHA.
The source identity seen by provenance remains the actual stable tag and commit.
Preparation serializes independently from stable builds. Retries reuse only a
matching verified reservation; another preview or notes cannot claim its tag.

Stable promotion does not repeat CI or Full Suite. Previous results remain
associated with the selected preview and are linked from the stable notes;
recorded warnings are retained. Failed tests are not relabeled as passing.
The existing `release` environment still controls final publication.

An explicit manual `full-suite.yml` dispatch may set `live_verification=true`
to validate a candidate's live jobs before merge, or `full_verification=true` to
run every credential-free job on it. The two are mutually exclusive, and both
inputs are unavailable to reusable callers. The plan requires `workflow_dispatch` and an exact match
between the checked-out source and the manually selected workflow head
(`github.sha`). Ordinary runs accept the requested ref, including an unmerged
branch, and run all required jobs using its resolved immutable SHA. A dispatch
from a candidate branch does not qualify as trusted stable-release evidence.
There is no automatic privileged branch-push or PR trigger.

Live verification uses the same isolated live preparation, environment-owned role
and low-privilege broker clients. It intentionally omits the native,
deterministic and production-guard jobs. Its artifact is named
`full-suite-live-verification-result` and records `purpose: "live-verification"`
and `complete: false`; a successful result requires the live jobs to succeed
and the omissions to be explicitly skipped. The stable release workflow does
not consume this artifact, including for a verification run on `main`.

Full verification runs the native, deterministic, production-guard and Windows
release-contract jobs on the candidate, and never the jobs that receive
credentials: it skips the three `live_prepare_*` jobs and `live_linux`,
`live_macos` and `live_windows`, so unmerged code never runs where those
credentials are reachable. Every Full Suite checkout sets
`persist-credentials: false`, so candidate code does not find the repository
token on disk either. It refuses `verification_family` and `verification_test`
filters. Its artifact is named `full-suite-verification-result` and records
`purpose: "full-verification"`, `complete: false`, and exactly seven jobs in
`omittedLegs`: those six and `scope_runs`, whose tests the deterministic job
already runs; a successful result requires every other job to succeed and the
seven to be skipped. No release workflow consumes it, even after the
candidate merges.

Manual verification can additionally select `verification_family` as
`claude-sdk`, `claude-tui`, `codex`, `copilot`, or `opencode`; its default is `all`.
Scoped runs keep the same exact-head authorization, run only the chosen
family's existing shards, and require Windows release-contract coverage to be
explicitly skipped. The result records `verificationFamily` and its omissions.
Release-purpose runs refuse scoped selections and require
`verificationFamily: "all"` independently of `passed` and the job statuses.
For a specific family, `verification_test` can select an exact repository file.
Discovery rejects unknown or mismatched files and retains their original shard
identities and declared platforms. Preparation runs only on those platforms.
The result records `verificationTest`, `verificationPlatforms` and any omitted
hosted job; the reducer requires those omissions to be skipped and the selected
jobs to succeed. Both the source gate and result reducer refuse this selection
for release-purpose runs.

POSIX preparation obtains a pinned official Node distribution and transports
its complete prefix with the validated dependency archive. Credentialed jobs
only unpack and copy those prepared bytes; they do not execute dependency
installers. Node and CLI startup run under the low-privilege identity after
runner directories are protected. Collection retires that macOS account's
launchd domains and refuses to copy while executable processes remain.

Live matrices assign one file per supported platform to each job. Linux, macOS
and Windows live jobs have separate concurrency caps of 4, 2 and 3. Each role session requests
3,600 seconds just before its run step; jobs allow 80 minutes, test steps 70
minutes, and live files and runs 3,600 seconds. Model work stops at the
five-minute cleanup reserve, so it always ends while the session is valid, and
evidence collection follows. Timeouts fail coverage.
The existing IAM role duration and credential-separation boundary are unchanged.

Feature, fix, documentation, refactor, and test PRs do not update release
metadata. Promotion updates it on the selected source. After publication a
metadata-only branch and PR link synchronize the version, badge and changelog
with current `main`, without changing its product code or downgrading a newer
version.

## Build and validation

After validating the promotion, the stable workflow:

1. regenerates the preview source's harness distributions and checks determinism;
2. builds native binaries for Linux, macOS, and Windows with the stable version;
3. runs native and installer smoke tests, ShellCheck and PSScriptAnalyzer;
4. packages the native and manual-copy runtime archives, installers, manifest
   and checksums;
5. checks installation, lifecycle and updates from the previous stable release;
6. verifies and attests the staged release inventory before publication.

The update journey and final asset verifier use the pinned publication-control
commit's tooling; the build and packager use the selected preview's source.
No PR test matrix or live suite runs during promotion. Required PR checks provide
Linux smoke, unit, and deterministic integration coverage for product changes;
nightly previews provide the broader harness coverage. Lifecycle and upgrade
failures in the newly built stable candidate still block publication.

The release manifest records the stable tag ref and exact release commit. Native
installers select `aidlc-runtime-X.Y.Z.tar.gz`; manual-copy users download
`aidlc-copy-runtime-X.Y.Z.tar.gz`. The copy archive and its checksum sidecar stay
outside the manifest and main checksum inventory for older client compatibility.
Provenance authenticates them independently. No installer trust rule changes.

## Provenance

The `publish` job receives `id-token: write` and `attestations: write` only
after the build, lifecycle and update-from-the-last-release jobs pass
(a preview's `publish` does not wait for the update job, which only reports there). GitHub generates build provenance for
the staged assets. The exported provenance bundle is included as
`aidlc-release.intoto.jsonl`.

The preview workflow schedules `main` daily at 22:00 in `Europe/Lisbon` and
accepts manual dispatch. Scheduled and manual runs serialize through the
`release-preview` workflow concurrency group without cancelling the active run.
Each later run re-reads the release list: the planner skips the publication build
chain if the source commit is unchanged since the latest published preview, or
if that preview was built from a newer commit that descends from this run's
source (an older run, retried or queued), so the channel never moves backwards.
Contract checks and Full Suite still run for that source. The final result
requires validation and the release tests (which report the Full Suite result)
to succeed, and publication to succeed or be skipped as intended; a failed Full
Suite does not fail it, deduplicated or not. If `main` advances again on the
same UTC date, another preview can publish with the next build counter.

A run tests and publishes the commit it was started on. `main` receives merges
constantly, and a runner can pick a run up long after its trigger (22 minutes
for Preview Release 36485041152), so planning, publication and release require
only that the commit is still on `main` (an ancestor of its current tip), not
that it is the tip. The run's provenance names that commit, so it cannot switch
to a newer one. A revert does not remove a commit from `main`'s history, so a
commit reverted after its preview was triggered is still tested with the Full
Suite's credentials and can publish as a prerelease: to withdraw it, cancel that
Preview Release run, or delete the prerelease after it publishes. This is a
maintainer decision (2026-09-29).

The planner reads the current stable `x.y.z` from
`core/tools/aidlc-version.ts` and allocates
`<x.y.(z+1)>-preview.<YYYYMMDD>.<N>` using the UTC date at planning and ids
occupied by existing tags or release records. It calculates the next patch in
memory and never edits release metadata. Drafts and orphan tags reserve their
ids, so retry planning and later same-day publications advance `N` past their
occupied ids. Leftover `aidlc-staging-*` drafts still require inspection and
removal before the publisher stages another candidate.

The planner renders notes from changes since the previous preview. Contract
checks gate the authorized commit, then the release build chain and Full Suite
run in parallel. Publication waits for validated artifacts and the completed
test report. A failing suite still permits publication; the preview notes open
with a warning and end with the Full Suite failure report. Full Suite runs
separately and retains its failed status
without failing Preview Release. Only the preview's Full Suite dispatch job adds
`actions: write`, to start and watch that run; the `Release tests` job adds
`actions: read` to download its evidence and list its jobs. Preview does not repeat the
PR CI test matrix.
PR CI and Full Suite use the same `deterministic-tests.yml` workflow definition
with different matrices: ten Linux unit shards and integration for PRs, and
Linux/macOS/Windows smoke/sixteen unit shards/integration/E2E for a manual full
verification. PR CI runs Linux smoke in its combined contract and production-guard
check job. The nightly (release purpose) Full Suite runs no deterministic
tier: its scope runs and guard matrix run in a job of their own on every OS,
beside the live jobs.
Integration and isolated E2E run in separate jobs with fresh runner processes. Each call
tests a fresh checkout of the supplied commit and retains sanitized evidence;
no previous test result is substituted for a run.
`AIDLC_BUILD_VERSION` stamps the preview id into projections, binaries,
`version.json`, both versioned runtime archives, and the packaged installers
while the source tree keeps its stable `x.y.z` version. A packaged installer
therefore defaults to the release that carried it instead of rediscovering
`latest`. The preview publisher verifies a staging draft,
creates an annotated tag that records the source repository and commit, then
publishes the draft as a prerelease with `make_latest: false`; stable
`latest/download` discovery therefore remains unchanged.

Stable and preview publication use the protected `release` and unattended
`preview` environments respectively. The preview environment must keep the
same `main` deployment policy but no required reviewers; merge approval plus
contract checks are its human and deterministic gates, and Full Suite failures
are reported in the preview notes rather than blocking it. Stable
runs use a separate concurrency group. The preview publisher stages and
byte-verifies the complete
candidate before publication and works with either mutable or immutable
repository releases.

When a compatible GitHub CLI is available, installers verify `checksums.txt`
against that bundle and bind verification to:

- `awslabs/aidlc-workflows`;
- `.github/workflows/release.yml` for stable versions or
  `.github/workflows/preview-release.yml` for preview versions;
- the version tag for stable releases or `refs/heads/main` for previews;
- the exact source commit from `version.json`.

Missing or older GitHub CLI versions do not block installation. In that mode,
online transport remains HTTPS-only, and source identity validation plus
SHA-256 checks remain mandatory, but the client does not authenticate the
Sigstore bundle.

## Publication

The final `release` job runs in the protected `release` environment and receives
`contents: write`. Configure required reviewers on that environment when
releases need human approval. After approval, the job downloads the attested
candidate, rechecks the tag and checksums, and creates the GitHub Release:

```bash
bun scripts/release-promotion.ts notes \
  --repository "$GITHUB_REPOSITORY" \
  --tag "$RELEASE_TAG" \
  --out "$RUNNER_TEMP/release-notes.md"
gh release create "$RELEASE_TAG" build/release/* \
  --verify-tag \
  --title "AI-DLC ${RELEASE_TAG#v}" \
  --notes-file "$RUNNER_TEMP/release-notes.md"
```

The body contains the reviewed notes from the verified promotion record, which
also supplies this version's `CHANGELOG.md` entry, followed by the selected
preview/source reference, which links the preview's page. The preview's
recorded validation warnings and failure report stay on that page, not on the
stable page; the promotion record keeps the warning lines, and the promotion
run's summary shows them. The helper
rechecks the promotion before writing the notes. GitHub's own generated notes
are not used: their "What's Changed" list names every contributing account by handle.

The job then compares the local asset names with the asset names returned by
the GitHub Release API. A missing or extra upload fails the workflow.

Stable build and validation jobs retain `contents: read`; no Full Suite is
called during promotion. The separate preparation job has `contents: write`
to reserve the tag and `actions: write` to dispatch its build. After publication,
metadata synchronization has `contents: write` to push the metadata branch.
These jobs use `GITHUB_TOKEN`; final publication remains in the protected
`release` environment.

## Creating a release

Use [Promote a preview to production](../../DEVELOPERS.md#4-promote-a-preview-to-production).
Select the published preview's tag, choose the final stable version and supply
its release notes. Follow the dispatched stable build, then open the generated
metadata-only PR to record the version on `main`.

If the build fails before publication, rerun the failed jobs or dispatch Release
on the same prepared tag. A retry never moves an existing tag to another commit.
If a release already exists, inspect it before retrying; never replace published
assets silently. Corrections ship in a new version. Metadata synchronization
has its own retry and cannot undo a published release.
