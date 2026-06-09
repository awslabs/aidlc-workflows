#!/bin/bash
# t19: Unit tests for aidlc-jump.ts CLI tool (16 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-jump.ts"
STATE_TOOL="$AIDLC_SRC/tools/aidlc-state.ts"

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 16

# --- Test 1: resolve forward jump ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" resolve --stage code-generation --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"direction":"forward"' "resolve detects forward direction"
cleanup_test_project "$PROJ"

# --- Test 2: resolve backward jump ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" resolve --stage feasibility --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"direction":"backward"' "resolve detects backward direction"
cleanup_test_project "$PROJ"

# --- Test 3: resolve redo jump ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" resolve --stage feasibility --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"direction":"redo"' "resolve detects redo direction"
cleanup_test_project "$PROJ"

# --- Test 4: resolve phase jump finds first in-scope stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
OUT=$(bun "$TOOL" resolve --phase construction --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"target_slug":"functional-design"' "resolve phase construction → functional-design"
cleanup_test_project "$PROJ"

# --- Test 5: resolve rejects SKIP stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
OUT=$(bun "$TOOL" resolve --stage intent-capture --scope bugfix --project-dir "$PROJ" 2>&1) || true
assert_contains "$OUT" "skipped for scope" "resolve rejects SKIP stage"
cleanup_test_project "$PROJ"

# --- Test 6: resolve lists affected stages for forward jump ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
OUT=$(bun "$TOOL" resolve --stage code-generation --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" "affected_stages" "resolve returns affected stages"
cleanup_test_project "$PROJ"

# --- Test 7: execute forward marks intermediate stages [S] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" execute --target code-generation --direction forward --scope feature --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[S\] scope-definition' "forward marks intermediate [S]"
cleanup_test_project "$PROJ"

# --- Test 8: execute forward preserves [x] stages ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" execute --target code-generation --direction forward --scope feature --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[x\] intent-capture' "forward preserves [x] stages"
cleanup_test_project "$PROJ"

# --- Test 9: execute forward updates Current Stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" execute --target code-generation --direction forward --scope feature --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$STATE_TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "code-generation" "forward updates Current Stage"
cleanup_test_project "$PROJ"

# --- Test 10: execute forward appends audit ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" execute --target code-generation --direction forward --scope feature --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "STAGE_JUMPED" "forward appends STAGE_JUMPED audit"
cleanup_test_project "$PROJ"

# --- Test 11: execute backward resets downstream stages ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
bun "$TOOL" execute --target feasibility --direction backward --scope feature --project-dir "$PROJ" >/dev/null 2>&1
# After #50 refactor, the jump target becomes [-] (active) after reset so state
# and checkbox agree. Downstream stays [ ] pending.
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[-\] feasibility' "backward jump sets target to [-] active"
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[ \] code-generation' "backward resets downstream to [ ]"
cleanup_test_project "$PROJ"

# --- Test 12: execute backward decreases Completed count ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
bun "$TOOL" execute --target feasibility --direction backward --scope feature --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$STATE_TOOL" get "Completed" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "5" "backward Completed count is 5 (init+2 ideation)"
cleanup_test_project "$PROJ"

# --- Test 13: execute redo resets only target ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" execute --target feasibility --direction redo --scope feature --project-dir "$PROJ" >/dev/null 2>&1
# After #50 refactor, redo resets target then marks [-] active so state and
# checkbox agree.
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[-\] feasibility' "redo marks target [-] active after reset"
# Verify scope-definition is untouched (still [ ])
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[ \] scope-definition' "redo doesn't touch other stages"
cleanup_test_project "$PROJ"

# --- Test 14: execute returns JSON output ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" execute --target code-generation --direction forward --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"state_updated":true' "execute returns state_updated:true"
cleanup_test_project "$PROJ"

finish
