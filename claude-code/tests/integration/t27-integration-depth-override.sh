#!/bin/bash
# t27: Integration test — --depth flag override via claude CLI (7 tests)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=600

plan 7

# --- Test A: --depth minimal changes depth on existing state ---
PROJ_A=$(setup_integration_project --with-state "$FIXTURES_DIR/state-mid-ideation.md" --with-audit)
run_claude "$PROJ_A" "/aidlc --depth minimal --test-run"

STATE_A="$PROJ_A/aidlc-docs/aidlc-state.md"
AUDIT_A="$PROJ_A/aidlc-docs/audit.md"

assert_grep "$STATE_A" 'Depth.*Minimal' "depth override sets Depth to Minimal"
assert_grep "$AUDIT_A" 'DEPTH_CHANGED' "depth override logs DEPTH_CHANGED audit event"

cleanup_test_project "$PROJ_A"

# --- Test B: --scope bugfix --depth comprehensive overrides default ---
PROJ_B=$(setup_integration_project --no-aidlc-docs --with-brownfield-stub)
run_claude "$PROJ_B" "/aidlc bugfix --depth comprehensive --test-run"

STATE_B="$PROJ_B/aidlc-docs/aidlc-state.md"

assert_file_exists "$STATE_B" "state file created with scope+depth override"
assert_grep "$STATE_B" 'Depth.*Comprehensive' "depth comprehensive overrides bugfix default (Minimal)"
assert_grep "$STATE_B" '[Bb]ugfix' "bugfix scope recorded in state"

cleanup_test_project "$PROJ_B"

# --- Test C: --depth extreme (invalid) produces error ---
PROJ_C=$(setup_integration_project --with-state "$FIXTURES_DIR/state-mid-ideation.md" --with-audit)
run_claude "$PROJ_C" "/aidlc --depth extreme"

assert_contains "$CLAUDE_OUTPUT" "Unknown depth" "invalid depth produces error message"

# State should not change on error
MD5_BEFORE=$(md5sum "$PROJ_C/aidlc-docs/aidlc-state.md" 2>/dev/null | awk '{print $1}')
if [ -n "$MD5_BEFORE" ]; then
  run_claude "$PROJ_C" "/aidlc --depth extreme"
  MD5_AFTER=$(md5sum "$PROJ_C/aidlc-docs/aidlc-state.md" | awk '{print $1}')
  assert_eq "$MD5_BEFORE" "$MD5_AFTER" "invalid depth does not modify state"
else
  skip "state file not seeded for MD5 check"
fi

cleanup_test_project "$PROJ_C"

finish
