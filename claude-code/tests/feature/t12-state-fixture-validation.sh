#!/bin/bash
# t12: Meta-test — verify fixture state files match real template structure (20 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

FIXTURES_DIR="$SCRIPT_DIR/../fixtures"
TEMPLATE="$(cd "$SCRIPT_DIR/../../dist/claude/.claude/knowledge/aidlc-shared" && pwd)/state-template.md"
MID="$FIXTURES_DIR/state-mid-ideation.md"
INIT="$FIXTURES_DIR/state-initialization-done.md"

plan 20

# --- state-mid-ideation.md: 8 required section headings ---
assert_grep "$MID" "## Project Information" "mid-ideation: ## Project Information"
assert_grep "$MID" "## Scope Configuration" "mid-ideation: ## Scope Configuration"
assert_grep "$MID" "## Workspace State" "mid-ideation: ## Workspace State"
assert_grep "$MID" "## Execution Plan Summary" "mid-ideation: ## Execution Plan Summary"
assert_grep "$MID" "## Runtime State" "mid-ideation: ## Runtime State"
assert_grep "$MID" "## Stage Progress" "mid-ideation: ## Stage Progress"
assert_grep "$MID" "## Current Status" "mid-ideation: ## Current Status"
assert_grep "$MID" "## Session Resume Point" "mid-ideation: ## Session Resume Point"

# --- 5 phase headings ---
assert_grep "$MID" "### INITIALIZATION PHASE" "mid-ideation: ### INITIALIZATION PHASE"
assert_grep "$MID" "### IDEATION PHASE" "mid-ideation: ### IDEATION PHASE"
assert_grep "$MID" "### INCEPTION PHASE" "mid-ideation: ### INCEPTION PHASE"
assert_grep "$MID" "### CONSTRUCTION PHASE" "mid-ideation: ### CONSTRUCTION PHASE"
assert_grep "$MID" "### OPERATION PHASE" "mid-ideation: ### OPERATION PHASE"

# --- Bold field format ---
assert_grep "$MID" '\*\*Lifecycle Phase\*\*:' "mid-ideation: **Lifecycle Phase**: present"
assert_grep "$MID" '\*\*Current Stage\*\*:' "mid-ideation: **Current Stage**: present"
assert_grep "$MID" '\*\*State Version\*\*: 7' "mid-ideation: **State Version**: 7"
assert_grep "$MID" '\*\*Worktree Path\*\*:' "mid-ideation: **Worktree Path** present"
assert_grep "$MID" '\*\*Bolt Refs\*\*:' "mid-ideation: **Bolt Refs** present"
assert_grep "$MID" '\*\*Practices Affirmed Timestamp\*\*:' "mid-ideation: **Practices Affirmed Timestamp** present"

# --- state-initialization-done.md ---
# Same 8 section headings (spot check a few) are tested above for mid-ideation;
# for init-done, verify the key differentiator: Lifecycle Phase is IDEATION
assert_grep "$INIT" '\*\*Lifecycle Phase\*\*: IDEATION' "init-done: Lifecycle Phase is IDEATION"

finish
