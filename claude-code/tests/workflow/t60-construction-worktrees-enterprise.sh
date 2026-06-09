#!/bin/bash
# t60: Construction worktrees per scope — enterprise (v0.4.0 MR 13).
# Asserts the per-scope Construction contract for enterprise: scope-mapping has
# code-generation EXECUTE, dispatch-event runs cleanly, practices-discovery
# EXECUTEs, and the v7 state carries the v0.4.0 worktree fields. The four
# SKILL.md prose-presence checks (CONSTRUCTION-Flow / practices-preamble /
# HOLD-MERGE / skeleton-stance) were RETIRED at the engine cutover — see
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

PROJ=$(setup_construction_project "enterprise")

assert_scope_codegen_mode "enterprise" "EXECUTE"
assert_dispatch_event_runs_for_scope "enterprise" "$PROJ"

# Test 3: enterprise has full Inception phase (practices-discovery EXECUTE)
MAPPING="$AIDLC_SRC/tools/data/scope-grid.json"
PD_MODE=$(bun -e "
  const m = require('$MAPPING');
  console.log(m.enterprise.stages['practices-discovery'] || 'UNDEFINED');
")
if [ "$PD_MODE" = "EXECUTE" ]; then
  ok "enterprise scope EXECUTEs practices-discovery (drives skeleton-on stance)"
else
  not_ok "enterprise should EXECUTE practices-discovery" "got: $PD_MODE"
fi

# Test 4: dispatch-event RETURNED variant works for enterprise context
# (full audit-of-intent bracket: INVOKED was emitted in test 2; here we
# verify the post-call RETURNED path that MR 13 wires for skeleton-on scopes).
bun "$AIDLC_SRC/tools/aidlc-bolt.ts" dispatch-event \
  --event MERGE_DISPATCH_RETURNED \
  --slug "t-enterprise-bolt-1" \
  --strategy squash --target main --confidence 0.9 \
  --notes "trunk-based per rules/aidlc-team.md" \
  --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "MERGE_DISPATCH_RETURNED" "$PROJ/aidlc-docs/audit.md"; then
  ok "dispatch-event MERGE_DISPATCH_RETURNED brackets the dispatch (post-call emit)"
else
  not_ok "MERGE_DISPATCH_RETURNED emit failed" "no row in audit.md"
fi

# Test 5: state template v7 has the v0.4.0 fields MR 13 builds on
STATE="$PROJ/aidlc-docs/aidlc-state.md"
if grep -q "Worktree Path" "$STATE" \
  && grep -q "Bolt Refs" "$STATE" \
  && grep -q "Practices Affirmed Timestamp" "$STATE"; then
  ok "v7 state has the three v0.4.0 fields (Worktree Path, Bolt Refs, Practices Affirmed Timestamp)"
else
  not_ok "v7 state missing one of the three v0.4.0 fields" "$STATE"
fi

cleanup_test_project "$PROJ"
finish
