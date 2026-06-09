#!/bin/bash
# t42: Validate state-jumped.md fixture structure (12 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

plan 12

JUMPED="$FIXTURES_DIR/state-jumped.md"

# Validate jumped fixture has correct structure
assert_file_exists "$JUMPED" "jumped fixture file exists"
assert_grep "$JUMPED" '## Stage Progress' "jumped fixture has Stage Progress section"
assert_grep "$JUMPED" '## Current Status' "jumped fixture has Current Status section"
assert_grep "$JUMPED" '\[S\]' "jumped fixture has [S] skipped stages"
assert_grep "$JUMPED" '\[x\]' "jumped fixture has [x] completed stages"
assert_grep "$JUMPED" '\[-\]' "jumped fixture has [-] in-progress stage"
assert_grep "$JUMPED" 'CONSTRUCTION' "jumped fixture current phase is CONSTRUCTION"
assert_grep "$JUMPED" 'code-generation' "jumped fixture current stage is code-generation"

# Count [S] stages — should be more than 0
S_COUNT=$(grep -c '^\- \[S\]' "$JUMPED" || true)
assert_gt "$S_COUNT" 0 "jumped fixture has [S] skipped stages (count: $S_COUNT)"

# All initialization stages should be [x] not [S]
for stage in workspace-scaffold workspace-detection state-init; do
  assert_grep "$JUMPED" "\[x\] $stage" "init stage $stage is completed, not skipped"
done

finish
