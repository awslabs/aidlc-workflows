#!/bin/bash
# t29: Unit tests for sync-statusline.ts hook (7 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
HOOK="$AIDLC_SRC/hooks/aidlc-sync-statusline.ts"
MID_IDEATION="$FIXTURES_DIR/state-mid-ideation.md"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "1..0 # SKIP jq not installed"
  exit 0
fi

plan 7

# Helper: create test project with .claude/ symlinked so the hook can find tools
create_hook_test_project() {
  local proj
  proj=$(create_test_project)
  ln -s "$AIDLC_SRC" "$proj/.claude"
  echo "$proj"
}

# Test 1: Updates state when TaskUpdate in_progress with [slug]
PROJ=$(create_hook_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
# Mid-ideation has Current Stage = feasibility; update to scope-definition to verify change
echo '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Scope Definition [scope-definition]"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Current Stage.*scope-definition' "updates Current Stage on in_progress with [slug]"
cleanup_test_project "$PROJ"

# Test 2: Skips when status is completed
PROJ=$(create_hook_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
echo '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"completed"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
assert_eq "$MD5_BEFORE" "$MD5_AFTER" "skips when status is completed"
cleanup_test_project "$PROJ"

# Test 3: Skips when no activeForm
PROJ=$(create_hook_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
echo '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
assert_eq "$MD5_BEFORE" "$MD5_AFTER" "skips when no activeForm"
cleanup_test_project "$PROJ"

# Test 4: Skips when activeForm has no [slug] suffix
PROJ=$(create_hook_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
echo '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Validating jump target"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
assert_eq "$MD5_BEFORE" "$MD5_AFTER" "skips when activeForm has no [slug]"
cleanup_test_project "$PROJ"

# Test 5: Skips when no state file
PROJ=$(create_hook_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
echo '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Feasibility [feasibility]"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
RC=$?
assert_eq "$RC" "0" "exits 0 when no state file"
cleanup_test_project "$PROJ"

# Test 6: Updates Lifecycle Phase from stage graph
PROJ=$(create_hook_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
echo '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Code Generation [code-generation]"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Lifecycle Phase.*CONSTRUCTION' "updates Lifecycle Phase from stage graph"
cleanup_test_project "$PROJ"

# Test 7: Writes health heartbeat
PROJ=$(create_hook_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
rm -f "$PROJ/aidlc-docs/.aidlc-hooks-health/sync-statusline.last"
echo '{"tool_name":"TaskUpdate","tool_input":{"taskId":"t1","status":"in_progress","activeForm":"Running Feasibility [feasibility]"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_file_exists "$PROJ/aidlc-docs/.aidlc-hooks-health/sync-statusline.last" "writes health heartbeat"
cleanup_test_project "$PROJ"

finish
