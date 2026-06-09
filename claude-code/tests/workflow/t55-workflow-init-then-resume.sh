#!/bin/bash
# t55: Workflow test — two-phase: --init then bugfix --test-run resume (8 tests)
# Requires: claude CLI
# Runs --init first, then resumes with bugfix --test-run to verify session continuity.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 8

PROJ=$(setup_integration_project --no-aidlc-docs)

# Phase 1: Run --init
run_claude "$PROJ" "/aidlc --init"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# Test 1: After init — state file exists
assert_file_exists "$STATE" "after init: state file exists"

# Test 2: After init — all 3 init stages marked complete
if [ -f "$STATE" ]; then
  INIT_COMPLETED=$(grep -ciE '\[x\] (workspace-scaffold|workspace-detection|state-init)' "$STATE" || true)
  assert_eq "$INIT_COMPLETED" "3" "after init: all 3 init stages marked [x]"
else
  not_ok "after init: all 3 init stages marked [x]" "aidlc-state.md not found"
fi

# Phase 2: Run bugfix with --test-run (should resume from init state)
run_claude "$PROJ" "/aidlc bugfix --test-run"

# Test 3: After resume — state file still exists
assert_file_exists "$STATE" "after resume: state file still exists"

# Test 4: After resume — more stages completed than just init
if [ -f "$STATE" ]; then
  TOTAL_COMPLETED=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$TOTAL_COMPLETED" 4 "after resume: more than 4 stages completed"
else
  not_ok "after resume: more than 4 stages completed" "aidlc-state.md not found"
fi

# Test 5: After resume — bugfix stages in progress or complete
if [ -f "$STATE" ]; then
  BUGFIX_STAGES=$(grep -ciE '\[x\] (reverse-engineering|requirements-analysis|code-generation|build-and-test)' "$STATE" || true)
  assert_gt "$BUGFIX_STAGES" 0 "after resume: bugfix stages progressed"
else
  not_ok "after resume: bugfix stages progressed" "aidlc-state.md not found"
fi

# Test 6: Audit log exists after both sessions
assert_file_exists "$AUDIT" "audit file exists after both sessions"

# Test 7: Audit log has entries from both sessions (substantial size)
if [ -f "$AUDIT" ]; then
  AUDIT_SIZE=$(wc -c < "$AUDIT")
  assert_gt "$AUDIT_SIZE" 300 "audit has entries from both sessions (> 300 bytes)"
else
  not_ok "audit has entries from both sessions (> 300 bytes)" "audit.md not found"
fi

# Test 8: State file has Test Run Mode field (set during resume phase)
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Test Run Mode.*true" "state file has Test Run Mode: true"
else
  not_ok "state file has Test Run Mode: true" "aidlc-state.md not found"
fi

cleanup_test_project "$PROJ"

finish
