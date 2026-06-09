#!/bin/bash
# t20: Integration test for /aidlc --status (7 tests)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

MID_IDEATION="$FIXTURES_DIR/state-mid-ideation.md"

AIDLC_TEST_TIMEOUT=180

plan 7

# --- With state file (tests 1-5) ---
PROJ=$(setup_integration_project --with-state "$MID_IDEATION")

MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | cut -d' ' -f1)

run_claude "$PROJ" "/aidlc --status"
OUTPUT="$CLAUDE_OUTPUT"

# Test 1: Output contains IDEATION
assert_contains "$OUTPUT" "IDEATION" "status output contains IDEATION"

# Test 2: Output contains feasibility (case-insensitive — Claude may title-case)
assert_match "$OUTPUT" "[Ff]easibility" "status output contains feasibility"

# Test 3: Output contains feature
assert_contains "$OUTPUT" "feature" "status output contains feature"

# Test 4: State file unchanged
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | cut -d' ' -f1)
assert_eq "$MD5_AFTER" "$MD5_BEFORE" "state file unchanged after --status"

# Test 5: No new .md files created
NEW_FILES=$(find "$PROJ/aidlc-docs" -name "*.md" -newer "$PROJ/aidlc-docs/aidlc-state.md" -not -name "audit.md" -not -name ".aidlc-recovery.md" 2>/dev/null | wc -l)
if [ "$NEW_FILES" -eq 0 ]; then
  ok "no new .md files created in aidlc-docs/"
else
  not_ok "no new .md files created in aidlc-docs/" "found $NEW_FILES new files"
fi

cleanup_test_project "$PROJ"

# --- Without state file (tests 6-7) ---
PROJ=$(setup_integration_project --no-aidlc-docs)

run_claude "$PROJ" "/aidlc --status"
OUTPUT="$CLAUDE_OUTPUT"
RC="$CLAUDE_RC"

# Test 6: Output indicates no active workflow
if echo "$OUTPUT" | grep -qiE "no.*workflow|no.*state|not found|no.*active|not.*initialized"; then
  ok "no-state status indicates no active workflow"
else
  not_ok "no-state status indicates no active workflow" "output: $OUTPUT"
fi

# Test 7: Exit code is 0
if [ "$RC" -eq 0 ]; then
  ok "no-state status exits gracefully (exit 0)"
else
  not_ok "no-state status exits gracefully (exit 0)" "exit code: $RC"
fi

cleanup_test_project "$PROJ"

finish
