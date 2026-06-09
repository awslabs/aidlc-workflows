#!/bin/bash
# t07: Unit tests for audit-logger.ts (16 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

HOOK="$AIDLC_SRC/hooks/aidlc-audit-logger.ts"

plan 16

# --- Test 1: Skips non-aidlc-docs writes ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
BEFORE=$(cat "$PROJ/aidlc-docs/audit.md")
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/other/file.txt"}}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
AFTER=$(cat "$PROJ/aidlc-docs/audit.md")
assert_eq "$AFTER" "$BEFORE" "skips non-aidlc-docs writes"
cleanup_test_project "$PROJ"

# --- Test 2: Skips audit.md self-writes (anti-recursion) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
BEFORE=$(cat "$PROJ/aidlc-docs/audit.md")
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/audit.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
AFTER=$(cat "$PROJ/aidlc-docs/audit.md")
assert_eq "$AFTER" "$BEFORE" "skips audit.md self-writes"
cleanup_test_project "$PROJ"

# --- Test 3: Logs aidlc-docs artifact writes ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/knowledge/aidlc-shared/intent.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "ARTIFACT_CREATED" "logs aidlc-docs artifact writes as ARTIFACT_CREATED"
cleanup_test_project "$PROJ"

# --- Test 4: Extracts correct context breadcrumb ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/ideation/intent-capture/intent.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "ideation > intent-capture > intent.md" "extracts correct context breadcrumb"
cleanup_test_project "$PROJ"

# --- Test 5: Logs Edit tool ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/state.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "ARTIFACT_UPDATED" "Edit tool emits ARTIFACT_UPDATED"
cleanup_test_project "$PROJ"

# --- Test 6: Exits silently when no audit.md ---
PROJ=$(create_test_project)
# Intentionally do NOT seed audit file
rm -f "$PROJ/aidlc-docs/audit.md"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/knowledge/aidlc-shared/test.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
if [ ! -f "$PROJ/aidlc-docs/audit.md" ]; then
  ok "exits silently when no audit.md (file not created)"
else
  not_ok "exits silently when no audit.md (file not created)" "audit.md was unexpectedly created"
fi
cleanup_test_project "$PROJ"

# --- Test 7: Writes heartbeat ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/test.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_file_exists "$PROJ/aidlc-docs/.aidlc-hooks-health/audit-logger.last" "writes heartbeat"
cleanup_test_project "$PROJ"

# --- Test 8: Handles empty stdin gracefully ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
BEFORE=$(cat "$PROJ/aidlc-docs/audit.md")
echo "" | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
RC=$?
AFTER=$(cat "$PROJ/aidlc-docs/audit.md")
if [ "$RC" -eq 0 ] && [ "$AFTER" = "$BEFORE" ]; then
  ok "handles empty stdin gracefully"
else
  not_ok "handles empty stdin gracefully" "exit=$RC, audit changed=$([ "$AFTER" != "$BEFORE" ] && echo yes || echo no)"
fi
cleanup_test_project "$PROJ"

# --- Test 9: Handles malformed JSON stdin ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
BEFORE=$(cat "$PROJ/aidlc-docs/audit.md")
echo "not-json" | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
RC=$?
AFTER=$(cat "$PROJ/aidlc-docs/audit.md")
if [ "$RC" -eq 0 ] && [ "$AFTER" = "$BEFORE" ]; then
  ok "handles malformed JSON stdin"
else
  not_ok "handles malformed JSON stdin" "exit=$RC, audit changed=$([ "$AFTER" != "$BEFORE" ] && echo yes || echo no)"
fi
cleanup_test_project "$PROJ"

# --- Test 10: CLAUDE_PROJECT_DIR fallback from script path ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
mkdir -p "$PROJ/.claude/hooks"
cp "$HOOK" "$PROJ/.claude/hooks/aidlc-audit-logger.ts"
mkdir -p "$PROJ/.claude/tools"
cp "$AIDLC_SRC/tools/aidlc-lib.ts" "$PROJ/.claude/tools/aidlc-lib.ts"
cp "$AIDLC_SRC/tools/aidlc-audit.ts" "$PROJ/.claude/tools/aidlc-audit.ts"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/test.md\"}}" | \
  bun "$PROJ/.claude/hooks/aidlc-audit-logger.ts" 2>/dev/null
assert_file_exists "$PROJ/aidlc-docs/.aidlc-hooks-health/audit-logger.last" "CLAUDE_PROJECT_DIR fallback from script path"
cleanup_test_project "$PROJ"

# --- Test 11: Construction phase context breadcrumb ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction.md"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/construction/functional-design/design.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "construction > functional-design > design.md" "construction phase context breadcrumb"
cleanup_test_project "$PROJ"

# --- Test 12: Operation phase context breadcrumb ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$FIXTURES_DIR/state-operation.md"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/operation/deployment-pipeline/config.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "operation > deployment-pipeline > config.md" "operation phase context breadcrumb"
cleanup_test_project "$PROJ"

# --- Test 13: Audit-logger completes within 500ms ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
T_START=$(date +%s%N)
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/test.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
T_END=$(date +%s%N)
ELAPSED_MS=$(( (T_END - T_START) / 1000000 ))
assert_lt "$ELAPSED_MS" 500 "audit-logger completes within 500ms (took ${ELAPSED_MS}ms)"
cleanup_test_project "$PROJ"

# --- Test 14: Audit-logger skip path timing ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
T_START=$(date +%s%N)
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/other/file.txt"}}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
T_END=$(date +%s%N)
ELAPSED_MS=$(( (T_END - T_START) / 1000000 ))
assert_lt "$ELAPSED_MS" 300 "audit-logger skip path completes within 300ms (took ${ELAPSED_MS}ms)"
cleanup_test_project "$PROJ"

# --- Test 15: Emits canonical **Event** field (not free-form markdown) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
# Start fresh so we only see this test's write
: > "$PROJ/aidlc-docs/audit.md"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/test.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: ARTIFACT_" "emits canonical **Event**: ARTIFACT_* field"
cleanup_test_project "$PROJ"

# --- Test 16: Write and Edit emit different events on same file ---
PROJ=$(create_test_project)
# Start with empty audit.md to count only events from this test's invocations.
mkdir -p "$PROJ/aidlc-docs"
: > "$PROJ/aidlc-docs/audit.md"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/x.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/x.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
CREATED=$(grep -c "ARTIFACT_CREATED" "$PROJ/aidlc-docs/audit.md")
UPDATED=$(grep -c "ARTIFACT_UPDATED" "$PROJ/aidlc-docs/audit.md")
if [ "$CREATED" = "1" ] && [ "$UPDATED" = "1" ]; then
  ok "Write→ARTIFACT_CREATED, Edit→ARTIFACT_UPDATED on same file"
else
  not_ok "Write→ARTIFACT_CREATED, Edit→ARTIFACT_UPDATED on same file" "created=$CREATED updated=$UPDATED"
fi
cleanup_test_project "$PROJ"

finish
