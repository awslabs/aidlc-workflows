# Release supply chain

AI-DLC releases are created in `awslabs/aidlc-workflows` by two isolated
workflows: `.github/workflows/release.yml` for stable tags and
`.github/workflows/preview-release.yml` for scheduled or manually dispatched
previews. Both use the repository-provided `GITHUB_TOKEN`. Neither requires a
GitHub App, a personal access token, a second repository, or repository
secrets for publication. Full Suite live tests, called by the preview and by a
stable release that has no reusable result, use the existing `ai-pr-review`
environment's `AWS_AI_PR_REVIEW_ROLE_ARN` secret, resolved by the called
workflow's live jobs. The caller passes `secrets: inherit`, without which that
environment secret resolved empty in the called run.

## Release trigger

Pushing a strict `vX.Y.Z` tag starts the release workflow. The first job rejects
the release unless all of these conditions hold:

- the event ref is the pushed tag;
- the checked-out commit is the tag target;
- the tag target is contained in `main`;
- the tag equals `v` plus the version in `core/tools/aidlc-version.ts`.

Stable publication requires a passing release-purpose Full Suite for the exact
tagged commit. This reverses the 2026-09-21 decision that stable releases need
no Full Suite result; the maintainer reversed it on 2026-09-26. The
`Find Full Suite evidence` job (`actions: read`) searches successful Preview
Release runs of the tagged commit and successful manual `full-suite.yml`
dispatches on `main`, downloads their `full-suite-result`, and reuses the first
that qualifies. Evidence counts only from those reviewed workflows on `main`:
runs on other branches or events, verification artifacts, and results for
another commit or run never qualify. When none qualifies, the release calls
`full-suite.yml` for the tagged commit with `contents: read`,
`id-token: write` and `secrets: inherit`, as the preview does. A failed search
falls back to running the suite. `Require a passing Full Suite` then downloads
the result and runs `scripts/ci-full-suite-evidence.ts check`, which requires the
tagged `sha`, the producing `runId`, `purpose: "release"`,
`verificationFamily: "all"`, `coveragePolicy: "required-hosted-live-v1"`,
`passed: true`, no omitted or disabled legs, and every declared job successful.
A suite this run called must also have succeeded. `publish` and `release` need
that gate and recheck its verified commit; builds and lifecycle checks run
alongside the suite. A tag outside `main` fails validation, because a
release-purpose Full Suite only tests commits already on `main`.

An explicit manual `full-suite.yml` dispatch may set `live_verification=true`
to validate a candidate's live jobs before merge, or `full_verification=true` to
run every credential-free job on it. The two are mutually exclusive, and both
inputs are unavailable to reusable callers. The plan requires `workflow_dispatch` and an exact match
between the checked-out source and the manually selected workflow head
(`github.sha`). Ordinary runs retain the source-on-main gate and all required
jobs. There is no automatic privileged branch-push or PR trigger.

Live verification uses the same isolated live preparation, environment-owned role
and low-privilege broker clients. It intentionally omits the native,
deterministic and production-guard jobs. Its artifact is named
`full-suite-live-verification-result` and records `purpose: "live-verification"`
and `complete: false`; a successful result requires the live jobs to succeed
and the omissions to be explicitly skipped. The stable release workflow does
not consume this artifact, including for a verification run on `main`.

Full verification runs the native, deterministic, production-guard and Windows
release-contract jobs on the candidate, and never the jobs that receive
credentials: it skips `live_prepare`, `live_linux`, `live_macos` and
`live_windows`, which request OIDC and the AWS role, so unmerged code never runs where those
credentials are reachable. Every Full Suite checkout sets
`persist-credentials: false`, so candidate code does not find the repository
token on disk either. It refuses `verification_family` and `verification_test`
filters. Its artifact is named `full-suite-verification-result` and records
`purpose: "full-verification"`, `complete: false`, and exactly those four jobs
in `omittedLegs`; a successful result requires every other job to succeed and
the four to be skipped. No release workflow consumes it, even after the
candidate merges.

Manual verification can additionally select `verification_family` as
`claude-sdk`, `claude-tui`, `codex`, or `opencode`; its default is `all`.
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
and Windows live jobs have separate concurrency caps of 12, 6 and 6. Each role session requests
3,600 seconds just before its run step; jobs allow 80 minutes, test steps 70
minutes, and live files and runs 3,600 seconds. Model work stops at the
five-minute cleanup reserve, so it always ends while the session is valid, and
evidence collection follows. Timeouts fail coverage.
The existing IAM role duration and credential-separation boundary are unchanged.

Feature, fix, documentation, refactor, and test PRs do not update release
metadata. The release-preparation PR summarizes the user-visible changes merged
since the previous release and updates the version, README badge, and changelog
entry together before the tag is created. The workflow does not modify source
files.

## Build and validation

After validating the exact tag and source commit, the stable workflow:

1. regenerates every harness distribution and checks deterministic output;
2. runs typecheck, lint, ShellCheck, and
   PSScriptAnalyzer;
3. builds native binaries for Linux, macOS, and Windows;
4. runs native and installer smoke tests;
5. creates the out-of-band manual-copy `aidlc-copy-runtime-X.Y.Z.tar.gz` and
   its `.sha256` sidecar, the manifest-listed native
   `aidlc-runtime-X.Y.Z.tar.gz`, installers, `version.json`, and `checksums.txt`;
6. verifies the staged release inventory and checksums;
7. requires a passing Full Suite for that commit before `publish` attests
   anything, reusing an earlier result or running the suite alongside steps 1
   to 6.

The stable workflow runs the source test tiers only through that Full Suite.
Required PR checks provide Linux smoke, unit, and deterministic integration
coverage plus production-guard checks on every push; the merge queue adds the
focused cross-OS native-terminal and OS-isolation checks. Cross-platform E2E and
hosted live coverage run in the Full Suite, which the nightly preview calls and
stable publication requires for the tagged commit. The stable workflow
independently validates generated output, native binaries, installers,
lifecycle flows, checksums, and provenance of the release assets.

The release manifest records the tag ref and exact source commit. Both runtime
archive names include the release version. Manual-copy users download
`aidlc-copy-runtime-X.Y.Z.tar.gz`; native installers select
`aidlc-runtime-X.Y.Z.tar.gz`. The copy archive stays outside the manifest and
main checksum inventory so 2.8.x clients retain forward-compatible update
discovery; its sidecar and release provenance authenticate it independently.

## Provenance

The `publish` job receives `id-token: write` and `attestations: write` only
after the build and lifecycle jobs and the Full Suite gate pass. GitHub generates build provenance for
the staged assets. The exported provenance bundle is included as
`aidlc-release.intoto.jsonl`.

The preview workflow schedules `main` daily at 22:00 in `Europe/Lisbon` and
accepts manual dispatch. Scheduled and manual runs serialize through the
`release-preview` workflow concurrency group without cancelling the active run.
Each later run re-reads the release list: the planner skips the publication build
chain if the source commit is unchanged since the latest published preview.
Contract checks and Full Suite still run for that source, and the final result requires their
success even when publication is deduplicated. If `main` advances again on the
same UTC date, another preview can publish with the next build counter.

The planner reads the current stable `x.y.z` from
`core/tools/aidlc-version.ts` and allocates
`<x.y.(z+1)>-preview.<YYYYMMDD>.<N>` using the UTC date at planning and ids
occupied by existing tags or release records. It calculates the next patch in
memory and never edits release metadata. Drafts and orphan tags reserve their
ids, so retry planning and later same-day publications advance `N` past their
occupied ids. Leftover `aidlc-staging-*` drafts still require inspection and
removal before the publisher stages another candidate.

The planner renders notes from changes since the previous preview. Contract
checks gate the authorized commit before the normal release build chain. Full
Suite runs first but does not gate it. A failing suite still builds and
publishes the preview; its notes open with a warning and end with the Full
Suite failure report, and the run stays red. Only the `Release tests` job that renders this
report adds `actions: read`, to list the run's jobs. Preview does not repeat the
PR CI test matrix.
PR CI and Full Suite use the same `deterministic-tests.yml` workflow definition
with different matrices: Linux smoke/eight unit shards/integration for PRs, and
Linux/macOS/Windows smoke/eight unit shards/integration/E2E for nightly coverage.
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
gh release create "$RELEASE_TAG" build/release/* \
  --verify-tag \
  --title "AI-DLC ${RELEASE_TAG#v}" \
  --generate-notes
```

The job then compares the local asset names with the asset names returned by
the GitHub Release API. A missing or extra upload fails the workflow.

All earlier jobs retain `contents: read`. The called Full Suite's live jobs also
receive `id-token: write`, only for the `ai-pr-review` role, as in the preview.
No stored credential receives release write access, and no job receives
publication permission before the environment gate.

## Creating a release

1. Merge a release-preparation PR that updates:
   - `core/tools/aidlc-version.ts`;
   - the README version badge;
   - the matching `CHANGELOG.md` heading.
2. Confirm that the release-preparation PR passed its required branch checks and
   select its exact merged commit on `main`. A successful preview of that
   commit, or a manual `full-suite.yml` dispatch on `main` with `ref=<sha>`,
   leaves a `full-suite-result` the release reuses. Without one, the release
   runs the Full Suite itself and takes hours longer.
3. Create and push the matching tag from the selected commit. The commit may no
   longer be the tip of `main`, but it must still be contained in `main`:

   ```bash
   RELEASE_SHA="<release-preparation-commit-sha>"
   RELEASE_VERSION="X.Y.Z"
   git fetch --no-tags origin \
     "+refs/heads/main:refs/remotes/origin/main" &&
   git cat-file -e "${RELEASE_SHA}^{commit}" &&
   git merge-base --is-ancestor "$RELEASE_SHA" origin/main &&
   test "$(
     git show "${RELEASE_SHA}:core/tools/aidlc-version.ts" |
       awk -F'"' '/^export const AIDLC_VERSION = "/ { print $2 }'
   )" = "$RELEASE_VERSION" &&
   git tag "v$RELEASE_VERSION" "$RELEASE_SHA" &&
   git push origin "v$RELEASE_VERSION"
   ```

4. Monitor the `Release` workflow. It validates the tag and source, requires a
   passing Full Suite for the tagged commit (reused or run), and runs
   deterministic packaging, static checks, native smoke coverage, cross-platform
   builds, installer lifecycle tests, checksums, and provenance validation.
5. Confirm that the GitHub Release contains the binaries, installers,
   `aidlc-copy-runtime-X.Y.Z.tar.gz`, its `.sha256` sidecar,
   `aidlc-runtime-X.Y.Z.tar.gz`, `version.json`, `checksums.txt`, and the
   provenance bundle.

If publication fails before the release is created, rerun the failed workflow.
A failing Full Suite blocks publication: rerun its failed jobs for a flake, or
fix the failure and prepare a new release.
If a partial release exists, inspect and remove it before rerunning. Published
assets must not be replaced silently. Correct them in a new patch release.
