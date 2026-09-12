# Run 3 Summary — Devin CLI Harness (Third Run, Post-Fix Verification)

**Date:** 2026-09-01
**Scope:** express (9 stages, 6 approval gates)
**Mode:** interactive (`devin`)
**Outcome:** BLOCKED at code-generation plan approval — run-2 fix was necessary but NOT sufficient; 4 bugs found (A, B, C, D); 15/17 hooks verified.

## Purpose

This run was the live verification of the run-2 adapter fix (commit
`f51d55d3`, `normalizeToolResponse()` in `aidlc-devin-adapter.ts`). Run 2
found that the PostToolUse `record-human-turn` arm on `ask_user_question`
skipped because `hasExplicitHumanSelection()` rejected Devin's
object-format `tool_response` (`{success, output, error}`). The fix
added `normalizeToolResponse()` to extract `.output` before the selection
parsers run. Unit test `t332` case `13a` asserted the effect — a
`HUMAN_TURN` audit event lands, not just exit 0.

## Key finding: the fix was necessary but NOT sufficient

`normalizeToolResponse()` correctly extracts `.output` from the
`{success, output, error}` object wrapper. **But the PostToolUse
`record-human-turn` arm has NEVER fired for ANY `ask_user_question`
response — not in run 2, not in run 3.** All 7 `HUMAN_TURN` events in
run 3 are from `UserPromptSubmit` (typed prompts), not from the
PostToolUse arm.

The arm always skips because `hasExplicitHumanSelection()` (line 186 of
`aidlc-devin-adapter.ts`) returns false for the actual Devin response
shape. `normalizeToolResponse` was the first failure point (object
wrapper extraction); `hasExplicitHumanSelection` is the second (parsed
shape validation). The unit test `t332` case `13a` only tests that
`normalizeToolResponse` extracts the output and that the subprocess
exits 0 — it does NOT test that `hasExplicitHumanSelection` returns true
for the real Devin response shape.

**Why regular gates passed despite the arm never firing:** Regular gates
only need a `HUMAN_TURN` "since the last gate resolution" (any human
presence). A typed prompt (UserPromptSubmit) before the gate satisfies
this. The plan approval flow is different — it specifically requires
`recordPlanApprovalHumanResponse()` to write a response file, which only
fires when the PostToolUse arm runs with `session_id` and
`humanResponseText`. Since the arm always skips, no response file is
ever written.

## Phase-by-phase narrative

### Phase 0 — Install & Doctor (PASS)

Pre-flight checks in the source repo confirmed all fix markers present:
- `normalizeToolResponse` at line 131 of `dist/devin/.devin/hooks/aidlc-devin-adapter.ts`
- `### Devin` binding at line 180 of `stage-protocol-ensemble.md`
- `profile` field mechanic, model-resolution note, must-dispatch instruction
- `bun scripts/package.ts --check` clean

Fresh project `~/devin-e2e-test-3` created; dist/devin copied; install
commit `3588da8`. All four critical markers confirmed in the copied tree.
Doctor: 45 passed, 0 failed, exit 0. `settings.json present` correctly
absent (harness detected as `.devin`).

### Phase 1 — Cold Start & Initialization (PASS)

Session started interactively. Operator invoked
`/aidlc express "build a REST API for a todo app with CRUD endpoints"`.

**Finding:** The conductor asked "what to build" instead of acting on
the `print` directive — a conductor-side mishandling. The engine
returned a correct `print` directive instructing it to derive a label,
run `intent-create`, and re-run `next`. The conductor asked the operator
instead. Operator answered; intent `260901-todo-api` created.

Initialization stages (workspace-scaffold, workspace-detection,
state-init) completed: 3 `STAGE_STARTED` + 3 `STAGE_COMPLETED`.

### Phase 2 — Inception: requirements-analysis (PASS with findings)

The conductor ran `requirements-analysis`, presented structured
questions via `ask_user_question`, and the operator answered via native
prompts. Sensors fired and passed (`required-sections`,
`upstream-coverage`). Gate approved at 15:22:31 UTC.

**Findings:**
- 2 "no new human reply" errors early on — conductor called
  `aidlc-log answer` before the human replied (timing, not adapter bug).
- 2 `aidlc-log --help` / `aidlc-utility --help` syntax errors —
  conductor fumbling the CLI interface.
- 1 `aidlc-log review` on a 0-review stage — express scope has no
  reviewers; engine correctly refused.
- 1 `edit` failed: non-unique `old_string` (4 occurrences) — conductor
  tool-use error.
- 7 `HUMAN_TURN` events total, but **ALL from UserPromptSubmit** (typed
  prompts), 0 from the PostToolUse arm. Initially misattributed to the
  PostToolUse arm firing; corrected in post-run analysis.

### Phase 3 — Construction: code-generation (BLOCKED — 4 bugs)

The conductor advanced to `code-generation`. Plan written, plan approval
question presented via native `ask_user_question` at 15:27:58 UTC
(operator confirmed native prompt was used). Operator approved.

**Bug A (headline):** The PostToolUse `record-human-turn` arm did NOT
fire for the plan approval. No `HUMAN_TURN` minted between 15:22:28
(last regular gate) and the plan approval. No `response-horn-medallion.json`
written. Root cause: `hasExplicitHumanSelection()` returns false for the
actual Devin response shape — `normalizeToolResponse` was necessary but
not sufficient.

**Bug B:** The conductor tried to manually run
`bun .devin/hooks/aidlc-devin-adapter.ts record-human-turn` to record
the approval. The `plan-approval-guard` blocked it:
`isFrameworkToolInvocation()` only exempts `.devin/tools/`, not
`.devin/hooks/`. Also `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` env prefix
didn't work.

**Bug C:** The conductor tried `aidlc-log answer --checkpoint plan-approval`
directly (exempted from the guard). Refused: "Plan Approval requires the
actual offered choice from this prompt and session" — no response file
exists to match the challenge (downstream of Bug A).

**Bug D:** The conductor re-ran `next` to unblock, which returned a
`load-steering` directive that replaced the `run-stage` directive. The
guard then rejected ALL mutations (including reads) because it can't
select an approval target from a `load-steering` directive. The
conductor's recovery attempt made things worse.

**Deadlock:** 23 `PLAN_APPROVAL_BLOCKED` events (run 1: 15, run 2: 12).
0 `PLAN_APPROVAL_RECORDED`. The conductor dispatched `run_subagent`
twice during recovery attempts (producing 2 `SUBAGENT_COMPLETED` with
`Agent Type: unknown` — the `profile` field was not passed, so
`deliver-stage-rules` did not fire).

### Phase 4 — Operation & Completion (NOT REACHED)

The workflow never completed. 0 `WORKFLOW_COMPLETED`, 0 `STAGE_SKIPPED`.
Session exited cleanly at 15:45:17 UTC (`SESSION_ENDED`, reason
`prompt_input_exit`).

## Deltas from run 2

| Metric | Run 2 | Run 3 | Direction |
|--------|-------|-------|-----------|
| `PLAN_APPROVAL_BLOCKED` | 12 | 23 | worse (conductor recovery attempts compounded) |
| `PLAN_APPROVAL_RECORDED` | 0 | 0 | same (still broken) |
| `SUBAGENT_COMPLETED` | 0 | 2 | better (but from recovery attempts, not intended dispatch) |
| `HUMAN_TURN` | 5 (typed) | 7 (typed) | same source (all UserPromptSubmit, 0 from PostToolUse arm) |
| "no new human reply" errors | 8 (adapter bug) | 2 (conductor timing) | better (adapter symptom gone, but arm still doesn't fire) |
| Hook coverage | 14/17 | 15/17 | better (`log-subagent` newly verified) |
| `record-human-turn` on `ask_user_question` | FAIL | FAIL | same (arm still never fires) |
| Run completed | No | No | same |

## Bugs found

### Bug A — PostToolUse `record-human-turn` arm never fires (HEADLINE)

- **Symptom:** No `HUMAN_TURN` minted by the PostToolUse arm for any
  `ask_user_question` response. All 7 HUMAN_TURNs from UserPromptSubmit.
- **Root cause:** `hasExplicitHumanSelection()` in
  `aidlc-devin-adapter.ts` returns false for the actual Devin response
  shape. `normalizeToolResponse()` extracts `.output` correctly, but the
  parsed format doesn't match the expected
  `{answers: {questionId: {answers: ["choice"]}}}` structure.
- **Fix direction:** Log the raw `tool_response` from a live Devin
  `ask_user_question` PostToolUse to discover the actual response shape,
  then update `hasExplicitHumanSelection` to handle it. Or make the arm
  less strict — if `normalizeToolResponse` extracts output, mint the
  HUMAN_TURN regardless of the selection shape.
- **Location:** `aidlc-devin-adapter.ts` line 186
  (`hasExplicitHumanSelection`), `aidlc-devin-adapter.ts` line 131
  (`normalizeToolResponse`), `aidlc-record-human-turn.ts` line 105+
  (the `humanTurnMintAllowed` / `recordPlanApprovalHumanResponse` path).

### Bug B — `plan-approval-guard` blocks framework hook scripts

- **Symptom:** `bun .devin/hooks/aidlc-devin-adapter.ts record-human-turn`
  blocked during code-generation post-fingerprinting.
- **Root cause:** `isFrameworkToolInvocation()` in
  `aidlc-plan-approval-guard.ts` (line 464) only exempts scripts under
  `.devin/tools/`, not `.devin/hooks/`.
- **Also:** `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` env prefix didn't work
  (the guard reads `process.env` but the env var set as a command prefix
  may not be visible to the hook process).
- **Fix direction:** Extend `isFrameworkToolInvocation()` to also exempt
  `.devin/hooks/aidlc-*.ts`.
- **Location:** `aidlc-plan-approval-guard.ts` line 464.

### Bug C — `aidlc-log answer` refuses without response file (downstream of A)

- **Symptom:** `aidlc-log answer --checkpoint plan-approval` refused:
  "Plan Approval requires the actual offered choice from this prompt and
  session."
- **Root cause:** `recordPlanApprovalReceipt()` reads the challenge and
  response files; the challenge exists but the response doesn't (Bug A
  prevented it). Later: "fingerprint does not match" (Bug D changed the
  directive).
- **Fix:** Fixed automatically when Bug A is fixed.
- **Location:** `aidlc-testing-posture.ts` line 1472
  (`recordPlanApprovalReceipt`).

### Bug D — Conductor re-run of `next` corrupts directive state

- **Symptom:** Active directive changed from `run-stage` to
  `load-steering`; guard then rejects all mutations including reads.
- **Root cause:** The conductor re-ran `next` during deadlock recovery;
  the engine returned a `load-steering` directive that replaced the
  `run-stage` directive. The guard only accepts `run-stage` or
  `invoke-swarm` for approval authority.
- **Fix direction:** Conductor should not re-run `next` mid-approval; or
  the engine should not replace an active `run-stage` with
  `load-steering` while a plan approval challenge is pending.
- **Location:** Conductor behavior + `aidlc-plan-approval-guard.ts`
  directive-kind check.

## Conductor-side findings (not bugs)

- Asked "what to build" instead of acting on `print` directive.
- Called `aidlc-log answer` before human replied (2 timing errors).
- Tried `aidlc-log --help` and `aidlc-utility --help` with wrong syntax.
- Tried `aidlc-log review` on a 0-review stage.
- `edit` failed: non-unique `old_string` (4 occurrences).
- Tried `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` env prefix bypass (failed).
- Dispatched `run_subagent` without `profile` field (2 dispatches, both
  `Agent Type: unknown` — `deliver-stage-rules` did not fire).

## Hook coverage: 15/17

| Hook | Run 1 | Run 2 | Run 3 |
|------|-------|-------|-------|
| SessionStart | PASS | PASS | PASS |
| SessionEnd | PASS | PASS | PASS |
| UserPromptSubmit → record-human-turn | PASS | PASS | PASS |
| PreToolUse → state-transition-guard | PASS | PASS | PASS |
| PreToolUse → reviewer-scope | PASS | PASS | PASS |
| PreToolUse → review-freeze | PASS | PASS | PASS |
| PreToolUse → plan-approval-guard | PASS (15) | PASS (12) | PASS (23) |
| PreToolUse → deliver-stage-rules | NOT TESTED | NOT TESTED | NOT TESTED |
| PreToolUse → fold-usage | PASS | PASS | PASS |
| PostToolUse → audit-and-sensors | PASS | PASS | PASS |
| PostToolUse → sync-workflow-state | PASS | PASS | PASS |
| PostToolUse → log-subagent | NOT TESTED | NOT TESTED | **PASS** (2 events) |
| PostToolUse → record-human-turn (ask_user_question) | PARTIAL | **FAIL** | **FAIL** (arm never fires) |
| PostToolUse → rebuild-stage-graph | PASS | PASS | PASS |
| PostToolUse → fold-usage | PASS | PASS | PASS |
| PostCompaction → validate-state | PASS | PASS | PASS |
| Stop → continue-workflow | PASS | PASS | PASS |

**Newly verified in run 3:** `log-subagent` (2 `SUBAGENT_COMPLETED` from
conductor recovery dispatches).
**Still not tested:** `deliver-stage-rules` (conductor didn't pass
`profile` field in `run_subagent` calls).
**Still failing:** `record-human-turn` on `ask_user_question` (the
PostToolUse arm has never fired in any run).

## Artifacts

All artifacts in this directory. See `README.md` for SHA-256 manifest.
The full chronological log with live observations and corrected analysis
is in `RUN-NOTES.md`.
