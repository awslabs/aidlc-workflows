#!/bin/bash
# t52: Workflow test — state file progression during bugfix (10 tests)
# Requires: claude CLI
# Focuses on state file integrity: checkbox counts, stage ordering, field updates.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 10

PROJ=$(setup_integration_project --no-aidlc-docs)

# Run a bugfix workflow with --test-run flag
run_claude "$PROJ" "/aidlc bugfix --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"

# Test 1: State file exists
assert_file_exists "$STATE" "state file exists after workflow"

# Test 2: [x] count is greater than 4 (more completed at end than just init)
if [ -f "$STATE" ]; then
  COMPLETED=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$COMPLETED" 4 "[x] count > 4 (post-init stages completed)"
else
  not_ok "[x] count > 4 (post-init stages completed)" "aidlc-state.md not found"
fi

# Test 3: Current Stage field is populated and has advanced past initialization
if [ -f "$STATE" ]; then
  CURRENT_STAGE=$(sed -n 's/.*\*\*Current Stage\*\*: //p' "$STATE" || echo "")
  case "$CURRENT_STAGE" in
    ""|workspace-scaffold|workspace-detection|state-init)
      not_ok "Current Stage advanced past initialization" "got: '$CURRENT_STAGE'"
      ;;
    *)
      ok "Current Stage advanced past initialization (got: $CURRENT_STAGE)"
      ;;
  esac
else
  not_ok "Current Stage advanced past initialization" "aidlc-state.md not found"
fi

# Test 4: Completed counter in state file matches [x] count
if [ -f "$STATE" ]; then
  COUNTER=$(sed -n 's/.*\*\*Completed\*\*: \([0-9]*\).*/\1/p' "$STATE" || true)
  CHECKMARKS=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_eq "$COUNTER" "$CHECKMARKS" "Completed counter matches [x] count"
else
  not_ok "Completed counter matches [x] count" "aidlc-state.md not found"
fi

# Test 5: No [x] stages appear after [-] (ordering preserved)
if [ -f "$STATE" ]; then
  IN_PROGRESS_LINE=$(grep -n '^\- \[-\]' "$STATE" | tail -1 | cut -d: -f1 || true)
  if [ -n "$IN_PROGRESS_LINE" ] && [ "$IN_PROGRESS_LINE" -gt 0 ]; then
    LAST_X=$(grep -n '^\- \[x\]' "$STATE" | tail -1 | cut -d: -f1 || true)
    if [ -n "$LAST_X" ] && [ "$LAST_X" -gt "$IN_PROGRESS_LINE" ]; then
      not_ok "stage ordering: [x] after [-]" "[-] at line $IN_PROGRESS_LINE, [x] at line $LAST_X"
    else
      ok "stage ordering valid ([-] at line $IN_PROGRESS_LINE, last [x] before it)"
    fi
  else
    ok "stage ordering valid (no [-] — workflow fully complete)"
  fi
else
  not_ok "stage ordering check" "aidlc-state.md not found"
fi

# Test 6: Lifecycle Phase field is present
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Lifecycle Phase" "Lifecycle Phase field present"
else
  not_ok "Lifecycle Phase field present" "aidlc-state.md not found"
fi

# Test 7: Status field is present
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "\*\*Status\*\*:" "Status field present"
else
  not_ok "Status field present" "aidlc-state.md not found"
fi

# Test 8: Last Updated field has ISO timestamp
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Last Updated.*[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T" "Last Updated has ISO timestamp"
else
  not_ok "Last Updated has ISO timestamp" "aidlc-state.md not found"
fi

# Test 9: Active Agent field is present
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Active Agent" "Active Agent field present"
else
  not_ok "Active Agent field present" "aidlc-state.md not found"
fi

# Test 10: State Version is 7
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "State Version.*: 7$" "State Version is 7"
else
  not_ok "State Version is 7" "aidlc-state.md not found"
fi

cleanup_test_project "$PROJ"

finish
