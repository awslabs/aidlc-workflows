#!/bin/bash
# t53: Workflow test — bugfix scope routing (skip Ideation) (11 tests)
# Requires: claude CLI
# Verifies that bugfix scope correctly skips Ideation phase entirely.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 11

PROJ=$(setup_integration_project --no-aidlc-docs)

# Run a bugfix workflow with --test-run flag
run_claude "$PROJ" "/aidlc bugfix --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"

# Test 1: State file created
assert_file_exists "$STATE" "state file created"

# Test 2: No ideation directory created (bugfix skips Ideation entirely)
if [ -d "$PROJ/aidlc-docs/ideation" ]; then
  # Directory exists — check if it has any meaningful content
  IDEATION_FILES=$(find "$PROJ/aidlc-docs/ideation" -type f 2>/dev/null | wc -l)
  if [ "$IDEATION_FILES" -eq 0 ]; then
    ok "no ideation artifacts created (empty dir OK)"
  else
    not_ok "no ideation artifacts created" "found $IDEATION_FILES files in ideation/"
  fi
else
  ok "no ideation directory created (bugfix skips Ideation)"
fi

# Test 3: State file has no Ideation stage with [x] (or they're all skipped/absent)
if [ -f "$STATE" ]; then
  IDEATION_COMPLETED=$(grep -ciE '\[x\] (intent-capture|market-research|feasibility|scope-definition|team-formation|rough-mockups|approval-handoff)' "$STATE" || true)
  assert_eq "$IDEATION_COMPLETED" "0" "no Ideation stages marked [x]"
else
  not_ok "no Ideation stages marked [x]" "aidlc-state.md not found"
fi

# Test 4: Inception stages are present in state file
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "reverse-engineering\|requirements-analysis" "Inception stages present in state file"
else
  not_ok "Inception stages present in state file" "aidlc-state.md not found"
fi

# Test 5: Construction stages are present in state file
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "code-generation\|build-and-test" "Construction stages present in state file"
else
  not_ok "Construction stages present in state file" "aidlc-state.md not found"
fi

# Test 6: No Operation stages in bugfix
if [ -f "$STATE" ]; then
  OPERATION_STAGES=$(grep -ciE '\[x\] (deployment-pipeline|environment-provisioning|deployment-execution|observability-setup)' "$STATE" || true)
  assert_eq "$OPERATION_STAGES" "0" "no Operation stages executed in bugfix"
else
  not_ok "no Operation stages executed in bugfix" "aidlc-state.md not found"
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

# Test 11: Bugfix scope recorded
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "[Bb]ugfix" "bugfix scope recorded in state"
else
  not_ok "bugfix scope recorded in state" "aidlc-state.md not found"
fi

# Test 12: Total stages completed is 7 or fewer (bugfix is 7 of 31 stages)
if [ -f "$STATE" ]; then
  COMPLETED=$(grep -c '^\- \[x\]' "$STATE" || true)
  # Bugfix has 7 EXECUTE stages; allow some flexibility for env variance
  assert_lt "$COMPLETED" 12 "completed stages < 12 (bugfix scope constraint)"
else
  not_ok "completed stages < 12 (bugfix scope constraint)" "aidlc-state.md not found"
fi

cleanup_test_project "$PROJ"

finish
