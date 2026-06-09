#!/bin/bash
# t21: Integration test for /aidlc --init — first run (10 tests)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 10

PROJ=$(setup_integration_project --no-aidlc-docs)

run_claude "$PROJ" "/aidlc --init"

# Test 1: aidlc-state.md exists
assert_file_exists "$PROJ/aidlc-docs/aidlc-state.md" "init creates aidlc-state.md"

# Test 2: audit.md exists
assert_file_exists "$PROJ/aidlc-docs/audit.md" "init creates audit.md"

# Test 3: State file contains the current State Version
if [ -f "$PROJ/aidlc-docs/aidlc-state.md" ]; then
  assert_grep "$PROJ/aidlc-docs/aidlc-state.md" "State Version.*: 7$" "state file has State Version 7"
  assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\*\*Worktree Path\*\*:' "state file has Worktree Path field"
  assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\*\*Bolt Refs\*\*:' "state file has Bolt Refs field"
  assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\*\*Practices Affirmed Timestamp\*\*:' "state file has Practices Affirmed Timestamp field"
else
  not_ok "state file has State Version 7" "aidlc-state.md not found"
fi

# Tests 4-6: All 3 init stages marked completed
for stage in workspace-scaffold workspace-detection state-init; do
  if [ -f "$PROJ/aidlc-docs/aidlc-state.md" ]; then
    if grep -qi "\[x\] $stage" "$PROJ/aidlc-docs/aidlc-state.md" 2>/dev/null; then
      ok "[x] $stage in state file"
    else
      not_ok "[x] $stage in state file" "stage not marked complete"
    fi
  else
    not_ok "[x] $stage in state file" "aidlc-state.md not found"
  fi
done

# Test 7: knowledge/ directory exists
assert_dir_exists "$PROJ/aidlc-docs/knowledge" "init creates knowledge/ directory"

cleanup_test_project "$PROJ"

finish
