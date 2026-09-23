# Release supply chain

AI-DLC releases are created in `awslabs/aidlc-workflows` by two isolated
workflows: `.github/workflows/release.yml` for stable tags and
`.github/workflows/preview-release.yml` for scheduled or manually dispatched
previews. Both use the repository-provided `GITHUB_TOKEN`. Neither requires a
GitHub App, a personal access token, a second repository, or repository
secrets for publication. Required live tests use the existing `ai-pr-review`
environment's `AWS_AI_PR_REVIEW_ROLE_ARN` secret, resolved by the called
workflow's live jobs without a caller-supplied secret.

## Release trigger

Pushing a strict `vX.Y.Z` tag starts the release workflow. The first job rejects
the release unless all of these conditions hold:

- the event ref is the pushed tag;
- the checked-out commit is the tag target;
- the tag target is contained in `main`;
- the tag equals `v` plus the version in `core/tools/aidlc-version.ts`;
- a successful `preview-release.yml` run for the exact tag SHA, or a successful
  main-branch `workflow_dispatch` run of `full-suite.yml`, supplies a
  `full-suite-result` artifact with that exact `.sha`, the downloaded run's
  `.runId`, `.coveragePolicy == "required-hosted-live-v1"`, `.passed == true`,
  `.purpose == "release"`, `.verificationFamily == "all"`,
  `.disabledLegs == []`, `.omittedLegs == []`,
  and every declared job in `.legs` equal to `success`.

Old-policy, missing, expired, wrong-source/run, disabled-live or unsuccessful
evidence blocks publication. Kiro ACP/TUI/IDE, Cursor and Copilot remain explicit
documented exclusions and produce warnings; `.complete` remains false and is
not a release requirement. Job readiness does not prove complete case coverage
across OSes; see [Nightly full-suite matrix and provisioning](09-testing.md#nightly-full-suite-matrix-and-provisioning).
Every authorized Full Suite run executes hosted live jobs through the existing
environment; no separate live opt-in switch suppresses release coverage.
Ordinary runs retain source-on-main authorization, and credential isolation
applies before live execution in every mode.

An explicit manual `full-suite.yml` dispatch may set `live_verification=true`
to validate a candidate's live jobs before merge. This input is unavailable to
reusable callers. The plan requires `workflow_dispatch` and an exact match
between the checked-out source and the manually selected workflow head
(`github.sha`). Ordinary runs retain the source-on-main gate and all required
jobs. There is no automatic privileged branch-push or PR trigger.

Verification uses the same isolated live preparation, environment-owned role
and low-privilege broker clients. It intentionally omits the native,
deterministic and production-guard jobs. Its artifact is named
`full-suite-live-verification-result` and records `purpose: "live-verification"`
and `complete: false`; a successful result requires the live jobs to succeed
and the omissions to be explicitly skipped. Stable release rejects this
purpose even if `passed` is true, including for verification run on `main`.

Manual verification can additionally select `verification_family` as
`claude-sdk`, `claude-tui`, `codex`, or `opencode`; its default is `all`.
Scoped runs keep the same exact-head authorization, run only the chosen
family's existing shards, and require Windows release-contract coverage to be
explicitly skipped. The result records `verificationFamily` and its omissions.
Release-purpose runs refuse scoped selections, and the stable consumer requires
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

Live matrices assign one file per supported platform to each job, with at most
12 hosted and 6 Windows jobs running concurrently. Each role session requests
3,600 seconds; jobs allow 55 minutes, test steps 45 minutes, and isolated e2e
files 2,400 seconds, leaving time to collect evidence. Timeouts fail coverage.
The existing IAM role duration and credential-separation boundary are unchanged.

Feature, fix, documentation, refactor, and test PRs do not update release
metadata. The release-preparation PR summarizes the user-visible changes merged
since the previous release and updates the version, README badge, and changelog
entry together before the tag is created. The workflow does not modify source
files.

## Build and validation

After accepting the exact-commit Full Suite evidence, the stable workflow:

1. regenerates every harness distribution and checks deterministic output;
2. runs typecheck, lint, ShellCheck, and
   PSScriptAnalyzer;
3. builds native binaries for Linux, macOS, and Windows;
4. runs native and installer smoke tests;
5. creates the out-of-band manual-copy `aidlc-copy-runtime-X.Y.Z.tar.gz` and
   its `.sha256` sidecar, the manifest-listed native
   `aidlc-runtime-X.Y.Z.tar.gz`, installers, `version.json`, and `checksums.txt`;
6. verifies the staged release inventory and checksums.

The smoke, unit, integration and e2e source tiers are supplied by the accepted
nightly evidence. Stable release does not run them again; its native binary,
installer and lifecycle checks validate the newly built release assets.

The release manifest records the tag ref and exact source commit. Both runtime
archive names include the release version. Manual-copy users download
`aidlc-copy-runtime-X.Y.Z.tar.gz`; native installers select
`aidlc-runtime-X.Y.Z.tar.gz`. The copy archive stays outside the manifest and
main checksum inventory so 2.8.x clients retain forward-compatible update
discovery; its sidecar and release provenance authenticate it independently.

## Provenance

The `publish` job receives `id-token: write` and `attestations: write` only
after the build and lifecycle jobs pass. GitHub generates build provenance for
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
checks and Full Suite gate the authorized commit before the normal release
build chain. Preview does not repeat the PR CI test matrix.
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
contract checks and Full Suite are its human and deterministic gates. Stable runs use a separate
concurrency group. The preview publisher stages and byte-verifies the complete
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

All earlier jobs retain `contents: read`. No stored credential receives release
write access, and no job receives publication permission before the environment
gate.

## Creating a release

1. Merge a PR that updates:
   - `core/tools/aidlc-version.ts`;
   - the README version badge;
   - the matching `CHANGELOG.md` heading.
2. Wait for (or dispatch) `preview-release.yml` on the intended release SHA while
   it is `main`'s tip, and confirm the `full-suite-result` artifact records that
   exact SHA, matching run ID, `.coveragePolicy == "required-hosted-live-v1"`,
   `.purpose == "release"`, `.verificationFamily == "all"`,
   `.passed == true`, `.disabledLegs == []`,
   `.omittedLegs == []`, and every declared job successful.
   Required live jobs use the existing `ai-pr-review` environment's
   `AWS_AI_PR_REVIEW_ROLE_ARN`; verify its OIDC/model permissions and one-hour
   session support before running them.
   If its evidence is missing or expired, dispatch `full-suite.yml` on `main`
   with `ref=<sha>` to renew it without republishing an unchanged preview;
   confirm the new artifact meets the same policy. The tested source must
   contain the current result policy; an old permissive artifact is insufficient.

   ```bash
   gh workflow run full-suite.yml --ref main -f 'ref=<intended-release-sha>'
   ```

3. Create and push the matching tag from that verified commit. The commit may
   no longer be the tip of `main`, but it must still be contained in `main`.
   Do not substitute a newer tip without obtaining fresh preview evidence:

   ```bash
   # Set this to the sha recorded in the passing full-suite-result artifact.
   RELEASE_SHA='<preview-verified-commit-sha>'
   RELEASE_VERSION='X.Y.Z'
   git fetch --no-tags origin \
     '+refs/heads/main:refs/remotes/origin/main' &&
   git cat-file -e "${RELEASE_SHA}^{commit}" &&
   git merge-base --is-ancestor "$RELEASE_SHA" origin/main &&
   test "$(
     git show "${RELEASE_SHA}:core/tools/aidlc-version.ts" |
       awk -F'"' '/^export const AIDLC_VERSION = "/ { print $2 }'
   )" = "$RELEASE_VERSION" &&
   git tag "v$RELEASE_VERSION" "$RELEASE_SHA" &&
   git push origin "v$RELEASE_VERSION"
   ```

4. Monitor the `Release` workflow.
5. Confirm that the GitHub Release contains the binaries, installers,
   `aidlc-copy-runtime-X.Y.Z.tar.gz`, its `.sha256` sidecar,
   `aidlc-runtime-X.Y.Z.tar.gz`, `version.json`, `checksums.txt`, and the
   provenance bundle.

If publication fails before the release is created, rerun the failed workflow.
If a partial release exists, inspect and remove it before rerunning. Published
assets must not be replaced silently. Correct them in a new patch release.
