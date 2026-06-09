#!/bin/bash
# t124: scope-shape transpose — per-stage scopes: -> compiled EXECUTE/SKIP grid.
#
# MR 12 moved scope membership off scope-mapping.json onto each stage's
# scopes: frontmatter. `aidlc-graph compile` transposes those lists into
# scope-grid.json (a pure transpose — no graph-closure, no predicate),
# emitted through the canonical sole-writer + drift-guarded by compile
# --check, the same discipline that protects stage-graph.json.
#
# Assertions (12):
#   1. transposeScopeGrid is a callable export
#   2. fixture stage scopes: -> expected grid (column = union, sorted)
#   3. a stage naming a scope is EXECUTE under it; an un-naming stage is SKIP
#   4. scope columns are the sorted union of every name any stage declares
#   5. real compile emits scope-grid.json beside stage-graph.json
#   6. deterministic re-compile: gridJson is byte-identical across calls
#   7. canonicalScopeGridJson emits a trailing newline
#   8. canonicalScopeGridJson is byte-stable across calls
#   9. compile --check on a clean tree exits 0
#  10. compile --check exits 1 when scope-grid.json is stale (drift guard)
#  11. compile --check exits 1 when scope-grid.json is missing
#  12. the shipped grid is cell-identical to subgraphForScope for all 9 scopes
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

GRAPH_TOOL="$AIDLC_SRC/tools/aidlc-graph.ts"
GRAPH_JSON="$AIDLC_SRC/tools/data/stage-graph.json"
GRID_JSON="$AIDLC_SRC/tools/data/scope-grid.json"

plan 12

# 1. transposeScopeGrid export exists
OUT=$(bun -e "import { transposeScopeGrid } from '$GRAPH_TOOL'; console.log(typeof transposeScopeGrid);" 2>&1)
assert_eq "$OUT" "function" "transposeScopeGrid is a callable export"

# 2-4. Pure-transpose semantics on a synthetic 3-stage / 2-scope input.
OUT=$(bun -e "
  import { transposeScopeGrid } from '$GRAPH_TOOL';
  const stages = [
    { slug: 'a', number: '0.1', scopes: ['alpha', 'beta'] },
    { slug: 'b', number: '0.2', scopes: ['beta'] },
    { slug: 'c', number: '0.3', scopes: [] },
  ];
  const g = transposeScopeGrid(stages);
  console.log(JSON.stringify({
    cols: Object.keys(g),
    alpha: g.alpha.stages,
    beta: g.beta.stages,
  }));
" 2>&1)
COLS=$(echo "$OUT" | bun -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf-8')).cols.join(','))")
assert_eq "$COLS" "alpha,beta" "scope columns are the sorted union of declared names"

A_GRID=$(echo "$OUT" | bun -e "const d=JSON.parse(require('fs').readFileSync(0,'utf-8')); console.log(d.alpha.a+','+d.alpha.b+','+d.alpha.c)")
assert_eq "$A_GRID" "EXECUTE,SKIP,SKIP" "stage naming 'alpha' is EXECUTE; non-naming stages SKIP"

B_GRID=$(echo "$OUT" | bun -e "const d=JSON.parse(require('fs').readFileSync(0,'utf-8')); console.log(d.beta.a+','+d.beta.b+','+d.beta.c)")
assert_eq "$B_GRID" "EXECUTE,EXECUTE,SKIP" "two stages naming 'beta' both EXECUTE under it"

# 5. real compile emits scope-grid.json (use a sandbox grid path)
TMP_GRAPH=$(mktemp -t aidlc-t124-graph.XXXXXX.json); cp "$GRAPH_JSON" "$TMP_GRAPH"
TMP_GRID=$(mktemp -t aidlc-t124-grid.XXXXXX.json); rm -f "$TMP_GRID"
AIDLC_STAGE_GRAPH="$TMP_GRAPH" AIDLC_SCOPE_GRID="$TMP_GRID" bun "$GRAPH_TOOL" compile >/dev/null 2>&1
if [ -s "$TMP_GRID" ]; then
  ok "compile emits scope-grid.json beside stage-graph.json"
else
  not_ok "compile emits scope-grid.json beside stage-graph.json" "grid not written"
fi

# 6. deterministic re-compile: gridJson byte-identical across two compiles
GRID_HASH_1=$(bun -e "
  import { compileStageGraph } from '$GRAPH_TOOL';
  import { createHash } from 'crypto';
  console.log(createHash('sha256').update(compileStageGraph().gridJson).digest('hex'));
" 2>&1)
GRID_HASH_2=$(bun -e "
  import { compileStageGraph, __resetGraphCache } from '$GRAPH_TOOL';
  import { createHash } from 'crypto';
  __resetGraphCache();
  console.log(createHash('sha256').update(compileStageGraph().gridJson).digest('hex'));
" 2>&1)
assert_eq "$GRID_HASH_1" "$GRID_HASH_2" "gridJson is byte-identical across two compiles"

# 7. trailing newline
OUT=$(bun -e "
  import { canonicalScopeGridJson, transposeScopeGrid, loadGraph } from '$GRAPH_TOOL';
  const s = canonicalScopeGridJson(transposeScopeGrid(loadGraph()));
  console.log(s.endsWith('\n') ? 'YES' : 'NO');
" 2>&1)
assert_eq "$OUT" "YES" "canonicalScopeGridJson emits trailing newline"

# 8. byte-stable across calls
OUT=$(bun -e "
  import { canonicalScopeGridJson, transposeScopeGrid, loadGraph } from '$GRAPH_TOOL';
  import { createHash } from 'crypto';
  const g = transposeScopeGrid(loadGraph());
  const h1 = createHash('sha256').update(canonicalScopeGridJson(g)).digest('hex');
  const h2 = createHash('sha256').update(canonicalScopeGridJson(g)).digest('hex');
  console.log(h1 === h2 ? 'STABLE' : 'UNSTABLE');
" 2>&1)
assert_eq "$OUT" "STABLE" "canonicalScopeGridJson is byte-stable across calls"

# 9. compile --check clean tree exits 0 (sandboxed copies)
cp "$GRAPH_JSON" "$TMP_GRAPH"; cp "$GRID_JSON" "$TMP_GRID"
RC=0
AIDLC_STAGE_GRAPH="$TMP_GRAPH" AIDLC_SCOPE_GRID="$TMP_GRID" bun "$GRAPH_TOOL" compile --check >/dev/null 2>&1 || RC=$?
assert_eq "$RC" "0" "compile --check on clean tree (graph + grid) exits 0"

# 10. stale scope-grid.json -> exit 1 (mutate the grid only)
bun -e "
  const j = JSON.parse(require('fs').readFileSync('$TMP_GRID', 'utf-8'));
  const firstScope = Object.keys(j)[0];
  const firstStage = Object.keys(j[firstScope].stages)[0];
  // Flip one cell so the on-disk grid no longer matches the transpose.
  j[firstScope].stages[firstStage] = j[firstScope].stages[firstStage] === 'EXECUTE' ? 'SKIP' : 'EXECUTE';
  require('fs').writeFileSync('$TMP_GRID', JSON.stringify(j, null, 2) + '\n', 'utf-8');
"
RC=0
AIDLC_STAGE_GRAPH="$TMP_GRAPH" AIDLC_SCOPE_GRID="$TMP_GRID" bun "$GRAPH_TOOL" compile --check >/dev/null 2>&1 || RC=$?
assert_eq "$RC" "1" "compile --check exits 1 on a stale scope-grid.json (drift guard)"

# 11. missing scope-grid.json -> exit 1
rm -f "$TMP_GRID"
RC=0
AIDLC_STAGE_GRAPH="$TMP_GRAPH" AIDLC_SCOPE_GRID="$TMP_GRID" bun "$GRAPH_TOOL" compile --check >/dev/null 2>&1 || RC=$?
assert_eq "$RC" "1" "compile --check exits 1 when scope-grid.json is missing"
rm -f "$TMP_GRAPH" "$TMP_GRID"

# 12. shipped grid is cell-identical to subgraphForScope for all 9 scopes
OUT=$(bun -e "
  import { subgraphForScope } from '$GRAPH_TOOL';
  const grid = JSON.parse(require('fs').readFileSync('$GRID_JSON', 'utf-8'));
  const scopes = ['enterprise','feature','mvp','poc','bugfix','refactor','infra','security-patch','workshop'];
  const bad = [];
  for (const sc of scopes) {
    const execFromGrid = Object.entries(grid[sc].stages).filter(([,a]) => a === 'EXECUTE').map(([s]) => s).sort();
    const execFromSub = subgraphForScope(sc).map(s => s.slug).sort();
    if (JSON.stringify(execFromGrid) !== JSON.stringify(execFromSub)) bad.push(sc);
  }
  console.log(bad.length === 0 ? 'ALL_MATCH' : bad.join(','));
" 2>&1)
assert_eq "$OUT" "ALL_MATCH" "scope-grid EXECUTE set matches subgraphForScope for all 9 scopes"

finish
