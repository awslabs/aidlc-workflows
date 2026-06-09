#!/bin/bash
# t18: Unit tests for aidlc-audit.ts CLI tool (13 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-audit.ts"

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 13

# --- Test 1: append creates audit.md if missing ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/audit.md"
bun "$TOOL" append STAGE_COMPLETED --field "Stage=workspace-scaffold" --project-dir "$PROJ" >/dev/null 2>&1
assert_file_exists "$PROJ/aidlc-docs/audit.md" "append creates audit.md"
cleanup_test_project "$PROJ"

# --- Test 2: append writes header ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/audit.md"
bun "$TOOL" append STAGE_COMPLETED --field "Stage=workspace-scaffold" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "# AI-DLC Audit Log" "append writes header"
cleanup_test_project "$PROJ"

# --- Test 3: append writes event type ---
PROJ=$(create_test_project)
bun "$TOOL" append STAGE_COMPLETED --field "Stage=workspace-scaffold" --field "Details=Done" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "STAGE_COMPLETED" "append writes event type"
cleanup_test_project "$PROJ"

# --- Test 4: append writes field values ---
PROJ=$(create_test_project)
bun "$TOOL" append STAGE_COMPLETED --field "Stage=intent-capture" --field "Details=Q&A done" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "intent-capture" "append writes Stage field"
assert_grep "$PROJ/aidlc-docs/audit.md" "Q&A done" "append writes Details field"
cleanup_test_project "$PROJ"

# --- Test 5: append generates ISO timestamp ---
PROJ=$(create_test_project)
bun "$TOOL" append HEALTH_CHECKED --field "Details=All pass" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T[0-9]\{2\}:[0-9]\{2\}:[0-9]\{2\}Z' "append generates ISO timestamp"
cleanup_test_project "$PROJ"

# --- Test 6: append rejects invalid event type ---
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" append INVALID_EVENT --project-dir "$PROJ" 2>&1) || true
assert_contains "$OUT" "error" "append rejects invalid event type"
cleanup_test_project "$PROJ"

# --- Test 7: append returns JSON success ---
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" append WORKFLOW_STARTED --field "Scope=feature" --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"appended":true' "append returns JSON success"
cleanup_test_project "$PROJ"

# --- Test 8: multiple appends accumulate ---
PROJ=$(create_test_project)
bun "$TOOL" append STAGE_STARTED --field "Stage=workspace-scaffold" --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" append STAGE_COMPLETED --field "Stage=workspace-scaffold" --project-dir "$PROJ" >/dev/null 2>&1
COUNT=$(grep -c "^---" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$COUNT" "2" "multiple appends accumulate (2 separators)"
cleanup_test_project "$PROJ"

# --- Test 9: append-raw uses custom heading ---
PROJ=$(create_test_project)
bun "$TOOL" append-raw "Custom Event" "**Event**: CUSTOM\n**Details**: Something happened" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "## Custom Event" "append-raw uses custom heading"
cleanup_test_project "$PROJ"

# --- Test 10: append writes separator ---
PROJ=$(create_test_project)
bun "$TOOL" append STAGE_COMPLETED --field "Stage=workspace-scaffold" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^---$" "append writes separator line"
cleanup_test_project "$PROJ"

# --- Test 11: append writes human-readable heading ---
PROJ=$(create_test_project)
bun "$TOOL" append WORKSPACE_SCANNED --field "Details=Greenfield" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "## Workspace Scanned" "append writes heading for WORKSPACE_SCANNED"
cleanup_test_project "$PROJ"

# --- Test 12: initialization event type accepted ---
PROJ=$(create_test_project)
bun "$TOOL" append WORKSPACE_SCANNED --field "Details=test" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "WORKSPACE_SCANNED" "initialization event WORKSPACE_SCANNED accepted"
cleanup_test_project "$PROJ"

finish
