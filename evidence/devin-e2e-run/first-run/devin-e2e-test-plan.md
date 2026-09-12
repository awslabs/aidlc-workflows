# End-to-End Live Run Plan — Devin CLI Harness

This plan walks you through a full live AI-DLC workflow run on the Devin CLI
harness, with explicit checkpoints at every hook, audit event, and directive
dispatch so you can verify each piece fired correctly.

## Prerequisites

| Item | Requirement | Check |
|------|-------------|-------|
| Devin CLI | >= 3000.3.0 on PATH | `devin --version` -> must show `3000.3.0` or higher |
| bun | on PATH (non-interactive shells source `~/.zshenv`/`~/.bashrc`) | `which bun` -> must resolve |
| Model | set in `~/.config/devin/config.json` (user-level, NOT project) | `cat ~/.config/devin/config.json` -> must have a model entry |
| MCP servers (optional) | `CONTEXT7_API_KEY` for context7; AWS creds for the 4 AWS servers | Skip if unavailable -- they never block a workflow |

## Phase 0 -- Install & Doctor (5 minutes)

**Goal:** confirm the shipped tree is intact and the doctor recognizes the
Devin harness.

1. **Copy the distribution into a fresh git project:**
   ```bash
   mkdir ~/devin-e2e-test && cd ~/devin-e2e-test
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

   **Checkpoint 0a -- Doctor output must include these rows (all pass):**
   - `pass  bun installed`
   - `pass  aidlc-devin-adapter.ts present`
   - `pass  hooks.v1.json present (hook wiring)`
   - `pass  config.json present (permissions + read_config_from)`
   - `pass  mcp_config.json present (MCP servers)`
   - `pass  rules/aidlc.md present (standing method rule)`
   - `pass  devin CLI version <X.Y.Z> >= 3000.3.0`
   - `pass  hook approval: approve the project's hooks via /hooks...` (advisory, always passes)
   - **Must NOT include:** `settings.json present` (the Claude fallback -- if
     you see this, the harness dir wasn't detected as `.devin`)

   **Checkpoint 0b -- Doctor exit code:** must be 0 (all passed). If any row
   shows a failure, fix before proceeding.

3. **Approve hooks:**
   - Start `devin` in the project directory
   - Run `/hooks` in the Devin session
   - Approve all 17 AI-DLC hooks (all prefixed `aidlc-`)
   - **Fully restart Devin CLI** (quit and re-launch -- `/clear` is NOT enough)

   **Checkpoint 0c -- Hook approval:** After restart, the hooks are approved.
   Unapproved hooks silently no-op, so this step is mandatory.

## Phase 1 -- Cold Start & Initialization (10-15 minutes)

**Goal:** verify SessionStart fires, the orchestrator skill loads, and the
initialization phase (3 stages) runs.

4. **Start a fresh Devin session in the project:**
   ```bash
   cd ~/devin-e2e-test
   devin
   ```

5. **Invoke the orchestrator with a simple feature description:**
   ```
   /aidlc build a REST API for a todo app with CRUD endpoints
   ```

   **Checkpoint 1a -- SessionStart hook fired:** The session-start hook
   injects workflow context via `additionalContext`. Look for the welcome
   message containing "AIDLC WORKFLOW ACTIVE" (or the no-state version if
   this is the very first turn before state exists). If you see NO welcome
   message, the SessionStart hook didn't fire -- check hook approval (Phase 0
   step 3).

   **Checkpoint 1b -- Skill discovery:** The conductor should discover
   `.devin/skills/aidlc/SKILL.md` and begin the orchestration loop. The first
   engine call is `bun .devin/tools/aidlc-orchestrate.ts next`. You should see
   the conductor reading the skill and making its first `next` call.

   **Checkpoint 1c -- Initialization stages run (3 stages):**
   - `workspace-scaffold` -- creates the `aidlc/spaces/default/` shell
   - `workspace-detection` -- detects the workspace root
   - `state-init` -- creates the initial workflow state

   **Verify on disk:**
   ```bash
   ls aidlc/spaces/default/intents/  # should show the new intent dir
   cat aidlc/spaces/default/intents/active-intent  # should show the intent slug-id
   ls aidlc/spaces/default/intents/<slug>-<id8>/  # should show aidlc-state.md + audit/
   ```

   **Checkpoint 1d -- Audit trail started:**
   ```bash
   ls aidlc/spaces/default/intents/<slug>-<id8>/audit/
   # should show at least one shard: <hostname>-<cloneid>.md
   ```
   Read the shard -- it should contain `SESSION_STARTED` and `STAGE_STARTED` /
   `STAGE_COMPLETED` events for the 3 initialization stages.

   **Checkpoint 1e -- UserPromptSubmit hook fired:** The `record-human-turn`
   target should have recorded a `HUMAN_TURN` audit event. Grep the audit
   shard for `HUMAN_TURN` -- at least one entry should be present.

## Phase 2 -- Ideation Phase (20-40 minutes)

**Goal:** verify the first gated stage runs, the `ask` directive renders via
`ask_user_question`, and the gate approval cycle works.

6. **The conductor advances to `intent-capture` (first ideation stage).**

   **Checkpoint 2a -- `run-stage` directive:** The conductor receives a
   `run-stage` directive from `next`. Before running the stage body, it
   should read the `inline_context_paths` (the blocking context-load
   precondition). You should see file reads for the stage file + consumed
   artifacts.

   **Checkpoint 2b -- PreToolUse guards fired:** When the conductor makes its
   first tool call (e.g. `read` or `exec`), the PreToolUse hooks fire:
   - `state-transition-guard` -- checks for direct state mutations
   - `reviewer-scope` -- checks read scope
   - `review-freeze` -- checks if a review is in progress
   - `plan-approval-guard` -- checks for plan approval
   - `fold-usage` -- folds token usage

   If any guard blocks (exit 2), the conductor should see the block reason
   and NOT proceed. For a normal read, all guards allow (exit 0).

   **Checkpoint 2c -- `ask` directive renders via `ask_user_question`:** When
   the stage has a structured question (the `gate: true` path), the conductor
   receives an `ask` directive and MUST render it via the `ask_user_question`
   tool -- NOT echo the `question` fence as text. You should see a native
   Devin question prompt with clickable options, not a wall of text.

   **Checkpoint 2d -- PostToolUse hooks fired after artifact writes:** When
   the conductor writes an artifact (e.g. the intent capture document):
   - `audit-and-sensors` fires on `edit`/`write`/`apply_patch` -- the audit
     trail gains an `ARTIFACT_CREATED` or `ARTIFACT_UPDATED` row
   - `sync-workflow-state` fires on `todo_write` -- the workflow state updates
   - `rebuild-stage-graph` fires on `exec` -- the stage graph refreshes

   **Verify on disk:**
   ```bash
   # Audit trail should now have ARTIFACT_* events
   grep -c 'ARTIFACT_' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   # Should be > 0
   ```

   **Checkpoint 2e -- Gate approval:** After the stage body completes, the
   conductor presents the gate. You approve via `ask_user_question`. The
   conductor calls `report --result completed --user-input "<your approval>"`.
   The audit trail gains a `GATE_APPROVED` event.

   **Verify:**
   ```bash
   grep 'GATE_APPROVED\|STAGE_COMPLETED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   ```

7. **Continue through the remaining ideation stages** (market-research,
   feasibility, rough-mockups, team-formation, scope-definition,
   approval-handoff). Each follows the same pattern: `run-stage` -> context
   load -> stage body -> gate -> `report` -> `next`.

   **Checkpoint 2f -- `continue-workflow` hook fires on Stop:** At the end of
   each turn, the Stop hook fires the `continue-workflow` target. If work
   remains, it returns `{"decision":"block","reason":"..."}` -- the conductor
   should surface the continuation prompt. If no work remains (workflow
   complete), it returns silent exit 0.

   **Checkpoint 2g -- `/aidlc --status` works mid-workflow:**
   ```bash
   bun .devin/tools/aidlc-utility.ts status
   ```
   Should show: current phase (ideation), current stage, progress (e.g.
   "3/33 stages"), cost summary.

## Phase 3 -- Inception & Construction Phases (30-60 minutes)

**Goal:** verify subagent dispatch, the swarm referee, and the
construction-phase parallel work.

8. **Inception stages** (requirements-analysis, domain-design,
   contract-design, etc.) -- same pattern as ideation.

   **Checkpoint 3a -- `deliver-stage-rules` hook fires on `run_subagent`:**
   When the conductor dispatches a subagent (e.g. for a delegated stage), the
   PreToolUse hook with matcher `run_subagent` fires the `deliver-stage-rules`
   target. This delivers the active stage rules to the subagent.

   **Checkpoint 3b -- `log-subagent` hook fires on subagent completion:** The
   PostToolUse hook with matcher `run_subagent` fires `log-subagent`, which
   writes a `SUBAGENT_COMPLETED` audit event.

   **Verify:**
   ```bash
   grep 'SUBAGENT_COMPLETED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
   ```

9. **Construction phases** -- this is where parallel work happens (swarm).

   **Checkpoint 3c -- Swarm referee:** If the scope triggers a swarm (e.g.
   enterprise scope with multiple units), the conductor dispatches parallel
   subagents. The swarm referee (`aidlc-swarm.ts`) coordinates them. Each
   subagent's artifacts are tracked.

   **Checkpoint 3d -- `todo_write` -> `sync-workflow-state`:** During
   construction, the conductor uses `todo_write` to track per-unit progress.
   Each `todo_write` PostToolUse fires `sync-workflow-state`, which updates
   `aidlc-state.md`.

   **Verify:**
   ```bash
   cat aidlc/spaces/default/intents/<slug>-<id8>/aidlc-state.md
   # Should show Current Stage, per-unit progress, iteration count
   ```

## Phase 4 -- Operation Phase & Completion (20-30 minutes)

**Goal:** verify the final stages run, the workflow completes, and the
session-end hooks fire.

10. **Operation stages** (deployment-pipeline, deployment-execution,
    observability-setup, etc.)

    **Checkpoint 4a -- All 33 stages accounted for:** At this point, the
    audit trail should show `STAGE_COMPLETED` for every stage in the stage
    graph.

    **Verify:**
    ```bash
    grep -c 'STAGE_COMPLETED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
    # Should be 33 (or the scope's stage count)
    ```

11. **Workflow completion:** The engine returns a `done` directive. The
    conductor presents the completion summary and STOPS.

    **Checkpoint 4b -- `done` directive:** The conductor should print the
    completion summary and stop the loop. No more `next` calls.

    **Checkpoint 4c -- SessionEnd hook fires:** When you exit the Devin
    session, the SessionEnd hook fires `session-end`, which writes a
    `SESSION_ENDED` audit event.

    **Verify:**
    ```bash
    grep 'SESSION_ENDED' aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md
    ```

## Phase 5 -- Post-Run Verification (5 minutes)

**Goal:** verify the full audit trail, the session-cost skill, and the replay
skill.

12. **Session cost:**
    ```bash
    bun .devin/tools/aidlc-runtime.ts summary --json
    ```
    Should show: total duration, stage count, phase rollup, memory entries,
    sensor firings, learnings.

    Or via the skill: `/aidlc-session-cost` in a Devin session.

13. **Replay:**
    ```
    /aidlc-replay
    ```
    Should print a structured session narrative (phase rollup, stage
    outcomes, duration).

14. **Outcomes pack:**
    ```
    /aidlc-outcomes-pack
    ```
    Should write `OUTCOMES.md` at the project root.

    **Verify:**
    ```bash
    ls OUTCOMES.md  # should exist
    head -20 OUTCOMES.md  # should have the handover document
    ```

15. **Full audit trail integrity:**
    ```bash
    # Count all event types
    grep -oE 'ARTIFACT_CREATED|ARTIFACT_UPDATED|STAGE_STARTED|STAGE_COMPLETED|STAGE_AWAITING_APPROVAL|GATE_APPROVED|GATE_REJECTED|HUMAN_TURN|SUBAGENT_COMPLETED|SESSION_STARTED|SESSION_ENDED|SESSION_COMPACTED|LEARNING' \
      aidlc/spaces/default/intents/<slug>-<id8>/audit/*.md | sort | uniq -c | sort -rn
    ```

    **Expected distribution:**
    - `SESSION_STARTED`: >= 1
    - `STAGE_STARTED` + `STAGE_COMPLETED`: 33 each (or scope's stage count)
    - `GATE_APPROVED`: 1 per gated stage
    - `HUMAN_TURN`: >= 1 per gate
    - `ARTIFACT_CREATED` / `ARTIFACT_UPDATED`: many (one per artifact write)
    - `SUBAGENT_COMPLETED`: >= 1 if any delegated stage ran
    - `SESSION_ENDED`: >= 1 (if you exited cleanly)

## Phase 6 -- Hook Coverage Checklist

**Goal:** confirm every wired hook target actually fired during the run.

| Hook Event | Target | Matcher | How to verify it fired |
|------------|--------|---------|------------------------|
| SessionStart | session-start | -- | `SESSION_STARTED` in audit; welcome message with workflow context |
| SessionEnd | session-end | -- | `SESSION_ENDED` in audit |
| UserPromptSubmit | record-human-turn | -- | `HUMAN_TURN` in audit (one per user prompt) |
| PreToolUse | state-transition-guard | -- | No direct state mutations succeeded (no `aidlc-state.md` writes outside `report`) |
| PreToolUse | reviewer-scope | -- | Reviewer read-scope enforced (no out-of-scope reads during review) |
| PreToolUse | review-freeze | -- | No artifact writes during review freeze |
| PreToolUse | plan-approval-guard | -- | No code generation without plan approval |
| PreToolUse | deliver-stage-rules | run_subagent | Subagent received stage rules (check subagent brief in transcript) |
| PreToolUse | fold-usage | -- | Token usage folded (no errors in stderr) |
| PostToolUse | audit-and-sensors | edit\|write\|apply_patch | `ARTIFACT_*` events in audit |
| PostToolUse | sync-workflow-state | todo_write | `aidlc-state.md` updated after each `todo_write` |
| PostToolUse | log-subagent | run_subagent | `SUBAGENT_COMPLETED` in audit |
| PostToolUse | record-human-turn | ask_user_question | `HUMAN_TURN` in audit after each gate answer |
| PostToolUse | rebuild-stage-graph | exec | Stage graph refreshed after `exec` calls (no stale graph errors) |
| PostToolUse | fold-usage | -- | Token usage folded (no errors in stderr) |
| PostCompaction | validate-state | -- | State validated after compaction (no state corruption) |
| Stop | continue-workflow | -- | Continuation prompt surfaced when work remains; silent when done |

## Phase 7 -- Failure Mode Checklist

If something goes wrong, these are the most likely failure modes and their
diagnostics:

| Symptom | Likely Cause | Diagnostic |
|---------|-------------|------------|
| No welcome message on session start | Hooks not approved | Run `/hooks` in Devin, approve all, fully restart |
| `settings.json present` in doctor | Harness dir not detected as `.devin` | Confirm `AIDLC_HARNESS_DIR=.devin` or that `.devin/tools/data/harness.json` exists |
| Question fence echoed as text | Conductor didn't use `ask_user_question` | Check `question-rendering.md` is present at `.devin/skills/aidlc/question-rendering.md` |
| No `ARTIFACT_*` in audit | `audit-and-sensors` hook didn't fire | Check the adapter translated the tool name (`edit`->`Edit`, `write`->`Write`) |
| No `SUBAGENT_COMPLETED` | `log-subagent` didn't fire on `run_subagent` | Check the matcher `run_subagent` in `hooks.v1.json` matches Devin's tool name |
| Workflow doesn't advance past gate | `report` not called after approval | Check the conductor calls `report --result completed` after gate approval |
| `continue-workflow` doesn't block | No active workflow state | Check `aidlc-state.md` exists and `Current Stage` is set |
| Doctor shows `devin CLI version` failure | Devin CLI < 3000.3.0 | Upgrade Devin CLI |

## Quick-Start (if you just want to run it)

```bash
# 1. Setup
mkdir ~/devin-e2e && cd ~/devin-e2e
git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
cp -r /home/wiley/sources/aidlc-workflows/dist/devin/{.devin,aidlc,AGENTS.md,.gitignore} .
git add -A && git -c user.email=t@t -c user.name=t commit -qm "install aidlc"

# 2. Doctor
bun .devin/tools/aidlc-utility.ts doctor

# 3. Start Devin, approve hooks, restart
devin  # then /hooks, approve all, quit, re-launch

# 4. Run the workflow
/aidlc build a REST API for a todo app with CRUD endpoints

# 5. After completion, verify
bun .devin/tools/aidlc-runtime.ts summary --json
/aidlc-replay
/aidlc-outcomes-pack
```

The full run (33 stages, express scope) takes approximately 60-90 minutes
with a fast model. The `express` scope skips design/review passes -- use
`/aidlc express "..."` for the fastest end-to-end run. For a fuller test,
use `/aidlc feature "..."` (includes design + reviewers, ~2-3 hours).

## Recording Evidence

Each completed run is captured under
`evidence/devin-e2e-run/<run>/` (e.g. `first-run/`, `second-run/`,
`third-run/`), following the convention established by
`evidence/p3-kiro-routing/`. Each run directory contains:

- the raw captured artifacts (doctor output, workflow output, audit trail,
  outcomes pack, hook coverage, runtime graph, generated stage artifacts);
- a `SUMMARY.md` narrating the run phase by phase;
- a `README.md` recording the run environment and a SHA-256 manifest of
  every artifact (computed with
  `find . -type f ! -name README.md | sort | xargs sha256sum`).

A top-level `evidence/devin-e2e-run/README.md` tracks the campaign
table (run, date, scope, status). Update it when a new run lands.
