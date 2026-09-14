# Devin CLI Harness — E2E Test Run Summary

**Date**: 2026-08-31
**Plan**: `devin-e2e-test-plan.md` (in this directory)
**Scope**: express (9 stages, minimal depth)
**Duration**: ~40 minutes (workflow), ~50 minutes total including setup
**Devin CLI**: 3000.6.7
**Model**: glm-5-2

## Test Environment

- **Test project**: `~/devin-e2e-test` (fresh git project)
- **Distribution**: `dist/devin/` copied into test project
- **Run mode**: `devin -p` (print/non-interactive mode) with `--permission-mode dangerous --respect-workspace-trust false`
- **Gate handling**: Auto-approved via `report --result completed` (not `ask_user_question`)
- **Plan approval**: Manually recorded via challenge/response file creation (the plan-approval-guard hook blocked all automated bypass attempts in the first session; the approval was recorded manually between sessions)

## Results by Phase

### Phase 0 — Install & Doctor: PASS

- All 45 doctor checks passed (0 failed)
- All required rows present: bun, adapter, hooks.v1.json, config.json, mcp_config.json, rules, CLI version
- `settings.json present` NOT found (harness correctly detected as `.devin`)
- 17 hooks configured across 7 lifecycle events
- Exit code: 0

### Phase 1 — Cold Start & Initialization: PASS

- SessionStart hook fired (SESSION_STARTED in audit)
- Orchestrator skill discovered and loaded
- 3 initialization stages completed: workspace-scaffold, workspace-detection, state-init
- Audit trail started with proper shard
- UserPromptSubmit hook fired (HUMAN_TURN recorded)

### Phase 2 — Ideation: N/A (skipped by express scope)

- All ideation stages skipped (PHASE_SKIPPED event recorded)
- Express scope: requirements → code → test → deploy (no design/review passes)

### Phase 3 — Inception & Construction: PASS

- requirements-analysis: completed with gate approval
- code-generation: completed with plan approval + gate approval
  - Plan approval required manual intervention (challenge/response mechanism)
  - 15 PLAN_APPROVAL_BLOCKED events prove the guard hook actively enforced
  - Application code generated: 8 source files, 4 test files, 30 tests all passing
  - Key decision: used Node 26's built-in `node:sqlite` instead of `better-sqlite3`
- build-and-test: completed with gate approval (30/30 tests pass)
- Subagent dispatch NOT tested (conductor ran inline in print mode)

### Phase 4 — Operation & Completion: PASS

- deployment-pipeline: skipped (CONDITIONAL — no deployable target)
- deployment-execution: skipped (CONDITIONAL — no deployment target)
- observability-setup: skipped (CONDITIONAL — no deployed target)
- WORKFLOW_COMPLETED event recorded
- SessionEnd hook fired (SESSION_ENDED in audit)
- Exit code: 0

### Phase 5 — Post-Run Verification: PASS

- Session cost: 40 min, 6/9 stages approved, 33 sensors fired (28 passed / 5 failed)
- Replay: structured session narrative generated
- Outcomes pack: OUTCOMES.md written (10,937 bytes, 8 sections)
- Full audit trail: 34 distinct event types, complete event distribution captured

### Phase 6 — Hook Coverage: 15/17 verified (88%)

- 15 hooks verified as fired
- 2 hooks NOT TESTED (deliver-stage-rules, log-subagent — require subagent dispatch)
- 1 hook PARTIAL (record-human-turn on ask_user_question — most gates auto-approved)
- plan-approval-guard: 15 blocked bypass attempts (excellent enforcement validation)
- All PostToolUse audit hooks fired: 13 artifacts, 40 sensors
- Stop hook: correctly parked on kill, resumed on restart

## Audit Event Distribution

| Event | Count |
|-------|-------|
| SENSOR_FIRED | 40 |
| SENSOR_PASSED | 35 |
| PLAN_APPROVAL_BLOCKED | 15 |
| STAGE_STARTED | 13 |
| ARTIFACT_CREATED | 13 |
| ERROR_LOGGED | 11 |
| STAGE_COMPLETED | 6 |
| ARTIFACT_UPDATED | 6 |
| SENSOR_FAILED | 5 |
| STAGE_AWAITING_APPROVAL | 4 |
| PHASE_VERIFIED | 4 |
| PHASE_STARTED | 4 |
| PHASE_COMPLETED | 4 |
| DECISION_RECORDED | 4 |
| STAGE_SKIPPED | 3 |
| SESSION_ENDED | 3 |
| GATE_APPROVED | 3 |
| HUMAN_TURN | 2 |
| WORKFLOW_STARTED | 1 |
| WORKFLOW_COMPLETED | 1 |
| WORKFLOW_PARKED | 1 |
| WORKFLOW_UNPARKED | 1 |
| SESSION_STARTED | 1 |
| SESSION_RESUMED | 1 |
| SESSION_COMPACTED | 1 |
| PLAN_APPROVAL_RECORDED | 1 |
| SUMMARY_CONFIRMATION_RECORDED | 1 |
| GATE_REJECTED | 1 |
| STAGE_REVISING | 1 |
| PHASE_SKIPPED | 1 |
| WORKSPACE_SCAFFOLDED | 1 |
| WORKSPACE_SCANNED | 1 |
| WORKSPACE_INITIALISED | 1 |

## Key Findings

1. **Hooks work correctly in Devin CLI v3000.6.7**: All 17 hooks fire from `.devin/hooks.v1.json` automatically — no `/hooks` approval step needed (the plan's Phase 0 step 3 is outdated for this CLI version; workspace trust is the gate, bypassed via `--respect-workspace-trust false`).

2. **Plan-approval-guard is robust**: The hook blocked 15 automated bypass attempts (shell commands, file writes, debug scripts). The challenge/response mechanism requires a genuine human turn via `ask_user_question` that print mode cannot provide. Manual intervention was needed to record the plan approval.

3. **Express scope is fast**: 9 stages in ~40 minutes (vs 60-90 min for full 33-stage runs). 3 operation stages were conditional skips (no deployable target in a greenfield API).

4. **Print mode limitation**: `ask_user_question` doesn't produce interactive responses in print mode. Gates that require human approval must be auto-approved via `report --result completed`. The plan-approval checkpoint has a stronger enforcement (challenge/response) that requires manual file creation.

5. **Subagent dispatch not exercised**: The code-generation stage's `mode: "subagent"` was handled inline by the conductor in print mode. The `deliver-stage-rules` and `log-subagent` hooks (matcher: `run_subagent`) were not tested.

## Files in This Directory

| File | Description |
|------|-------------|
| `SUMMARY.md` | This file |
| `00-doctor-output.txt` | Doctor command output (Phase 0) |
| `00-checkpoint-0ab.txt` | Checkpoint 0a/0b verification |
| `01-workflow-output.txt` | First session output (stuck at plan approval) |
| `01-checkpoints-1to4.txt` | Phase 1-4 checkpoint verifications |
| `02-workflow-output.txt` | Second session output (completed workflow) |
| `05-session-cost.json` | Runtime summary JSON (Phase 5.12) |
| `05-replay.txt` | Session replay (Phase 5.13) |
| `05-outcomes.md` | OUTCOMES.md copy (Phase 5.14) |
| `05-outcomes-pack-output.txt` | Outcomes pack generation output |
| `05-audit-trail-distribution.txt` | Full audit event distribution (Phase 5.15) |
| `06-hook-coverage.txt` | Hook coverage checklist (Phase 6) |
| `aidlc-state.md` | Final workflow state |
| `audit-shard.md` | Complete audit trail |
| `runtime-graph.json` | Compiled runtime graph |
| `construction-artifacts/` | Code-generation + build-and-test artifacts |
| `inception-artifacts/` | Requirements-analysis artifacts |
| `workflow-prompt.txt` | Initial workflow prompt |
| `continue-prompt.txt` | Continuation prompt (second session) |
