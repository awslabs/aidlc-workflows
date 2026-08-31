# End-to-End Live Run Plan — Devin CLI Harness (Second Run, Interactive)

This is the **second** live end-to-end run of the Devin CLI harness. The
[first run](../first-run/devin-e2e-test-plan.md) was driven in `devin -p`
print mode and proved the deterministic plumbing (hooks fire, audit writes,
state advances, code generates, tests pass, sensors run) but could not
exercise the interactive, human-in-the-loop surfaces that are the actual
product:

- `ask_user_question` rendering — print mode can't surface a native prompt;
  gates were auto-approved via `report --result completed`.
- Plan-approval challenge/response — print mode can't produce a genuine human
  turn, so the `plan-approval-guard` hook blocked 15 automated bypass attempts
  and the approval was recorded by manually editing the questions file between
  sessions. The guard *enforced* (proven), but the *approval flow itself* was
  never genuinely exercised.
- `record-human-turn` PostToolUse arm on `ask_user_question` — partial, because
  most gates bypassed the question tool.
- Subagent dispatch — the conductor ran `code-generation` inline in print mode,
  so `deliver-stage-rules` and `log-subagent` (the two `run_subagent`-matcher
  hooks) never fired. 2/17 hooks unverified.

This second run removes those limitations by **driving `devin` interactively
at the keyboard**, with the same `express` scope and the same prompt as run 1
for direct comparability. The goal is to prove the interactive surfaces work
as designed — not to re-prove the plumbing run 1 already established.

## What this run targets (delta from run 1)

| Run 1 gap | Root cause | This run's fix |
|-----------|------------|----------------|
| `ask_user_question` not rendered | print mode | Interactive `devin` — real native prompts |
| Plan approval manual file hack | print mode can't produce a human turn | Genuine "Approve Plan" answer in the real prompt |
| `record-human-turn` on `ask_user_question` partial | gates auto-approved via `report` | Every gate goes through `ask_user_question` → hook fires |
| Subagent dispatch not tested | conductor ran inline in print mode | Interactive mode lets the conductor dispatch `run_subagent` for `code-generation` |

## What this run still does NOT exercise (express scope trade-off)

- **Ideation phase** — all 7 stages skipped (intent-capture → approval-handoff).
  `express` scope: requirements → code → test → deploy, no design/review pass.
- **Operation stages may conditional-skip again** — a greenfield API with no
  deployable target skips `deployment-pipeline`, `deployment-execution`, and
  `observability-setup` (CONDITIONAL — same as run 1). If you want to force
  them, change the prompt to name a deployment target (e.g. "containerize and
  deploy to AWS"). The default prompt keeps parity with run 1.

## Prerequisites

Same as run 1 — confirm before starting:

| Item | Requirement | Check |
|------|-------------|-------|
| Devin CLI | >= 3000.3.0 on PATH | `devin --version` -> must show `3000.3.0` or higher |
| bun | on PATH (non-interactive shells source `~/.zshenv`/`~/.bashrc`) | `which bun` -> must resolve |
| Model | set in `~/.config/devin/config.json` (user-level, NOT project) | `cat ~/.config/devin/config.json` -> must have a model entry |
| MCP servers (optional) | `CONTEXT7_API_KEY` for context7; AWS creds for the 4 AWS servers | Skip if unavailable — they never block a workflow |

## Phase 0 — Install & Doctor (5 minutes)

**Goal:** confirm the shipped tree is intact in a FRESH project (do not reuse
`~/devin-e2e-test` from run 1 — its state and audit trail would contaminate
this run).

1. **Copy the distribution into a fresh git project:**
   ```bash
   mkdir ~/devin-e2e-test-2 && cd ~/devin-e2e-test-2
   git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
   cp -r /home/wiley/sources/aidlc-workflows/dist/devin/.devin .devin
   cp -r /home/wiley/sources/aidlc-workflows/dist/devin/aidlc aidlc
   cp /home/wiley/sources/aidlc-workflows/dist/devin/AGENTS.md AGENTS.md
   cp /home/wiley/sources/aidlc-workflows/dist/devin/.gitignore .gitignore
   git add -A && git -c user.email=t@t -c user.name=t commit -qm "install aidlc devin shell"
   ```

2. **Run the doctor:**
   ```bash
   bun .devin/tools/aidlc-utility.ts doctor
   ```
   Save the output to `tests/evidence/devin-e2e-run/second-run/00-doctor-output.txt`.

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

3. **Hook approval (Devin CLI v3000.6.7+):** Run 1 found that hooks fire
   automatically from `.devin/hooks.v1.json` without a `/hooks` approval step
   on this CLI version — workspace trust is the gate. If you are on a version
   that still requires `/hooks`, approve all 17 `aidlc-` hooks there and fully
   restart (quit and re-launch — `/clear` is NOT enough). On v3000.6.7+,
   `--respect-workspace-trust false` is the equivalent bypass for non-interactive
   verification, but for this interactive run you should NOT pass that flag —
   let the normal trust prompt appear and approve it once.

## Phase 1 — Cold Start & Initialization (10-15 minutes)

**Goal:** verify SessionStart fires, the orchestrator skill loads, and the
initialization phase (3 stages) runs.

4. **Start a fresh INTERACTIVE Devin session in the project:**
   ```bash
   cd ~/devin-e2e-test-2
   devin
   ```
   Do NOT use `devin -p` (print mode) — that is the run-1 limitation we are
   removing. You must be at the keyboard to answer gates.

5. **Invoke the orchestrator with the same prompt as run 1:**
   ```
   /aidlc express "build a REST API for a todo app with CRUD endpoints"
   ```
   Using `/aidlc express` (or the `/aidlc-express` skill) bakes the express
   scope in directly — no scope detection. Same prompt as run 1 for direct
   comparability of the audit trail.

   **Checkpoint 1a — SessionStart hook fired:** Look for the welcome message
   containing "AIDLC WORKFLOW ACTIVE" (or the no-state version on the very
   first turn). If you see NO welcome message, the SessionStart hook didn't
   fire — check hook approval (Phase 0 step 3).

   **Checkpoint 1b — Skill discovery:** The conductor discovers
   `.devin/skills/aidlc/SKILL.md` and begins the orchestration loop. The first
   engine call is `bun .devin/tools/aidlc-orchestrate.ts next`.

   **Checkpoint 1c — Initialization stages run (3 stages):**
   - `workspace-scaffold` — creates the `aidlc/spaces/default/` shell
   - `workspace-detection` — detects the workspace root
   - `state-init` — creates the initial workflow state

   **Verify on disk (run in a separate terminal, NOT in the Devin session):**
   ```bash
   cd ~/devin-e2e-test-2
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
   target should have recorded a `HUMAN_TURN` audit event. Grep the audit
   shard for `HUMAN_TURN` — at least one entry should be present.

## Phase 2 — Inception: requirements-analysis (15-25 minutes)

**Goal:** verify the first gated stage runs, the `ask` directive renders via
`ask_user_question` (the run-1 gap), and the gate approval cycle works
through the real prompt.

6. **The conductor advances to `requirements-analysis` (first inception stage
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
   - `plan-approval-guard` — checks for plan approval (no-op outside
     code-generation)
   - `fold-usage` — folds token usage

   For a normal read, all guards allow (exit 0).

   **Checkpoint 2c — `ask` directive renders via `ask_user_question` (THE
   RUN-1 GAP):** When the stage has a structured question (the `gate: true`
   path), the conductor receives an `ask` directive and MUST render it via the
   `ask_user_question` tool — NOT echo the `question` fence as text. You
   should see a **native Devin question prompt with clickable options**, not a
   wall of text. This is the single most important checkpoint of this run: if
   you see a text fence instead of a native prompt, the harness adapter is not
   translating the directive correctly.

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

   **Checkpoint 2e — Gate approval via the REAL prompt (THE RUN-1 GAP):**
   After the stage body completes, the conductor presents the gate. **You
   approve by clicking/selecting an option in the native `ask_user_question`
   prompt** — do NOT type `bun .devin/tools/aidlc-orchestrate.ts report
   --result completed` yourself. The conductor calls `report --result
   completed --user-input "<your approval>"` on your behalf. The audit trail
   gains a `GATE_APPROVED` event AND a `HUMAN_TURN` event (the run-1 partial
   arm is now fully exercised).

   **Verify:**
   ```bash
   grep 'GATE_APPROVED\|HUMAN_TURN' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Both should be present after your approval
   ```

## Phase 3 — Construction: code-generation + build-and-test (30-50 minutes)

**Goal:** verify the plan-approval challenge/response works GENUINELY (the
run-1 gap), and that subagent dispatch fires the two untested hooks.

7. **The conductor advances to `code-generation`.** This stage has the
   `plan-approval-guard` PreToolUse hook that blocked 15 automated bypass
   attempts in run 1. This run is the genuine test of the approval flow.

   **Checkpoint 3a — Plan written before generation:** The conductor writes
   `code-generation-plan.md` and `unit-test-instructions.md`, refreshes the
   Testing Contract and approval fingerprint, then presents the Plan Approval
   question via `ask_user_question`. You should see the plan content rendered
   in the conductor's output BEFORE the approval prompt appears.

   **Checkpoint 3b — Genuine "Approve Plan" answer (THE RUN-1 GAP):** You
   answer "Approve Plan" in the real `ask_user_question` prompt. The
   `plan-approval-guard` hook (<ref_file file="/home/wiley/sources/aidlc-workflows/dist/devin/.devin/hooks/aidlc-plan-approval-guard.ts" />) checks 6 pieces of evidence:
   plan exists, instructions exist, approved, contract valid, fingerprint
   valid, receipt valid, contract hash present. If all are current, the guard
   allows the developer-agent dispatch with **zero `PLAN_APPROVAL_BLOCKED`
   events** — the contrast with run 1's 15 blocks is the headline result.

   **Verify (the key delta metric):**
   ```bash
   grep -c 'PLAN_APPROVAL_BLOCKED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Run 1: 15. This run: expected 0 (or very few if the conductor needs a retry).
   ```

   **Checkpoint 3c — Subagent dispatch fires (THE RUN-1 GAP):** If the
   conductor dispatches the developer agent via `run_subagent` (the stage's
   `mode: subagent`), two hooks fire that were untested in run 1:
   - PreToolUse `deliver-stage-rules` (matcher: `run_subagent`) — delivers the
     active stage rules to the subagent brief
   - PostToolUse `log-subagent` (matcher: `run_subagent`) — writes a
     `SUBAGENT_COMPLETED` audit event

   **Verify:**
   ```bash
   grep 'SUBAGENT_COMPLETED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Should be >= 1 (run 1: 0)
   ```

   If the conductor still runs inline (no `run_subagent` call), record this as
   a finding — it may be a conductor-side choice rather than a print-mode
   limitation. The two hooks remain unverified in that case.

   **Checkpoint 3d — Code generated + tests pass:** Application code is
   written to the workspace root, tests run, and the stage completes with a
   gate. Approve the gate via the real `ask_user_question` prompt
   (Checkpoint 2e pattern).

8. **The conductor advances to `build-and-test`.** Same pattern: stage body
   → gate → real approval → `report`.

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
workflow completes, and the session-end hooks fire.

9. **Operation stages** (`deployment-pipeline`, `deployment-execution`,
   `observability-setup`).

   **Checkpoint 4a — Conditional skips are clean:** With a greenfield API and
   no deployable target, these stages should `STAGE_SKIPPED` with a
   `CONDITIONAL` reason (same as run 1). If you want them to run, restart with
   a prompt that names a deployment target.

   **Verify:**
   ```bash
   grep -c 'STAGE_COMPLETED\|STAGE_SKIPPED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Should account for all express-scope stages (9 EXECUTE: 3 init +
   # requirements-analysis + code-generation + build-and-test + 3 operation
   # conditional skips)
   ```

10. **Workflow completion:** The engine returns a `done` directive. The
    conductor presents the completion summary and STOPS.

    **Checkpoint 4b — `done` directive:** The conductor prints the completion
    summary and stops the loop. No more `next` calls.

    **Checkpoint 4c — SessionEnd hook fires:** When you exit the Devin session
    (`/exit` or quit), the SessionEnd hook fires `session-end`, which writes a
    `SESSION_ENDED` audit event.

    **Verify:**
    ```bash
    grep 'SESSION_ENDED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
    ```

## Phase 5 — Post-Run Verification (5 minutes)

**Goal:** verify the full audit trail, the session-cost skill, the replay
skill, and the outcomes pack. Run these in a separate terminal (NOT in the
Devin session, which has exited).

11. **Session cost:**
    ```bash
    cd ~/devin-e2e-test-2
    bun .devin/tools/aidlc-runtime.ts summary --json
    ```
    Save to `tests/evidence/devin-e2e-run/second-run/05-session-cost.json`.
    Should show: total duration, stage count, phase rollup, memory entries,
    sensor firings, learnings.

12. **Replay** (start a fresh `devin` session in the project, then):
    ```
    /aidlc-replay
    ```
    Save the output to `tests/evidence/devin-e2e-run/second-run/05-replay.txt`.
    Should print a structured session narrative (phase rollup, stage
    outcomes, duration).

13. **Outcomes pack:**
    ```
    /aidlc-outcomes-pack
    ```
    Save the output to `tests/evidence/devin-e2e-run/second-run/05-outcomes-pack-output.txt`
    and copy the generated `OUTCOMES.md` to
    `tests/evidence/devin-e2e-run/second-run/05-outcomes.md`.
    Should write `OUTCOMES.md` at the project root.

14. **Full audit trail integrity:**
    ```bash
    grep -oE 'ARTIFACT_CREATED|ARTIFACT_UPDATED|STAGE_STARTED|STAGE_COMPLETED|STAGE_AWAITING_APPROVAL|GATE_APPROVED|GATE_REJECTED|HUMAN_TURN|SUBAGENT_COMPLETED|PLAN_APPROVAL_BLOCKED|PLAN_APPROVAL_RECORDED|SESSION_STARTED|SESSION_ENDED|SESSION_COMPACTED|LEARNING|WORKFLOW_COMPLETED' \
      aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md | sort | uniq -c | sort -rn
    ```
    Save to `tests/evidence/devin-e2e-run/second-run/05-audit-trail-distribution.txt`.

    **Expected distribution (delta from run 1 highlighted):**
    - `SESSION_STARTED`: >= 1
    - `STAGE_STARTED` + `STAGE_COMPLETED`: 6 each (3 init + 3 inception/construction)
    - `STAGE_SKIPPED`: 3 (operation conditional)
    - `GATE_APPROVED`: 3 (one per gated stage — via real `ask_user_question`)
    - `HUMAN_TURN`: >= 1 per gate + plan approval (run 1: 2; **this run: >= 4**)
    - `ARTIFACT_CREATED` / `ARTIFACT_UPDATED`: many
    - `PLAN_APPROVAL_BLOCKED`: **expected 0** (run 1: 15) — the headline delta
    - `PLAN_APPROVAL_RECORDED`: 1 (genuine human approval)
    - `SUBAGENT_COMPLETED`: **>= 1 if dispatch fires** (run 1: 0) — the other headline delta
    - `SESSION_ENDED`: >= 1

## Phase 6 — Hook Coverage Checklist

**Goal:** confirm every wired hook target fired. The target is 17/17 (run 1
was 15/17).

| Hook Event | Target | Matcher | How to verify | Run 1 | Run 2 target |
|------------|--------|---------|---------------|-------|--------------|
| SessionStart | session-start | -- | `SESSION_STARTED` in audit | PASS | PASS |
| SessionEnd | session-end | -- | `SESSION_ENDED` in audit | PASS | PASS |
| UserPromptSubmit | record-human-turn | -- | `HUMAN_TURN` in audit | PASS | PASS |
| PreToolUse | state-transition-guard | -- | No direct state mutations | PASS | PASS |
| PreToolUse | reviewer-scope | -- | Reviewer read-scope enforced | PASS | PASS |
| PreToolUse | review-freeze | -- | No writes during review | PASS | PASS |
| PreToolUse | plan-approval-guard | -- | **Zero blocks after genuine approval** | PASS (15 blocks) | PASS (0 blocks) |
| PreToolUse | deliver-stage-rules | run_subagent | Subagent received stage rules | **NOT TESTED** | **PASS** |
| PreToolUse | fold-usage | -- | Token usage folded | PASS | PASS |
| PostToolUse | audit-and-sensors | edit\|write\|apply_patch | `ARTIFACT_*` events | PASS | PASS |
| PostToolUse | sync-workflow-state | todo_write | State updated after `todo_write` | PASS | PASS |
| PostToolUse | log-subagent | run_subagent | `SUBAGENT_COMPLETED` in audit | **NOT TESTED** | **PASS** |
| PostToolUse | record-human-turn | ask_user_question | `HUMAN_TURN` after each gate answer | **PARTIAL** | **PASS** |
| PostToolUse | rebuild-stage-graph | exec | Stage graph refreshed | PASS | PASS |
| PostToolUse | fold-usage | -- | Token usage folded | PASS | PASS |
| PostCompaction | validate-state | -- | State validated after compaction | PASS | PASS |
| Stop | continue-workflow | -- | Continuation prompt when work remains | PASS | PASS |

Save the completed checklist to
`tests/evidence/devin-e2e-run/second-run/06-hook-coverage.txt`.

## Phase 7 — Failure Mode Checklist

Same diagnostics as run 1, plus the new interactive-mode failure modes:

| Symptom | Likely Cause | Diagnostic |
|---------|-------------|------------|
| No welcome message on session start | Hooks not approved / workspace not trusted | Approve workspace trust prompt; on older CLI, run `/hooks` and approve all, fully restart |
| Question fence echoed as text (not native prompt) | Conductor didn't use `ask_user_question` | Check `question-rendering.md` is present at `.devin/skills/aidlc/question-rendering.md`; check the adapter translates the `ask` directive |
| `PLAN_APPROVAL_BLOCKED` after genuine approval | Conductor didn't refresh Testing Contract or fingerprint before presenting the question | Check `code-generation-plan.md`, `unit-test-instructions.md`, and the questions file all have matching fingerprints; the guard requires all 6 evidence pieces to be current |
| No `SUBAGENT_COMPLETED` | Conductor ran `code-generation` inline (not via `run_subagent`) | May be a conductor-side choice, not a print-mode limitation — record as a finding; the two `run_subagent`-matcher hooks remain unverified |
| No `ARTIFACT_*` in audit | `audit-and-sensors` hook didn't fire | Check the adapter translated the tool name (`edit`->`Edit`, `write`->`Write`) |
| Workflow doesn't advance past gate | `report` not called after approval | The conductor should call `report --result completed` after your `ask_user_question` answer; if it doesn't, the adapter isn't wiring the answer through |
| `continue-workflow` doesn't block | No active workflow state | Check `aidlc-state.md` exists and `Current Stage` is set |

## Quick-Start (if you just want to run it)

```bash
# 1. Setup (FRESH project — do not reuse ~/devin-e2e-test from run 1)
mkdir ~/devin-e2e-test-2 && cd ~/devin-e2e-test-2
git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
cp -r /home/wiley/sources/aidlc-workflows/dist/devin/{.devin,aidlc,AGENTS.md,.gitignore} .
git add -A && git -c user.email=t@t -c user.name=t commit -qm "install aidlc"

# 2. Doctor
bun .devin/tools/aidlc-utility.ts doctor

# 3. Start INTERACTIVE Devin (NOT print mode)
devin

# 4. Run the workflow (same prompt as run 1)
/aidlc express "build a REST API for a todo app with CRUD endpoints"

# 5. At every gate: approve via the real ask_user_question prompt
#    At code-generation plan approval: answer "Approve Plan" genuinely
#    Do NOT type `report --result completed` yourself

# 6. After completion, verify (in a separate terminal)
cd ~/devin-e2e-test-2
bun .devin/tools/aidlc-runtime.ts summary --json
# then in a fresh devin session:
/aidlc-replay
/aidlc-outcomes-pack
```

The full interactive run (express scope, 9 stages, 3 conditional skips) takes
approximately 40-60 minutes with a fast model — longer than run 1's 40 minutes
because you are answering each gate by hand instead of auto-approving.

## Recording Evidence

Capture under `tests/evidence/devin-e2e-run/second-run/` (this directory),
following the convention established by `first-run/` and
`tests/evidence/p3-kiro-routing/`. The directory contains:

- the raw captured artifacts (doctor output, workflow output, audit trail,
  outcomes pack, hook coverage, runtime graph, generated stage artifacts);
- a `SUMMARY.md` narrating the run phase by phase, with explicit callouts of
  the deltas from run 1 (PLAN_APPROVAL_BLOCKED count, SUBAGENT_COMPLETED
  presence, HUMAN_TURN count);
- a `README.md` recording the run environment and a SHA-256 manifest of
  every artifact (computed with
  `find . -type f ! -name README.md | sort | xargs sha256sum`).

Update the campaign table in
`tests/evidence/devin-e2e-run/README.md` when this run lands.
