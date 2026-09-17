# PR #996, Item 1: Plan Approval session-isolation plan

**Status:** Proposed implementation plan; no runtime changes or test execution performed while preparing it.

**Prepared:** 2026-09-17.

**Review:** [Item 1 — P1: Plan Approval authority can cross session boundaries](https://github.com/awslabs/aidlc-workflows/pull/996#pullrequestreview-5226026258), submitted by `leandrodamascena` on 2026-09-16 against `8381961892a0df0288074110344b2e65c98fa9b1`.

**Implementation baseline:** `bce80f291789a35d5045ebb898ed83f9d14cc525`, the latest PR head verified through GitHub while preparing this plan. The reviewed fallback code remains present at that head. Recheck the PR head before implementation; do not silently apply this plan to a different revision.

**User decisions:** Target the latest PR head; revert the three existing local release-metadata edits; match Claude Code's intended approval behavior. The metadata edits were reverted. The original checkout remains at the reviewed commit; the latest head was inspected in a separate detached worktree. Saving this plan does not update the original branch.

## 1. Goal and scope

Prevent a response supplied for session A from being recorded against session B's challenge, and prevent certification requested for A from consuming B's pending challenge/response pair—even when both sessions represent exactly the same plan identity and attempt.

Match Claude Code's intended shared-engine contract:

- **Creating authority is session-bound.** The challenge, observed human response, and newly certified receipt must refer to the same supplied runtime session and matching challenge.
- **Reusing valid certified authority is not session-bound.** An already-certified receipt remains usable after a session change when the existing plan-identity, attempt, prompt, Testing Contract, and applicable source-drift checks still pass. Retain the original approving session as receipt provenance; do not relabel the receipt for the resuming session.

This is a shared-core correction, with Devin transport regression coverage. It is not a Devin-only conditional and does not add a second approval implementation.

### Non-goals

- Review Items 2–9: native dispatch-field translation, background lifecycle, reviewer isolation, MCP/configuration changes, doctor portability, branch integration, and evidence cleanup.
- Changing the receipt key/schema, requiring reapproval solely because a new session starts, or redesigning same-session challenge freshness.
- Removing `.current-session` globally or changing general workflow selection, session-to-intent bindings, PID ancestry, or other harnesses' identity contracts.
- Changing legacy Kiro recovery, break-glass policy, source-drift policy, or question-response extraction behavior.
- Release version/badge/changelog changes, commits, pushes, or PR replies during this planning task.

## 2. Fact-checked baseline

The following are source observations at the implementation baseline, not claims of fresh runtime reproduction. Line references are baseline-specific; use function names after edits.

| Verified fact | Source |
| --- | --- |
| `recordPlanApprovalHumanResponse` first reads the supplied session, then reads `.current-session` if that challenge is absent. It writes the response using `effectiveSession`, which can be another session. | `core/tools/aidlc-testing-posture.ts:1940–1975` |
| `certifyPlanApprovalReceipt` falls back when either supplied-session record is absent, substitutes a complete challenge/response pair from the current session, then writes a receipt bearing the originally requested session. | `core/tools/aidlc-testing-posture.ts:2055–2087, 2144–2157` |
| Existing pairing validates challenge ID, selected choice, and plan identity. `runtimeIdentityMatches` compares target, intent, run floor, fingerprint, questions file, and prompt hash—not session. | `core/tools/aidlc-testing-posture.ts:1814–1825, 2078–2087` |
| The storage readers already reject a challenge or response whose embedded session differs from the requested session. Reading only through the supplied key therefore restores the intended boundary without a new storage format. | `core/tools/aidlc-lib.ts:3355–3385` |
| Challenge IDs include session, compared identity, and offered-option properties. Clearing a session's challenge also clears its response. | `core/tools/aidlc-testing-posture.ts:1877–1895`; `core/tools/aidlc-lib.ts:3387–3402` |
| The receipt path is keyed by target, run floor, and fingerprint; evaluation also checks the full runtime identity and applicable source drift. Current-session equality is not a receipt-reuse condition. | `core/tools/aidlc-lib.ts:3254–3272`; `core/tools/aidlc-testing-posture.ts:2483–2531` |
| Claude wires SessionStart, UserPromptSubmit, and AskUserQuestion PostToolUse to the shared hooks. Its manifest projects the shared tools, hooks, and stage instructions. The problematic shared fallbacks consequently affect the Claude projection on this PR too. | `harness/claude/settings.json:78–98, 134–141`; `harness/claude/manifest.ts:77–84` |
| SessionStart already publishes the runtime session, including before a workflow exists. The Code Generation stage already requires the SessionStart ID for `decision` and the same ID for `answer`. | `core/hooks/aidlc-session-start.ts:182–189, 399`; `core/aidlc-common/stages/construction/code-generation.md:269–303` |
| The human-turn hook takes `session_id` from the payload and passes it to the shared response function. Its non-fatal human-presence bookkeeping is distinct from successful approval certification. | `core/hooks/aidlc-record-human-turn.ts:139–177` |
| Devin already forwards the session in SessionStart and human-response payloads and supplies a valid payload session as an override to its core subprocess environment. This is existing code, not a missing transport mechanism to invent. | `harness/devin/hooks/aidlc-devin-adapter.ts:526–536, 541–567, 577–607` |
| Existing integration assertions require approvals to survive resume, a new SessionStart, and other legitimate observer/lifecycle actions. | `tests/integration/t328-authority-rebinding.test.ts:553–640` |
| Devin test 13d seeds a challenge and checks that one response file exists; it does not assert the complete response ownership or receipt certification. | `tests/unit/t332-devin-adapter.test.ts:662–708` |

### Host evidence and limits

The installed Devin `3000.10.21` documentation bundle, located through the `devin-cli` skill at `docs/extensibility/hooks/overview.mdx:104–129`, documents `session_id` as stable per session and `prompt_id` as per-turn. It also documents `DEVIN_PROJECT_DIR` as the project-root environment variable. Documentation is not a fresh live capture.

`tests/fixtures/devin-hook-payloads/capture-provenance.json` identifies the committed raw captures as Devin `3000.6.14`. Those captures use session slugs; they do not establish that every current host session ID is a slug or UUID. C07/C08 did not capture human-answered PostToolUse envelopes. The native answered shapes discussed in [DEVIN-08](08-questions-and-human-turns.md) include session-export-derived and synthetic evidence; label new fixtures accordingly.

The review reports a reproduced same-identity cross-session certification and a rejected mismatched-intent case. This planning session verified the relevant code paths but did not rerun those scenarios. The first implementation step below supplies reproducible red/green evidence.

## 3. Intended change

### A. Remove authority fallback in the shared core

Modify `core/tools/aidlc-testing-posture.ts` only for the two normal authority lookups:

1. In `recordPlanApprovalHumanResponse`, replace the challenge lookup/fallback block with:

   ```ts
   const challenge = readPlanApprovalChallenge(projectDir, session);
   ```

   Remove `effectiveSession` and write the response using the supplied `session`. Keep offered-choice matching and response hashing unchanged. If this session has no normal challenge, preserve the existing same-session legacy-recovery check and final `{ recorded: false }`; do not return early in a way that breaks recovery.

2. In `certifyPlanApprovalReceipt`, replace the mutable lookup/fallback block with:

   ```ts
   const challenge = readPlanApprovalChallenge(projectDir, session);
   const response = readPlanApprovalResponse(projectDir, session);
   ```

   Retain the existing missing-record, challenge-ID, choice, and runtime-identity checks and their refusal text:

   ```text
   Plan Approval requires the actual offered choice from this prompt and session
   ```

3. Remove the now-unused `readCurrentSessionId` import from this module. No other uses were found in it at the baseline. Do not remove the shared helper or its unrelated callers.

4. Preserve active-directive locking, source certification, drift handling, same-session cleanup, Request Changes behavior, receipt key/schema, and override/recovery semantics.

The existing session-validating readers are the enforcement seam. A new global alias, intent-UUID lookup, search for any matching challenge, or session fallback inside the readers would recreate the defect and is explicitly excluded.

### B. Use and verify the existing Devin session transport

The required sequence is already expressible without new commands or host configuration:

```text
SessionStart(session_id = S)
  -> shared hook publishes Runtime Session S
  -> log decision --session S creates challenge S
  -> actual human reply arrives with session_id S
  -> adapter forwards S; shared hook records response S
  -> log answer --session S certifies receipt S
```

Do not read an intent UUID from a binding file as a substitute for S. Do not use `.current-session` to repair a missing or mismatched S. Do not manufacture a new approval session in the adapter.

Prove this sequence through adapter subprocess tests before proposing runtime changes to the adapter. The baseline already supplies the necessary transport. If a current-host capture contradicts it, stop and present the specific discrepancy and proposed binding change for agreement instead of silently expanding this fix.

Recovery for a wrongly keyed pending challenge is a fresh presentation under the actual host runtime session and a fresh human answer. Do not copy or relabel another session's challenge/response, inject approval into protected files, or treat HUMAN_TURN/exit 0 as approval success. If host session identity is unavailable, certification must remain unavailable; a restart with functioning SessionStart hooks is preferable to guessing.

## 4. Implementation sequence and regression matrix

### Step 1 — Establish failing isolation tests

Extend `tests/unit/t328-plan-approval-runtime-authority.test.ts` using its existing project/plan fixtures. Derive valid question evidence from fixture artifacts, mint challenges through `recordPlanApprovalChallenge`, record responses through `recordPlanApprovalHumanResponse`, and certify through `recordPlanApprovalReceipt`. Use the public readers to inspect ownership and receipt content.

Use deterministic interleavings rather than timing-dependent simultaneous threads: two live session keys and an explicitly moved current-session pointer exercise these branches directly. Establish an identical identity once and use it for both sessions so an unrelated fingerprint/intent mismatch cannot hide the isolation failure. Verify actual challenge IDs and returned/stored sessions, not only errors or response-file counts.

| Case | Required assertion |
| --- | --- |
| Only B has a pending challenge; `.current-session = B`; reply is supplied for A | `{ recorded: false }`; no response for A or B; B's challenge is unchanged. This is a pre-fix failing case. |
| B has a matching challenge and its own human response; A has neither; certification is requested for A with identical evidence | Certification throws the existing pairing refusal; no receipt is created; B's pending pair is unchanged. This independently tests certification rather than relying on response rejection. |
| A has its own challenge but no response; B has a complete pair for identical evidence | Certification for A still refuses. Cover the original `!challenge || !response` branch, not just the both-absent case. |
| Both sessions have challenges for identical evidence; A answers while current-session points at B | Only A's response is written, paired with A's challenge; B's state is unchanged. |
| A has its own valid pair while current-session points at B | A certifies successfully; receipt session and challenge ID are A's; A's pending pair is consumed and B's is unchanged. Repeat symmetrically for B in a separate fixture. |
| Mismatched intent identity | Same-session pairing with evidence differing in `authority.intentId` refuses; also repeat the review's cross-session mismatched-intent scenario. No receipt is created. |
| Wrong challenge ID or selected choice | Existing rejection remains; a matching plan alone never supplies missing human authority. |
| Request Changes is supplied under the wrong session | Cannot consume B's response or clear an existing matching durable receipt. Snapshot the receipt and both pending pairs before the call. |
| Valid same-session Request Changes | Existing withdrawal/cleanup behavior still works; no approval receipt is manufactured. |
| Blank or unknown supplied session while B has pending authority | No fallback response or receipt. Keep legacy recovery's own exact-session path intact. |
| Pointer absent or moved between decision, response, and certification | Results depend on the supplied session, never on the pointer. |

Run the new isolation cases on the unmodified baseline first and preserve their failures. Some control cases should already pass; only the actual regressions need to fail before the fix. Then apply Section 3A and rerun the same cases.

### Step 2 — Cover the shared CLI and Devin hook boundary

- Extend the hook lifecycle coverage in `tests/unit/t265-plan-approval-guard.test.ts` to exercise `log decision`, a session-tagged human-turn hook response, and `log answer`, with a second session current. Verify successful same-session certification and rejected cross-session certification. Keep the existing bare-numeric and JSON-quoted response tests introduced after the review.
- Extend `tests/unit/t332-devin-adapter.test.ts` to assert the exact stored response in test 13d, then add A/B interleavings using native-shaped answered-question payloads and direct UserPromptSubmit payloads.
- Use `DEVIN_PROJECT_DIR` and a native-shaped payload without invented `cwd`; use distinct valid session IDs and separately vary `prompt_id` to show it does not replace session identity.
- Assert that SessionStart context contains the exact supplied runtime session both with and without an active workflow. Use that ID for challenge creation and certification in a positive subprocess case; do not seed the response/receipt for that positive lifecycle case.
- Include an absent-session event with B's challenge pending: human-presence handling may remain advisory, but no protected approval response or receipt may appear. A payload for an unknown session or an intent UUID must not redirect to B.
- For the negative transport cases, seed only the prerequisite challenge or independently observed B response as appropriate, and assert B's state remains unchanged. Label these as deterministic tests, not live human acceptance.

### Step 3 — Preserve Claude parity and established authority semantics

Run the shared approval/runtime suites, the existing receipt-key tests, and the integration approval-survival cases. Specifically retain:

- certified receipt survives a new SessionStart/resume when the existing identity and source rules permit it;
- receipt retains its approving session instead of being reissued for the resuming session;
- changed target, intent, attempt, prompt, plan, instructions, or Testing Contract still invalidates authority as currently specified;
- strict/relaxed source-drift behavior is unchanged;
- protected legacy recovery and typed override still require their own existing authority and do not gain a fallback;
- source-race, lock, and observer-safety coverage remains green.

No session equality check belongs in `evaluateCodeGenerationApproval` or the receipt key for this fix. The user explicitly chose to retain Claude's intended resume behavior.

### Step 4 — Update the focused documentation

As part of implementation, update these existing documents to distinguish the removed workaround from the intended contract:

- [DEVIN-09](09-plan-approval-authority.md): replace the current-fallback description and “intended fallback” regression expectation with strict session pairing, exact-session recovery, and evidence for the new tests.
- [Findings index](index.md): update only the DEVIN-09 status/open-boundary entries when supported by actual results; keep other review gaps open.
- [DEVIN-14](14-regression-and-evidence.md): update the Plan Approval regression/evidence row, separating deterministic coverage from live acceptance.

Search `docs/` and `README.md` for `readCurrentSessionId`, `.current-session`, and fallback-isolation language before finalizing. Preserve unrelated navigation/usage references and historical evidence; do not turn old captures into current-host PASS claims. The existing shared Code Generation commands already name the correct runtime session, so no new flags or duplicated harness-specific approval protocol are needed.

## 5. Verification commands for implementation

Run from a checkout based on the pinned latest PR head, after normal repository dependency setup. These commands were verified against the repository's package scripts, documented Bun test infrastructure, and existing test paths; they have **not** been run for this plan.

First materialize the projections used by the subprocess fixtures:

```bash
bun scripts/package.ts
```

Name the new shared test group `Item 1 session isolation`, then capture its baseline failure and its post-fix success with the same command. Regenerate projections again after source changes before testing projected CLI/hook paths.

```bash
bun test tests/unit/t328-plan-approval-runtime-authority.test.ts --test-name-pattern 'Item 1 session isolation'
```

Focused post-fix tests:

```bash
bun test tests/unit/t265-plan-approval-guard.test.ts tests/unit/t328-plan-approval-runtime-authority.test.ts tests/unit/t330-authority-rebinding.test.ts tests/unit/t332-devin-adapter.test.ts tests/unit/t334-change-control-plan-approval.test.ts
bun test tests/integration/t328-authority-rebinding.test.ts
```

Final packaging/static gate, once after the final source changes:

```bash
bun scripts/package.ts --check
bun run typecheck
bun run lint
git diff --check
```

If an agreed follow-up changes session resolution or binding rather than just proving the existing transport, add `tests/unit/t318-session-binding-helpers.test.ts` and `tests/unit/t312-orchestrate-session-binding.test.ts` to the focused run. Such a change requires the discrepancy review described in Section 3B; it is not assumed necessary.

Record exit statuses, failing assertions, exact tested SHA and patch state, and any skipped checks. Do not amend release metadata or security controls to clear unrelated failures. No live model suite or authenticated MCP call is required to prove these deterministic Item 1 regressions.

## 6. Current-host acceptance and completion criteria

After deterministic tests pass, perform an attended, disposable Devin validation on the supported host version. Record exact CLI/build, AI-DLC SHA, installation channel, and sanitized hook input/output. The user must supply actual human choices; manually seeded authority is not live acceptance.

1. Open sessions A and B against the same disposable workflow/plan and attempt; observe each SessionStart ID and verify they differ before testing.
2. Move the current-session pointer through ordinary session activity. Approve in A and confirm only A's pending challenge receives the response and its receipt records A.
3. Exercise a mismatched-session answer/certification and confirm refusal without consumption of the other session's pending authority. Use the deterministic suite for deliberately injected mismatched hook payloads; do not mislabel synthetic event injection as host behavior.
4. Resume unchanged, legitimately certified work in a fresh session and verify the shared approval evaluation still recognizes the original receipt. Keep this approval check separate from native subagent dispatch, whose Item 2 defect is out of scope.
5. Retain small sanitized fixtures and a concise outcome record. If an attended current-host test cannot be performed, report it as NOT RUN; do not close the live-evidence gap based on subprocess results.

Item 1 implementation is complete when all four reviewer-requested isolation properties are covered and pass, legitimate same-session certification works through both the shared Claude-style lifecycle and Devin adapter, durable receipt reuse remains unchanged, focused/static checks pass or have explicitly reported blockers, and documentation accurately states the evidence level.

### Residual limitations

This prevents new cross-session miscertification; it does not prove that receipts produced before the fix were correctly attributed. Do not bulk-delete or silently migrate existing protected state. A receipt known to come from a mispaired flow requires a separately agreed fresh human approval/recovery procedure. No automatic migration or invalidation is authorized by this plan.

Same-session delayed replies, sanitization/collision behavior of session filenames, malicious same-user environment manipulation, and broader host identity guarantees are not resolved by removing these two fallbacks. Do not present this fix as a complete redesign of session security or as closure of the review's other authority/isolation findings.
