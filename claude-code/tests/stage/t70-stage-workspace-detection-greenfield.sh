#!/bin/bash
# t70: Stage test — workspace detection classifies greenfield stub (8 assertions)
# Runs /aidlc --init --force --test-run against a seeded state + greenfield stub.
# The deterministic scanner inside aidlc-utility init runs in <1s so none of
# the classification assertions need CLAUDE_RC=124 skip guards anymore.
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 8

# Setup: scaffold project with greenfield stub, pre-seeded state at workspace-detection
PROJ=$(setup_integration_project \
  --with-state "$FIXTURES_DIR/state-pre-workspace-detection.md" \
  --with-greenfield-stub \
  --with-audit)

# --force so init runs on the seeded state; --test-run auto-confirms any prompts
run_claude "$PROJ" "/aidlc --init --force --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"

# Test 1: State file still exists
assert_file_exists "$STATE" "state file still exists"

# Test 2: Completed counter matches [x] count (internal consistency)
if [ -f "$STATE" ]; then
  X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
  COMPLETED=$(grep 'Completed' "$STATE" | grep -oE '[0-9]+' | head -1 || true)
  COMPLETED="${COMPLETED:-0}"
  assert_eq "$X_COUNT" "$COMPLETED" "Completed counter ($COMPLETED) matches [x] count ($X_COUNT)"
else
  not_ok "Completed counter matches [x] count" "aidlc-state.md not found"
fi

# Test 3: Project Type contains greenfield
assert_grep "$STATE" "[Gg]reenfield" "Project Type is greenfield"

# Test 4: Audit has WORKSPACE_SCANNED
assert_grep "$PROJ/aidlc-docs/audit.md" "WORKSPACE_SCANNED" "audit has WORKSPACE_SCANNED event"

# Test 5: [x] count >= 3 (three init stages complete after --force reinit)
if [ -f "$STATE" ]; then
  X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$X_COUNT" 2 "completed >= 3 (all init stages), got $X_COUNT"
else
  not_ok "completed >= 3" "aidlc-state.md not found"
fi

# Test 6: Project Root is populated
if [ -f "$STATE" ]; then
  PROJECT_ROOT=$(grep -i "Project Root" "$STATE" | head -1 || true)
  if echo "$PROJECT_ROOT" | grep -qv '—'; then
    ok "Project Root is populated"
  else
    not_ok "Project Root is populated" "Project Root still has placeholder"
  fi
else
  not_ok "Project Root is populated" "aidlc-state.md not found"
fi

# Test 7: State version is 7
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "State Version.*: 7" "state version is 7"
else
  not_ok "state version is 7" "aidlc-state.md not found"
fi

# Test 8: Project Type does NOT say brownfield (negative)
if [ -f "$STATE" ]; then
  PROJECT_TYPE=$(grep -i "Project Type" "$STATE" | head -1 || true)
  if echo "$PROJECT_TYPE" | grep -qi "brownfield"; then
    not_ok "Project Type is not brownfield" "Project Type line: $PROJECT_TYPE"
  else
    ok "Project Type is not brownfield"
  fi
else
  not_ok "Project Type is not brownfield" "aidlc-state.md not found"
fi

cleanup_test_project "$PROJ"

finish
