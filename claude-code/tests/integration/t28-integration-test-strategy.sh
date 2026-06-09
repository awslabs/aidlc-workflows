#!/bin/bash
# t28: Integration test — --test-strategy flag via claude CLI (6 tests)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=600

plan 6

# --- Test A: --test-strategy minimal changes strategy on existing state ---
PROJ_A=$(setup_integration_project --with-state "$FIXTURES_DIR/state-mid-ideation.md" --with-audit)
run_claude "$PROJ_A" "/aidlc --test-strategy minimal --test-run"

STATE_A="$PROJ_A/aidlc-docs/aidlc-state.md"
AUDIT_A="$PROJ_A/aidlc-docs/audit.md"

assert_grep "$STATE_A" 'Test Strategy.*Minimal' "test-strategy override sets Test Strategy to Minimal"
assert_grep "$AUDIT_A" 'TEST_STRATEGY_CHANGED' "test-strategy override logs TEST_STRATEGY_CHANGED audit event"

cleanup_test_project "$PROJ_A"

# --- Test B: --test-strategy extreme (invalid) produces error ---
PROJ_B=$(setup_integration_project --with-state "$FIXTURES_DIR/state-mid-ideation.md" --with-audit)
run_claude "$PROJ_B" "/aidlc --test-strategy extreme"

assert_contains "$CLAUDE_OUTPUT" "Unknown test strategy" "invalid test strategy produces error message"

cleanup_test_project "$PROJ_B"

# --- Test C: --depth and --test-strategy apply together in a single invocation ---
# The orchestrator routes both flags through config-change in one atomic call.
# Audit-count assertions catch LLM drift into separate CLI invocations (the
# original bug: step 8 STOPped before step 9 could fire).
PROJ_C=$(setup_integration_project --with-state "$FIXTURES_DIR/state-mid-ideation.md" --with-audit)

run_claude "$PROJ_C" "/aidlc --depth standard --test-strategy minimal --test-run"

STATE_C="$PROJ_C/aidlc-docs/aidlc-state.md"
AUDIT_C="$PROJ_C/aidlc-docs/audit.md"

assert_grep "$STATE_C" 'Depth.*Standard' "combined --depth --test-strategy: Depth is Standard"
assert_grep "$STATE_C" 'Test Strategy.*Minimal' "combined --depth --test-strategy: Test Strategy is Minimal"
STRAT_COUNT=$(grep -c '^\*\*Event\*\*: TEST_STRATEGY_CHANGED' "$AUDIT_C")
assert_eq "$STRAT_COUNT" "1" "combined --depth --test-strategy: exactly one TEST_STRATEGY_CHANGED event"

cleanup_test_project "$PROJ_C"

finish
