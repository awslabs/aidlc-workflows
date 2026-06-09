#!/bin/bash
# t21b: Integration test for /aidlc --init — --force semantics (6 tests)
# First --init establishes state; second without --force must leave state
# unchanged; third with --force succeeds and appends a fresh WORKFLOW_STARTED
# without wiping audit. Behavioral assertions only — the tool's rejection
# message shape is locked down deterministically in tests/unit/t27-tool-utility.sh
# ("Init rejection contract"). The orchestrator's prose varies per LLM turn,
# so we do not grep its output here; we assert on state and audit instead.
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 6

PROJ=$(setup_integration_project --no-aidlc-docs)
STATE_FILE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT_FILE="$PROJ/aidlc-docs/audit.md"

# First run: establish state
run_claude "$PROJ" "/aidlc --init"
if [ ! -f "$STATE_FILE" ]; then
  echo "Bail out! first --init did not create state file"
  exit 1
fi
STAGES_FIRST=$(grep -c '^\- \[' "$STATE_FILE" 2>/dev/null || true)
PHASE_FIRST=$(sed -n 's/.*\*\*Lifecycle Phase\*\*: //p' "$STATE_FILE" 2>/dev/null || true)
AUDIT_LINES_FIRST=$(wc -l < "$AUDIT_FILE" 2>/dev/null || true)
WORKFLOW_COUNT_FIRST=$(grep -c "^\*\*Event\*\*: WORKFLOW_STARTED" "$AUDIT_FILE" 2>/dev/null || true)
# Workflow-state-changing events (WORKFLOW_STARTED + PHASE_* + STAGE_*) — the ones
# that must NOT fire on a rejected re-init. SESSION_* events fire per claude
# session independent of workflow state, so we track those separately.
WORKFLOW_STATE_EVENTS_FIRST=$(grep -cE "^\*\*Event\*\*: (WORKFLOW_|PHASE_|STAGE_|GATE_)" "$AUDIT_FILE" 2>/dev/null || true)

# Second run: no --force → the init tool rejects (exit 1, "already exists...
# Use --force to reinitialize" — covered deterministically in the unit tier).
# Here we assert the *behavioral* consequence: the orchestrator honoured the
# rejection, so state and workflow-state audit events must be unchanged.
run_claude "$PROJ" "/aidlc --init"

# Test 1: state structure unchanged after rejected re-init
STAGES_SECOND=$(grep -c '^\- \[' "$STATE_FILE" 2>/dev/null || true)
PHASE_SECOND=$(sed -n 's/.*\*\*Lifecycle Phase\*\*: //p' "$STATE_FILE" 2>/dev/null || true)
if [ "$STAGES_SECOND" = "$STAGES_FIRST" ] && [ "$PHASE_SECOND" = "$PHASE_FIRST" ]; then
  ok "state structure unchanged after rejected re-init"
else
  not_ok "state structure unchanged after rejected re-init" \
    "stages: ${STAGES_FIRST}→${STAGES_SECOND}, phase: ${PHASE_FIRST}→${PHASE_SECOND}"
fi

# Test 2: workflow state events unchanged after rejected re-init. Session
# events (SESSION_STARTED, SESSION_RESUMED, SESSION_ENDED) ARE expected to
# fire on every new claude -p invocation regardless of workflow state — that's
# their point. What must NOT change is the workflow/phase/stage/gate stream.
WORKFLOW_STATE_EVENTS_SECOND=$(grep -cE "^\*\*Event\*\*: (WORKFLOW_|PHASE_|STAGE_|GATE_)" "$AUDIT_FILE" 2>/dev/null || true)
if [ "$WORKFLOW_STATE_EVENTS_SECOND" = "$WORKFLOW_STATE_EVENTS_FIRST" ]; then
  ok "workflow state events unchanged after rejected re-init"
else
  not_ok "workflow state events unchanged after rejected re-init" \
    "first: $WORKFLOW_STATE_EVENTS_FIRST, after rejected: $WORKFLOW_STATE_EVENTS_SECOND"
fi

# Third run: --force → must succeed
run_claude "$PROJ" "/aidlc --init --force"
RC3="$CLAUDE_RC"
if [ "$RC3" -eq 0 ]; then
  ok "third --init --force exits zero"
else
  not_ok "third --init --force exits zero" "exit code: $RC3"
fi

# Test 4: state file still exists after --force reinit
assert_file_exists "$STATE_FILE" "state file still exists after --force reinit"

# Test 5: state file was rewritten (init stages still [x])
if grep -qi "\[x\] workspace-scaffold" "$STATE_FILE" 2>/dev/null; then
  ok "--force reinit produces [x] workspace-scaffold"
else
  not_ok "--force reinit produces [x] workspace-scaffold" "state not reinitialized"
fi

# Test 6: audit gained a second WORKFLOW_STARTED event (not wiped)
# (SESSION_* events are hook-owned and fire per Claude Code session, not per --force.)
WORKFLOW_COUNT_THIRD=$(grep -c "^\*\*Event\*\*: WORKFLOW_STARTED" "$AUDIT_FILE" 2>/dev/null || true)
if [ "$WORKFLOW_COUNT_THIRD" -gt "$WORKFLOW_COUNT_FIRST" ]; then
  ok "audit gained a fresh WORKFLOW_STARTED on --force ($WORKFLOW_COUNT_FIRST → $WORKFLOW_COUNT_THIRD)"
else
  not_ok "audit gained a fresh WORKFLOW_STARTED on --force" \
    "count: $WORKFLOW_COUNT_FIRST → $WORKFLOW_COUNT_THIRD"
fi

cleanup_test_project "$PROJ"

finish
