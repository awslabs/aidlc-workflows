#!/bin/bash
# t64: Construction worktrees per scope — workshop (v0.4.0 MR 13).
# Skeleton-on; practices-discovery EXECUTE; multi-engineer parallel scenario.
# The four shared SKILL.md prose-presence checks AND the two inline §8
# workshop-resume / resume-mid-batch carve-out greps were RETIRED at the engine
# cutover: that SKILL.md prose was deleted, and the surviving behaviour lives in
# the engine + stage-protocol.md resume handling + the worktree tools (see
# _construction-worktrees-helpers.sh and the t09/t10/t11 worktree tests). What
# remains here is the per-scope codegen mode, the dispatch-event tool behaviour,
# and the v7 state fields. (3 tests)
set -euo pipefail
T_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$T_DIR/../lib/tap.sh"
source "$T_DIR/../lib/fixtures.sh"
source "$T_DIR/_construction-worktrees-helpers.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 3

PROJ=$(setup_construction_project "workshop")

assert_scope_codegen_mode "workshop" "EXECUTE"
assert_dispatch_event_runs_for_scope "workshop" "$PROJ"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
if grep -q "Worktree Path" "$STATE" && grep -q "Bolt Refs" "$STATE"; then
  ok "v7 state has v0.4.0 fields for workshop"
else
  not_ok "v7 state missing v0.4.0 fields" "$STATE"
fi

cleanup_test_project "$PROJ"
finish
