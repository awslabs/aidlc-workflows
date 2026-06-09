#!/bin/bash
# t26: Integration test — backward jump via claude CLI (8 tests)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=600

plan 8

# Test: backward jump from construction to ideation stage
PROJ=$(setup_integration_project --with-state "$FIXTURES_DIR/state-construction.md" --with-audit)
run_claude "$PROJ" "/aidlc --stage intent-capture --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# --- State invariants (hold regardless of post-jump advancement) ---

# Backward jump from 20 completed stages must reduce completed count
COMPLETED=$(grep 'Completed' "$STATE" | grep -oE '[0-9]+' | head -1)
assert_lt "$COMPLETED" 20 "backward jump reduced completed count (was 20, now $COMPLETED)"

# Audit records the jump target (written at step 9, deterministic)
assert_grep "$AUDIT" 'intent-capture' "audit records jump target intent-capture"

# Jump reset 16+ stages; can't re-complete them all in any reasonable turn budget
X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
assert_lt "$X_COUNT" 15 "significant downstream reset ($X_COUNT completed, was 20)"

# Internal consistency: Completed counter matches actual [x] count
assert_eq "$X_COUNT" "$COMPLETED" "Completed counter matches actual [x] count"

# --- Audit log integrity (written during jump handler, deterministic) ---
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" 'STAGE_JUMPED' "audit has STAGE_JUMPED event"
  assert_grep "$AUDIT" 'BACKWARD' "audit records backward direction"
  assert_grep "$AUDIT" 'Timestamp' "audit event has timestamp"
else
  not_ok "audit has STAGE_JUMPED event" "audit.md not found"
  not_ok "audit records backward direction" "audit.md not found"
  not_ok "audit event has timestamp" "audit.md not found"
fi

# After a backward jump, Status is Running (the Paused status was removed in
# the Phase 11 state-machine refactor — the workflow never pauses mid-flight).
# In Progress field matches Current Stage.
STATUS=$(sed -n 's/.*\*\*Status\*\*: //p' "$STATE" | head -1)
CURRENT_STAGE=$(sed -n 's/.*\*\*Current Stage\*\*: //p' "$STATE" | head -1)
IN_PROGRESS=$(sed -n 's/.*\*\*In Progress\*\*: //p' "$STATE" | head -1)
if [ "$STATUS" = "Running" ] && [ -n "$CURRENT_STAGE" ] && [ "$CURRENT_STAGE" = "$IN_PROGRESS" ]; then
  ok "In Progress field matches Current Stage ($CURRENT_STAGE) and Status=Running"
else
  not_ok "state consistency" "Status='$STATUS' Current Stage='$CURRENT_STAGE' In Progress='$IN_PROGRESS'"
fi

cleanup_test_project "$PROJ"

finish
