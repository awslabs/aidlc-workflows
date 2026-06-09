#!/bin/bash
# t59: Workflow test — depth override persists through bugfix workflow (6 tests)
# Requires: claude CLI
# Verifies that --depth comprehensive on a bugfix scope overrides the
# Minimal default and persists through the entire workflow execution.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 6

PROJ=$(setup_integration_project --no-aidlc-docs --with-brownfield-stub)

# Run bugfix with depth override
run_claude "$PROJ" "/aidlc bugfix --depth comprehensive --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# Test 1: State file created
assert_file_exists "$STATE" "state file created"

# Test 2: Depth is Comprehensive (not bugfix default Minimal)
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Depth.*Comprehensive" "depth comprehensive overrides bugfix default"
else
  not_ok "depth comprehensive overrides bugfix default" "aidlc-state.md not found"
fi

# Test 3: Scope is bugfix
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "[Bb]ugfix" "bugfix scope recorded in state"
else
  not_ok "bugfix scope recorded in state" "aidlc-state.md not found"
fi

# Test 4: Init stages completed
if [ -f "$STATE" ]; then
  INIT_COMPLETED=$(grep -ciE '\[x\] (workspace-scaffold|workspace-detection|state-init)' "$STATE" || true)
  assert_gt "$INIT_COMPLETED" 2 "at least 3 init stages completed"
else
  not_ok "at least 3 init stages completed" "aidlc-state.md not found"
fi

# Test 5: At least one Construction stage progressed
if [ -f "$STATE" ]; then
  CONSTRUCTION_PROGRESS=$(grep -ciE '\[x\] (code-generation|build-and-test)' "$STATE" || true)
  assert_gt "$CONSTRUCTION_PROGRESS" 0 "at least one Construction stage progressed"
else
  not_ok "at least one Construction stage progressed" "aidlc-state.md not found"
fi

# Test 6: Audit log has WORKFLOW_STARTED event
# Known scope invocations log WORKFLOW_STARTED, not SCOPE_DETECTED
# (SCOPE_DETECTED is only for freeform intent auto-detection)
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" "WORKFLOW_STARTED" "audit has WORKFLOW_STARTED event"
else
  not_ok "audit has WORKFLOW_STARTED event" "audit.md not found"
fi

cleanup_test_project "$PROJ"

finish
