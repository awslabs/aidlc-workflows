#!/bin/bash
# t61: Construction worktrees per scope — feature (v0.4.0 MR 13).
# Skeleton-on scope; practices-discovery EXECUTE; full Inception. The four
# SKILL.md prose-presence checks were RETIRED at the engine cutover — see
# _construction-worktrees-helpers.sh for where that behaviour is now covered.
# (5 tests)
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

plan 5

PROJ=$(setup_construction_project "feature")

assert_scope_codegen_mode "feature" "EXECUTE"
assert_dispatch_event_runs_for_scope "feature" "$PROJ"

MAPPING="$AIDLC_SRC/tools/data/scope-grid.json"
PD_MODE=$(bun -e "console.log(require('$MAPPING').feature.stages['practices-discovery']);")
if [ "$PD_MODE" = "EXECUTE" ]; then
  ok "feature scope EXECUTEs practices-discovery"
else
  not_ok "feature should EXECUTE practices-discovery" "got: $PD_MODE"
fi

bun "$AIDLC_SRC/tools/aidlc-bolt.ts" dispatch-event \
  --event MERGE_DISPATCH_RETURNED --slug "t-feature-bolt-1" \
  --strategy squash --target main --confidence 0.85 \
  --notes "trunk-based" --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "MERGE_DISPATCH_RETURNED" "$PROJ/aidlc-docs/audit.md"; then
  ok "dispatch-event RETURNED post-call emit works for feature"
else
  not_ok "RETURNED emit failed for feature" "no row in audit.md"
fi

STATE="$PROJ/aidlc-docs/aidlc-state.md"
if grep -q "Worktree Path" "$STATE" && grep -q "Bolt Refs" "$STATE"; then
  ok "v7 state has v0.4.0 fields for feature"
else
  not_ok "v7 state missing v0.4.0 fields" "$STATE"
fi

cleanup_test_project "$PROJ"
finish
