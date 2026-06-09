#!/bin/bash
# t23: Integration test for /aidlc --help (6 tests)
# Requires: claude CLI
#
# Strategy: the deterministic help text lives in `aidlc-utility.ts help` and
# SKILL.md instructs the orchestrator to run it and print the output verbatim.
# We split the test into two parts:
#   Part A — verify the deterministic help text has the expected content (runs
#     the tool directly, no LLM). This is the substantive assertion.
#   Part B — verify that `/aidlc --help` routed through Claude Code completes
#     without error and produces *some* output. We do not assert on the content
#     of the LLM response because Opus sometimes runs the tool internally and
#     gives a short summary instead of echoing the full text (claude -p doesn't
#     always surface tool stdout verbatim in the final response).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=120

plan 6

# ---------- Part A: deterministic help text ----------

TOOL="$AIDLC_SRC/tools/aidlc-utility.ts"
HELP_OUT=$(bun "$TOOL" help 2>&1)

# Test 1: Output contains AI-DLC
assert_contains "$HELP_OUT" "AI-DLC" "help output contains AI-DLC"

# Test 2: Output contains --status
assert_contains "$HELP_OUT" "--status" "help output contains --status"

# Test 3: Output contains --init
assert_contains "$HELP_OUT" "--init" "help output contains --init"

# Test 4: Output contains --doctor
assert_contains "$HELP_OUT" "--doctor" "help output contains --doctor"

# Test 5: Output contains enterprise
assert_contains "$HELP_OUT" "enterprise" "help output contains enterprise"

# ---------- Part B: /aidlc --help via Claude Code ----------

PROJ=$(setup_integration_project)

run_claude "$PROJ" "/aidlc --help"
RC="$CLAUDE_RC"

# Test 6: Claude Code completes --help without error
if [ "$RC" -eq 0 ]; then
  ok "/aidlc --help via claude completes successfully"
else
  not_ok "/aidlc --help via claude completes successfully" "exit code: $RC"
fi

cleanup_test_project "$PROJ"

finish
