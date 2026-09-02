# Supply-Chain Security

This chapter is the focused design for AI-DLC release production,
publication, verification, installation, and update transport. It describes
the controls implemented in `.github/workflows/release.yml`,
`scripts/package-release.ts`, `core/tools/aidlc-release.ts`, and the native
installer and lifecycle modules.

## 1. Complementary release controls

Three controls answer different questions:

1. **Release attestation.** GitHub artifact attestation verification proves
   that an artifact digest has an attestation issued for the configured source
   repository by its trusted workflow. The default trust root is
   `awslabs/aidlc-workflows` and
   `awslabs/aidlc-workflows/.github/workflows/release.yml`. Publication occurs
   in the separate `awslabs/aidlc-workflows-releases` repository, whose
   protected-tag and immutable-release policy binds those attested bytes to one
   release record.
2. **SLSA build provenance.** The signed provenance predicate records the
   source repository, source revision, GitHub Actions workflow, and build
   environment that produced the subject digest. It answers how and from what
   source the artifact was built.
3. **Checksums.** `checksums.txt` proves that downloaded bytes match the
   SHA-256 values published for `version.json` and each manifest asset. It is
   the byte-integrity control used directly by installers and mirrors.

The controls are complementary. A checksum without authenticated provenance
can faithfully reproduce an attacker's bytes. Provenance without a local
digest check does not prove the file on disk is the attested subject.

## 2. Publication boundary

The publication boundary is one GitHub Release for an unused `v*` tag in a
dedicated publication repository. The source repository contains reviewed code
and the signing workflow; the publication repository contains release records
and grants no direct human or team write, maintain, or administrator authority.
Organization owners retain unavoidable administrator authority and are trusted
publication actors. The workflow has no tag-push trigger. A maintainer manually
dispatches it from
`refs/heads/main` and names the new tag. `authorize` fetches current source
`main`, requires `github.sha`, checked-out `HEAD`, and `origin/main` to be the
same commit, and requires protected-environment
`AIDLC_PUBLICATION_REPOSITORY` to name a different repository under the same
owner.
The protected `release` environment requires non-author approval and protects
the authorization App credentials. Its sole deployment policy is the `main`
branch because GitHub evaluates environment policies against the dispatch ref,
not the tag supplied as workflow input. `authorize` proves the exact equality
above using only the normal read token. Only then does it mint a short-lived App
token scoped to the source and publication repositories, use it to read the
otherwise-hidden ruleset bypass actors, publication collaborator permissions,
and organization-owner list, and emit a distinct authorization identity error
when any authority surface is missing or unreadable.

After the authorization and test gates, `publish` rechecks the authorized main
SHA, requires the tag to equal `v<version.json.version>`, re-verifies checksums,
attests the candidate, exports the Sigstore bundle, validates the exact
13-file inventory, and uploads it as the immutable `attested-release` workflow
artifact. `publish` has signing permissions but only `contents: read`.

The protected `promote` job downloads that immutable artifact. Its workflow
token remains `contents: read`. Release title and body come from the reviewed
version section in `CHANGELOG.md`; a short-lived policy token re-reads controls,
and only the final token receives Contents write for the publication
repository. The policy pass repeats the source environment,
publication-repository immutable-release and complete ruleset validation, and
collaborator plus organization-owner enumeration so authorization cannot go
stale during the build. It authenticates `checksums.txt` through
both GitHub's online attestation path and the exported bundle before reading
any checksum or manifest data. It then validates `version.json`, verifies every
manifest asset through both provenance paths, records the complete local digest
set, runs the real online-install journey from a separate copy, and rechecks the
untouched publication directory. The contents-write token creates an isolated
publication commit that records the source repository and digest, pushes it
under a run-unique staging ref, and creates a private GitHub Release draft
targeting that commit.
`scripts/publish-release.ts` first refuses to run while any `aidlc-staging-*`
draft from an earlier run still exists, so leftovers are inspected and removed
deliberately rather than accumulating. It then creates the draft under a unique
non-release staging tag, uploads the exact 13-file set, compares the remote
inventory, downloads every draft asset to check it against the local digest
set, and re-reads the release to confirm its ETag, identity, and asset ids did
not move while the bytes were read. GitHub does not support conditional
requests on release updates, so the update remains unconditional. The
enforceable isolation boundary is repository authority: collaborator
enumeration must show no write, maintain, or administrator principal except an
independently enumerated organization owner, the workflow token has no
publication access, and the final App token is scoped only to this repository.
Organization owners are trusted at this boundary; no ordinary
source-repository writer can replace a draft asset in the final window. The
publisher changes `tag_name` to the unused
guarded `v*` tag, sets `draft: false`, and immediately re-verifies identity,
asset ids, tag commit, and every asset byte. It then removes the temporary
staging ref; the immutable official tag retains the publication commit.

Published releases are immutable by policy. A defective artifact is corrected
by a new patch release. A compromised release is excluded from update
discovery and linked to its corrective release without deleting the original
release, tag, attestations, or audit record.

`scripts/package-release.ts` stages `version.json`, `checksums.txt`, installers,
binaries, and `aidlc-runtime.tar.gz`. Full package generation first removes
generated harness and plugin roots that no longer exist in source, and release
assembly independently requires the generated harness/plugin inventory to
equal the authored inventory before archiving. The staging job verifies those bytes,
then uploads one `release-candidate` without a provenance bundle. Unix and
Windows lifecycle jobs checksum and test that exact artifact without signing
permissions. Because the public offline installer now requires provenance for
every local directory, those pre-attestation jobs add a job-local sentinel
bundle and verifier fixture, assert that the installer invoked it, and never
upload either fixture. Each lifecycle job then scaffolds and doctors all seven
harnesses in separate fresh projects; Unix runs every installed command under
its stripped `PATH`. This pre-gate lifecycle coverage owns harness breadth.
After the human gate, `publish` downloads the candidate,
re-verifies it, attests `build/release/*`, copies the Sigstore bundle to the
stable asset name `aidlc-release.intoto.jsonl`, validates the exact local
inventory, and uploads it as an immutable workflow artifact without rebuilding
or repackaging. The gated `promote` job authenticates and validates those
artifact bytes, records their complete digest set, then serves a separate copy through a
loopback GitHub-shaped `latest/download/` mirror and runs the real online
installer with Bun removed from `PATH` and an absolute `gh` path. That
rehearsal exercises release transport, the installer's mandatory provenance
branch against the exported bundle, native `version`, one Claude project
config, and doctor before the final release creation. Keeping that online
rehearsal Claude-only is deliberate:
lifecycle provides seven-harness breadth, while promote proves authenticated
transport plus one complete installed journey. The bundle is
intentionally not listed in either `version.json` or `checksums.txt`: those
files describe and digest the installable artifacts, while the bundle is its
own trust channel and is verified with Sigstore or `gh attestation verify`.

## 3. Threat model

### Build tampering

The build job uses commit-SHA-pinned third-party actions, installs the frozen
`bun.lock`, regenerates projections, runs the two-build package determinism
guard, and builds each target in a target-native matrix
(`.github/workflows/release.yml`). The candidate is assembled once and consumed
unchanged by Unix and Windows lifecycle tests. Those jobs verify checksums and
use a hermetic provenance-verifier fixture because the real attestation does
not exist until after approval. `publish` re-verifies and attests those bytes,
then transfers them through an immutable workflow artifact. The gated
`promote` job verifies that artifact before creating the release from the same
local directory. GitHub artifact attestations provide the signed SLSA
provenance for the post-gate release subjects.

### Release or tag hijack

Tag protection, publication-repository access isolation, and the protected
`release` environment are required GitHub settings. They are not represented by
files in this repository and must be confirmed before the first publication.
The authorization job reads those settings through a protected-environment
GitHub App identity and fails unless
the environment has exactly the `aidlc-admins` team as its reviewer, self-review
and administrator bypass are disabled, and `main` is the only deployment
policy. It separately requires immutable releases to be enabled and enforced by
the repository owner. It also requires
two separate active tag rulesets over exactly `refs/tags/v*`, with no
exclusions: a creation-only ruleset with exactly the protected release App
integration in `always` bypass mode, and an update-plus-deletion ruleset with no
bypass actors. Any additional active ruleset whose creation, update, or deletion
controls can apply to `v*` also fails closed, including broader `~ALL` tag
rulesets. Combined controls, extra actors, wrong modes, hidden actor data, or
partial namespaces fail closed. It also fails if the publication repository is
the source repository, collaborator or organization-owner enumeration is
unreadable, or any listed non-owner principal has push, maintain, or
administrator authority. Every
source-consuming job checks out the authorized main SHA; the publisher checks
that the final publication tag remains absent before staging and promotion.

### Mirror or download tampering

The staging and lifecycle jobs establish pre-gate byte integrity through
`checksums.txt`. After approval, `publish` repeats checksum verification and
attests the candidate. The gated `promote` job then authenticates
`checksums.txt` online and through the exported bundle before using it,
validates the exact manifest and directory inventory, and verifies every
manifest asset through both provenance paths before release creation. Remote
and local installers, plus `core/tools/aidlc-release.ts`, first verify
the attestation for `checksums.txt` against the repository, signer workflow,
and `refs/heads/main` using `aidlc-release.intoto.jsonl`. They then verify the
`version.json` checksum, read its authenticated `sourceDigest`, and verify the
same attestation again with both `--source-ref refs/heads/main` and
`--source-digest <reviewed source commit>`. Only then do they verify each selected asset
against both the manifest and checksum row. Asset names are basename-only and
metadata and asset sizes are bounded. Mirrors must carry the complete
manifest-driven asset set plus the bundle.

Provenance authenticates a release set; it does not prove freshness. When no
explicit version is requested, a compromised download source can replay an
older genuine `version.json`, checksum file, and matching bundle. Consumers
that require a specific release or a monotonic deployment policy must request
that version explicitly and retain their own accepted-version floor.

### Partial publication failure

Publication has no destructive rollback after the publish update succeeds.
A failure this run caused before publication (a GitHub API error, a network
fault, a malformed response) deletes the staging draft it created, after
confirming the release is still this run's draft, so failed attempts leave no
drafts behind. A failure that indicates interference retains the release for
inspection instead: a draft whose identity, asset ids, or bytes no longer
match what was uploaded, a release that is no longer this run's draft, or any
state reached once publication was attempted. The log names the retained
release and the exact `gh release delete <staging-tag> --repo <repository>
--yes` command; the next run refuses to stage until it is gone. The immutable
`attested-release` workflow artifact plus transparency-log entries retain the
build evidence in every case. If the final API response is lost, the publisher
rereads the release: an exact immutable release and tag are accepted, while an
unreadable or ambiguous result is left untouched for the named publication
owner. Once the App update succeeds, the official tag and published assets are
both byte-verified and immutable. The staging draft cannot be changed by an
ordinary source writer because that identity has no publication-repository
authority.

### Compromised release

The response owner excludes the compromised version from update discovery,
publishes a corrective patch from a reviewed commit and protected tag, and
links both release records. Existing records are retained so tags,
attestations, and incident evidence remain auditable.

### Archive tampering at install time

`core/tools/aidlc-archive.ts` rejects absolute paths, traversal segments,
drive-root paths, links, special files, duplicate destinations, file-ancestor
collisions, bad tar checksums, truncation, and oversized compressed or
expanded input. `core/tools/aidlc-lifecycle.ts` extracts only into a private
temporary candidate and reserves the verified executable names before the
candidate can reach the install root.

The Unix bootstrap refuses root by default (`scripts/install.sh`); the
PowerShell bootstrap refuses Administrator by default unless the explicit CI
escape hatch is set (`scripts/install.ps1`). Installs are per-user.
`core/tools/aidlc-transaction.ts` is the shared mutation engine: it validates
root-relative non-overlapping operations, blocks symlink traversal and
filesystem-boundary crossings, stages candidates privately, snapshots current
targets, commits with rename boundaries, rolls back in reverse order, and
retains incomplete recovery evidence in `.aidlc-recovery-*` quarantine.

## 4. SLSA level

The initial claim is **SLSA Build Level 2**. GitHub Actions produces signed
artifact attestations for release subjects, and consumers can verify the
source and build identity. The stated goal is **SLSA Build Level 3**, using an
isolated, organization-controlled reusable build workflow. Level 3 is not
implemented.

## 5. Consumer verification

Online verification against GitHub:

```bash
tag=vX.Y.Z
source_digest=<reviewed-source-commit-from-authenticated-version.json>
gh attestation verify ./aidlc-linux-x64 \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml \
  --source-ref refs/heads/main \
  --source-digest "$source_digest"
```

Offline or mirror verification from the shipped bundle:

```bash
source_digest=<trusted-40-hex-source-commit>
gh attestation verify ./aidlc-linux-x64 \
  --bundle ./aidlc-release.intoto.jsonl \
  --repo awslabs/aidlc-workflows \
  --signer-workflow awslabs/aidlc-workflows/.github/workflows/release.yml \
  --source-ref refs/heads/main \
  --source-digest "$source_digest"
```

For offline verification, obtain the reviewed source commit through a trusted
channel before disconnecting; do not derive the expected digest only from the
untrusted download directory.

Online installers and lifecycle commands use the same trust-root controls:

- `AIDLC_PUBLICATION_REPOSITORY` selects the GitHub repository used for default
  release downloads and defaults to `awslabs/aidlc-workflows-releases`.
- `AIDLC_RELEASE_REPOSITORY` selects the attested source repository and defaults
  to `awslabs/aidlc-workflows`.
- `AIDLC_RELEASE_WORKFLOW` selects the signer workflow and defaults to
  `<AIDLC_RELEASE_REPOSITORY>/.github/workflows/release.yml`.

Fork and mirror operators must set these explicitly, together with the matching
release base URL. A publication or mirror URL does not implicitly broaden or
replace the provenance trust root.

Fork release rehearsals must also configure the protected `release`
environment with exactly the `main` branch deployment policy, its authorization
App identity, the `aidlc-admins` team as the sole reviewer, immutable releases,
and both release-tag rulesets. A personal-account fork without teams cannot
satisfy this production release contract.

Verify every artifact covered by the checksum file:

```bash
sha256sum -c checksums.txt
```

`scripts/package-release.ts` writes the schema consumed by mirrors and
installers. `version.json` contains:

- `schemaVersion`
- `version`
- `date`
- `sourceRef`, fixed to `refs/heads/main`
- `sourceDigest`, the exact 40-hex commit shared by `main` and the release tag
- `distributions[]` with `name` and `productName`
- `assets[]` with `name`, `sha256`, `bytes`, and `kind`
- binary-only `target`
- optional binary `verification` with `status`, `mode`, and `hostTarget`

`core/tools/aidlc-release.ts` validates those exact fields, rejects unknown
asset shapes, and requires the runtime and installer names defined by the
schema.

## 6. Workflow hardening inventory

- Every third-party action in `.github/workflows/release.yml` is pinned to a
  full 40-hex commit SHA, with the release line retained as a comment.
- Workflow-global permissions are `contents: read`.
- `authorize` runs inside the protected `release` environment. The environment
  stores `AIDLC_RELEASE_AUTH_APP_ID` and
  `AIDLC_RELEASE_AUTH_APP_PRIVATE_KEY`; missing configuration fails before any
  ruleset request.
- `authorize` mints a GitHub App installation token scoped to the source and
  publication repositories with Actions read, repository Administration read,
  Metadata read, Members read, and organization Administration read. That
  identity can observe `bypass_actors`, enumerate publication collaborators and
  organization owners, and verify the organization's default repository
  permission; omitted or unreadable authority data is reported as an
  authorization identity failure rather than a policy mismatch.
- No job before `publish` receives `id-token: write` or
  `attestations: write`.
- `publish` is the only signing job. It receives `contents: read`,
  `id-token: write`, and `attestations: write` inside the protected `release`
  environment and consumes the authorization job's immutable tag SHA. Every
  earlier source checkout uses that SHA rather than resolving the tag again.
- `publish` validates the bundle-complete candidate and transfers it through
  the immutable v4 workflow-artifact service; it cannot create or edit a
  GitHub Release.
- `promote` keeps its workflow token at `contents: read`, authenticates
  metadata before use, verifies every asset and both provenance paths,
  rehearses the real online installer from a copy, and rechecks the original
  digest set. It uses the reviewed changelog for notes plus separate read-only
  policy and publication-only Contents write tokens. The last token creates the
  isolated publication commit and performs the staging-tag-to-`v*` publication.
- No job outside the protected `release` environment receives any write
  permission.
- OIDC supplies short-lived identity to Sigstore; no long-lived signing key is
  stored in the repository.
- The source digest in `version.json` and provenance must equal the reviewed
  release-prep commit. The publication tag points to an App-created publication
  commit that records that source identity.
- `alpine:3.20` remains tag-pinned for the musl smoke job. Each disposable
  container installs the documented `libgcc` and `libstdc++` prerequisites
  shared by Bun's and Node.js's musl builds, mounts the workspace read-only,
  executes an already-built binary, and produces no release bytes. Fully
  static Bun musl compile targets remain upstream-tracked rather than
  available today. The matrix uses `fail-fast: false` so both musl
  architectures report. Artifact-moving and source-fetching actions are
  SHA-pinned.

## 7. Named ownership

Ownership is team-based, not individual. Every duty below requires elevated
repository rights (release editing, tag pushes through protection,
workflow-adjacent changes), and `@awslabs/aidlc-admins` is the team that
holds them - consistent with the CODEOWNERS policy already in force, which
assigns `CHANGELOG.md` and `.github/` to that team alone. Naming the team
rather than individuals keeps this table valid across membership rotation.
The focused review confirms the assignment and the qualifiers below.

Organization owners are also trusted publication actors because GitHub grants
them administrator authority to every organization-owned repository. They are
enumerated separately during both policy checks so their unavoidable access is
explicit rather than mistaken for removable collaborator access. This is a
platform-level trust boundary, not a release duty assignment.

| Duty | Owner |
|------|-------|
| Approve the release-prep PR | `@awslabs/aidlc-admins` |
| Approve protected release execution | `@awslabs/aidlc-admins` |
| Create the isolated publication commit, protected tag, and GitHub Release | Protected release App |
| Update latest and installer metadata | `@awslabs/aidlc-admins` |
| Respond to partial publication failure | `@awslabs/aidlc-admins` |
| Supersede a compromised release | `@awslabs/aidlc-admins` |

Two qualifiers carry the separation-of-duties intent that individual names
would otherwise have encoded:

- The release-prep PR must be approved by a team member other than its
  author. GitHub enforces this mechanically: an author cannot approve their
  own pull request.
- A compromised release must be superseded by a team member other than the
  one who authorized the affected tag, because the compromise vector may be
  that member's credentials.

The environment reviewer names the team, while the publication repository has
no ordinary human or team writer and the creation ruleset's sole bypass actor is
the protected release App. Organization owners retain their separately
documented trusted authority. A team approval authorizes one App-mediated
publication without granting ordinary source-repository credentials authority
over the draft or official tag. The separate update-plus-deletion ruleset has no
bypass actor, including for the App or team. The GitHub Release is published by
a main-branch manual dispatch.

## 8. No OS code-signing

AI-DLC does not use Apple Developer ID, notarization, Authenticode, or another
OS code-signing program, and does not plan to add one.

The supported macOS path downloads through `curl`, which does not add the
browser quarantine attribute. Apple Silicon linkers apply the automatic ad
hoc signature needed for a local Mach-O executable. On Windows,
`scripts/install.ps1` verifies the SHA-256 and byte length, then calls
`Unblock-File` to remove Mark-of-the-Web before executing the verified
binary; this is the supported SmartScreen path.

Two carve-outs are accepted:

- A raw binary downloaded through a browser can carry macOS quarantine. The
  documentation never offers that path; use the installer or offline release
  set.
- Device-management environments that require organization-signed binaries
  are not a supported audience. They can ingest the offline release set,
  perform internal review, and redistribute it under their own controls.

## 9. Enterprise transport

The native client in `core/tools/aidlc-release.ts` reads `HTTPS_PROXY` or
`https_proxy` and applies `NO_PROXY` or `no_proxy`. It deliberately does not
read `HTTP_PROXY`. Without a custom CA it uses the platform trust store; an
absolute `ca-bundle` path can be supplied by option, `AIDLC_CA_BUNDLE`, or
machine config (`core/tools/aidlc-machine-config.ts`).

Release mirrors resolve in explicit option, `AIDLC_RELEASE_BASE_URL`, machine
`release-base-url`, then the GitHub default. Mirror URLs must use HTTPS except
for loopback tests and cannot contain credentials, queries, or fragments.
Proxy credentials stay in the process environment: they are never written to
machine config, logs, or errors. URL errors pass through the redactor in
`core/tools/aidlc-release.ts`.

Offline mode is first-class: `--offline` requires a local `--from` release
directory, requires its exported provenance bundle, and opens no release
socket. `core/tools/aidlc-update.ts` caches
update metadata for 24 hours in `update-check.json` and replaces it through
the shared transaction engine. Global `update-check=false` disables automatic
and explicit metadata refresh, but does not block a user-requested
`aidlc update`.

## 10. Standing trust rules

1. An arbitrary plugin URL is never an automatic trust source. Claude and
   Codex use host-native marketplace and trust flows; Kiro folder-drop is an
   explicit operator trust decision. AIDLC does not fetch and execute a plugin
   solely because content named a URL (`docs/reference/18-plugin-mechanism.md`).
2. Authored content is never forked per release channel. `core/` and
   `harness/<name>/` are the hand-authored sources, and `scripts/package.ts`
   materializes ignored local `dist/` and `dist-release/` trees. The determinism
   guard builds both channels and plugin projections twice in temporary roots
   and requires byte-identical results (`docs/reference/01-architecture.md`).

## 11. Open items for focused review

- Create the protected `release` environment with non-author approval,
  self-review and administrator bypass disabled, exactly the `aidlc-admins`
  reviewer team, and exactly the `main` branch deployment policy.
- Create `awslabs/aidlc-workflows-releases` (or configure another dedicated
  `AIDLC_PUBLICATION_REPOSITORY`) under the same owner. Grant no direct human,
  team, or ordinary source-writer push, maintain, or administrator access beyond
  the organization's unavoidable owners, and keep the organization default
  repository permission at `none` or `read`.
- Enable immutable releases on that publication repository and require owner
  enforcement.
- Install the protected GitHub App on both repositories with Actions read,
  repository Administration read, organization Administration read, Members
  read, Metadata read, and Contents write, then store its App ID as the
  protected-environment variable
  `AIDLC_RELEASE_AUTH_APP_ID` and its private key as the protected-environment
  secret `AIDLC_RELEASE_AUTH_APP_PRIVATE_KEY`. Do not store the private key as
  an ordinary repository secret.
- In the publication repository, create an active creation-only ruleset covering
  exactly `refs/tags/v*`, with
  no exclusions and exactly the protected release App integration in `always`
  bypass mode.
  Create a separate active update-plus-deletion ruleset over the same exact
  namespace with no exclusions and no bypass actors.
  Disable or replace any broader active tag ruleset whose creation, update, or
  deletion controls also apply to `v*`; leaving it active intentionally fails
  the exact-policy preflight.
- Decide whether repeated protected-environment approvals across `authorize`,
  `publish`, and `promote` are an acceptable manual-release UX cost. Do not remove
  the environment merely to avoid those approvals; it protects both the App
  private key and public visibility.
- Confirm the team-based ownership assignment in section 7
  (`@awslabs/aidlc-admins` on every duty, with its two separation-of-duties
  qualifiers).
- Build the isolated organization-controlled workflow required for SLSA Build
  Level 3.
- Resolve the Windows verification policy. The current implementation marks a
  host-runnable windows-x64 artifact `VERIFIED` after its full-runtime gates
  pass (`scripts/build-binaries.ts`). The RFC proposed retaining
  `UNVERIFIED` until milestone 3 Windows journeys are green; that hold is not
  implemented. The condition the hold was waiting on has since been met: the
  milestone 3 Windows journeys ran green end to end on a real Windows Server
  2025 host (2026-08-17), and both host-runnable Windows artifacts completed
  all 49 runtime gates with exact `VERIFIED` full-runtime verification
  objects. The review's decision is therefore whether that evidence lets the
  current label stand as-is, not whether to build the hold.
