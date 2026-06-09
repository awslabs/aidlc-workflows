#!/bin/bash
# t71: Stage test — workspace detection classifies brownfield stub (10 assertions)
# Runs /aidlc --init --force --test-run against a seeded state + brownfield stub.
# The deterministic scanner inside aidlc-utility init runs in <1s so none of
# the classification assertions need CLAUDE_RC=124 skip guards anymore.
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 10

# Setup: scaffold project with brownfield stub, pre-seeded state at workspace-detection
PROJ=$(setup_integration_project \
  --with-state "$FIXTURES_DIR/state-pre-workspace-detection.md" \
  --with-brownfield-stub \
  --with-audit)

# --force so init runs on the seeded state; --test-run auto-confirms any prompts
run_claude "$PROJ" "/aidlc --init --force --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"

# Test 1: State file still exists
assert_file_exists "$STATE" "state file still exists"

# Test 2: Completed counter matches [x] count
if [ -f "$STATE" ]; then
  X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
  COMPLETED=$(grep 'Completed' "$STATE" | grep -oE '[0-9]+' | head -1 || true)
  COMPLETED="${COMPLETED:-0}"
  assert_eq "$X_COUNT" "$COMPLETED" "Completed counter ($COMPLETED) matches [x] count ($X_COUNT)"
else
  not_ok "Completed counter matches [x] count" "aidlc-state.md not found"
fi

# Test 3: Project Type contains brownfield
assert_grep "$STATE" "[Bb]rownfield" "Project Type is brownfield"

# Test 4: Frameworks field lists React (scoped — not elsewhere in the file)
assert_grep "$STATE" "^- \*\*Frameworks\*\*:.*React" "Frameworks field lists React"

# Test 5: Languages field lists TypeScript (scoped — not elsewhere in the file)
assert_grep "$STATE" "^- \*\*Languages\*\*:.*TypeScript" "Languages field lists TypeScript"

# Test 6: Audit has WORKSPACE_SCANNED
assert_grep "$PROJ/aidlc-docs/audit.md" "WORKSPACE_SCANNED" "audit has WORKSPACE_SCANNED event"

# Test 7: [x] count >= 3 (three init stages complete)
if [ -f "$STATE" ]; then
  X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$X_COUNT" 2 "completed >= 3 (all init stages), got $X_COUNT"
else
  not_ok "completed >= 3" "aidlc-state.md not found"
fi

# Test 8: State version is 7
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "State Version.*: 7" "state version is 7"
else
  not_ok "state version is 7" "aidlc-state.md not found"
fi

# Test 9: Languages field populated
assert_grep "$STATE" "Languages" "Languages field present"

# Test 10: Frameworks field populated
assert_grep "$STATE" "Frameworks" "Frameworks field present"

cleanup_test_project "$PROJ"

finish
