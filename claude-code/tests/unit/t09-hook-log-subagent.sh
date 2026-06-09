#!/bin/bash
# t09: Unit tests for log-subagent.ts (8 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

HOOK="$AIDLC_SRC/hooks/aidlc-log-subagent.ts"

plan 8

# --- Test 1: Logs subagent completion ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "SUBAGENT_COMPLETED" "logs subagent completion as SUBAGENT_COMPLETED event"
cleanup_test_project "$PROJ"

# --- Test 2: Handles missing agent_id ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{"agent_type":"developer"}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
# Entry should be written with agent type but no Agent ID line
assert_grep "$PROJ/aidlc-docs/audit.md" "developer" "handles missing agent_id — agent type present"
cleanup_test_project "$PROJ"

# --- Test 3: Exits silently when no audit.md ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/audit.md"
echo '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"Done"}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
if [ ! -f "$PROJ/aidlc-docs/audit.md" ]; then
  ok "exits silently when no audit.md"
else
  not_ok "exits silently when no audit.md" "audit.md was unexpectedly created"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Writes heartbeat ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{"agent_type":"quality"}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_file_exists "$PROJ/aidlc-docs/.aidlc-hooks-health/log-subagent.last" "writes heartbeat"
cleanup_test_project "$PROJ"

# --- Test 5: Handles empty stdin gracefully ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
BEFORE=$(cat "$PROJ/aidlc-docs/audit.md")
echo "" | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "handles empty stdin gracefully (exit 0)"
else
  not_ok "handles empty stdin gracefully (exit 0)" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 6: Truncates long messages ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
# Generate a 500-char message
LONG_MSG=$(printf 'A%.0s' {1..500})
echo "{\"agent_type\":\"developer\",\"agent_id\":\"xyz\",\"last_assistant_message\":\"$LONG_MSG\"}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
# The entry should exist but the full 500-char message should be truncated
assert_grep "$PROJ/aidlc-docs/audit.md" "developer" "truncates long messages — entry written"
# Verify the full 500-char string is NOT in the audit (it was truncated to 200)
assert_not_grep "$PROJ/aidlc-docs/audit.md" "A\{500\}" "long message was truncated"
cleanup_test_project "$PROJ"

# --- Test 8: Event field shape (canonical, no free-form markdown) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{"agent_type":"architect","agent_id":"abc-123","last_assistant_message":"done"}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "\*\*Event\*\*: SUBAGENT_COMPLETED" "emits canonical Event field"
cleanup_test_project "$PROJ"

finish
