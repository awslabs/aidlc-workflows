#!/bin/bash
# t63: Construction worktrees per scope — poc (v0.4.0 MR 13).
# Skeleton-on; practices-discovery SKIP (poc is rapid). The four SKILL.md
# prose-presence checks were RETIRED at the engine cutover — see
# _construction-worktrees-helpers.sh for where that behaviour is now covered.
# The PRACTICES_SECTION_EMPTY tool-emit check (test 4) is PRESERVED — it is the
# behavioural anchor for the practices-fallback signal. (5 tests)
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

PROJ=$(setup_construction_project "poc")

assert_scope_codegen_mode "poc" "EXECUTE"
assert_dispatch_event_runs_for_scope "poc" "$PROJ"

# poc SKIPs practices-discovery (rapid scope) — orchestrator falls back to
# org.md / hardcoded defaults at U1 read. PRACTICES_SECTION_EMPTY advisory
# fires for any unaffirmed sections.
MAPPING="$AIDLC_SRC/tools/data/scope-grid.json"
PD_MODE=$(bun -e "console.log(require('$MAPPING').poc.stages['practices-discovery']);")
if [ "$PD_MODE" = "SKIP" ]; then
  ok "poc scope SKIPs practices-discovery (relies on U1 fallback chain)"
else
  not_ok "poc should SKIP practices-discovery" "got: $PD_MODE"
fi

# Verify PRACTICES_SECTION_EMPTY emit path works (MR 13's primary fallback signal)
bun "$AIDLC_SRC/tools/aidlc-state.ts" practices-event \
  --type empty --field "Section: Walking Skeleton" --field "Fallback: org.md" \
  --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "PRACTICES_SECTION_EMPTY" "$PROJ/aidlc-docs/audit.md"; then
  ok "PRACTICES_SECTION_EMPTY advisory works for poc fallback path"
else
  not_ok "PRACTICES_SECTION_EMPTY emit failed" "no row in audit.md"
fi

STATE="$PROJ/aidlc-docs/aidlc-state.md"
if grep -q "Worktree Path" "$STATE" && grep -q "Bolt Refs" "$STATE"; then
  ok "v7 state has v0.4.0 fields for poc"
else
  not_ok "v7 state missing v0.4.0 fields" "$STATE"
fi

cleanup_test_project "$PROJ"
finish
