#!/bin/bash
# t24: Integration test — forward --stage jump via claude CLI (12 tests)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=600

plan 12

# Test: --stage with existing state file jumps correctly
# Target approval-handoff (lightweight gate stage) instead of code-generation to avoid timeout
PROJ=$(setup_integration_project --with-state "$FIXTURES_DIR/state-mid-ideation.md" --with-audit)
run_claude "$PROJ" "/aidlc --stage approval-handoff --test-run"

# Guard: detect silent timeout (exit 124 = timeout with empty output)
assert_not_eq "$CLAUDE_RC" "124" "Claude CLI did not timeout"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# --- State file integrity ---
assert_grep "$STATE" '\[S\]' "state file has [S] skipped stages"
assert_grep "$STATE" 'approval-handoff' "current stage is approval-handoff"
assert_grep "$STATE" 'IDEATION' "lifecycle phase is IDEATION"

# Prior incomplete stages should be [S]
if grep -qE '\[S\].*feasibility|\[S\] feasibility' "$STATE" 2>/dev/null; then
  ok "feasibility marked as skipped"
else
  not_ok "feasibility marked as skipped" "feasibility not found with [S]"
fi

if grep -qE '\[S\].*team-formation|\[S\] team-formation' "$STATE" 2>/dev/null; then
  ok "team-formation marked as skipped"
else
  not_ok "team-formation marked as skipped" "team-formation not found with [S]"
fi

# Previously completed stages should remain [x]
if grep -qE '\[x\].*intent-capture|\[x\] intent-capture' "$STATE" 2>/dev/null; then
  ok "intent-capture still completed"
else
  not_ok "intent-capture still completed" "intent-capture not found with [x]"
fi

# Completed counter should match actual [x] count (not count [S])
X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
COMPLETED=$(grep 'Completed' "$STATE" | grep -oE '[0-9]+' | head -1)
assert_eq "$X_COUNT" "$COMPLETED" "Completed counter matches [x] count"

# Last Updated should have a timestamp
assert_grep "$STATE" 'Last Updated.*[0-9T:]' "Last Updated has fresh timestamp"

# --- Audit log integrity ---
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" 'STAGE_JUMPED' "audit has STAGE_JUMPED event"
  assert_grep "$AUDIT" 'FORWARD' "audit records forward direction"
  assert_grep "$AUDIT" 'Timestamp.*[0-9T:]' "audit event has ISO timestamp"
else
  not_ok "audit has STAGE_JUMPED event" "audit.md not found"
  not_ok "audit records forward direction" "audit.md not found"
  not_ok "audit event has ISO timestamp" "audit.md not found"
fi

cleanup_test_project "$PROJ"

finish
