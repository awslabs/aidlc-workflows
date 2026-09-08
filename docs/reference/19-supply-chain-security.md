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

The version bump, README badge, and changelog entry are reviewed in the release
PR before the tag is created. The workflow does not modify source files.

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

When a compatible GitHub CLI is available, installers verify `checksums.txt`
against that bundle and bind verification to:

- `awslabs/aidlc-workflows`;
- `.github/workflows/release.yml`;
- the release tag;
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
