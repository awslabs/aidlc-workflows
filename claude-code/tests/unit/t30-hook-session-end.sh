#!/bin/bash
# t30: Unit tests for session-end.ts (7 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
HOOK="$AIDLC_SRC/hooks/aidlc-session-end.ts"
MID_IDEATION="$FIXTURES_DIR/state-mid-ideation.md"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 7

# --- Test 1: Emits SESSION_ENDED when active workflow exists ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo '{"reason":"logout"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "SESSION_ENDED" "emits SESSION_ENDED when active workflow exists"
cleanup_test_project "$PROJ"

# --- Test 2: Includes reason field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo '{"reason":"logout"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "\*\*Reason\*\*: logout" "records reason field"
cleanup_test_project "$PROJ"

# --- Test 3: No-op when state file absent (no active workflow) ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
seed_audit_file "$PROJ"
BEFORE=$(wc -l < "$PROJ/aidlc-docs/audit.md")
echo '{"reason":"logout"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
AFTER=$(wc -l < "$PROJ/aidlc-docs/audit.md")
if [ "$BEFORE" = "$AFTER" ]; then
  ok "no-op when state file absent"
else
  not_ok "no-op when state file absent" "audit grew from $BEFORE to $AFTER lines"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Writes heartbeat when active workflow exists ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo '{"reason":"logout"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_file_exists "$PROJ/aidlc-docs/.aidlc-hooks-health/session-end.last" "writes heartbeat when active workflow exists"
cleanup_test_project "$PROJ"

# --- Test 5: Handles empty stdin gracefully ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo "" | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "handles empty stdin gracefully (exit 0)"
else
  not_ok "handles empty stdin gracefully" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 6: Defaults reason to 'unknown' when no stdin ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo "" | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "\*\*Reason\*\*: unknown" "defaults reason to 'unknown'"
cleanup_test_project "$PROJ"

# --- Test 7: No heartbeat when state file absent ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
rm -rf "$PROJ/aidlc-docs/.aidlc-hooks-health"
echo '{"reason":"logout"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
if [ ! -f "$PROJ/aidlc-docs/.aidlc-hooks-health/session-end.last" ]; then
  ok "no heartbeat when state file absent"
else
  not_ok "no heartbeat when state file absent" "heartbeat unexpectedly written"
fi
cleanup_test_project "$PROJ"

finish
