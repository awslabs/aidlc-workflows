# End-to-End Live Run Plan — Devin CLI Harness (Third Run, Post-Fix Verification)

This is the **third** live end-to-end run of the Devin CLI harness. The
[first run](../first-run/devin-e2e-test-plan.md) drove `devin -p` (print mode)
and proved the deterministic plumbing (15/17 hooks verified). The
[second run](../second-run/devin-e2e-test-plan.md) drove `devin` interactively
and **found** the bug print mode could not expose: the
`record-human-turn` PostToolUse hook on `ask_user_question` skipped because
`hasExplicitHumanSelection()` in `aidlc-devin-adapter.ts` returned false for
Devin's object-format `tool_response` (`{success, output, error}`). That broke
all `ask_user_question` answer recording and BLOCKED the run at code-generation
plan approval — 12 `PLAN_APPROVAL_BLOCKED` events, 0 `PLAN_APPROVAL_RECORDED`,
14/17 hooks verified.

The bug is now fixed (commit `f51d55d3`,
`fix(devin,codex): normalize object-format tool_response so ask_user_question
answers record`). A `normalizeToolResponse()` helper extracts `output` from
the object form before the selection parsers run, and unit test `t332` case
`13a` asserts the **effect** — a `HUMAN_TURN` audit event lands, not just
exit 0. `bun scripts/package.ts --check` confirms `dist/devin` is in sync.

This third run is the **live verification** of that fix. The unit test proves
the subprocess shim; this run proves the end-to-end human-in-the-loop flow in
a real interactive Devin session. Same `express` scope, same prompt as runs 1
and 2 for direct audit-trail comparability.

## What this run targets (delta from run 2)

| Run 2 outcome | Root cause | Fix in place | This run's verification |
|---------------|------------|--------------|--------------------------|
| `record-human-turn` skipped on `ask_user_question` | `hasExplicitHumanSelection` rejected object-format `tool_response` | `normalizeToolResponse()` extracts `.output` (commit `f51d55d3`) | Every gate answer mints a `HUMAN_TURN` via the PostToolUse arm — no "no new human reply" errors |
| Plan approval BLOCKED (12 blocks, 0 recorded) | No human response → no receipt → guard blocks | Same fix unblocks the challenge/response/receipt triple | Genuine "Approve Plan" → `PLAN_APPROVAL_RECORDED: 1`, `PLAN_APPROVAL_BLOCKED: 0`, guard allows developer-agent dispatch |
| `deliver-stage-rules` + `log-subagent` NOT TESTED (2/17) | Workflow blocked before `run_subagent` could fire | Fix unblocks the path past plan approval | If the conductor dispatches `code-generation` via `run_subagent`, both hooks fire → `SUBAGENT_COMPLETED >= 1` |
| 14/17 hooks verified | 1 FAIL + 2 NOT TESTED | — | **Target: 17/17** |

## What this run still does NOT exercise (express scope trade-off)

Carried forward from run 2 — unchanged:

- **Ideation phase** — all 7 stages skipped (intent-capture → approval-handoff).
  `express` scope: requirements → code → test → deploy, no design/review pass.
- **Operation stages may conditional-skip again** — a greenfield API with no
  deployable target skips `deployment-pipeline`, `deployment-execution`, and
  `observability-setup` (CONDITIONAL — same as runs 1 and 2). If you want to
  force them, change the prompt to name a deployment target (e.g. "containerize
  and deploy to AWS"). The default prompt keeps parity with runs 1 and 2.

## Prerequisites

Same as runs 1 and 2 — confirm before starting. **One addition**: confirm the
fix is actually in the `dist/devin` tree you are about to copy, or the run will
reproduce the run-2 block.

| Item | Requirement | Check |
|------|-------------|-------|
| Adapter fix present | `normalizeToolResponse` defined in the shipped adapter | `grep -n 'function normalizeToolResponse' dist/devin/.devin/hooks/aidlc-devin-adapter.ts` -> must match (run 2's tree would NOT match) |
| dist in sync | `bun scripts/package.ts --check` clean | `bun scripts/package.ts --check` -> `package --check: all harness trees in sync` |
| Devin CLI | >= 3000.3.0 on PATH | `devin --version` -> must show `3000.3.0` or higher |
| bun | on PATH (non-interactive shells source `~/.zshenv`/`~/.bashrc`) | `which bun` -> must resolve |
| Model | set in `~/.config/devin/config.json` (user-level, NOT project) | `cat ~/.config/devin/config.json` -> must have a model entry |
| MCP servers (optional) | `CONTEXT7_API_KEY` for context7; AWS creds for the 4 AWS servers | Skip if unavailable — they never block a workflow |

## Phase 0 — Install & Doctor (5 minutes)

**Goal:** confirm the shipped tree carries the fix and is intact in a FRESH
project (do not reuse `~/devin-e2e-test-2` from run 2 — its state and audit
trail would contaminate this run).

1. **Verify the fix is in the dist tree (pre-flight, in the source repo):**
   ```bash
   cd /home/wiley/sources/aidlc-workflows
   bun scripts/package.ts --check   # must be clean
   grep -n 'function normalizeToolResponse' dist/devin/.devin/hooks/aidlc-devin-adapter.ts
   # must match line ~131. If it does NOT match, stop — re-run
   # `bun scripts/package.ts` and re-check before proceeding.
   ```

2. **Copy the distribution into a fresh git project:**
   ```bash
   mkdir ~/devin-e2e-test-3 && cd ~/devin-e2e-test-3
   git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
   cp -r /home/wiley/sources/aidlc-workflows/dist/devin/.devin .devin
   cp -r /home/wiley/sources/aidlc-workflows/dist/devin/aidlc aidlc
   cp /home/wiley/sources/aidlc-workflows/dist/devin/AGENTS.md AGENTS.md
   cp /home/wiley/sources/aidlc-workflows/dist/devin/.gitignore .gitignore
   git add -A && git -c user.email=t@t -c user.name=t commit -qm "install aidlc devin shell (post-fix)"
   ```

3. **Confirm the fix landed in the copied tree:**
   ```bash
   grep -n 'function normalizeToolResponse' ~/devin-e2e-test-3/.devin/hooks/aidlc-devin-adapter.ts
   # must match. This is the single most important pre-flight check —
   # a missing match means you copied a stale tree and will reproduce run 2.
   ```

4. **Run the doctor:**
   ```bash
   bun .devin/tools/aidlc-utility.ts doctor
   ```
   Save the output to `evidence/devin-e2e-run/third-run/00-doctor-output.txt`.

   **Checkpoint 0a — Doctor output must include these rows (all pass):**
   - `pass  bun installed`
   - `pass  aidlc-devin-adapter.ts present`
   - `pass  hooks.v1.json present (hook wiring)`
   - `pass  config.json present (permissions + read_config_from)`
   - `pass  mcp_config.json present (MCP servers)`
   - `pass  rules/aidlc.md present (standing method rule)`
   - `pass  devin CLI version <X.Y.Z> >= 3000.3.0`
   - **Must NOT include:** `settings.json present` (the Claude fallback — if
     you see this, the harness dir wasn't detected as `.devin`)

   **Checkpoint 0b — Doctor exit code:** must be 0 (all passed).

5. **Hook approval (Devin CLI v3000.6.7+):** Hooks fire automatically from
   `.devin/hooks.v1.json` without a `/hooks` approval step on this CLI version
   — workspace trust is the gate (confirmed in runs 1 and 2). Let the normal
   trust prompt appear and approve it once. Do NOT pass
   `--respect-workspace-trust false` for this interactive run.

## Phase 1 — Cold Start & Initialization (10-15 minutes)

**Goal:** verify SessionStart fires, the orchestrator skill loads, and the
initialization phase (3 stages) runs. Expected to PASS as in runs 1 and 2 —
this phase is unaffected by the adapter fix.

6. **Start a fresh INTERACTIVE Devin session in the project:**
   ```bash
   cd ~/devin-e2e-test-3
   devin
   ```
   Do NOT use `devin -p` (print mode) — that is the run-1 limitation. You must
   be at the keyboard to answer gates.

7. **Invoke the orchestrator with the same prompt as runs 1 and 2:**
   ```
   /aidlc express "build a REST API for a todo app with CRUD endpoints"
   ```
   Using `/aidlc express` bakes the express scope in directly — no scope
   detection. Same prompt as runs 1 and 2 for direct audit-trail comparability.

   **Checkpoint 1a — SessionStart hook fired:** Look for the welcome message
   containing "AIDLC WORKFLOW ACTIVE" (or the no-state version on the very
   first turn). If you see NO welcome message, the SessionStart hook didn't
   fire — check workspace trust (Phase 0 step 5).

   **Checkpoint 1b — Skill discovery:** The conductor discovers
   `.devin/skills/aidlc/SKILL.md` and begins the orchestration loop. The first
   engine call is `bun .devin/tools/aidlc-orchestrate.ts next`.

   **Checkpoint 1c — Initialization stages run (3 stages):**
   - `workspace-scaffold` — creates the `aidlc/spaces/default/` shell
   - `workspace-detection` — detects the workspace root
   - `state-init` — creates the initial workflow state

   **Verify on disk (run in a separate terminal, NOT in the Devin session):**
   ```bash
   cd ~/devin-e2e-test-3
   ls aidlc/spaces/default/intents/  # should show the new intent dir
   cat aidlc/spaces/default/intents/active-intent  # should show the intent slug-id
   ls aidlc/spaces/default/intents/<slug>-<id8>/  # should show aidlc-state.md + audit/
   ```

   **Checkpoint 1d — Audit trail started:**
   ```bash
   ls aidlc/spaces/default/intents/<slug>-<id8>/audit/
   # should show at least one shard: <hostname>-<cloneid>.md
   ```
   Read the shard — it should contain `SESSION_STARTED` and `STAGE_STARTED` /
   `STAGE_COMPLETED` events for the 3 initialization stages.

   **Checkpoint 1e — UserPromptSubmit hook fired:** The `record-human-turn`
   target should have recorded a `HUMAN_TURN` audit event from the typed
   `/aidlc express ...` prompt. Grep the audit shard for `HUMAN_TURN` — at
   least one entry should be present.

## Phase 2 — Inception: requirements-analysis (15-25 minutes)

**Goal:** verify the first gated stage runs, the `ask` directive renders via
`ask_user_question` (closed in run 2), AND — the run-3 delta — that the
answer is now **recorded** as a `HUMAN_TURN` by the PostToolUse arm (the
run-2 FAIL).

8. **The conductor advances to `requirements-analysis` (first inception stage
   in express scope — ideation is skipped).**

   **Checkpoint 2a — `run-stage` directive:** The conductor receives a
   `run-stage` directive from `next`. Before running the stage body, it reads
   the `inline_context_paths` (the blocking context-load precondition). You
   should see file reads for the stage file + consumed artifacts.

   **Checkpoint 2b — PreToolUse guards fired:** When the conductor makes its
   first tool call, the PreToolUse hooks fire:
   - `state-transition-guard` — checks for direct state mutations
   - `reviewer-scope` — checks read scope
   - `review-freeze` — checks if a review is in progress
   - `plan-approval-guard` — no-op outside code-generation
   - `fold-usage` — folds token usage

   For a normal read, all guards allow (exit 0).

   **Checkpoint 2c — `ask` directive renders via `ask_user_question`:** When
   the stage has a structured question (the `gate: true` path), the conductor
   receives an `ask` directive and MUST render it via the `ask_user_question`
   tool — NOT echo the `question` fence as text. You should see a **native
   Devin question prompt with clickable options**. (Closed in run 2; re-verify
   it did not regress.)

   **Checkpoint 2d — PostToolUse hooks fired after artifact writes:** When
   the conductor writes an artifact (e.g. the requirements document):
   - `audit-and-sensors` fires on `edit`/`write`/`apply_patch` — the audit
     trail gains an `ARTIFACT_CREATED` or `ARTIFACT_UPDATED` row
   - `sync-workflow-state` fires on `todo_write` — the workflow state updates
   - `rebuild-stage-graph` fires on `exec` — the stage graph refreshes

   **Verify on disk:**
   ```bash
   grep -c 'ARTIFACT_' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Should be > 0
   ```

   **Checkpoint 2e — Gate approval via the REAL prompt (THE RUN-3 DELTA):**
   After the stage body completes, the conductor presents the gate. **You
   approve by clicking/selecting an option in the native `ask_user_question`
   prompt** — do NOT type `bun .devin/tools/aidlc-orchestrate.ts report
   --result completed` yourself. The conductor calls `report --result
   completed --user-input "<your approval>"` on your behalf.

   **The run-3 verification:** with the fix in place, the PostToolUse
   `record-human-turn` arm on `ask_user_question` must NOT skip. The audit
   trail gains a `GATE_APPROVED` event AND a `HUMAN_TURN` event minted by the
   PostToolUse arm itself (not just the UserPromptSubmit arm). Run 2 saw the
   PostToolUse arm skip and 8 `ERROR_LOGGED` "no new human reply" events; run
   3 must see **zero** such errors.

   **Verify (the key delta metric for this phase):**
   ```bash
   grep -c 'HUMAN_TURN' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Run 2: 1 (from the typed workaround prompt, NOT the ask_user_question arm).
   # Run 3: expected >= 2 — one from UserPromptSubmit (the /aidlc prompt) AND
   #         one from the ask_user_question PostToolUse arm (the fix).

   grep -c 'no new human reply' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Run 2: 8. Run 3: expected 0.
   ```

## Phase 3 — Construction: code-generation + build-and-test (30-50 minutes)

**Goal:** verify the plan-approval challenge/response/receipt triple works
GENUINELY (the run-2 BLOCK), and that subagent dispatch fires the two hooks
that have been unverified across runs 1 and 2.

9. **The conductor advances to `code-generation`.** This is the stage that
   BLOCKED run 2. This run is the headline verification of the fix.

   **Checkpoint 3a — Plan written before generation:** The conductor writes
   `code-generation-plan.md` and `unit-test-instructions.md`, refreshes the
   Testing Contract and approval fingerprint, then presents the Plan Approval
   question via `ask_user_question`. You should see the plan content rendered
   in the conductor's output BEFORE the approval prompt appears.

   **Checkpoint 3b — Genuine "Approve Plan" answer (THE RUN-2 BLOCK, NOW
   UNBLOCKED):** You answer "Approve Plan" in the real `ask_user_question`
   prompt. With the fix:
   - The PostToolUse `record-human-turn` arm recognizes the object-format
     `tool_response`, extracts `.output`, and calls
     `recordPlanApprovalHumanResponse()` → a `HUMAN_TURN` is minted.
   - `recordPlanApprovalReceipt()` writes the receipt (the
     challenge↔response match now succeeds).
   - The `plan-approval-guard` hook
     (<ref_file file="/home/wiley/sources/aidlc-workflows/dist/devin/.devin/hooks/aidlc-plan-approval-guard.ts" />)
     checks all 6 evidence pieces (plan, instructions, approved, contract,
     fingerprint, receipt) → all current → **allows** the developer-agent
     dispatch with **zero `PLAN_APPROVAL_BLOCKED` events**.

   **Verify (the headline delta metric vs run 2):**
   ```bash
   grep -c 'PLAN_APPROVAL_BLOCKED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Run 1: 15 (print mode, manual hack). Run 2: 12 (genuine approval, blocked).
   # Run 3: expected 0 (genuine approval, fix in place).

   grep -c 'PLAN_APPROVAL_RECORDED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Run 1: 1 (manual file hack). Run 2: 0 (could not record). Run 3: expected 1 (genuine).
   ```

   **Checkpoint 3c — Subagent dispatch fires (THE RUNS-1-AND-2 GAP):** With
   the gate unblocked, the conductor can now dispatch the developer agent via
   `run_subagent` (the stage's `mode: subagent`). Two hooks fire that were
   unverified in both prior runs:
   - PreToolUse `deliver-stage-rules` (matcher: `run_subagent`) — delivers the
     active stage rules to the subagent brief
   - PostToolUse `log-subagent` (matcher: `run_subagent`) — writes a
     `SUBAGENT_COMPLETED` audit event

   **Verify:**
   ```bash
   grep -c 'SUBAGENT_COMPLETED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Run 1: 0 (print mode, inline). Run 2: 0 (blocked before dispatch).
   # Run 3: expected >= 1 if the conductor dispatches run_subagent.
   ```

   If the conductor still runs inline (no `run_subagent` call), record this as
   a finding — it is a conductor-side choice, not a print-mode or adapter
   limitation. The two hooks remain unverified in that case, and the run is
   not a 17/17 PASS regardless of the adapter fix.

   **Checkpoint 3d — Code generated + tests pass:** Application code is
   written to the workspace root, tests run, and the stage completes with a
   gate. Approve the gate via the real `ask_user_question` prompt
   (Checkpoint 2e pattern — the PostToolUse arm must mint a `HUMAN_TURN`
   here too).

10. **The conductor advances to `build-and-test`.** Same pattern: stage body
    → gate → real approval → `report`. The PostToolUse `record-human-turn`
    arm must mint a `HUMAN_TURN` for this gate answer as well.

    **Checkpoint 3e — `todo_write` → `sync-workflow-state`:** During
    construction, the conductor uses `todo_write` to track progress. Each
    `todo_write` PostToolUse fires `sync-workflow-state`, which updates
    `aidlc-state.md`.

    **Verify:**
    ```bash
    cat aidlc/spaces/default/intents/<slug>-<id8>/aidlc-state.md
    # Should show Current Stage, progress, iteration count
    ```

## Phase 4 — Operation & Completion (10-20 minutes)

**Goal:** verify the final stages run (or conditional-skip cleanly), the
workflow completes, and the session-end hooks fire. Run 2 never reached this
phase; run 1 did, so this is a return-to-parity check.

11. **Operation stages** (`deployment-pipeline`, `deployment-execution`,
    `observability-setup`).

    **Checkpoint 4a — Conditional skips are clean:** With a greenfield API and
    no deployable target, these stages should `STAGE_SKIPPED` with a
    `CONDITIONAL` reason (same as run 1). If you want them to run, restart
    with a prompt that names a deployment target.

    **Verify:**
    ```bash
    grep -c 'STAGE_COMPLETED\|STAGE_SKIPPED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
    # Should account for all express-scope stages (9 EXECUTE: 3 init +
    # requirements-analysis + code-generation + build-and-test + 3 operation
    # conditional skips)
    ```

12. **Workflow completion:** The engine returns a `done` directive. The
    conductor presents the completion summary and STOPS.

    **Checkpoint 4b — `done` directive:** The conductor prints the completion
    summary and stops the loop. No more `next` calls. A `WORKFLOW_COMPLETED`
    audit event is written (run 2: 0; run 1: 1).

    **Checkpoint 4c — SessionEnd hook fires:** When you exit the Devin session
    (`/exit` or quit), the SessionEnd hook fires `session-end`, which writes a
    `SESSION_ENDED` audit event. (Run 2's session exited cleanly at the user's
    stop request but mid-stage; run 3 should exit cleanly AFTER completion.)

    **Verify:**
    ```bash
    grep 'SESSION_ENDED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
    ```

## Phase 5 — Post-Run Verification (5 minutes)

**Goal:** verify the full audit trail, the session-cost skill, the replay
skill, and the outcomes pack. Run these in a separate terminal (NOT in the
Devin session, which has exited). Run 2 could not complete this phase
(workflow incomplete); run 1 did, so this is a return-to-parity check.

13. **Session cost:**
    ```bash
    cd ~/devin-e2e-test-3
    bun .devin/tools/aidlc-runtime.ts summary --json
    ```
    Save to `evidence/devin-e2e-run/third-run/05-session-cost.json`.
    Should show: total duration, stage count, phase rollup, memory entries,
    sensor firings, learnings.

14. **Replay** (start a fresh `devin` session in the project, then):
    ```
    /aidlc-replay
    ```
    Save the output to `evidence/devin-e2e-run/third-run/05-replay.txt`.
    Should print a structured session narrative (phase rollup, stage
    outcomes, duration).

15. **Outcomes pack:**
    ```
    /aidlc-outcomes-pack
    ```
    Save the output to `evidence/devin-e2e-run/third-run/05-outcomes-pack-output.txt`
    and copy the generated `OUTCOMES.md` to
    `evidence/devin-e2e-run/third-run/05-outcomes.md`.
    Should write `OUTCOMES.md` at the project root.

16. **Full audit trail integrity:**
    ```bash
    grep -oE 'ARTIFACT_CREATED|ARTIFACT_UPDATED|STAGE_STARTED|STAGE_COMPLETED|STAGE_AWAITING_APPROVAL|GATE_APPROVED|GATE_REJECTED|HUMAN_TURN|SUBAGENT_COMPLETED|PLAN_APPROVAL_BLOCKED|PLAN_APPROVAL_RECORDED|SESSION_STARTED|SESSION_ENDED|SESSION_COMPACTED|LEARNING|WORKFLOW_COMPLETED' \
      aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md | sort | uniq -c | sort -rn
    ```
    Save to `evidence/devin-e2e-run/third-run/05-audit-trail-distribution.txt`.

    **Expected distribution (delta from runs 1 and 2 highlighted):**
    - `SESSION_STARTED`: >= 1
    - `STAGE_STARTED` + `STAGE_COMPLETED`: 6 each (3 init + 3 inception/construction)
    - `STAGE_SKIPPED`: 3 (operation conditional)
    - `GATE_APPROVED`: 3 (one per gated stage — via real `ask_user_question`)
    - `HUMAN_TURN`: **>= 5** — one UserPromptSubmit + one PostToolUse arm per
      gate answer (3 gates) + one for plan approval. Run 1: 2; run 2: 5 (but
      from typed workarounds, not the PostToolUse arm); **run 3: from the
      PostToolUse arm itself — the fix proven end-to-end**.
    - `ARTIFACT_CREATED` / `ARTIFACT_UPDATED`: many
    - `PLAN_APPROVAL_BLOCKED`: **expected 0** (run 1: 15, run 2: 12) — the
      headline delta
    - `PLAN_APPROVAL_RECORDED`: **1 (genuine human approval)** (run 1: 1 via
      manual hack, run 2: 0)
    - `SUBAGENT_COMPLETED`: **>= 1 if dispatch fires** (runs 1 and 2: 0) — the
      other headline delta
    - `WORKFLOW_COMPLETED`: 1 (run 1: 1, run 2: 0)
    - `SESSION_ENDED`: >= 1
    - `ERROR_LOGGED` with "no new human reply": **expected 0** (run 2: 8) —
      the adapter-fix symptom

## Phase 6 — Hook Coverage Checklist

**Goal:** confirm every wired hook target fired. The target is **17/17**
(run 1: 15/17, run 2: 14/17). This run closes the run-2 FAIL
(`record-human-turn` on `ask_user_question`) and the runs-1-and-2 NOT TESTED
pair (`deliver-stage-rules`, `log-subagent`).

| Hook Event | Target | Matcher | How to verify | Run 1 | Run 2 | Run 3 target |
|------------|--------|---------|---------------|-------|-------|--------------|
| SessionStart | session-start | -- | `SESSION_STARTED` in audit | PASS | PASS | PASS |
| SessionEnd | session-end | -- | `SESSION_ENDED` in audit | PASS | PASS | PASS |
| UserPromptSubmit | record-human-turn | -- | `HUMAN_TURN` in audit | PASS | PASS | PASS |
| PreToolUse | state-transition-guard | -- | No direct state mutations | PASS | PASS | PASS |
| PreToolUse | reviewer-scope | -- | Reviewer read-scope enforced | PASS | PASS | PASS |
| PreToolUse | review-freeze | -- | No writes during review | PASS | PASS | PASS |
| PreToolUse | plan-approval-guard | -- | **Zero blocks after genuine approval** | PASS (15 blocks) | PASS (12 blocks) | **PASS (0 blocks)** |
| PreToolUse | deliver-stage-rules | run_subagent | Subagent received stage rules | NOT TESTED | NOT TESTED | **PASS** |
| PreToolUse | fold-usage | -- | Token usage folded | PASS | PASS | PASS |
| PostToolUse | audit-and-sensors | edit\|write\|apply_patch | `ARTIFACT_*` events | PASS | PASS | PASS |
| PostToolUse | sync-workflow-state | todo_write | State updated after `todo_write` | PASS | PASS | PASS |
| PostToolUse | log-subagent | run_subagent | `SUBAGENT_COMPLETED` in audit | NOT TESTED | NOT TESTED | **PASS** |
| PostToolUse | record-human-turn | ask_user_question | `HUMAN_TURN` after each gate answer | PARTIAL | **FAIL** | **PASS** |
| PostToolUse | rebuild-stage-graph | exec | Stage graph refreshed | PASS | PASS | PASS |
| PostToolUse | fold-usage | -- | Token usage folded | PASS | PASS | PASS |
| PostCompaction | validate-state | -- | State validated after compaction | PASS | PASS | PASS |
| Stop | continue-workflow | -- | Continuation prompt when work remains | PASS | PASS | PASS |

Save the completed checklist to
`evidence/devin-e2e-run/third-run/06-hook-coverage.txt`.

## Phase 7 — Failure Mode Checklist

Same diagnostics as runs 1 and 2, plus the run-3-specific regression check:

| Symptom | Likely Cause | Diagnostic |
|---------|-------------|------------|
| `PLAN_APPROVAL_BLOCKED` after genuine approval (run-2 symptom recurs) | The fix is NOT in the copied tree | `grep -n 'function normalizeToolResponse' ~/devin-e2e-test-3/.devin/hooks/aidlc-devin-adapter.ts` — must match. If not, you copied a stale `dist/devin`; re-run Phase 0 step 1-3. |
| `no new human reply` errors on `ask_user_question` answers (run-2 symptom recurs) | Same — fix missing | Same diagnostic. Also confirm `bun scripts/package.ts --check` is clean in the source repo. |
| No welcome message on session start | Hooks not approved / workspace not trusted | Approve workspace trust prompt; on older CLI, run `/hooks` and approve all, fully restart |
| Question fence echoed as text (not native prompt) | Conductor didn't use `ask_user_question` | Check `question-rendering.md` is present at `.devin/skills/aidlc/question-rendering.md`; check the adapter translates the `ask` directive |
| No `SUBAGENT_COMPLETED` | Conductor ran `code-generation` inline (not via `run_subagent`) | Now a genuine conductor-side choice (not a block) — record as a finding; the two `run_subagent`-matcher hooks remain unverified and 17/17 is not reachable |
| No `ARTIFACT_*` in audit | `audit-and-sensors` hook didn't fire | Check the adapter translated the tool name (`edit`->`Edit`, `write`->`Write`) |
| Workflow doesn't advance past gate | `report` not called after approval | The conductor should call `report --result completed` after your `ask_user_question` answer; if it doesn't, the adapter isn't wiring the answer through |
| `continue-workflow` doesn't block | No active workflow state | Check `aidlc-state.md` exists and `Current Stage` is set |

## Quick-Start (if you just want to run it)

```bash
# 0. Pre-flight (in the source repo) — confirm the fix is shipped
cd /home/wiley/sources/aidlc-workflows
bun scripts/package.ts --check
grep -n 'function normalizeToolResponse' dist/devin/.devin/hooks/aidlc-devin-adapter.ts  # must match

# 1. Setup (FRESH project — do not reuse ~/devin-e2e-test-2 from run 2)
mkdir ~/devin-e2e-test-3 && cd ~/devin-e2e-test-3
git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
cp -r /home/wiley/sources/aidlc-workflows/dist/devin/{.devin,aidlc,AGENTS.md,.gitignore} .
git add -A && git -c user.email=t@t -c user.name=t commit -qm "install aidlc (post-fix)"

# 2. Confirm the fix landed in the copied tree (THE critical pre-flight)
grep -n 'function normalizeToolResponse' .devin/hooks/aidlc-devin-adapter.ts  # must match

# 3. Doctor
bun .devin/tools/aidlc-utility.ts doctor

# 4. Start INTERACTIVE Devin (NOT print mode)
devin

# 5. Run the workflow (same prompt as runs 1 and 2)
/aidlc express "build a REST API for a todo app with CRUD endpoints"

# 6. At every gate: approve via the real ask_user_question prompt
#    At code-generation plan approval: answer "Approve Plan" genuinely
#    Do NOT type `report --result completed` yourself
#    With the fix, the PostToolUse arm now records each answer — no "no new
#    human reply" errors, no PLAN_APPROVAL_BLOCKED loop.

# 7. After completion, verify (in a separate terminal)
cd ~/devin-e2e-test-3
bun .devin/tools/aidlc-runtime.ts summary --json
# then in a fresh devin session:
/aidlc-replay
/aidlc-outcomes-pack
```

The full interactive run (express scope, 9 stages, 3 conditional skips) takes
approximately 40-60 minutes with a fast model — comparable to run 2's
estimated 40-60 minutes, but this run should actually COMPLETE rather than
block at code-generation.

## Optional: Background Monitor

Run 2 introduced a polling monitor (`poll-run2.sh`) that sampled the audit
trail every 45 seconds and logged milestone detections. Replicate it for run
3 to produce a `monitoring-log.txt` alongside the audit shard — useful for
correlating when each `HUMAN_TURN` (PostToolUse arm) and the
`PLAN_APPROVAL_RECORDED` event landed relative to wall-clock time. Adapt
`poll-run2.sh`:

- change `EVIDENCE_DIR` to `.../third-run`
- change `STATE_FILE` to the run-3 intent path
- add a milestone for `PLAN_APPROVAL_RECORDED` (run 2 tracked it but never saw
  it; run 3 expects to)
- keep the milestone for `SUBAGENT_COMPLETED` (runs 1 and 2 never saw it; run
  3 expects to)

Save as `evidence/devin-e2e-run/third-run/poll-run3.sh` and launch it in a
separate terminal before step 7 (`/aidlc express ...`).

## Recording Evidence

Capture under `evidence/devin-e2e-run/third-run/` (this directory),
following the convention established by `first-run/`, `second-run/`, and
`evidence/p3-kiro-routing/`. The directory contains:

- the raw captured artifacts (doctor output, workflow output, audit trail,
  outcomes pack, hook coverage, runtime graph, generated stage artifacts);
- a `SUMMARY.md` narrating the run phase by phase, with explicit callouts of
  the deltas from run 2 (`PLAN_APPROVAL_BLOCKED` 12→0,
  `PLAN_APPROVAL_RECORDED` 0→1, `SUBAGENT_COMPLETED` 0→>=1, `HUMAN_TURN`
  PostToolUse arm now firing, "no new human reply" errors 8→0, hook coverage
  14/17→17/17);
- a `README.md` recording the run environment and a SHA-256 manifest of
  every artifact (computed with
  `find . -type f ! -name README.md | sort | xargs sha256sum`).

Update the campaign table in
`evidence/devin-e2e-run/README.md` when this run lands.
