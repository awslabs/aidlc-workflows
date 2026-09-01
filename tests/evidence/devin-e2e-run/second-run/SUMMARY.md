# Devin CLI Harness — E2E Test Run 2 Summary (Interactive, Blocked at Plan Approval)

**Date**: 2026-08-31
**Plan**: `devin-e2e-test-plan.md` (in this directory)
**Scope**: express (9 stages, minimal depth)
**Duration**: ~25 minutes (workflow), ~30 minutes total including setup
**Devin CLI**: 3000.6.7
**Model**: glm-5-2
**Mode**: **interactive** (`devin`, NOT `devin -p` print mode) — the key delta from run 1
**Status**: **BLOCKED** at code-generation plan approval — harness adapter bug found

## Test Environment

- **Test project**: `~/devin-e2e-test-2` (fresh git project, separate from run 1's `~/devin-e2e-test`)
- **Distribution**: `dist/devin/` copied into test project
- **Run mode**: `devin` (interactive) — user at the keyboard answering gates via real `ask_user_question` prompts
- **Gate handling**: User approved gates via native `ask_user_question` prompts (NOT auto-approved via `report --result completed`)
- **Plan approval**: User answered "Approve Plan" genuinely in the native prompt — but the adapter bug prevented the response from being recorded

## Results by Phase

### Phase 0 — Install & Doctor: PASS

- All 45 doctor checks passed (0 failed)
- All required rows present: bun, adapter, hooks.v1.json, config.json, mcp_config.json, rules, CLI version
- `settings.json present` NOT found (harness correctly detected as `.devin`)
- Exit code: 0

### Phase 1 — Cold Start & Initialization: PASS

- SessionStart hook fired (WORKFLOW_STARTED in audit)
- Orchestrator skill discovered and loaded
- 3 initialization stages completed: workspace-scaffold, workspace-detection, state-init
- Audit trail started with proper shard
- UserPromptSubmit hook fired (HUMAN_TURN recorded from typed prompts)

### Phase 2 — Inception: requirements-analysis: PARTIAL PASS

- `ask_user_question` rendered as a **native Devin prompt** with clickable options — **THE RUN-1 GAP IS CLOSED** (Checkpoint 2c: PASS)
- The conductor presented the requirements questions via the real prompt UI
- User answered via the native prompt
- **BUT**: the `record-human-turn` PostToolUse hook on `ask_user_question` **skipped** because `hasExplicitHumanSelection()` returned false for Devin's object-format `tool_response` (see Root Cause below)
- The conductor struggled to record the answer — 8 ERROR_LOGGED events: "Cannot record this answer because no new human reply has arrived for the question"
- Eventually the gate was approved (1 GATE_APPROVED) — likely via a workaround where the user typed a prompt that registered via UserPromptSubmit
- requirements-analysis completed with 1 GATE_APPROVED, 1 STAGE_COMPLETED

### Phase 3 — Construction: code-generation: BLOCKED (Adapter Bug)

- The conductor advanced to code-generation and wrote the plan artifacts:
  - `code-generation-plan.md` (167 lines, 12 implementation steps)
  - `unit-test-instructions.md` (Jest + supertest, 16 tests)
  - `_contract.md` (Testing Contract with sha256 fingerprint)
  - `code-generation-questions.md` (with `[Answer]: Approve Plan`)
- The conductor presented the Plan Approval question via `ask_user_question` — **native prompt rendered correctly**
- User answered "Approve Plan" genuinely in the native prompt
- **BUT**: the same adapter bug prevented `recordPlanApprovalHumanResponse()` from being called
- Without the human response, `recordPlanApprovalReceipt()` could not write the receipt
- The `plan-approval-guard` hook blocked all subsequent tool calls (12 PLAN_APPROVAL_BLOCKED events) because `receiptValid` was false
- The conductor entered a retry loop: re-presenting the question, user answering, guard blocking — the user reported "it always asks me to answer after I choose Approve Plan"
- **Run stopped here** at the user's request

### Phase 4 — Operation & Completion: NOT REACHED

### Phase 5 — Post-Run Verification: N/A (workflow incomplete)

### Phase 6 — Hook Coverage: 14/17 verified (82%)

- 14 hooks verified as fired or correctly enforced
- **1 hook FAIL**: `record-human-turn` on `ask_user_question` PostToolUse
- 2 hooks NOT TESTED: `deliver-stage-rules`, `log-subagent` (blocked before subagent dispatch)

## Audit Event Distribution

| Event | Count | Run 1 comparison |
|-------|-------|------------------|
| PLAN_APPROVAL_BLOCKED | 12 | Run 1: 15 (both runs prove the guard enforces) |
| ARTIFACT_CREATED | 9 | Run 1: 13 |
| SENSOR_PASSED | 8 | Run 1: 35 |
| SENSOR_FIRED | 8 | Run 1: 40 |
| ERROR_LOGGED | 8 | Run 1: 11 (different errors — run 2's are all "no human reply") |
| ARTIFACT_UPDATED | 8 | Run 1: 6 |
| STAGE_STARTED | 7 | Run 1: 13 |
| HUMAN_TURN | 5 | Run 1: 2 (run 2 has more because user typed prompts as workarounds) |
| DECISION_RECORDED | 5 | Run 1: 4 |
| STAGE_COMPLETED | 4 | Run 1: 6 |
| PHASE_STARTED | 3 | Run 1: 4 |
| PHASE_VERIFIED | 2 | Run 1: 4 |
| PHASE_COMPLETED | 2 | Run 1: 4 |
| WORKFLOW_STARTED | 1 | Run 1: 1 |
| SUMMARY_CONFIRMATION_RECORDED | 1 | Run 1: 1 |
| STAGE_AWAITING_APPROVAL | 1 | Run 1: 4 |
| PHASE_SKIPPED | 1 | Run 1: 1 |
| GATE_APPROVED | 1 | Run 1: 3 |
| PLAN_APPROVAL_RECORDED | 0 | Run 1: 1 (manual hack) — **run 2: 0 (genuine approval couldn't be recorded)** |
| SUBAGENT_COMPLETED | 0 | Run 1: 0 (both runs: not reached) |
| WORKFLOW_COMPLETED | 0 | Run 1: 1 (run 2: blocked) |
| SESSION_ENDED | 0 | Run 1: 3 (run 2: session not exited cleanly) |

## Root Cause: Harness Adapter Bug in `hasExplicitHumanSelection()`

### The bug

The `record-human-turn` PostToolUse hook on `ask_user_question` fires correctly
but **skips** (returns 0 without recording) because
`hasExplicitHumanSelection()` in `aidlc-devin-adapter.ts` (line 151) returns
false for Devin's `tool_response` format:

```typescript
function hasExplicitHumanSelection(toolResponse: unknown, toolInput?: unknown): boolean {
  if (typeof toolResponse !== "string") return false;  // ← Devin passes an object, not a string
  // ...
}
```

Devin's PostToolUse `tool_response` for `ask_user_question` is an object
`{success, output, error}` (documented in the adapter's own comment at line
122-125), not a JSON string. The function immediately returns false, causing
the hook to skip at line 370-373:

```typescript
if (
  tool === "ask_user_question" &&
  !hasExplicitHumanSelection(devin.tool_response, devin.tool_input)
) {
  return 0;  // ← skips, no human response recorded
}
```

### The cascade

1. User answers "Approve Plan" in native `ask_user_question` prompt
2. PostToolUse hook fires → `hasExplicitHumanSelection()` returns false → hook skips
3. `recordPlanApprovalHumanResponse()` is never called → no response recorded
4. `recordPlanApprovalReceipt()` can't write the receipt (requires challenge↔response match)
5. `plan-approval-guard` checks `receiptValid` → false → blocks (12 times)
6. Conductor re-presents the question → user answers → same loop

### Broader impact

The bug affects ALL `ask_user_question` answer recording, not just plan
approval. The conductor also struggled with requirements-analysis (8
ERROR_LOGGED events: "Cannot record this answer because no new human reply
has arrived"). It found a workaround for the gate (user typing a prompt that
registered via UserPromptSubmit), but the plan-approval challenge/response/
receipt mechanism is stricter — it requires the actual offered choice from
the specific prompt — so the workaround doesn't work.

### The fix

`hasExplicitHumanSelection()` needs to handle Devin's object-format
`tool_response` by extracting the answer from `{success, output, error}.output`
and parsing that as JSON, or by detecting the answer structure directly in the
object. The adapter's own comment acknowledges the object format but calls the
skip "correct fail-open behavior" — it's not fail-open for Plan Approval,
where the receipt depends on the response being recorded.

The fix belongs in `core/` (the adapter source) or `harness/devin/` (the
per-harness surface), then regenerated via `bun scripts/package.ts`.

## Key Findings

1. **`ask_user_question` rendering works in interactive mode** — native Devin
   prompts with clickable options appear correctly. This was the single
   biggest run-1 gap and it is CLOSED. The harness adapter correctly
   translates the `ask` directive into the `ask_user_question` tool call.

2. **`ask_user_question` answer recording is broken** — the PostToolUse hook
   fires but skips because `hasExplicitHumanSelection()` doesn't handle
   Devin's object-format `tool_response`. This breaks all answer recording
   from `ask_user_question`, including the Plan Approval challenge/response/
   receipt triple. This is a **new finding that run 1 could not expose**
   because print mode never fired the question tool.

3. **Plan-approval-guard enforces correctly** — 12 PLAN_APPROVAL_BLOCKED
   events prove the guard blocks when the receipt is missing. The guard is
   not the bug; the adapter is. The guard correctly requires all 6 evidence
   pieces (plan, instructions, approved, contract, fingerprint, receipt) and
   blocks when the receipt is absent.

4. **Interactive mode surfaces bugs print mode cannot** — run 1 (print mode)
   reported 15/17 hooks verified and called the run a PASS. Run 2 (interactive
   mode) found the `record-human-turn` PostToolUse bug on the very first
   `ask_user_question` prompt. The interactive trial is essential for
   verifying the human-in-the-loop surfaces.

5. **Subagent dispatch still not tested** — the workflow blocked at
   code-generation plan approval, before the conductor could dispatch the
   developer agent via `run_subagent`. `deliver-stage-rules` and
   `log-subagent` remain unverified (same as run 1).

## What Run 3 Should Do

1. **Fix the adapter bug** — update `hasExplicitHumanSelection()` to handle
   Devin's object-format `tool_response`, repackage `dist/devin`.
2. **Re-run interactive express scope** — same prompt, same scope. With the
   fix, the plan approval should record the genuine human response, the
   receipt should be written, and the guard should allow the developer-agent
   dispatch with 0 PLAN_APPROVAL_BLOCKED events.
3. **Verify subagent dispatch** — if the conductor dispatches `run_subagent`
   for code-generation, `deliver-stage-rules` and `log-subagent` should fire,
   closing the last 2 untested hooks.

## Files in This Directory

| File | Description |
|------|-------------|
| `SUMMARY.md` | This file |
| `devin-e2e-test-plan.md` | The run 2 plan |
| `00-doctor-output.txt` | Doctor command output (Phase 0) |
| `00-checkpoint-0ab.txt` | Checkpoint 0a/0b verification |
| `05-audit-trail-distribution.txt` | Full audit event distribution |
| `05-session-cost.json` | Runtime summary JSON |
| `06-hook-coverage.txt` | Hook coverage checklist |
| `aidlc-state.md` | Final workflow state (stopped at code-generation) |
| `audit-shard.md` | Complete audit trail (764 lines) |
| `runtime-graph.json` | Compiled runtime graph |
| `monitoring-log.txt` | Background monitor polling log (8 polls) |
| `inception-artifacts/` | requirements-analysis artifacts |
| `construction-artifacts/` | code-generation plan artifacts (plan, questions, contract — code never generated) |
