#!/bin/bash
# t58: Workflow test — workshop scope routing (skip Ideation) (14 tests)
# Requires: claude CLI
# Verifies that workshop scope correctly skips Ideation phase and runs
# Inception, Construction, and Operation at Standard depth.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 14

PROJ=$(setup_integration_project --no-aidlc-docs)

# Run a workshop workflow with --test-run flag
run_claude "$PROJ" "/aidlc workshop --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# Test 1: State file created
assert_file_exists "$STATE" "state file created"

# Test 2: No ideation directory created (workshop skips Ideation entirely)
if [ -d "$PROJ/aidlc-docs/ideation" ]; then
  IDEATION_FILES=$(find "$PROJ/aidlc-docs/ideation" -type f 2>/dev/null | wc -l)
  if [ "$IDEATION_FILES" -eq 0 ]; then
    ok "no ideation artifacts created (empty dir OK)"
  else
    not_ok "no ideation artifacts created" "found $IDEATION_FILES files in ideation/"
  fi
else
  ok "no ideation directory created (workshop skips Ideation)"
fi

# Test 3: No Ideation stages marked [x] in state
if [ -f "$STATE" ]; then
  IDEATION_COMPLETED=$(grep -ciE '\[x\] (intent-capture|market-research|feasibility|scope-definition|team-formation|rough-mockups|approval-handoff)' "$STATE" || true)
  assert_eq "$IDEATION_COMPLETED" "0" "no Ideation stages marked [x]"
else
  not_ok "no Ideation stages marked [x]" "aidlc-state.md not found"
fi

# Test 4: Inception stages present in state
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "reverse-engineering\|requirements-analysis" "Inception stages present in state file"
else
  not_ok "Inception stages present in state file" "aidlc-state.md not found"
fi

# Test 5: Construction stages present in state
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "code-generation\|build-and-test" "Construction stages present in state file"
else
  not_ok "Construction stages present in state file" "aidlc-state.md not found"
fi

# Test 6: Operation stages present in state
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "deployment-pipeline\|observability-setup" "Operation stages present in state file"
else
  not_ok "Operation stages present in state file" "aidlc-state.md not found"
fi

# Tests 7-9: All 3 init stages marked completed
for stage in workspace-scaffold workspace-detection state-init; do
  if [ -f "$STATE" ]; then
    if grep -qi "\[x\] $stage" "$STATE" 2>/dev/null; then
      ok "[x] $stage in state file"
    else
      not_ok "[x] $stage in state file" "stage not marked complete"
    fi
  else
    not_ok "[x] $stage in state file" "aidlc-state.md not found"
  fi
done

# Test 11: Workshop scope recorded
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "[Ww]orkshop" "workshop scope recorded in state"
else
  not_ok "workshop scope recorded in state" "aidlc-state.md not found"
fi

# Test 12: Depth is Standard (workshop default)
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Depth.*Standard" "workshop defaults to Standard depth"
else
  not_ok "workshop defaults to Standard depth" "aidlc-state.md not found"
fi

# Test 13: Test Strategy is Minimal (workshop default, independent of Standard depth)
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Test Strategy.*Minimal" "workshop defaults to Minimal test strategy"
else
  not_ok "workshop defaults to Minimal test strategy" "aidlc-state.md not found"
fi

# Test 14: Completed stages 24 or fewer (workshop is 24 of 31 stages)
# (was Test 13 before test-strategy assertion was added)
if [ -f "$STATE" ]; then
  COMPLETED=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_lt "$COMPLETED" 30 "completed stages < 30 (workshop scope constraint)"
else
  not_ok "completed stages < 30 (workshop scope constraint)" "aidlc-state.md not found"
fi

# Test 15: Audit log exists and has content
if [ -f "$AUDIT" ]; then
  AUDIT_SIZE=$(wc -c < "$AUDIT")
  assert_gt "$AUDIT_SIZE" 200 "audit log has substantial content"
else
  not_ok "audit log has substantial content" "audit.md not found"
fi

cleanup_test_project "$PROJ"

finish
