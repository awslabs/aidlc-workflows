# Plan Approval sessions, challenges, responses, and receipts

**Finding:** DEVIN-09. **Status:** Strict session pairing implemented, regression-covered, and accepted live on Devin CLI 3000.10.31 (2026-09-17); receipt reuse without re-prompt remains inconclusive because DEVIN-07 blocks every developer dispatch. **Source baseline:** `8bbdb928` (Item 1 fix on `feat/devin-harness`). **Fact-checked:** 2026-09-17.

## Why this was needed

Plan Approval is more than an answer in Markdown. A session/intent identifier mix-up or lost challenge can leave a genuinely answered plan unapproved; accepting a plain written answer would instead bypass the human authority contract.

## Current implementation

The engine separates the offered challenge, observed human response, and certified approval receipt. Plan and test instructions, Testing Contract, source/content identity, and attempt provenance participate in the current authority checks. Exact rules live in aidlc-testing-posture and the shared runtime helpers, not in the renderer.

The Devin adapter forwards valid payload session identity through the engine environment. Devin session slugs and intent UUIDs are different identifiers; the session binding file is not a source for a substitute host session ID.

Human responses are recorded only against the supplied runtime session's challenge. Receipt certification reads the challenge and response only from that same session; missing or mismatched authority is refused instead of consulting .current-session. The exact Runtime Session from SessionStart is used for both decision and answer. Already-certified receipts retain their approving session and remain reusable under the existing identity, attempt, and source-drift rules after a session change.

If a pending challenge was recorded with the wrong session identifier, re-present the plan under the Runtime Session from the owning conversation's SessionStart context and obtain a fresh human answer. Do not copy or relabel pending challenge/response records from another session. If that runtime identity is unavailable, restore functioning SessionStart hooks before retrying; HUMAN_TURN or an exit-0 hook is not an approval receipt.

Directly writing Approve Plan into a questions file, manually creating challenge/response files, disabling guards, or reporting completed to bypass a gate is not genuine live acceptance. Historic experiments that used those shortcuts must remain excluded from approval-compatibility claims.

## Evidence and limits

t265 exercises missing/stale authority, human response and receipt paths, unit/stage targets, source/content changes, direct mutation refusal, and a real decision → session-tagged human-turn hook → answer lifecycle across two sessions with another session current. The `Item 1 session isolation` suite in t328-plan-approval-runtime-authority covers the strict-pairing matrix directly on the shared runtime functions. t332 drives the same A/B pairing through the real Devin adapter transport — the real decision command, adapter-observed answer events in native PostToolUse and direct UserPromptSubmit shapes, the real answer command, and exact receipt inspection — including absent, unknown, and intent-UUID session identifiers and DEVIN_PROJECT_DIR resolution without an injected cwd. These are deterministic seams.

Attended acceptance on Devin CLI 3000.10.31 (session-isolation acceptance, 2026-09-17, `bce80f29` plus the uncommitted fix, express scope; raw artifacts at `evidence/devin-e2e-run/session-isolation-run/`, compact record in DEVIN-14) observed: the challenge keyed by the hook-observed session slug rather than the intent UUID; a concurrent second session's typed `Approve Plan` recorded only its own HUMAN_TURN and wrote no response for the owning session; a forced `answer --session <other>` refused with `Plan Approval requires the actual offered choice from this prompt and session` while `.current-session` pointed at that other session; the genuine native click certified the receipt under the owning session; and after `/clear` the receipt persisted byte-identical and was later honored (`status: generation`). Devin session ids on that build are slugs (`purple-wool`), and one restart's SessionStart payload carried no `session_id`. The "no re-prompt after session change" half is inconclusive: the conductor re-presented Plan Approval because the DEVIN-07 dispatch block told it the plan was not approved; the re-minted challenge had identical identity and re-certified the same receipt path. `hello.py` was never generated because every developer dispatch was blocked by DEVIN-07.

The native task/prompt mismatch from DEVIN-07 also affects what dispatch evidence reaches this guard. Do not infer the correctness of the adapter boundary from core-only approval tests.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Valid approval | A new human reply to the actual offered choice certifies matching current content/attempt evidence | t265 CLI/hook lifecycle; t332 independent picked/typed decision-to-receipt lifecycles and seeded response assertions; live native click certified on 3000.10.31 (session-isolation acceptance S1) |
| Written answer without evidence | Generation remains refused | t265 conductor-authored-answer and missing-receipt tests |
| Content/attempt/source drift | Stale approval cannot authorize changed work or another target | t265; t328-plan-approval-runtime-authority; t330-authority-rebinding |
| Session isolation | A response or certification supplied for one session pairs only with that session's own challenge/response; missing or mismatched authority is refused and `.current-session` is never consulted | t328 `Item 1 session isolation`; t265 CLI/hook A/B; t332 adapter A/B transport; live S2/S3/S4 on 3000.10.31 (session-isolation acceptance) |
| Receipt reuse after session change | A valid certified receipt survives `/clear`/restart without a new approval | Live S5: persistence and later honoring observed; no-re-prompt inconclusive in that run because of the DEVIN-07 dispatch block (fixed since). In the native-dispatch acceptance (2026-09-18) the same session was resumed and compacted mid code-generation without a new Plan Approval prompt (`PLAN_APPROVAL_RECORDED` stayed 1), but no `/clear` was issued, so the cross-session case is still unverified; rerun the DEVIN-14 live protocol (approve, `/clear`, resume) to close it |
| Re-entry and Stop | Observer consultation preserves live authority; ordinary publication remains distinct | DEVIN-11; t328-authority-rebinding integration |

### Session-isolation matrix (upgrade checklist)

When session resolution or approval storage changes, the deterministic isolation cases to keep green are: a reply supplied for session A while only B holds a pending challenge records nothing for either session; certification requested for A while B holds a complete challenge/response pair with identical plan identity refuses; A holding a challenge but no response cannot consume B's pair (the partial-miss branch); a response written while `.current-session` points at B still lands under the supplied session; `Request Changes` under the wrong session neither consumes B's response nor clears a matching durable receipt; blank, unknown, or intent-UUID session ids never redirect to B's authority; and results never depend on the pointer's position between decision, response, and certification. These live in the `Item 1 session isolation` suite of `t328-plan-approval-runtime-authority`, with CLI/hook and adapter-transport variants in t265 and t332.

Removing the fallbacks prevents new miscertification; it does not prove receipts minted before the fix were correctly attributed, and no bulk migration or invalidation of existing protected state was performed. Same-session delayed replies, session-filename sanitization, and hostile same-user environment manipulation remain out of scope.

## Superseded approaches and history

`dafe8bec` added the current-session fallback for an observed session-identifier mismatch; `8bbdb928` removed it because the fallback let a challenge/response pair recorded under one session certify authority requested for another. The implementation plan for that fix was folded into this finding and DEVIN-14 and removed from the tree; it is recoverable in Git history from commit `8bbdb928`. Shared authority rebinding also separates approval identity from incidental directive issuance. The current implementation, not old development-version headings, determines the contract.

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
- `evidence/devin-e2e-run/session-isolation-run/` — the attended run's retained artifacts (grandfathered exception to the Item 9 minimal-evidence policy; compact record in DEVIN-14)

[Back to findings index](index.md)
