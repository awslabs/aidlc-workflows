#!/bin/bash
# t98 (feature): aidlc-runtime compile sensor_firings[] + learnings_captured
# populator (v0.5.0 MR 12). 16 feature assertions covering fire_id pairing,
# the 4-state result enum (passed/failed/budget-override/incomplete), the
# deterministic 60s open-window orphan cutoff (computed from baseline_ts =
# max audit timestamp, no wall-clock), BoltInstance worktree-scoped
# attribution, parent non-worktree firings, learnings_captured counts split
# by Source, and the forward-compat shape.
#
# Surface tested:
#   - Pairing (7): FIRED+PASSED → passed; FIRED+FAILED → failed+detail_path;
#     FIRED+BUDGET_OVERRIDE → budget-override; orphan in closed window →
#     incomplete; orphan in open window ≥60s → incomplete; orphan in open
#     window <60s → omitted; 4 parallel FIRED with interleaved terminals →
#     all paired by fire_id; re-compile byte-equal; sort ts-ascending.
#   - BoltInstance (3): worktree-scoped firings per instance; parent holds
#     only non-worktree firings; no double-count.
#   - learnings_captured (3): approved stage with 2 orchestrator + 1
#     user_addition → {2,1}; pending stage → null; instance-bearing parent
#     → null (rollup invariant).
#   - Forward-compat (3): result is one of the 4 states; fire_id present;
#     detail_path only on failed.
#
# Strategy: static audit fixtures under tests/fixtures/v05-mr12-learnings/
# for input determinism, mirroring t96's compile-against-known-input shape.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-runtime.ts"
STATE_FIXTURE="$REPO_ROOT/tests/fixtures/state-construction.md"
FIXTURES_DIR="$REPO_ROOT/tests/fixtures/v05-mr12-learnings"

if [ ! -f "$RUNTIME_TS" ]; then
  echo "Bail out! aidlc-runtime.ts not found"
  exit 1
fi
if [ ! -f "$STATE_FIXTURE" ]; then
  echo "Bail out! state-construction.md not found"
  exit 1
fi
if [ ! -d "$FIXTURES_DIR" ]; then
  echo "Bail out! v05-mr12 fixtures dir missing at $FIXTURES_DIR"
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 16

# --- Helpers --------------------------------------------------------------

FIXTURES=()
trap '
	for f in "${FIXTURES[@]:-}"; do
		if [ -n "$f" ] && [ -d "$f" ]; then
			rm -rf "$f" 2>/dev/null || true
		fi
	done
' EXIT INT TERM

make_project_with_audit() {
  local audit_path="$1"
  local proj
  proj=$(mktemp -d -t aidlc-t98f-XXXXXX)
  FIXTURES+=("$proj")
  mkdir -p "$proj/aidlc-docs"
  cp "$STATE_FIXTURE" "$proj/aidlc-docs/aidlc-state.md"
  cp "$audit_path" "$proj/aidlc-docs/audit.md"
  echo "$proj"
}

run_compile() {
  bun "$RUNTIME_TS" --project-dir "$1" compile >/dev/null 2>&1
}

graph_query() {
  local proj="$1"
  local expr="$2"
  bun -e "
		const g = JSON.parse(require('fs').readFileSync('$proj/aidlc-docs/runtime-graph.json', 'utf-8'));
		console.log(JSON.stringify($expr));
	" 2>&1
}

# --- Pairing ----------------------------------------------------------------

PROJ=$(make_project_with_audit "$FIXTURES_DIR/audit-sensor-pairing.md")
run_compile "$PROJ"
SF="g.stages.find(s=>s.stage_slug==='code-generation').sensor_firings"

# 1. FIRED+PASSED → passed
R=$(graph_query "$PROJ" "$SF.find(f=>f.fire_id==='aaaa0001')?.result")
assert_eq '"passed"' "$R" "FIRED+PASSED paired by fire_id → result:passed"

# 2. FIRED+FAILED → failed + detail_path
R=$(graph_query "$PROJ" "$SF.find(f=>f.fire_id==='bbbb0002')?.result")
DP=$(graph_query "$PROJ" "$SF.find(f=>f.fire_id==='bbbb0002')?.detail_path")
if [ "$R" = '"failed"' ] && [ "$DP" != "null" ] && [ "$DP" != "" ]; then
  ok "FIRED+FAILED paired → result:failed with detail_path"
else
  not_ok "FIRED+FAILED → failed+detail_path" "result=$R detail_path=$DP"
fi

# 3. FIRED+BUDGET_OVERRIDE → budget-override
R=$(graph_query "$PROJ" "$SF.find(f=>f.fire_id==='cccc0003')?.result")
assert_eq '"budget-override"' "$R" "FIRED+BUDGET_OVERRIDE paired → result:budget-override"

# 4. orphan in closed window → incomplete
R=$(graph_query "$PROJ" "$SF.find(f=>f.fire_id==='dddd0004')?.result")
assert_eq '"incomplete"' "$R" "orphan FIRED in closed window → result:incomplete"

# 5. orphan in open window ≥60s → incomplete (old00001), <60s omitted (young002)
PROJ_OPEN=$(make_project_with_audit "$FIXTURES_DIR/audit-orphan-open-window.md")
run_compile "$PROJ_OPEN"
SFO="g.stages.find(s=>s.stage_slug==='code-generation').sensor_firings"
R=$(graph_query "$PROJ_OPEN" "$SFO.find(f=>f.fire_id==='old00001')?.result")
assert_eq '"incomplete"' "$R" "orphan in open window ≥60s past baseline_ts → incomplete"

# 6. orphan in open window <60s → omitted from array
YOUNG=$(graph_query "$PROJ_OPEN" "$SFO.some(f=>f.fire_id==='young002')")
assert_eq "false" "$YOUNG" "orphan in open window <60s past baseline_ts → omitted (no 5th pending state)"

# 7. 4 parallel FIRED with interleaved terminals → all paired by fire_id
PROJ_4=$(make_project_with_audit "$FIXTURES_DIR/audit-4-parallel-interleaved.md")
run_compile "$PROJ_4"
SF4="g.stages.find(s=>s.stage_slug==='code-generation').sensor_firings"
P1=$(graph_query "$PROJ_4" "$SF4.find(f=>f.fire_id==='fire0001')?.result")
P2=$(graph_query "$PROJ_4" "$SF4.find(f=>f.fire_id==='fire0002')?.result")
P3=$(graph_query "$PROJ_4" "$SF4.find(f=>f.fire_id==='fire0003')?.result")
P4=$(graph_query "$PROJ_4" "$SF4.find(f=>f.fire_id==='fire0004')?.result")
if [ "$P1" = '"passed"' ] && [ "$P2" = '"failed"' ] && [ "$P3" = '"passed"' ] && [ "$P4" = '"passed"' ]; then
  ok "4 parallel FIRED, interleaved terminals → each correctly paired by fire_id (not positional)"
else
  not_ok "4-parallel fire_id pairing" "f1=$P1 f2=$P2 f3=$P3 f4=$P4"
fi

# --- Determinism + sort -----------------------------------------------------

# 8. re-compile byte-equal
SHA_BEFORE=$(shasum -a 256 "$PROJ/aidlc-docs/runtime-graph.json" | awk '{print $1}')
run_compile "$PROJ"
SHA_AFTER=$(shasum -a 256 "$PROJ/aidlc-docs/runtime-graph.json" | awk '{print $1}')
assert_eq "$SHA_BEFORE" "$SHA_AFTER" "re-compile produces byte-equivalent runtime-graph.json (no wall-clock)"

# 9. sort ts-ascending
TS_SORTED=$(graph_query "$PROJ" "(()=>{const a=$SF.map(f=>f.ts);return JSON.stringify(a)===JSON.stringify([...a].sort());})()")
assert_eq "true" "$TS_SORTED" "sensor_firings sorted by ts ascending"

# --- BoltInstance -----------------------------------------------------------

PROJ_B=$(make_project_with_audit "$FIXTURES_DIR/audit-3-bolts-sensors.md")
run_compile "$PROJ_B"
INST="g.stages.find(s=>s.stage_slug==='code-generation').instances"

# 10. each instance has its own worktree-scoped firings
AUTH_FID=$(graph_query "$PROJ_B" "$INST.find(i=>i.bolt==='auth').sensor_firings.map(f=>f.fire_id)")
CART_FID=$(graph_query "$PROJ_B" "$INST.find(i=>i.bolt==='cart').sensor_firings.map(f=>f.fire_id)")
PAY_FID=$(graph_query "$PROJ_B" "$INST.find(i=>i.bolt==='pay').sensor_firings.map(f=>f.fire_id)")
if [ "$AUTH_FID" = '["auth0001"]' ] && [ "$CART_FID" = '["cart0002"]' ] && [ "$PAY_FID" = '[]' ]; then
  ok "3-Bolt: each instance carries its own worktree-scoped firings (auth=[auth0001] cart=[cart0002] pay=[])"
else
  not_ok "BoltInstance worktree-scoped firings" "auth=$AUTH_FID cart=$CART_FID pay=$PAY_FID"
fi

# 11. parent holds only non-worktree firings
PARENT_FID=$(graph_query "$PROJ_B" "g.stages.find(s=>s.stage_slug==='code-generation').sensor_firings.map(f=>f.fire_id)")
assert_eq '["pnt00003"]' "$PARENT_FID" "instance-bearing parent holds only firings NOT under any worktree (pnt00003)"

# 12. no double-count: worktree firings do not also land on the parent
PARENT_HAS_WT=$(graph_query "$PROJ_B" "g.stages.find(s=>s.stage_slug==='code-generation').sensor_firings.some(f=>['auth0001','cart0002'].includes(f.fire_id))")
assert_eq "false" "$PARENT_HAS_WT" "worktree-scoped firings are not double-counted on the parent"

# --- learnings_captured -----------------------------------------------------

PROJ_L=$(make_project_with_audit "$FIXTURES_DIR/audit-learnings-captured.md")
run_compile "$PROJ_L"

# 13. approved stage with 2 orchestrator + 1 user_addition → {2,1}
LC=$(graph_query "$PROJ_L" "g.stages.find(s=>s.stage_slug==='user-stories').learnings_captured")
assert_eq '{"from_orchestrator":2,"from_user_addition":1}' "$LC" "approved stage learnings_captured = {from_orchestrator:2, from_user_addition:1}"

# 14. pending stage → null
LC_PENDING=$(graph_query "$PROJ_L" "g.stages.find(s=>s.stage_slug==='application-design').learnings_captured")
assert_eq "null" "$LC_PENDING" "pending stage learnings_captured = null"

# 15. instance-bearing parent (non-approved rollup) → null (rollup invariant, :500-502)
PROJ_F=$(make_project_with_audit "$REPO_ROOT/tests/fixtures/v05-mr11-bolt-runtime-graph/audit-3-bolts-1-failed.md")
run_compile "$PROJ_F"
LC_PARENT=$(graph_query "$PROJ_F" "g.stages.find(s=>s.stage_slug==='code-generation').learnings_captured")
assert_eq "null" "$LC_PARENT" "instance-bearing parent (any-failed rollup) learnings_captured = null (invariant)"

# --- Forward-compat ---------------------------------------------------------

# 16. every firing has fire_id, a valid 4-state result, detail_path only on failed
SHAPE_OK=$(graph_query "$PROJ" "(()=>{const valid=['passed','failed','budget-override','incomplete'];return $SF.every(f=>typeof f.fire_id==='string'&&f.fire_id.length>0&&valid.includes(f.result)&&(f.result==='failed'||f.detail_path===undefined));})()")
assert_eq "true" "$SHAPE_OK" "every firing: fire_id present, result ∈ 4-state enum, detail_path only on failed"

finish
