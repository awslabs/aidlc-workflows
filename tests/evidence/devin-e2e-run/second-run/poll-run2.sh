#!/bin/bash
# AI-DLC E2E Run 2 - Polling loop
# Polls every 45 seconds for up to 40 minutes (~53 iterations)

EVIDENCE_DIR="/home/wiley/sources/aidlc-workflows/tests/evidence/devin-e2e-run/second-run"
STATE_FILE="/home/wiley/devin-e2e-test-2/aidlc/spaces/default/intents/260831-todo-api/aidlc-state.md"
LOG_FILE="$EVIDENCE_DIR/monitoring-log.txt"
MAX_POLLS=53
POLL_INTERVAL=45
DONE=0

# Track milestones
FIRST_HUMAN_TURN_SEEN=0
FIRST_GATE_APPROVED_SEEN=0
PLAN_APPROVAL_BLOCKED_COUNT=0
PLAN_APPROVAL_RECORDED_COUNT=0
SUBAGENT_COMPLETED_COUNT=0
WORKFLOW_COMPLETED_SEEN=0
SESSION_ENDED_SEEN=0
LAST_EVENT_COUNT=0
STALE_POLLS=0

EVENT_PATTERN='ARTIFACT_CREATED|ARTIFACT_UPDATED|STAGE_STARTED|STAGE_COMPLETED|STAGE_AWAITING_APPROVAL|GATE_APPROVED|GATE_REJECTED|HUMAN_TURN|SUBAGENT_COMPLETED|PLAN_APPROVAL_BLOCKED|PLAN_APPROVAL_RECORDED|SESSION_STARTED|SESSION_ENDED|SESSION_COMPACTED|WORKFLOW_STARTED|WORKFLOW_COMPLETED|WORKFLOW_PARKED|WORKFLOW_UNPARKED|PHASE_STARTED|PHASE_COMPLETED|PHASE_SKIPPED|PHASE_VERIFIED|STAGE_SKIPPED|STAGE_REVISING|DECISION_RECORDED|SUMMARY_CONFIRMATION_RECORDED|LEARNING|ERROR_LOGGED|SENSOR_FIRED|SENSOR_PASSED|SENSOR_FAILED'

for ((i=1; i<=MAX_POLLS; i++)); do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # 1. Event distribution
  EVENT_DIST=$(cd /home/wiley/devin-e2e-test-2 && grep -oE "$EVENT_PATTERN" \
    aidlc/spaces/default/intents/260831-todo-api/audit/*.md 2>/dev/null | sort | uniq -c | sort -rn)

  TOTAL_EVENTS=$(echo "$EVENT_DIST" | grep -c . 2>/dev/null || echo 0)

  # 2. Current stage from state file
  STAGE_INFO=$(grep -E 'Current Stage|Current Status|Last Updated' "$STATE_FILE" 2>/dev/null)

  # 3. Extract key counts
  HUMAN_TURN_COUNT=$(echo "$EVENT_DIST" | grep -c 'HUMAN_TURN' 2>/dev/null || echo 0)
  GATE_APPROVED_COUNT=$(echo "$EVENT_DIST" | grep -c 'GATE_APPROVED' 2>/dev/null || echo 0)
  PLAN_BLOCKED_COUNT=$(echo "$EVENT_DIST" | grep -c 'PLAN_APPROVAL_BLOCKED' 2>/dev/null || echo 0)
  PLAN_RECORDED_COUNT=$(echo "$EVENT_DIST" | grep -c 'PLAN_APPROVAL_RECORDED' 2>/dev/null || echo 0)
  SUBAGENT_COUNT=$(echo "$EVENT_DIST" | grep -c 'SUBAGENT_COMPLETED' 2>/dev/null || echo 0)
  WORKFLOW_COMPLETED=$(echo "$EVENT_DIST" | grep -c 'WORKFLOW_COMPLETED' 2>/dev/null || echo 0)
  SESSION_ENDED=$(echo "$EVENT_DIST" | grep -c 'SESSION_ENDED' 2>/dev/null || echo 0)

  # Detect milestones
  MILESTONE_MSG=""
  if [ "$HUMAN_TURN_COUNT" -gt 0 ] && [ "$FIRST_HUMAN_TURN_SEEN" -eq 0 ]; then
    FIRST_HUMAN_TURN_SEEN=1
    MILESTONE_MSG="$MILESTONE_MSG [MILESTONE: First HUMAN_TURN detected - run-1 gap closed]"
  fi
  if [ "$GATE_APPROVED_COUNT" -gt 0 ] && [ "$FIRST_GATE_APPROVED_SEEN" -eq 0 ]; then
    FIRST_GATE_APPROVED_SEEN=1
    MILESTONE_MSG="$MILESTONE_MSG [MILESTONE: First GATE_APPROVED - gate approval cycle worked]"
  fi
  if [ "$PLAN_BLOCKED_COUNT" -gt 0 ] && [ "$PLAN_APPROVAL_BLOCKED_COUNT" -eq 0 ]; then
    PLAN_APPROVAL_BLOCKED_COUNT=$PLAN_BLOCKED_COUNT
    MILESTONE_MSG="$MILESTONE_MSG [MILESTONE: PLAN_APPROVAL_BLOCKED count=$PLAN_BLOCKED_COUNT (run 1 had 15, target 0)]"
  fi
  if [ "$PLAN_RECORDED_COUNT" -gt 0 ] && [ "$PLAN_APPROVAL_RECORDED_COUNT" -eq 0 ]; then
    PLAN_APPROVAL_RECORDED_COUNT=$PLAN_RECORDED_COUNT
    MILESTONE_MSG="$MILESTONE_MSG [MILESTONE: PLAN_APPROVAL_RECORDED count=$PLAN_RECORDED_COUNT - genuine plan approval happened]"
  fi
  if [ "$SUBAGENT_COUNT" -gt 0 ] && [ "$SUBAGENT_COMPLETED_COUNT" -eq 0 ]; then
    SUBAGENT_COMPLETED_COUNT=$SUBAGENT_COUNT
    MILESTONE_MSG="$MILESTONE_MSG [MILESTONE: SUBAGENT_COMPLETED count=$SUBAGENT_COUNT - subagent dispatch fired (run 1 had 0)]"
  fi

  # Log to monitoring file
  echo "[Poll #$i @ $TS] Events=$TOTAL_EVENTS | HUMAN_TURN=$HUMAN_TURN_COUNT GATE_APPROVED=$GATE_APPROVED_COUNT PLAN_BLOCKED=$PLAN_BLOCKED_COUNT PLAN_RECORDED=$PLAN_RECORDED_COUNT SUBAGENT=$SUBAGENT_COUNT WF_COMPLETED=$WORKFLOW_COMPLETED SESSION_ENDED=$SESSION_ENDED$MILESTONE_MSG" >> "$LOG_FILE"
  echo "  Stage: $(echo "$STAGE_INFO" | tr '\n' ' | ')" >> "$LOG_FILE"
  echo "  Event Distribution:" >> "$LOG_FILE"
  echo "$EVENT_DIST" | sed 's/^/    /' >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"

  # Check for completion
  if [ "$WORKFLOW_COMPLETED" -gt 0 ] || [ "$SESSION_ENDED" -gt 0 ]; then
    if [ "$WORKFLOW_COMPLETED_SEEN" -eq 0 ] || [ "$SESSION_ENDED_SEEN" -eq 0 ]; then
      echo "[Poll #$i @ $TS] *** COMPLETION DETECTED *** WORKFLOW_COMPLETED=$WORKFLOW_COMPLETED SESSION_ENDED=$SESSION_ENDED - stopping poll and doing final capture" >> "$LOG_FILE"
      echo "" >> "$LOG_FILE"
      DONE=1
      break
    fi
  fi

  # Staleness check
  if [ "$TOTAL_EVENTS" -eq "$LAST_EVENT_COUNT" ]; then
    STALE_POLLS=$((STALE_POLLS + 1))
  else
    STALE_POLLS=0
  fi
  LAST_EVENT_COUNT=$TOTAL_EVENTS

  if [ "$STALE_POLLS" -ge 7 ] && [ $i -ge 40 ]; then
    echo "[Poll #$i @ $TS] *** STALENESS: No new events in last ~5 minutes (after 30 min). Current state:" >> "$LOG_FILE"
    echo "  Stage: $(echo "$STAGE_INFO" | tr '\n' ' | ')" >> "$LOG_FILE"
    echo "  Continuing to poll (user may be reading a long plan)..." >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
    STALE_POLLS=0
  fi

  sleep $POLL_INTERVAL
done

if [ "$DONE" -eq 0 ]; then
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "[Poll loop ended @ $TS] Max polls ($MAX_POLLS) reached. Doing final capture with current state." >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"
fi

# === FINAL CAPTURE ===
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "================================================================================" >> "$LOG_FILE"
echo "FINAL CAPTURE @ $TS" >> "$LOG_FILE"
echo "================================================================================" >> "$LOG_FILE"

# a. Full audit event distribution
cd /home/wiley/devin-e2e-test-2 && grep -oE "$EVENT_PATTERN" \
  aidlc/spaces/default/intents/260831-todo-api/audit/*.md 2>/dev/null | sort | uniq -c | sort -rn > "$EVIDENCE_DIR/05-audit-trail-distribution.txt"

# b. Final state file copy
cp "$STATE_FILE" "$EVIDENCE_DIR/aidlc-state.md" 2>/dev/null

# c. Copy full audit shard
cp /home/wiley/devin-e2e-test-2/aidlc/spaces/default/intents/260831-todo-api/audit/galaxybook-31663ac55957.md "$EVIDENCE_DIR/audit-shard.md" 2>/dev/null

# d. Session cost summary
cd /home/wiley/devin-e2e-test-2 && bun .devin/tools/aidlc-runtime.ts summary --json > "$EVIDENCE_DIR/05-session-cost.json" 2>&1

# e. Runtime graph capture
cd /home/wiley/devin-e2e-test-2 && bun .devin/tools/aidlc-runtime.ts graph --json > "$EVIDENCE_DIR/runtime-graph.json" 2>/dev/null

# f. Construction artifacts
mkdir -p "$EVIDENCE_DIR/construction-artifacts"
cp -r /home/wiley/devin-e2e-test-2/aidlc/spaces/default/intents/260831-todo-api/construction/* "$EVIDENCE_DIR/construction-artifacts/" 2>/dev/null

# g. Inception artifacts
mkdir -p "$EVIDENCE_DIR/inception-artifacts"
cp -r /home/wiley/devin-e2e-test-2/aidlc/spaces/default/intents/260831-todo-api/inception/* "$EVIDENCE_DIR/inception-artifacts/" 2>/dev/null

# Print final summary
FINAL_DIST=$(cat "$EVIDENCE_DIR/05-audit-trail-distribution.txt")
FINAL_HUMAN_TURN=$(echo "$FINAL_DIST" | grep -c 'HUMAN_TURN' 2>/dev/null || echo 0)
FINAL_GATE_APPROVED=$(echo "$FINAL_DIST" | grep -c 'GATE_APPROVED' 2>/dev/null || echo 0)
FINAL_PLAN_BLOCKED=$(echo "$FINAL_DIST" | grep -c 'PLAN_APPROVAL_BLOCKED' 2>/dev/null || echo 0)
FINAL_PLAN_RECORDED=$(echo "$FINAL_DIST" | grep -c 'PLAN_APPROVAL_RECORDED' 2>/dev/null || echo 0)
FINAL_SUBAGENT=$(echo "$FINAL_DIST" | grep -c 'SUBAGENT_COMPLETED' 2>/dev/null || echo 0)
FINAL_WF_COMPLETED=$(echo "$FINAL_DIST" | grep -c 'WORKFLOW_COMPLETED' 2>/dev/null || echo 0)
FINAL_SESSION_ENDED=$(echo "$FINAL_DIST" | grep -c 'SESSION_ENDED' 2>/dev/null || echo 0)

echo "" >> "$LOG_FILE"
echo "================================================================================" >> "$LOG_FILE"
echo "FINAL SUMMARY - Headline Deltas" >> "$LOG_FILE"
echo "================================================================================" >> "$LOG_FILE"
echo "PLAN_APPROVAL_BLOCKED:  Run 1 = 15  |  Run 2 = $FINAL_PLAN_BLOCKED  |  Target = 0  |  $([ "$FINAL_PLAN_BLOCKED" -eq 0 ] && echo 'PASS' || echo 'FAIL')" >> "$LOG_FILE"
echo "SUBAGENT_COMPLETED:     Run 1 = 0   |  Run 2 = $FINAL_SUBAGENT  |  Target >= 1 |  $([ "$FINAL_SUBAGENT" -ge 1 ] && echo 'PASS' || echo 'NOT TESTED / FAIL')" >> "$LOG_FILE"
echo "HUMAN_TURN:             Run 1 = 2   |  Run 2 = $FINAL_HUMAN_TURN  |  Target >= 1 |  $([ "$FINAL_HUMAN_TURN" -ge 1 ] && echo 'PASS' || echo 'FAIL')" >> "$LOG_FILE"
echo "GATE_APPROVED:          Run 1 = ?   |  Run 2 = $FINAL_GATE_APPROVED  |  Target >= 1 |  $([ "$FINAL_GATE_APPROVED" -ge 1 ] && echo 'PASS' || echo 'NOT TESTED / FAIL')" >> "$LOG_FILE"
echo "PLAN_APPROVAL_RECORDED: Run 2 = $FINAL_PLAN_RECORDED" >> "$LOG_FILE"
echo "WORKFLOW_COMPLETED:     Run 2 = $FINAL_WF_COMPLETED" >> "$LOG_FILE"
echo "SESSION_ENDED:          Run 2 = $FINAL_SESSION_ENDED" >> "$LOG_FILE"
echo "================================================================================" >> "$LOG_FILE"

echo "POLLING_COMPLETE"
