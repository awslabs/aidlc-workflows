# Plan Approval sessions, challenges, responses, and receipts

**Finding:** DEVIN-09. **Status:** Shared authority implemented; fallback isolation needs explicit regression evidence. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

Plan Approval is more than an answer in Markdown. A session/intent identifier mix-up or lost challenge can leave a genuinely answered plan unapproved; accepting a plain written answer would instead bypass the human authority contract.

## Current implementation

The engine separates the offered challenge, observed human response, and certified approval receipt. Plan and test instructions, Testing Contract, source/content identity, and attempt provenance participate in the current authority checks. Exact rules live in aidlc-testing-posture and the shared runtime helpers, not in the renderer.

The Devin adapter forwards valid payload session identity through the engine environment. Devin session slugs and intent UUIDs are different identifiers; the session binding file is not a source for a substitute host session ID.

recordPlanApprovalHumanResponse first looks for the supplied session's challenge and falls back to readCurrentSessionId when none is found. certifyPlanApprovalReceipt can use the current session's challenge/response pair when the supplied session lacks either. The fallback was introduced for the observed mismatch; it does not create authority when no valid matching evidence exists.

Directly writing Approve Plan into a questions file, manually creating challenge/response files, disabling guards, or reporting completed to bypass a gate is not genuine live acceptance. Historic experiments that used those shortcuts must remain excluded from approval-compatibility claims.

## Evidence and limits

t265 exercises missing/stale authority, human response and receipt paths, unit/stage targets, source/content changes, and direct mutation refusal. t332 includes a seeded native-shaped response test. Those are useful seams, but a specifically identified regression for the current-session fallback's cross-session isolation was not located during this audit.

The native task/prompt mismatch from DEVIN-07 also affects what dispatch evidence reaches this guard. Do not infer the correctness of the adapter boundary from core-only approval tests.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Valid approval | A new human reply to the actual offered choice certifies matching current content/attempt evidence | t265 lifecycle; t332 seeded response; live UI path NOT RUN |
| Written answer without evidence | Generation remains refused | t265 conductor-authored-answer and missing-receipt tests |
| Content/attempt/source drift | Stale approval cannot authorize changed work or another target | t265; t328-plan-approval-runtime-authority; t330-authority-rebinding |
| Session fallback | Intended fallback works without allowing another concurrent session's challenge/response to authorize this one | Explicit fallback isolation test/evidence gap |
| Re-entry and Stop | Observer consultation preserves live authority; ordinary publication remains distinct | DEVIN-11; t328-authority-rebinding integration |

## Superseded approaches and history

`dafe8bec` added the current-session fallback. Shared authority rebinding also separates approval identity from incidental directive issuance. The current implementation, not old development-version headings, determines the contract.

Retired: a matching state hash alone proves continuation validity; next must immediately return run-stage; successful HUMAN_TURN or a Markdown label is a valid Plan Approval receipt. The first historical live run's manually seeded authority is not a successful human-gate test.

## Sources

- `core/tools/aidlc-testing-posture.ts` — recordPlanApprovalHumanResponse, certifyPlanApprovalReceipt
- `core/tools/aidlc-lib.ts` — session and approval runtime helpers
- `harness/devin/hooks/aidlc-devin-adapter.ts` — session override, plan-approval-guard
- `tests/unit/t265-plan-approval-guard.test.ts`
- `tests/unit/t328-plan-approval-runtime-authority.test.ts`
- `tests/unit/t330-authority-rebinding.test.ts`
- `tests/unit/t332-devin-adapter.test.ts`
- `tests/integration/t328-authority-rebinding.test.ts`
- `evidence/devin-e2e-run/first-run/SUMMARY.md`

[Back to findings index](index.md)
