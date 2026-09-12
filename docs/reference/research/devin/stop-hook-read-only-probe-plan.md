# Stop-hook read-only probe: fact check and regression plan

Date: 2026-09-12
PR: #996 (`feat/devin-harness`)
Inspected baseline: `f3b3810c`

## Verdict

The proposition identifies the correct historical architectural defect, but its proposed runtime fix is already present in this branch. Preserve the existing internal observer mode instead of adding a redundant public `next --probe` flag. Strengthen regression coverage for the non-retained `load-steering` path and keep the pre-probe Plan Approval carve-out unchanged as defense in depth.

The observer fix and authority rebinding landed upstream in `d7521b19` (PR #1000) and are present after merge `d63b2c1f`. `resetPlanApprovalRuntime` no longer exists in executable core code. Remaining references in the Stop-hook comments and earlier research describe the historical failure, not current behavior.

## Verified call path

1. `core/hooks/aidlc-continue-workflow.ts` checks the shared resume wait and then `hasPendingPlanApprovalChallenge` before consulting the engine. Copilot has a separate retained-evidence path; it does not use this shared spawn when session evidence is available.
2. `runEngineNextDirective(projectDir, sessionId)` spawns `bun <harness>/tools/aidlc-orchestrate.ts next --project-dir <project>`, with `hookChildEnv(..., { [STOP_HOOK_PROBE_ENV]: "1" })` and a bounded timeout.
3. `core/tools/aidlc-lib.ts` defines `STOP_HOOK_PROBE_ENV` as `AIDLC_STOP_HOOK_PROBE`. `isReadOnlyEngineProbe()` recognizes this and the existing `AIDLC_ROUTE_CHECK=1` observer.
4. `main` dispatches `next` to `handleNext`. Directive preparation uses `transportRunStage`: an unchanged delivery can be retained; a changed rule bundle prepares a new `load-steering` directive. Stop probes use a deterministic probe token without minting a steering key.
5. `emit` explicitly requires `!isReadOnlyEngineProbe()` before calling `writeActiveDirectiveMarker`. The ordinary publication path enters `transactActiveDirective`; its commit has the independent `refuseEngineObserverWrite` barrier. `handleContinue` also avoids cursor advancement for observers.
6. The historical publication-to-`resetPlanApprovalRuntime` deletion path has been removed. Current approval authority binds to content and attempt, independently of directive issuance. Engine touches, diary bootstrap, claim-cache writes, single-stage audit starts, and other observer-sensitive paths already have read-only protections.

The Stop hook itself is not wholly read-only: health, usage, and no-progress bookkeeping remain intentional. The read-only contract applies to its engine consultation.

## Existing coverage and the remaining useful gap

- `tests/integration/t121-stop-hook-enforce.test.ts` already tests the carve-out and witnesses the child probe environment, but its carve-out case does not explicitly assert that the mock engine was never spawned.
- `tests/integration/t328-authority-rebinding.test.ts` already creates a real live Plan Approval challenge, invokes the real Stop probe directly, checks preservation, and records the subsequent human approval. It also tests per-Unit observer purity.
- Those Stop-probe comparisons use `bytesMoved`, which filters advisory runtime noise; the stronger contract is equality of the entire existing file/directory-content snapshot, including turn markers.
- An already issued, unchanged directive can take the retained path. Add an explicit changed-rule-bundle case to force the probe to prepare `load-steering`, so idempotent retention cannot mask accidental publication. Verify the same challenge and marker bytes survive, and then demonstrate that an ordinary `next` still publishes the new steering marker.

## Implementation plan

1. Keep all `core/` and `harness/` runtime source unchanged, including the existing carve-out and observer environment interface. No new CLI flag or configuration.
2. Strengthen t121 with an assertion that the mock engine's `.probe-env-witness.json` does not exist after the live-challenge carve-out.
3. Strengthen both existing t328 Stop-probe comparisons with unfiltered snapshot equality.
4. Add a t328 regression that delivers stage-level code-generation, mints a real challenge through `presentPlan`, appends a deterministic rule to project memory, and snapshots the project. Invoke the real engine with `p.probeEnv`; require exit 0, `load-steering` for code-generation, part 1, a continuation token, an identical challenge, an identical active marker, and an identical complete content snapshot. Repeat the probe to verify stability. Finally invoke ordinary `next` and require publication of `load-steering` with changed marker bytes. This control runs only after the preservation assertions.
5. Correct the hooks reference's stale claim that route checks touch `.aidlc-engine-touch`: current `markEngineTouch` suppresses both observer modes. Link the old research diagnosis to this superseding fact check without rewriting its historical evidence.
6. No version, README badge, or changelog bump: these are test and documentation changes, expressly exempt under AGENTS.md. Generated outputs remain local, ignored, and uncommitted.

## Verification plan

Regenerate projections with `bun scripts/package.ts`; run `bun scripts/package.ts --check` for all eight harnesses. Run the strengthened cases against the already-fixed baseline: they are expected to pass, not to reproduce a current deletion bug.

Required Stop-hook and affected integration slice:

```bash
bun test tests/integration/t121-stop-hook-enforce.test.ts tests/integration/t118.test.ts tests/integration/t328-authority-rebinding.test.ts tests/integration/t329-guard-recovery-loop.test.ts tests/integration/t325-team-unit-claims.test.ts tests/integration/t327-team-dispatcher.test.ts tests/integration/t327-stop-hook-subagent-inflight.test.ts
```

Observer, steering, authority, and harness adapter contracts:

```bash
bun test tests/unit/t114-orchestrate-next.test.ts tests/unit/t248-steering-content-delivery.test.ts tests/unit/t259-turn-markers.test.ts tests/unit/t328-plan-approval-runtime-authority.test.ts tests/unit/t330-authority-rebinding.test.ts tests/unit/t147-kiro-hook-adapter.test.ts tests/unit/t149-codex-hook-adapter.test.ts tests/unit/t218-kiro-ide-hook-adapter.test.ts tests/unit/t241-opencode-adapter.test.ts tests/unit/t249-copilot-adapter.test.ts tests/unit/t250-copilot-adapter-security.test.ts tests/unit/t276-cursor-adapter.test.ts tests/unit/t332-devin-adapter.test.ts
```

Run changed-test Biome checks, core and tests TypeScript checks, and `git diff --check`. Report pre-existing failures with evidence; do not change security controls, unrelated tests, or compiler configuration to obtain a green result.

Cross-harness compatibility rests on unchanged authored runtime source plus the exercised adapter contracts. Packaging determinism is not proof of before/after runtime parity or live host behavior. No live CLI/LLM end-to-end claim will be made. If a check exposes an actual runtime gap, stop and revise this plan before changing runtime behavior.

## Delivery

Review the full diff and verification evidence, record results here, commit only authored changes, push to `origin/feat/devin-harness`, and comment on upstream PR #996 with the historical correction, current mechanism, test outcomes, and limitations.

## Execution results

Completed on 2026-09-12 against the existing runtime at `f3b3810c`.

- The new fresh-steering regression passed on its first run: 1 test, 24 assertions. Both probes returned `load-steering` for code-generation, part 1, without altering the live challenge, active marker, or unfiltered fixture snapshot. The ordinary `next` positive control then published the new steering marker.
- Strengthened existing stage-level and per-Unit probe tests passed. The t121 carve-out assertion confirms that the mock engine was not spawned. The production carve-out remains byte-for-byte unchanged.
- Snapshot scope: the existing helper compares file-content hashes and directory entries, including advisory turn markers. It excludes `.git` and does not compare timestamps or permissions; this is not an OS-level filesystem-write trace.
- No authored runtime source under `core/` or `harness/` changed. No new flag, configuration, version bump, or generated output is committed.

### Verification outcomes

| Check | Result |
| --- | --- |
| `bun scripts/package.ts` | Passed; all eight harnesses and plugin projections regenerated |
| New t328 fresh-steering case | 1 passed, 0 failed |
| Seven-file integration slice above | 171 passed, 4 failed; all failures are pre-existing t118 cases |
| Required t121 Stop-hook suite | Passed within the integration slice |
| Full t328 authority-rebinding integration file | Passed within the integration slice |
| Thirteen-file unit/adapter slice above | 558 passed, 0 failed |
| `bun scripts/package.ts --check` | Passed; deterministic across all eight harnesses |
| `bunx tsc --noEmit -p tsconfig.json` | Passed |
| `bunx tsc --noEmit -p tsconfig.tests.json` | Existing TS2769 at `tests/unit/t294-config-diagnostics.test.ts:314` |
| Changed-test Biome check | Passed; no fixes applied |
| `git diff --check` | Passed |

The four t118 failures reproduce with the follow-up edits absent: `SP7-control`, `SP7-invalid`, `SP7-escape`, and `WALK B`. The tests TypeScript error also reproduces with those edits absent. These are recorded limitations, not regressions attributed to the probe change; no unrelated fixes were attempted. The integration slice is therefore not fully green.

Cross-harness result: this follow-up changes tests and documentation only; all selected Kiro CLI, Kiro IDE, Codex, opencode, Copilot, Cursor, and Devin adapter contracts passed, alongside shared Claude-projection tests. No harness runtime behavior is changed by this diff. Packaging determinism is reported separately, not as a substitute for behavioral coverage. No live host/LLM E2E or full release-suite run is claimed.

### Local evidence inventory

Logs are local, outside the repository, under `/tmp/aidlc-probe-evidence/`:

- `01-package.log`: regeneration
- `02-t328-new-test.log`: focused fresh-steering regression
- `03-integration-slice.log`: seven integration files and four t118 failures
- `04-t118-baseline.log`: the same four failures without the follow-up edits
- `05-unit-slice.log`: 558 passing unit/adapter tests
- `06-package-check.log`: eight-harness determinism
- `07-tsc-core.log`: successful core typecheck (empty output)
- `08-tsc-tests.log`: existing tests typecheck error
- `09-biome.log`: changed-test lint
- `10-diff-check.log`: whitespace check (empty output)
- `11-tsc-tests-baseline.log`: identical typecheck error without the follow-up edits

These temporary evidence paths are not portable release artifacts. The commands and results above remain in the repository for reproducibility.
