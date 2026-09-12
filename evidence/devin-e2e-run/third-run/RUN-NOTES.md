# Run 3 — Live Notes (operator-observed events)

Running log of everything that happens during the third-run interactive
Devin session, captured as it occurs. This complements the deterministic
post-run audit-trail analysis (Phases 5-6) with the operator's live
observations — the things the audit trail cannot see (conductor missteps,
UI rendering quality, prompt wording, timing).

Format: `### HH:MM:SS — event` then a short note. Findings flagged
`[FINDING]` are worth carrying into `SUMMARY.md`.

---

## Phase 0 — Pre-flight (completed by Devin assistant)

- 11:51 — Source repo pre-flight: `package --check` clean; `normalizeToolResponse` at line 131; `### Devin` binding at line 180; `profile` field mechanic present; model-resolution note (SWE-1.6) present; must-dispatch instruction present. All pass.
- 11:52 — Fresh project `~/devin-e2e-test-3` created; `dist/devin` copied; install commit landed (`3588da8`).
- 11:52 — Copied-tree verification: all four critical markers (`normalizeToolResponse`, `### Devin`, `profile`, `Dispatched topologies must dispatch`) present in the copied tree. Pass.
- 11:52 — Doctor: 45 passed, 0 failed, exit 0. `settings.json present` correctly absent (harness detected as `.devin`). Saved to `00-doctor-output.txt`.

## Phase 1 — Cold start & initialization

### 11:57 — Operator started interactive session
`devin` launched in `~/devin-e2e-test-3`. Workspace trust approved.

### 11:57 — Operator invoked `/aidlc express "build a REST API for a todo app with CRUD endpoints"`
Same prompt as runs 1 and 2, per plan.

### 11:57 — [FINDING] Conductor asked "what to build" instead of acting on the `print` directive
The engine returned a `print` directive instructing the conductor to derive
a 2-3 word kebab label from the description, run `intent-create`, then
re-run `next`. The conductor instead asked the operator what to build —
a conductor-side mishandling of the `print` directive, not an engine or
hook bug.

Verified by re-running the same `next` command from a separate shell
(read-only, does not touch the live session's state):
```
{"kind":"print","message":"Run `bun .devin/tools/aidlc-utility.ts intent-create --scope express --arguments='build a REST API for a todo app with CRUD endpoints' --label \"<2-3 word kebab essence>\"` to start the workflow (9 of 33 stages, 6 approval gates), then re-run `next` to continue. …"}
```

The engine is correct; the conductor did not follow the `print` branch of
the loop. No audit event was minted (no intent exists yet —
`aidlc/spaces/default/intents/active-intent` is absent, only the
`.aidlc-hooks-health` dir is present).

**Resolution path:** operator will answer the conductor's question so it
has enough to derive a label and create the intent. This is a conductor
UX issue, not a run-3 blocker — once the intent exists and `next` is
re-run, the initialization stages should proceed normally and the
run-3 verification (adapter fix, plan approval, subagent dispatch) is
unaffected.

Carry into SUMMARY: the `print`-directive handling on this conductor/model
combination is a finding worth noting separately from the adapter-fix
verification.

### 12:03 — Intent created: `260901-todo-api`
Operator answered the conductor's question; conductor ran `intent-create`
and the intent directory `aidlc/spaces/default/intents/260901-todo-api/`
was created. `active-intent` now points to `260901-todo-api`.

### 12:03-12:05 — Initialization stages ran (3 stages)
`STAGE_STARTED: 4` / `STAGE_COMPLETED: 3` in the audit at this point —
the 3 init stages (workspace-scaffold, workspace-detection, state-init)
completed, and the 4th `STAGE_STARTED` is `requirements-analysis` now
in progress. Matches runs 1 and 2.

### 12:06 — [FINDING] 2 "no new human reply" errors early in requirements-analysis
Two `ERROR_LOGGED` events at 15:06:15 and 15:06:31 UTC:
```
aidlc-log answer --stage requirements-analysis --details Guide me
Cannot record this answer because no new human reply has arrived for the question.
```
**Different root cause from run 2.** Run 2's 8 errors were the adapter
bug — the PostToolUse `record-human-turn` arm rejected object-format
`tool_response`, so no human reply was ever registered, and every
subsequent `aidlc-log answer` found nothing. Run 3's 2 errors are a
**conductor timing mistake**: the conductor called `aidlc-log answer`
*before* the human reply had arrived (it tried to log "Guide me" as an
answer the user hadn't given yet). The adapter fix is working —
`HUMAN_TURN` events ARE being minted (4 so far, see below). The
conductor just jumped the gun twice early on. Not a run-3 blocker.

Also 2 more `ERROR_LOGGED` at 15:06:41/47 — the conductor tried
`aidlc-log --help` and `aidlc-log answer --help` (unknown subcommand /
missing value). Conductor fumbling for the `aidlc-log` interface, not a
hook or engine issue.

### 12:11-12:17 — [CORRECTED — NOT VERIFIED] HUMAN_TURNs are from UserPromptSubmit, NOT PostToolUse arm
Audit shows **4 `HUMAN_TURN` events** so far:
- 15:11:36 — no Session field — paired with a `Question Answered` event 7s later
- 15:16:23 — no Session field — paired with a `Question Answered` event 6s later
- 15:17:33 — has `Session: horn-medallion` — paired with a `Decision Recorded` event
- 15:17:59 — no Session field — followed by an `Artifact Updated` 7s later

**INITIAL (WRONG) ANALYSIS:** The pairing pattern indicated the PostToolUse
arm on `ask_user_question` was recognizing the object-format
`tool_response`, extracting `.output`, and minting `HUMAN_TURN`.

**CORRECTED ANALYSIS (post-run investigation):** All 7 HUMAN_TURNs are
from `UserPromptSubmit` events (typed prompts), NOT from the PostToolUse
arm. Evidence: only 2 of 7 HUMAN_TURNs have `Session: horn-medallion`
(the PostToolUse arm forwards `devin.session_id` if present; if it were
firing, ALL would have Session). The PostToolUse arm has NEVER fired —
`hasExplicitHumanSelection()` returns false for the actual Devin
`ask_user_question` response shape, so the arm always skips. The
`normalizeToolResponse()` fix from run 2 was necessary but NOT sufficient.
See Bug A in the "Bugs to fix" section for the confirmed root cause.

### 12:11 — [FINDING] Conductor `edit` failed: non-unique old_string (4 occurrences)
Operator reported:
```
Tool 'edit' validation failed: String not unique in file. Found 4 occurrences
of old_string in '/home/wiley/devin-e2e-test-3/aidlc/spaces/default/intents/260901-todo-api/...'
```
The conductor tried to `edit` a file (likely
`requirements-analysis-questions.md`, which had just been updated per
the audit) with an `old_string` that matched 4 places. Conductor-side
tool-use error — it should have supplied more surrounding context to
disambiguate, or used `write` to replace the whole file. Not a hook or
engine issue; the conductor needs to retry with a unique match.

### Current audit distribution (as of 12:17 UTC)
```
6 ARTIFACT_UPDATED
4 STAGE_STARTED
4 HUMAN_TURN          <- all from UserPromptSubmit (typed), NOT PostToolUse arm
4 ERROR_LOGGED        <- 2 are "no new human reply" (conductor timing), 2 are aidlc-log --help fumbling
3 STAGE_COMPLETED
3 DECISION_RECORDED
2 no new human reply  <- run-2 had 8 (adapter bug); run-3 has 2 (conductor jumped the gun)
1 ARTIFACT_CREATED
0 PLAN_APPROVAL_BLOCKED   <- not yet at code-generation
0 PLAN_APPROVAL_RECORDED  <- not yet at code-generation
0 SUBAGENT_COMPLETED      <- not yet at code-generation
```

### 12:18 — [FINDING] 2 more ERROR_LOGGED — conductor fumbling review/help interface
- 15:18:51 — `aidlc-log review --stage requirements-analysis --reviewer aidlc-product-lead-agent --iteration 1` rejected: "this stage allows 0 review passes". Express scope ships no reviewers, so the conductor tried to start a review that the engine correctly refused. Conductor should present findings at the gate instead.
- 15:19:50 — `aidlc-utility --help` → "Unknown command 'undefined'". Conductor passed `--help` wrong; the tool wants `aidlc-utility help`.

Both are conductor tool-use fumbling, not hook/engine bugs. Total
ERROR_LOGGED now 6: 2 "no new human reply" (conductor timing) + 2
aidlc-log --help fumbling + 1 review-not-allowed + 1 utility --help.
Run 2 had 8 "no new human reply" alone; run 3 has 2 of those and 4
other conductor fumbles. The adapter-fix symptom ("no new human reply")
is NOT recurring — the 2 we see are early conductor timing, not the
adapter skipping.

### 12:21 — Sensors fired and passed at requirements-analysis gate
`SENSOR_FIRED` / `SENSOR_PASSED` for `required-sections` and
`upstream-coverage` (twice — on `requirements-analysis-questions.md`
and `requirements.md`). All passed (37-42ms each). Then
`STAGE_AWAITING_APPROVAL` for `requirements-analysis` at 15:21:51 UTC.

### 12:21 — requirements-analysis gate pending
State shows `In Progress: requirements-analysis`, `Completed: 3` (the
init stages). The conductor should now present the approval gate via
`ask_user_question`. Operator to approve via the native prompt.

### Current audit distribution (as of 12:21 UTC)
```
7 ARTIFACT_UPDATED
6 ERROR_LOGGED         <- 2 no-new-human-reply (timing) + 4 conductor fumbles
5 HUMAN_TURN           <- all from UserPromptSubmit (typed), NOT PostToolUse arm
4 STAGE_STARTED
4 DECISION_RECORDED
3 STAGE_COMPLETED
3 SENSOR_FIRED + 3 SENSOR_PASSED
2 ARTIFACT_CREATED
1 STAGE_AWAITING_APPROVAL
0 PLAN_APPROVAL_BLOCKED   <- not yet at code-generation
0 PLAN_APPROVAL_RECORDED  <- not yet at code-generation
0 SUBAGENT_COMPLETED      <- not yet at code-generation
```

### 12:22 — requirements-analysis gate APPROVED
`GATE_APPROVED` at 15:22:31 UTC. `HUMAN_TURN` at 15:22:28 (6s before).
State advanced to `Completed: 4`, `In Progress: code-generation`.

### 12:22-12:27 — code-generation started, conductor hit by plan-approval-guard early
Multiple `PLAN_APPROVAL_BLOCKED` events at 15:22:35, 15:22:39, 15:22:42,
15:23:27, 15:23:54, 15:27:47 — the guard blocked the conductor's
mutation-capable commands during plan generation (before the approval
gate was presented). This is the guard working as intended — no
mutations before plan approval.

### 12:27 — Plan approval question presented
`DECISION_RECORDED` at 15:27:58 UTC:
- Decision: "Approve this exact Code Generation plan?"
- Options: Approve Plan, Request Changes
- Checkpoint: Code Generation Plan Approval
- Session: horn-medallion
- Challenge file written: `aidlc/.aidlc-sessions/plan-approval/challenge-horn-medallion.json`

### 12:28 — [FINDING — BUG A] PostToolUse `record-human-turn` arm did NOT fire for plan approval
**Critical finding.** The operator approved the plan, but **no
`HUMAN_TURN` event was minted after 15:22:28**. The last HUMAN_TURN is
the requirements-analysis gate approval at 15:22:28. The plan approval
was presented at 15:27:58 and the operator approved after that, but
there is zero HUMAN_TURN between 15:22:28 and the current state.

This means the PostToolUse `record-human-turn` arm on `ask_user_question`
**did not fire (or fired but skipped) for the plan approval question**.
The adapter fix from run 2 (`normalizeToolResponse`) made the arm fire
for regular questions (6 HUMAN_TURNs prove this), but the plan approval
`ask_user_question` response was NOT recorded.

Consequence: no `response-horn-medallion.json` file was written
(`recordPlanApprovalHumanResponse` was never called because the arm
didn't mint a HUMAN_TURN with the session_id). The challenge file
exists but no matching response file.

**Root cause hypotheses (need investigation):**
1. The conductor may not have used `ask_user_question` for the plan
   approval (it may have presented the question as text), so the
   PostToolUse arm never triggered.
2. The arm fired but `hasExplicitHumanSelection()` returned false for
   the plan approval response shape (a different object-format variant
   than `normalizeToolResponse` handles).
3. The arm fired but `devin.session_id` was absent, so
   `recordPlanApprovalHumanResponse` was skipped (the `if (sessionId &&
   humanResponseText)` guard in `aidlc-record-human-turn.ts`).

### 12:28 — [FINDING — BUG B] plan-approval-guard blocks manual `record-human-turn` invocation
The conductor, seeing no response was recorded, tried to manually run
`bun .devin/hooks/aidlc-devin-adapter.ts record-human-turn` via Bash.
The `plan-approval-guard` PreToolUse hook **blocked it**:

```
Tool rejected: Code generation cannot run mutation-capable shell command:
DEVIN_PROJECT_DIR=... bun .../aidlc-devin-adapter.ts record-human-turn 2>&1
for the zero-Unit stage-level implementation because the plan, unit-test
instructions, and current Testing Contract are fingerprinted and approved.
```

**Root cause:** `isFrameworkToolInvocation()` in
`aidlc-plan-approval-guard.ts` (line 464) only exempts scripts under
`.devin/tools/` (the `trustedToolsDir`), NOT scripts under
`.devin/hooks/`. So `bun .devin/hooks/aidlc-devin-adapter.ts` is treated
as a mutation-capable shell command and blocked during code-generation
post-fingerprinting. The guard should exempt framework hook scripts too,
not just framework tool scripts.

The conductor tried 4 times:
- 15:28:46 — `bun .../aidlc-devin-adapter.ts record-human-turn` → blocked
- 15:29:42 — `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1 bun .../aidlc-devin-adapter.ts record-human-turn` → blocked (the env var should disable the guard, but it didn't work — possibly because the env var is set in the command but the guard reads `process.env` which may not see it, or the guard's off-switch check happens before the env var is applied)
- 15:29:50 — `bun .../aidlc-devin-adapter.ts record-human-turn` (no env prefix) → blocked
- 15:30:33 — `/dev/null` (unknown command) → blocked

### 12:28-12:30 — [FINDING — BUG C] aidlc-log answer refused: no matching response
The conductor also tried `aidlc-log answer --checkpoint plan-approval
--session horn-medallion --details "Approve Plan"` directly (twice at
15:28:59 and 15:30:53). Both refused:
```
Refusing to record Plan Approval: Plan Approval requires the actual
offered choice from this prompt and session
```
This is a **downstream consequence of Bug A**: `recordPlanApprovalReceipt()`
reads the challenge and response files; the challenge exists but the
response doesn't (because the PostToolUse arm didn't record it). So the
challenge/response match fails and the receipt is refused.

`aidlc-log.ts` IS under `.devin/tools/` so the guard does NOT block it
(`isFrameworkToolInvocation` exempts it). The refusal comes from
`recordPlanApprovalReceipt()` itself, not the guard.

### 12:30 — DEADLOCK: code-generation is blocked
The conductor is in a deadlock:
1. Bug A: the automatic PostToolUse arm didn't record the plan approval response
2. Bug B: the guard blocks manual `record-human-turn` invocation (hooks not exempted)
3. Bug C: `aidlc-log answer` refuses because no response file exists (downstream of Bug A)

`PLAN_APPROVAL_BLOCKED` count is now **9** (run 2 had 12; run 3 has 9
and counting). `PLAN_APPROVAL_RECORDED` is **0** (same as run 2). The
adapter fix from run 2 is verified working for regular questions but
the plan approval flow has a separate break.

### Current audit distribution (as of 12:30 UTC)
```
10 ARTIFACT_UPDATED
9 PLAN_APPROVAL_BLOCKED   <- run-2 had 12; run-3 has 9 (different root cause)
7 ERROR_LOGGED
6 HUMAN_TURN              <- all from UserPromptSubmit (typed), NOT PostToolUse arm
6 STAGE_STARTED
5 DECISION_RECORDED
5 ARTIFACT_CREATED
4 STAGE_COMPLETED
4 SENSOR_PASSED
4 SENSOR_FIRED
1 STAGE_AWAITING_APPROVAL
1 SESSION_COMPACTED
1 GATE_APPROVED
0 PLAN_APPROVAL_RECORDED  <- same as run 2 (the fix didn't unblock this)
0 SUBAGENT_COMPLETED      <- can't dispatch, blocked at plan approval
```

### 12:30 — Operator decision: stop and deal with bugs later
Operator chose to stop the run here and address the bugs (A, B, C, D)
separately. The run has produced its key finding: the run-2 adapter fix
(`normalizeToolResponse`) was necessary but NOT sufficient. The
PostToolUse `record-human-turn` arm has NEVER fired for ANY
`ask_user_question` response — all 7 HUMAN_TURNs are from
UserPromptSubmit (typed prompts). `hasExplicitHumanSelection()` returns
false for the actual Devin response shape, so the arm always skips. The
plan approval flow is broken as a result, plus three additional bugs
(B, C, D) compound the deadlock.

**Run outcome at stop:**
- Adapter fix (run-2 bug): **NOT SUFFICIENT.** `normalizeToolResponse()`
  extracts `.output` correctly, but `hasExplicitHumanSelection()` still
  returns false for the actual Devin response shape. The PostToolUse arm
  has NEVER fired for ANY `ask_user_question` response. All 7 HUMAN_TURNs
  are from UserPromptSubmit (typed prompts).
- Plan approval flow: **STILL BROKEN** — same root cause as run 2
  (PostToolUse arm skips), plus new bugs (B: guard blocks hooks, C:
  downstream refusal, D: directive corruption on re-run).
- `PLAN_APPROVAL_RECORDED`: 0 (same as run 2)
- `PLAN_APPROVAL_BLOCKED`: 23 (run 2: 12 — worse, because the conductor
  kept trying to unblock itself and made things worse)
- `SUBAGENT_COMPLETED`: 2 (runs 1 and 2: 0 — but from conductor recovery
  attempts, not intended developer-agent dispatch)
- Hook coverage: 15/17 (run 1: 15/17, run 2: 14/17). The run-2 FAIL
  (`record-human-turn` on `ask_user_question`) is **STILL FAIL** — the
  arm has never fired. `log-subagent` is newly PASS (2 events).
  `deliver-stage-rules` remains NOT TESTED.

### Bugs to fix (for the next run)

**Bug A — PostToolUse `record-human-turn` arm has NEVER fired for ANY ask_user_question response**
- Symptom: No `HUMAN_TURN` event minted after the plan approval
  `ask_user_question` (last HUMAN_TURN at 15:22:28, plan approval
  presented at 15:27:58, operator approved after that — zero
  HUMAN_TURNs in between).
- Consequence: No `response-horn-medallion.json` written, so
  `recordPlanApprovalReceipt()` has no response to match the challenge.
- **CONFIRMED ROOT CAUSE** (operator confirmed native ask_user_question
  was used; code analysis confirms the skip path):
  `hasExplicitHumanSelection()` in `aidlc-devin-adapter.ts` (line 186)
  returns false for the Devin `ask_user_question` PostToolUse
  `tool_response` shape. The `normalizeToolResponse()` fix from run 2
  successfully extracts `.output` from the `{success, output, error}`
  object wrapper, but the parsed output format does NOT match the
  expected `{answers: {questionId: {answers: ["choice"]}}}` shape that
  `hasExplicitHumanSelection` validates against. One of the 12 checks
  in the function fails — which specific check requires logging the
  raw `tool_response` or inspecting the actual Devin response format.
- **The PostToolUse arm has NEVER fired for ANY ask_user_question
  response — not just plan approval.** All 7 `HUMAN_TURN` events in
  run 3 are from `UserPromptSubmit` events (typed prompts), not from
  the PostToolUse arm. Evidence: only 2 of 7 HUMAN_TURNs have
  `Session: horn-medallion` (PostToolUse would carry session_id for
  all; UserPromptSubmit may or may not). The 5 without Session are
  definitively from UserPromptSubmit.
- **Why regular gates passed despite the arm never firing:** Regular
  gates only need a `HUMAN_TURN` "since the last gate resolution" (any
  human presence). A typed prompt (UserPromptSubmit) before the gate
  satisfies this check. The plan approval flow is different — it
  specifically requires `recordPlanApprovalHumanResponse()` to write a
  response file, which only happens when the PostToolUse arm fires
  with `session_id` and `humanResponseText`. Since the arm always
  skips, no response file is ever written.
- **The run-2 fix was necessary but NOT sufficient.**
  `normalizeToolResponse()` fixed the first failure point (extracting
  `.output` from the object wrapper), but there's a SECOND failure
  point in `hasExplicitHumanSelection()` (the parsed output shape
  doesn't match the expected format). The unit test `t332` case `13a`
  only tests that `normalizeToolResponse` extracts the output and that
  the subprocess exits 0 — it does NOT test that
  `hasExplicitHumanSelection` actually returns true for the real Devin
  response shape.
- **Fix direction:** Either (a) log the raw `tool_response` from a
  live Devin ask_user_question PostToolUse to discover the actual
  response shape, then update `hasExplicitHumanSelection` to handle
  it; or (b) make the PostToolUse arm less strict — if
  `normalizeToolResponse` successfully extracts output, mint the
  HUMAN_TURN and call `recordPlanApprovalHumanResponse` regardless of
  whether the selection shape matches the strict
  `{answers: {questionId: {answers: [...]}}}` format. The strict
  check was meant to distinguish "user clicked an option" from "user
  typed Other", but it's rejecting ALL responses.

**Bug B — `plan-approval-guard` blocks framework hook scripts**
- Symptom: `bun .devin/hooks/aidlc-devin-adapter.ts record-human-turn`
  blocked by the guard during code-generation post-fingerprinting.
- Root cause: `isFrameworkToolInvocation()` in
  `aidlc-plan-approval-guard.ts` (line 464) only exempts scripts under
  `.devin/tools/` (the `trustedToolsDir`), NOT scripts under
  `.devin/hooks/`. The `trustedToolsDir` is computed as
  `resolve(projectLexical, harnessDir(), "tools")` — it should also
  exempt `.devin/hooks/aidlc-*.ts` (the framework hook scripts).
- Also: `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` prefix didn't work
  (15:29:42 attempt still blocked). The guard reads
  `process.env.AIDLC_DISABLE_PLAN_APPROVAL_GUARD` at line 629, but the
  env var set as a command prefix may not be visible to the hook's
  `process.env` if the guard runs in a different process context —
  needs investigation.
- Fix: extend `isFrameworkToolInvocation()` to also exempt
  `.devin/hooks/aidlc-*.ts` (or add a separate
  `isFrameworkHookInvocation()` check). The hook scripts are
  framework-owned, not user mutations, and should never be blocked by
  the guard.

**Bug C — `aidlc-log answer` refuses without a response file (downstream of Bug A)**
- Symptom: `aidlc-log answer --checkpoint plan-approval --session
  horn-medallion --details "Approve Plan"` refused with "Plan Approval
  requires the actual offered choice from this prompt and session".
- Root cause: `recordPlanApprovalReceipt()` in
  `aidlc-testing-posture.ts` (line 1472) reads both the challenge and
  response files; the challenge exists but the response doesn't (Bug A
  prevented it). The `challenge.challengeId !== response.challengeId`
  match fails.
- This is **downstream of Bug A** — fixing Bug A (so the PostToolUse
  arm records the response) will fix Bug C automatically. If Bug A
  can't be fixed easily, an alternative is a manual response-file
  writer, but that's a workaround, not a fix.

### Conductor-side findings (not bugs, just fumbles)

- Conductor asked "what to build" instead of acting on the `print`
  directive (12:03).
- Conductor called `aidlc-log answer` before the human replied (2
  "no new human reply" errors at 15:06:15/31).
- Conductor tried `aidlc-log --help` and `aidlc-utility --help` with
  wrong syntax (2 errors).
- Conductor tried `aidlc-log review` on a 0-review stage (1 error).
- Conductor `edit` failed: non-unique `old_string` (4 occurrences).
- Conductor tried `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1` env prefix to
  bypass the guard — didn't work (Bug B).

### 12:37 — [FINDING — Bug D] Active directive is `load-steering`, not `run-stage` — guard rejects all mutations
New error from the conductor's `cat` command (a READ, not even a
mutation):
```
Tool rejected: Code generation cannot start because its Plan Approval
authority is ambiguous or stale. workspace mutation cannot select one
approval target from directive kind "load-steering". Run a fresh
`aidlc-orchestrate.ts next` and use that exact directive; no stage-level
fallback is permitted.
```

The active directive (`.aidlc-active-directive.json`) now has
`"kind": "load-steering"` (revision 5, was `run-stage` at revision 4).
The `plan-approval-guard` only accepts `run-stage` or `invoke-swarm`
directives for code-generation approval authority — a `load-steering`
directive is stale/ambiguous, so the guard rejects EVERY mutation
(including reads via Bash now).

**What happened:** the conductor re-ran `next` at some point between
15:30 and 15:37, and the engine returned a `load-steering` directive
(the steering-token re-entry path — the conductor was trying to
re-enter the stage after the deadlock). This replaced the `run-stage`
directive in the active-directive slot. Now the guard sees a
`load-steering` directive and rejects everything because it can't
select an approval target from a non-`run-stage` directive.

This is a **new failure mode** — the conductor's attempt to unblock
itself by re-running `next` made things worse by replacing the
approval-bearing `run-stage` directive with a `load-steering` one.

### 12:37 — New HUMAN_TURN at 15:37:37 (but still no plan approval response)
A 7th `HUMAN_TURN` appeared at 15:37:37 UTC — but this is from the
operator typing in the session (trying to unblock), NOT from the
PostToolUse arm recording a plan approval. The `response-horn-medallion.json`
file is still absent. Bug A is still in effect.

### 12:37 — [FINDING — Bug C variant] New error message: "approval authority requires a run-stage or invoke-swarm directive, got 'load-steering'"
At 15:37:41, `aidlc-log answer` was tried again and refused with a
DIFFERENT error than before:
```
Code Generation approval authority requires a run-stage or invoke-swarm
directive, got "load-steering"
```
This is a variant of Bug C — now the refusal is at the directive-kind
check (upstream of the challenge/response match), because the active
directive is `load-steering` (Bug D). The plan approval flow is now
doubly blocked: wrong directive kind (Bug D) AND no response file
(Bug A/C).

### 12:40 — PLAN_APPROVAL_BLOCKED now 14 (run 2 had 12)
```
14 PLAN_APPROVAL_BLOCKED   <- run-2 had 12; run-3 has 14 and counting
9 ERROR_LOGGED             <- 2 no-new-human-reply + 2 aidlc-log --help + 1 review + 1 utility --help + 2 plan-approval-refused + 1 load-steering-refused
7 HUMAN_TURN               <- 6 from regular gates + 1 from operator typing (still 0 from plan approval arm)
0 PLAN_APPROVAL_RECORDED   <- same as run 2
0 SUBAGENT_COMPLETED       <- same as runs 1 and 2
```

The deadlock is now worse than run 2's: the conductor's self-recovery
attempts (re-running `next`, trying env-var bypass, manual
record-human-turn) have corrupted the directive state. The session
cannot recover without either fixing the bugs or manually resetting
the active directive to a fresh `run-stage`.

### Recommendation: stop the session
The run has found its bugs. Continuing will only produce more
`PLAN_APPROVAL_BLOCKED` events and potentially further corrupt the
directive state. The operator should `/exit` the session. The audit
trail and state are preserved on disk for bug investigation.

### 12:42 — [SURPRISE] 2 SUBAGENT_COMPLETED events fired!
Two `SUBAGENT_COMPLETED` audit events appeared:
- 15:42:07 UTC — `Agent Type: unknown`
- 15:44:17 UTC — `Agent Type: unknown`

The `log-subagent` PostToolUse hook fired (its heartbeat
`log-subagent.last` is at 12:44). This means the conductor DID dispatch
`run_subagent` at least twice during its deadlock recovery attempts —
likely trying to dispatch a subagent to work around the blocked
mutations. The `Agent Type: unknown` suggests the conductor did NOT
pass the agent slug as the `profile` field (the adapter and
`deliver-stage-rules` hook match on `tool_input.profile`), so the
agent type wasn't captured.

**However:** `deliver-stage-rules` did NOT fire — there is no
`deliver-stage-rules.last` in the hooks-health dir. This is consistent
with the `profile` field being absent: the `deliver-stage-rules` hook
matches on `run_subagent` but the adapter may not forward the call if
the `profile` field is missing, or the hook fired but skipped. The
`log-subagent` hook fired (it just logs completion), but
`deliver-stage-rules` (which delivers stage rules to the subagent
brief) did not.

**Net:** `SUBAGENT_COMPLETED: 2` (runs 1 and 2 had 0). This is a
partial verification of the `log-subagent` hook. But the dispatches
were the conductor's failed recovery attempts, NOT the intended
developer-agent dispatch for code-generation (which requires plan
approval first). The `deliver-stage-rules` hook remains NOT TESTED
(no heartbeat file).

### 12:44 — New error variant: fingerprint mismatch
At 15:44:02, `aidlc-log answer` refused with a THIRD variant:
```
Plan Approval fingerprint does not match the active intent, target,
directive epoch, plan, instructions, and Testing Contract
```
This is yet another refusal reason — the fingerprint check now fails,
likely because the active directive changed (Bug D: `load-steering`)
and the fingerprint no longer matches the original `run-stage`
directive's fingerprint. The plan approval flow is now triply blocked
(Bug A: no response, Bug D: wrong directive kind, fingerprint mismatch).

### 12:45 — Session exited cleanly
`SESSION_ENDED` at 15:45:17 UTC, reason `prompt_input_exit`. The
SessionEnd hook fired (`session-end.last` at 12:45). Clean exit.

### 12:45 — `continue-workflow` hook dropped 3 times
The `continue-workflow.drops` file shows 3 drops at 15:37:15, 15:42:06,
and 15:44:17, all with: "current stage code-generation has an
unanswered logged decision; allowing the stop (pending-decision
carve-out)". The Stop hook's `continue-workflow` target correctly
allowed the stop because there was an unanswered logged decision (the
plan approval). This is the hook working as intended — not a bug.

## Final audit trail distribution
```
23 PLAN_APPROVAL_BLOCKED   <- run 1: 15, run 2: 12, run 3: 23 (worst)
11 ERROR_LOGGED            <- run 2: 8+ (all "no new human reply"); run 3: 2 of those + 9 other
10 ARTIFACT_UPDATED
 7 HUMAN_TURN              <- run 1: 2, run 2: 5, run 3: 7 — ALL from UserPromptSubmit, 0 from PostToolUse arm
 6 STAGE_STARTED
 5 DECISION_RECORDED
 5 ARTIFACT_CREATED
 4 STAGE_COMPLETED
 4 SENSOR_PASSED
 4 SENSOR_FIRED
 3 QUESTION_ANSWERED
 2 SUBAGENT_COMPLETED      <- run 1: 0, run 2: 0, run 3: 2 (conductor recovery attempts, not intended dispatch)
 1 SUMMARY_CONFIRMATION_RECORDED
 1 STAGE_AWAITING_APPROVAL
 1 SESSION_ENDED           <- clean exit
 1 SESSION_COMPACTED
 1 GATE_APPROVED           <- requirements-analysis gate only
 0 PLAN_APPROVAL_RECORDED  <- run 1: 1 (hack), run 2: 0, run 3: 0
 0 STAGE_SKIPPED           <- never reached operation phase
 0 WORKFLOW_COMPLETED      <- never completed
 0 SESSION_STARTED         <- (not in audit; SessionStart hook fired but event may not be in shard)
```

## Hook coverage (final)

| Hook Event | Target | Run 1 | Run 2 | Run 3 |
|------------|--------|-------|-------|-------|
| SessionStart | session-start | PASS | PASS | PASS (heartbeat) |
| SessionEnd | session-end | PASS | PASS | PASS (SESSION_ENDED) |
| UserPromptSubmit | record-human-turn | PASS | PASS | PASS (HUMAN_TURN from typed prompts) |
| PreToolUse | state-transition-guard | PASS | PASS | PASS (heartbeat) |
| PreToolUse | reviewer-scope | PASS | PASS | PASS (heartbeat) |
| PreToolUse | review-freeze | PASS | PASS | PASS (heartbeat) |
| PreToolUse | plan-approval-guard | PASS (15 blocks) | PASS (12 blocks) | PASS (23 blocks) |
| PreToolUse | deliver-stage-rules | NOT TESTED | NOT TESTED | **NOT TESTED** (no heartbeat — conductor didn't pass `profile` field) |
| PreToolUse | fold-usage | PASS | PASS | PASS (assumed; no explicit counter) |
| PostToolUse | audit-and-sensors | PASS | PASS | PASS (ARTIFACT_* events) |
| PostToolUse | sync-workflow-state | PASS | PASS | PASS (state updates) |
| PostToolUse | log-subagent | NOT TESTED | NOT TESTED | **PASS** (2 SUBAGENT_COMPLETED, heartbeat at 12:44) |
| PostToolUse | record-human-turn | PARTIAL | **FAIL** | **FAIL** (arm NEVER fired — all 7 HUMAN_TURNs from UserPromptSubmit, 0 from PostToolUse; hasExplicitHumanSelection rejects all Devin response shapes) |
| PostToolUse | rebuild-stage-graph | PASS | PASS | PASS (assumed) |
| PostToolUse | fold-usage | PASS | PASS | PASS (assumed) |
| PostCompaction | validate-state | PASS | PASS | PASS (heartbeat at 12:26, SESSION_COMPACTED) |
| Stop | continue-workflow | PASS | PASS | PASS (3 drops, all correct carve-outs) |

**Run 3 hook coverage: 15/17** (run 1: 15/17, run 2: 14/17).
- `log-subagent`: **NEWLY VERIFIED** (2 SUBAGENT_COMPLETED events)
- `deliver-stage-rules`: **STILL NOT TESTED** (conductor didn't pass `profile` field)
- `record-human-turn` on `ask_user_question`: **FAIL** (arm NEVER fired — all 7 HUMAN_TURNs from UserPromptSubmit; hasExplicitHumanSelection rejects all Devin response shapes; the run-2 fix was necessary but not sufficient)

## Summary of run 3 outcomes

**Verified (the run-2 adapter fix works for regular questions):**
- `normalizeToolResponse()` correctly extracts `.output` from Devin's
  object-format `tool_response` — the extraction itself works.
- **BUT: the PostToolUse `record-human-turn` arm has NEVER fired
  successfully.** All 7 `HUMAN_TURN` events are from `UserPromptSubmit`
  (typed prompts), not from the PostToolUse arm. The arm skips because
  `hasExplicitHumanSelection()` returns false for the actual Devin
  response shape — `normalizeToolResponse` was necessary but not
  sufficient.
- The "no new human reply" adapter-bug symptom is reduced (2 remaining
  errors are conductor timing, not adapter skipping) — but this is
  because UserPromptSubmit HUMAN_TURNs satisfy the gate's presence
  check, NOT because the PostToolUse arm is working.

**New bugs found (the plan approval flow is separately broken):**
- **Bug A:** PostToolUse `record-human-turn` arm does NOT fire for plan
  approval `ask_user_question` — no `HUMAN_TURN` minted, no response
  file written. Root cause needs investigation (hypotheses in bug log).
- **Bug B:** `plan-approval-guard` blocks framework hook scripts
  (`isFrameworkToolInvocation` only exempts `.devin/tools/`, not
  `.devin/hooks/`).
- **Bug C:** `aidlc-log answer` refuses without a response file
  (downstream of Bug A).
- **Bug D:** Conductor's re-run of `next` replaced the `run-stage`
  directive with `load-steering`, making the guard reject all
  mutations (including reads).

**Hook coverage: 15/17** (run 1: 15/17, run 2: 14/17).
- `log-subagent` newly verified (2 SUBAGENT_COMPLETED).
- `deliver-stage-rules` still not tested.
- `record-human-turn` on `ask_user_question`: **FAIL** — arm never fired; all 7 HUMAN_TURNs from UserPromptSubmit; the run-2 fix was necessary but not sufficient.

**Run did NOT complete.** `WORKFLOW_COMPLETED: 0`, `STAGE_SKIPPED: 0`
(never reached operation phase), `PLAN_APPROVAL_RECORDED: 0`.

---

<!-- Append new events below this line. Newest at the bottom. -->
