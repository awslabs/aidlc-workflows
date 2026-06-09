#!/bin/bash
# t30: Scope-to-Stage Mapping consistency (17 tests)
#
# Scope routing is data-driven in the compiled scope-grid.json (the
# transpose of every stage's scopes: frontmatter), and SKILL.md carries a
# compiled summary table between BEGIN/END markers. This test asserts:
#   1. SKILL.md's compiled table region is well-formed (markers present)
#   2. Row count matches the number of scopes in the compiled grid
#   3. Every scope in the grid appears in the table
#   4. Each scope's EXECUTE count in the table matches the count derived
#      from the grid stages map
#   5. Phase-presence semantics preserved from the pre-MR-10 test:
#      bugfix has no IDEATION EXECUTE stages; workshop has no IDEATION
#      EXECUTE stages; bugfix has no OPERATION EXECUTE stages
#
# MR 12 retired scope-mapping.json; the compiled grid (same {scope:{stages}}
# shape) is the source of truth. The grid is byte-derived from the stage
# frontmatter at compile (drift-guarded by compile --check).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"
SCOPE_MAPPING="$AIDLC_SRC/tools/data/scope-grid.json"
STAGE_GRAPH="$AIDLC_SRC/tools/data/stage-graph.json"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 17

# ----- Section A: compiled table region shape (4 assertions) -----
REGION=$(sed -n '/<!-- BEGIN: compiled scope grid/,/<!-- END: compiled scope grid -->/p' "$SKILL")
assert_contains "$REGION" "BEGIN: compiled" "SKILL.md has scope-table BEGIN marker"
assert_contains "$REGION" "END: compiled" "SKILL.md has scope-table END marker"
assert_contains "$REGION" "| Scope" "SKILL.md scope-table has header row"
assert_contains "$REGION" "| EXECUTE / Total" "SKILL.md scope-table has EXECUTE / Total column"

# ----- Section B: row count matches JSON (1 assertion) -----
ROW_COUNT=$(echo "$REGION" | grep -cE '^\| [a-z-]+ ')
JSON_COUNT=$(bun -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('$SCOPE_MAPPING', 'utf-8'))).length)" 2>&1 | tail -1)
assert_eq "$ROW_COUNT" "$JSON_COUNT" "scope-table row count matches compiled scope-grid"

# ----- Section C: per-scope EXECUTE counts match JSON truth (9 assertions) -----
# For each scope in alphabetical order, compute EXECUTE count from JSON and
# check the table row's "N / 31" cell agrees.
for scope in bugfix enterprise feature infra mvp poc refactor security-patch workshop; do
  JSON_EXEC=$(bun -e "
    const m = JSON.parse(require('fs').readFileSync('$SCOPE_MAPPING', 'utf-8'));
    console.log(Object.values(m['$scope'].stages).filter(v => v === 'EXECUTE').length);
  " 2>&1 | tail -1)
  # Extract the "N / 31" cell from the table row. Example row:
  #   | bugfix         | Minimal       | (default)    | 7 / 31          |
  TABLE_EXEC=$(echo "$REGION" | grep "^| $scope " | grep -oE '[0-9]+ / [0-9]+' | head -1 | awk '{print $1}')
  assert_eq "$TABLE_EXEC" "$JSON_EXEC" "$scope EXECUTE count in table matches JSON"
done

# ----- Section D: phase-presence semantics (3 assertions) -----
# Preserved from pre-MR-10 t30: these were load-bearing guarantees about
# scope shape. The compiled table shows totals but not phase breakdowns,
# so these assertions read the JSON directly.
BUGFIX_IDEATION=$(bun -e "
  const g = JSON.parse(require('fs').readFileSync('$STAGE_GRAPH', 'utf-8'));
  const m = JSON.parse(require('fs').readFileSync('$SCOPE_MAPPING', 'utf-8'));
  const ideationSlugs = g.filter(s => s.phase === 'ideation').map(s => s.slug);
  const execCount = ideationSlugs.filter(s => m.bugfix.stages[s] === 'EXECUTE').length;
  console.log(execCount);
" 2>&1 | tail -1)
assert_eq "$BUGFIX_IDEATION" "0" "bugfix executes zero ideation-phase stages"

WORKSHOP_IDEATION=$(bun -e "
  const g = JSON.parse(require('fs').readFileSync('$STAGE_GRAPH', 'utf-8'));
  const m = JSON.parse(require('fs').readFileSync('$SCOPE_MAPPING', 'utf-8'));
  const ideationSlugs = g.filter(s => s.phase === 'ideation').map(s => s.slug);
  const execCount = ideationSlugs.filter(s => m.workshop.stages[s] === 'EXECUTE').length;
  console.log(execCount);
" 2>&1 | tail -1)
assert_eq "$WORKSHOP_IDEATION" "0" "workshop executes zero ideation-phase stages"

BUGFIX_OPERATION=$(bun -e "
  const g = JSON.parse(require('fs').readFileSync('$STAGE_GRAPH', 'utf-8'));
  const m = JSON.parse(require('fs').readFileSync('$SCOPE_MAPPING', 'utf-8'));
  const operationSlugs = g.filter(s => s.phase === 'operation').map(s => s.slug);
  const execCount = operationSlugs.filter(s => m.bugfix.stages[s] === 'EXECUTE').length;
  console.log(execCount);
" 2>&1 | tail -1)
assert_eq "$BUGFIX_OPERATION" "0" "bugfix executes zero operation-phase stages"

finish
