# Implementation Plan — PR #996 Review Fixes

## Baseline and scope

Prepared on 2026-09-05 against commit `0211b5ff`, which matched the PR head at review time. GitHub reported the PR as CONFLICTING. This is a plan only; no implementation changes or test-suite runs were performed during its preparation.

Source comments:

- https://github.com/awslabs/aidlc-workflows/pull/996#issuecomment-5500403527
- https://github.com/awslabs/aidlc-workflows/pull/996#issuecomment-5512822850
- https://github.com/awslabs/aidlc-workflows/pull/996#issuecomment-5513837643
- https://github.com/awslabs/aidlc-workflows/pull/996#issuecomment-5514884204
- https://github.com/awslabs/aidlc-workflows/pull/996#issuecomment-5515825448

Apply the comments chronologically: later corrections supersede earlier recommendations.

| Feedback | Disposition |
|---|---|
| Missing hook coverage (“30 versus 17”) | Retracted. Do not add a speculative hook-wiring layer. |
| Duplicate subagent completion events | Existing adapter guard avoids this; preserve it and add regression coverage. |
| Compiled runtime and harness-resolution changes | Reported merged in the later comment; verify and retain rather than reimplement. |
| `fold-usage` wiring | Remove the two inert registrations. |
| Fixtures | Align with captured payloads; some local fixtures already contain `tool_use_id`. |
| Desktop doctor | Discover the bundled binary before falling back to an explicit advisory. |
| Runner invocation and persona restrictions | Add supported Devin-native enforcement. |
| Onboarding truncation | Reduce shared always-on content; do not treat the proposed shared-budget explanation as proven. |
| Repository hygiene | `.devin-plan.md` is already removed; review remaining artifacts. |

## 1. Refresh the branch and establish a clean baseline

**Priority: P0 — integration prerequisite**

1. Fetch current upstream and compare it with the PR branch.
2. Re-evaluate the conflicts rather than assuming the September 2 metadata-only diagnosis remains current.
3. Integrate upstream:
   - Prefer a merge if preserving published history.
   - Rebase only with explicit approval to rewrite history.
4. Resolve authored release metadata first:
   - Preserve upstream changelog entries.
   - Select the next valid release version under repository policy.
   - Keep the README badge, changelog heading, and authored version synchronized.
5. Regenerate distributions instead of manually resolving generated version files.

The branch declares `2.7.3` at the reviewed commit. The earlier “no re-bump needed” advice was time-specific; do not reuse it without checking upstream.

### Acceptance criteria

- Upstream integration is resolved.
- Version/changelog synchronization and packaging drift checks pass.
- Baseline failures are recorded separately from new regressions, including any environment-sensitive failures.

## 2. Remove inert usage hooks and strengthen adapter contracts

**Priority: P1 — runtime overhead and regression protection**

### Primary files

- `harness/devin/hooks.v1.json`
- `harness/devin/hooks/aidlc-devin-adapter.ts`
- `tests/fixtures/devin-hook-payloads/payloads.json`
- `tests/unit/t332-devin-adapter.test.ts`
- `tests/unit/t331-devin-packaging.test.ts`
- `tests/unit/t221-reviewer-scope-hook.test.ts`

### Changes

1. Remove `fold-usage` from both `PreToolUse` and `PostToolUse`.
   - Leave the shared core hook available for harnesses that support it.
   - Update Devin capability descriptions so they do not imply Claude-format transcript usage collection.
2. Separate captured payload fixtures from synthetic compatibility/edge-case fixtures.
   - Remove unsupported `cwd` and `transcript_path` fields from captured cases.
   - Include measured `prompt_id` and `tool_use_id` fields where appropriate.
   - Record capture version and provenance; do not extrapolate unobserved event shapes.
3. Test project-directory resolution without `payload.cwd`.

Important local discrepancy: the adapter currently resolves `DEVIN_PROJECT_DIR → payload.cwd → process.cwd()`. The review’s broader claim about script-path/AIDLC environment fallback does not describe this code. Test the actual implementation and decide whether additional fallback behavior is needed.

### Regression tests

- No emitted hook registration invokes `fold-usage`.
- One `run_subagent` followed by repeated `read_subagent` polls produces no extra completion records.
- Unrecognized tools do not cause broad-match guards to block unrelated calls.
- Named matcher tools have fixture coverage.
- Reviewer-scope, review-freeze, and plan-approval guards are registered on `PreToolUse` with compatible coverage.
- Match adapter subcommands without depending on path spelling or quoting.
- Reject invalid named matcher tools during packaging validation, while permitting the intentional empty matcher.

### Acceptance criteria

- Inert subprocess invocations are eliminated.
- Existing enforcement remains intact.
- Tests assert behavior and supported capabilities, not historical hook counts or one particular matcher string.

## 3. Restrict model-invocable runners and project persona permissions

**Priority: P1 — workflow integrity**

### Primary implementation points

- `core/tools/aidlc-runner-gen.ts`
- `scripts/package.ts` (`projectTierFrontmatter`)
- Applicable plugin composition paths in `scripts/plugin-hooks-template/compose.ts`

### Changes

1. Classify generated skills by behavior rather than relying on the review’s historical runner counts.
2. Emit `triggers: [user]` for Devin workflow-mutating runners:
   - Stage runners.
   - Initialization runners.
   - Scope/composition runners where applicable.
3. Implement this in generation so installed runner regeneration preserves the restriction—not merely as a distribution post-processing step.
4. Add Devin-specific persona projection:
   - Remove unsupported `disallowedTools` and `maxTurns` keys from emitted Devin profiles.
   - Translate the delegation restriction into a supported `allowed-tools` allowlist excluding `run_subagent`.
   - Preserve the tools each role actually needs.
   - Correct emitted prose that claims unsupported fields enforce restrictions.
5. Check plugin composition paths so regenerated or plugin-provided surfaces do not bypass the same policy.

### Acceptance criteria

- All classified mutating runners are user-only.
- Persona restrictions use documented Devin fields.
- No unintended behavior change occurs in other harnesses.
- Tests cover generation, regeneration, and applicable plugin composition.

## 4. Make doctor Desktop-aware and enforce the supported version floor

**Priority: P1 — installation correctness**

### Primary implementation point

`core/tools/aidlc-utility.ts`: the reviewed doctor implementation hard-fails when no version can be read and pins `3000.3.0`.

### Changes

1. Resolve the binary in this order:
   - `devin` on `PATH`.
   - On macOS, the measured standard Desktop bundle location: `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`.
   - Otherwise report version verification unavailable as an advisory.
2. Raise the minimum to `3000.3.22`, documenting the exit-code-2/stderr blocking compatibility requirement.
   - Avoid the stronger, insufficiently established claim that every older version cannot block at all.
3. Distinguish missing binaries from binaries that exist but fail execution or return an unparseable version.
   - A broken discovered binary must not silently receive the missing-binary advisory.
4. Report the checked binary’s source/path.
5. Keep Desktop hook execution support explicitly unverified until exercised through Desktop itself.

### Tests

Use controlled executable stubs and injectable discovery paths for:

- Supported PATH binary.
- Supported bundled binary.
- Neither binary found.
- Version `3000.3.21`.
- Exact minimum and newer versions.
- Nonzero exit and malformed version output.

### Acceptance criteria

- Supported Desktop installations are not rejected merely because the binary is off PATH.
- Known old binaries fail.
- Unknown versions are never presented as verified support.

## 5. Reduce always-on onboarding content

**Priority: P1 — instruction delivery**

### Primary source

`core/templates/onboarding.md`, plus harness onboarding fills and packaging verification.

### Changes

1. Compress `AI-DLC Structure` into a short navigation summary.
2. Consolidate the duplicate DocumentKB descriptions already present in the template.
3. Relocate detailed reference material to an on-demand resource shipped with the installation.
   - Do not rely solely on repository `docs/` paths that may be absent from a copied distribution.
4. Keep essential instructions near the beginning:
   - Starting and resuming workflows.
   - Approval boundaries.
   - Artifact locations.
   - Untrusted-document handling.
5. Establish a conservative project-owned size target, for example ≤12 KiB per rendered onboarding file, and check all harnesses.

### Verification

- Validate rendered byte sizes, links, and required instruction presence.
- Probe actual live rule injection with clean and substantial global-rule contexts.
- Use distinct beginning/end sentinels and the exact truncation marker; do not rely on `devin rules show` alone.

### Acceptance criteria

- Onboarding has substantial size headroom.
- Essential instructions remain intact.
- Documentation distinguishes the vendor’s documented cap from observed truncation and the unproven shared-budget hypothesis.

## 6. Documentation, coexistence, and repository hygiene

**Priority: P2**

1. Update `docs/guide/harnesses/devin.md`, onboarding fills, and the capability matrix for:
   - Minimum version and Desktop discovery.
   - Usage-ledger limitations.
   - User-only runners and persona permissions.
   - Onboarding size limitations.
2. Document that Claude compatibility imports include hooks and can duplicate AIDLC audit processing when both installations are active.
   - Explain how users can choose one hook source.
   - Do not silently disable all Claude imports for existing users.
3. Add documentation-parity assertions for these concrete requirements, not counts of the word “Devin.”
4. Review root-level evidence and generated HTML:
   - Preserve useful evidence and provenance.
   - Propose relocation into an agreed documentation/evidence location.
   - Remove redundant working/generated artifacts only after explicit approval.
   - Update all affected references.
5. Confirm the already-removed `.devin-plan.md` needs no further action.

## Verification and delivery sequence

Implement each behavioral change with a failing regression test first.

Suggested commit sequence:

1. Upstream integration and baseline.
2. Hook cleanup, fixtures, and adapter contracts.
3. Runner and persona restrictions.
4. Doctor discovery and version floor.
5. Shared onboarding reduction.
6. Documentation/hygiene, release metadata, and final regeneration.

Run targeted tests during development, then:

```bash
bun scripts/package.ts
bun run check
bash tests/run-tests.sh --ci --no-llm
bash tests/run-tests.sh --e2e --no-llm
```

Complete live CLI validation separately for hook blocking, ordinary-prompt runner behavior, audit uniqueness, and onboarding injection. Validate Desktop execution on an actual Desktop installation before advertising verified Desktop support.

Definition of done: every non-retracted concern has a fix or an explicit evidence-backed limitation; generated distributions are synchronized; deterministic checks pass or baseline failures are clearly isolated; and remaining live-validation gaps are stated in the PR.
