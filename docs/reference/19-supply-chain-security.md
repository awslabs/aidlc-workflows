# Release supply chain

AI-DLC releases are created in `awslabs/aidlc-workflows` by
`.github/workflows/release.yml`. The workflow uses the repository-provided
`GITHUB_TOKEN`. It does not require a GitHub App, a personal access token, a
second repository, or repository secrets.

## Release trigger

Pushing a strict `vX.Y.Z` tag starts the release workflow. The first job rejects
the release unless all of these conditions hold:

- the event ref is the pushed tag;
- the checked-out commit is the tag target;
- the tag target is contained in `main`;
- the tag equals `v` plus the version in `core/tools/aidlc-version.ts`.

Feature, fix, documentation, refactor, and test PRs do not update release
metadata. The release-preparation PR summarizes the user-visible changes merged
since the previous release and updates the version, README badge, and changelog
entry together before the tag is created. The workflow does not modify source
files.

## Build and validation

The workflow:

1. regenerates every harness distribution and checks deterministic output;
2. runs the project test suite, typecheck, lint, ShellCheck, and
   PSScriptAnalyzer;
3. builds native binaries for Linux, macOS, and Windows;
4. runs native and installer smoke tests;
5. creates `aidlc-runtime-X.Y.Z.tar.gz`, installers, `version.json`, and
   `checksums.txt`;
6. verifies the staged release inventory and checksums.

The release manifest records the tag ref and exact source commit. The runtime
archive name includes the release version so users can download the matching
distribution explicitly.

## Provenance

The `publish` job receives `id-token: write` and `attestations: write` only
after the build and lifecycle jobs pass. GitHub generates build provenance for
the staged assets. The exported provenance bundle is included as
`aidlc-release.intoto.jsonl`.

The preview channel schedules `main` daily and accepts manual dispatch, with
publication at most once per UTC day for both triggers combined. Scheduled
and manual runs serialize through the `release-preview` workflow concurrency
group without cancelling the active run. Each later run re-reads the release
list: the planner skips if a preview is already published for that UTC day,
even if `main` has advanced, or if the source commit is unchanged since the
latest published preview. The daily check counts both the date in a published
preview's id and its GitHub `published_at` timestamp in UTC, so an overnight
build also consumes the day on which it becomes public.

The planner allocates `<x.y.z>-preview.<YYYYMMDD>.<N>` using the UTC date at
planning and ids occupied by existing tags or release records. Drafts and
orphan tags do not consume the daily publication allowance, so retry planning
can advance `N` past their occupied ids. This counter permits retries, not
multiple public daily releases. Leftover `aidlc-staging-*` drafts still require
inspection and removal before the publisher stages another candidate.

The planner renders notes from changes since the previous preview. Callable
CI gates the authorized commit before the normal release build chain.
`AIDLC_BUILD_VERSION` stamps the preview id into projections, binaries,
`version.json`, and the versioned runtime archive while the source tree keeps
its stable `x.y.z` version. The preview publisher verifies a staging draft,
creates an annotated tag that records the source repository and commit, then
publishes the draft as a prerelease with `make_latest: false`; stable
`latest/download` discovery therefore remains unchanged.

The final publication job selects the protected `release` environment for
stable tags and the unattended `preview` environment for preview runs. The
preview environment must keep the same `main` deployment policy but no
required reviewers; merge approval plus callable CI are its human and
deterministic gates. Stable runs use a separate concurrency group.

When a compatible GitHub CLI is available, installers verify `checksums.txt`
against that bundle and bind verification to:

- `awslabs/aidlc-workflows`;
- `.github/workflows/release.yml`;
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
2. Create and push the matching tag:

```bash
git switch main
git pull --ff-only
git tag vX.Y.Z
git push origin vX.Y.Z
```

3. Monitor the `Release` workflow.
4. Confirm that the GitHub Release contains the binaries, installers,
   `aidlc-runtime-X.Y.Z.tar.gz`, `version.json`, `checksums.txt`, and the
   provenance bundle.

If publication fails before the release is created, rerun the failed workflow.
If a partial release exists, inspect and remove it before rerunning. Published
assets must not be replaced silently. Correct them in a new patch release.
