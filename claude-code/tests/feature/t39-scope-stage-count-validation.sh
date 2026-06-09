#!/bin/bash
# t39: Scope EXECUTE counts match expected ranges (9 tests)
#
# Authoritative source is the compiled scope-grid.json (MR 12 retired
# scope-mapping.json; the grid is the transpose of every stage's scopes:
# frontmatter, same {scope:{stages}} shape). Reads EXECUTE counts directly
# from the grid and verifies ranges that reflect each scope's intent. Also
# covers the "security-patch deploys" structural assertion by checking
# EXECUTE on two specific operation-phase slugs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SCOPE_MAPPING="$AIDLC_SRC/tools/data/scope-grid.json"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 9

# Helper: EXECUTE count for a scope from JSON.
exec_count() {
  local scope="$1"
  bun -e "
    const m = JSON.parse(require('fs').readFileSync('$SCOPE_MAPPING', 'utf-8'));
    console.log(Object.values(m['$scope'].stages).filter(v => v === 'EXECUTE').length);
  " 2>&1 | tail -1
}

# Helper: check whether a slug is EXECUTE in a scope.
is_execute() {
  local scope="$1"
  local slug="$2"
  bun -e "
    const m = JSON.parse(require('fs').readFileSync('$SCOPE_MAPPING', 'utf-8'));
    console.log(m['$scope'].stages['$slug'] === 'EXECUTE' ? 'yes' : 'no');
  " 2>&1 | tail -1
}

# 1. Enterprise: all 32 stages EXECUTE
ENT=$(exec_count "enterprise")
assert_eq "$ENT" "32" "enterprise executes all 32 stages"

# 2. Feature: all 32 stages EXECUTE
FEAT=$(exec_count "feature")
assert_eq "$FEAT" "32" "feature executes all 32 stages"

# 3. MVP: range 15-25 (operations skipped; inception+construction+init)
MVP=$(exec_count "mvp")
if [ "$MVP" -ge 15 ] && [ "$MVP" -le 25 ]; then
  ok "mvp executes $MVP stages (expected 15-25)"
else
  not_ok "mvp executes $MVP stages (expected 15-25)"
fi

# 4. POC: range 5-12 (minimal footprint)
POC=$(exec_count "poc")
if [ "$POC" -ge 5 ] && [ "$POC" -le 12 ]; then
  ok "poc executes $POC stages (expected 5-12)"
else
  not_ok "poc executes $POC stages (expected 5-12)"
fi

# 5. Bugfix: exactly 7 (init+RE+req+codegen+build)
BUGFIX=$(exec_count "bugfix")
assert_eq "$BUGFIX" "7" "bugfix executes exactly 7 stages"

# 6. Refactor: range 7-12
REF=$(exec_count "refactor")
if [ "$REF" -ge 7 ] && [ "$REF" -le 12 ]; then
  ok "refactor executes $REF stages (expected 7-12)"
else
  not_ok "refactor executes $REF stages (expected 7-12)"
fi

# 7. Infra: range 9-16
INFRA=$(exec_count "infra")
if [ "$INFRA" -ge 9 ] && [ "$INFRA" -le 16 ]; then
  ok "infra executes $INFRA stages (expected 9-16)"
else
  not_ok "infra executes $INFRA stages (expected 9-16)"
fi

# 8. Security-patch: includes deployment-pipeline + deployment-execution
PIPELINE=$(is_execute "security-patch" "deployment-pipeline")
EXECUTION=$(is_execute "security-patch" "deployment-execution")
if [ "$PIPELINE" = "yes" ] && [ "$EXECUTION" = "yes" ]; then
  ok "security-patch executes deployment-pipeline and deployment-execution"
else
  not_ok "security-patch executes deployment-pipeline and deployment-execution" \
    "pipeline=$PIPELINE execution=$EXECUTION"
fi

# 9. Workshop: range 20-28 (skips ideation only)
WORKSHOP=$(exec_count "workshop")
if [ "$WORKSHOP" -ge 20 ] && [ "$WORKSHOP" -le 28 ]; then
  ok "workshop executes $WORKSHOP stages (expected 20-28)"
else
  not_ok "workshop executes $WORKSHOP stages (expected 20-28)"
fi

finish
