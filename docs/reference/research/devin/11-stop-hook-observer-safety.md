# Stop-hook consultation must preserve live approval state

**Finding:** DEVIN-11. **Status:** Shared observer mechanism implemented and regression-covered. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

A hook deciding whether the conductor may stop must not destroy the approval challenge it is waiting for. Historical re-entry could prepare new steering and publish runtime state while supposedly only consulting the engine.

## Current implementation

The shared Stop hook checks for a live pending Plan Approval challenge before its shared next probe and allows the stop without spawning that probe. This remains defense in depth, not the only protection.

runEngineNextDirective supplies session/project context, a bounded timeout, and AIDLC_STOP_HOOK_PROBE=1. isReadOnlyEngineProbe recognizes that flag and AIDLC_ROUTE_CHECK=1. Engine observer paths suppress publication and runtime writes; write primitives have independent observer barriers.

A probe may prepare fresh load-steering rather than reuse a retained directive. It must not mint/persist ordinary publication state, advance steering cursors, or disturb challenge/response/active-marker bytes. Ordinary next can publish runtime metadata and is not covered by the observer-only guarantee.

The historical resetPlanApprovalRuntime function is absent from executable core code at this baseline. Do not add a new public next --probe flag or resurrect reset-suppression recipes to fix a path already replaced upstream.

The Stop hook as a whole is not read-only: health, usage, drop, and no-progress bookkeeping remain intentional. The protected contract concerns its engine consultation and authority state.

## Evidence and limits

t121 asserts the pending-challenge carve-out does not spawn its mock engine. The t328 integration tests exercise real stage/unit observer paths; the changed-rule-bundle case forces fresh steering, compares complete fixture content snapshots, repeats the probe, and uses ordinary next as a publishing control.

The snapshot helper checks file content and directory entries, not OS-level writes, permissions, or timestamps, and excludes .git. Do not describe it as proof of zero filesystem syscalls. Historical failures from other test files are not current failures unless reproduced.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Live challenge at Stop | Allow the human wait without calling the engine probe | t121-stop-hook-enforce |
| Fresh steering during consultation | Return a valid observer directive while challenge and active-marker bytes remain unchanged | t328-authority-rebinding integration, fresh load-steering case |
| Repeat consultation | Repeated probes remain content-stable | Same integration case |
| Ordinary next control | Normal invocation can publish the changed steering marker after observer assertions | Same integration case; do not conflate with read-only probe |
| New engine writer | Every new observer-reachable write respects isReadOnlyEngineProbe and primitive barriers | Inspect aidlc-lib/orchestrate call paths; extend observer regressions |

## Superseded approaches and history

The pending-challenge carve-out appeared in `d6e26c47`. Shared upstream observer/authority work was present after merge `d63b2c1f`. `b8ebe5f7` strengthened regression evidence for the already-fixed fresh-steering path rather than changing production behavior.

Superseded: Stop still deletes approval runtime via resetPlanApprovalRuntime; the entire Stop hook is write-free; every next call is read-only; idempotent retention alone proves observer safety.

## Sources

- `core/hooks/aidlc-continue-workflow.ts` — hasPendingPlanApprovalChallenge, runEngineNextDirective
- `core/tools/aidlc-lib.ts` — isReadOnlyEngineProbe, refuseEngineObserverWrite, transactActiveDirective
- `core/tools/aidlc-orchestrate.ts` — observer publication paths
- `tests/integration/t121-stop-hook-enforce.test.ts`
- `tests/integration/t328-authority-rebinding.test.ts`
- `tests/unit/t330-authority-rebinding.test.ts`

[Back to findings index](index.md)
