#!/bin/bash
# t56: Workflow test — forward jump + auto-init with --test-run (8 tests)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 8

# Test: Jump to reverse-engineering with bugfix scope (no state file), run with --test-run
# Target reverse-engineering (lightweight inception stage) instead of code-generation to avoid timeout
PROJ=$(setup_integration_project --no-aidlc-docs --with-brownfield-stub)
run_claude "$PROJ" "/aidlc --stage reverse-engineering --scope bugfix --test-run"

# Guard: detect silent timeout (exit 124 = timeout with empty output)
assert_not_eq "$CLAUDE_RC" "124" "Claude CLI did not timeout"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# Should have auto-initialized
assert_dir_exists "$PROJ/aidlc-docs" "aidlc-docs directory created"
assert_file_exists "$STATE" "state file created"

# Scope should be bugfix
if [ -f "$STATE" ]; then
  assert_grep "$STATE" 'bugfix' "scope is bugfix"
else
  not_ok "scope is bugfix" "aidlc-state.md not found"
fi

# Should have [S] for stages before reverse-engineering
if [ -f "$STATE" ]; then
  assert_grep "$STATE" '\[S\]' "skipped stages marked [S]"
else
  not_ok "skipped stages marked [S]" "aidlc-state.md not found"
fi

# reverse-engineering should have been executed or be in progress
if [ -f "$STATE" ]; then
  assert_grep "$STATE" 'reverse-engineering' "reverse-engineering is referenced in state"
else
  not_ok "reverse-engineering is referenced in state" "aidlc-state.md not found"
fi

# Audit should have STAGE_JUMPED
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" 'STAGE_JUMPED' "audit has STAGE_JUMPED"
else
  not_ok "audit has STAGE_JUMPED" "audit.md not found"
fi

# Phase should be INCEPTION
if [ -f "$STATE" ]; then
  assert_grep "$STATE" 'INCEPTION' "lifecycle phase is INCEPTION"
else
  not_ok "lifecycle phase is INCEPTION" "aidlc-state.md not found"
fi

cleanup_test_project "$PROJ"

finish
