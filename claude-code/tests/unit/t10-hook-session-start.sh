#!/bin/bash
# t10: Unit tests for session-start.ts (17 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

HOOK="$AIDLC_SRC/hooks/aidlc-session-start.ts"
MID_IDEATION="$FIXTURES_DIR/state-mid-ideation.md"

plan 17

# --- Test 1: Silent exit when no state file ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>&1)
if [ -z "$OUTPUT" ]; then
  ok "silent exit when no state file"
else
  not_ok "silent exit when no state file" "got output: $OUTPUT"
fi
cleanup_test_project "$PROJ"

# --- Test 2: No heartbeat when no state file ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
if [ ! -f "$PROJ/aidlc-docs/.aidlc-hooks-health/session-start.last" ]; then
  ok "no heartbeat when no state file"
else
  not_ok "no heartbeat when no state file" "heartbeat was unexpectedly created"
fi
cleanup_test_project "$PROJ"

# --- Test 3: Outputs valid JSON ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
if echo "$OUTPUT" | jq -e '.additionalContext' >/dev/null 2>&1; then
  ok "outputs valid JSON with additionalContext key"
else
  not_ok "outputs valid JSON with additionalContext key" "output: $OUTPUT"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Extracts Lifecycle Phase ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "IDEATION" "extracts Lifecycle Phase"
cleanup_test_project "$PROJ"

# --- Test 5: Extracts Current Stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "feasibility" "extracts Current Stage"
cleanup_test_project "$PROJ"

# --- Test 6: Extracts Active Agent ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "aidlc-architect-agent" "extracts Active Agent"
cleanup_test_project "$PROJ"

# --- Test 7: Extracts Scope ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "feature" "extracts Scope"
cleanup_test_project "$PROJ"

# --- Test 8: Includes recovery breadcrumb note ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
mkdir -p "$PROJ/aidlc-docs"
echo "# Recovery breadcrumb" > "$PROJ/aidlc-docs/.aidlc-recovery.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "recovery breadcrumb" "includes recovery breadcrumb note"
cleanup_test_project "$PROJ"

# --- Test 9: No recovery note when no breadcrumb ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
rm -f "$PROJ/aidlc-docs/.aidlc-recovery.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_not_contains "$OUTPUT" "recovery breadcrumb" "no recovery note when no breadcrumb"
cleanup_test_project "$PROJ"

# --- Test 10: Writes heartbeat when state exists ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" >/dev/null 2>/dev/null
assert_file_exists "$PROJ/aidlc-docs/.aidlc-hooks-health/session-start.last" "writes heartbeat when state exists"
cleanup_test_project "$PROJ"

# --- Test 11: Extracts CONSTRUCTION phase from construction fixture ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "CONSTRUCTION" "extracts CONSTRUCTION phase"
cleanup_test_project "$PROJ"

# --- Test 12: Extracts OPERATION phase from operation fixture ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-operation.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "OPERATION" "extracts OPERATION phase"
cleanup_test_project "$PROJ"

# --- Test 13: Graceful handling of corrupted fixture ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-corrupted.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "corrupted fixture does not crash session-start (exit 0)"
else
  not_ok "corrupted fixture does not crash session-start" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 14: source=startup emits SESSION_STARTED ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" >/dev/null 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "SESSION_STARTED" "source=startup emits SESSION_STARTED"
cleanup_test_project "$PROJ"

# --- Test 15: source=resume emits SESSION_RESUMED ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo '{"source":"resume"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" >/dev/null 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "SESSION_RESUMED" "source=resume emits SESSION_RESUMED"
cleanup_test_project "$PROJ"

# --- Test 16: source=clear emits SESSION_STARTED ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo '{"source":"clear"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" >/dev/null 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "SESSION_STARTED" "source=clear emits SESSION_STARTED"
cleanup_test_project "$PROJ"

# --- Test 17: source=compact does NOT emit (owned by PreCompact) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
echo '{"source":"compact"}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" >/dev/null 2>/dev/null
assert_not_grep "$PROJ/aidlc-docs/audit.md" "SESSION_COMPACTED" "source=compact does not emit (PreCompact owns it)"
cleanup_test_project "$PROJ"

finish
