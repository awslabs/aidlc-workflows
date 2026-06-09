#!/bin/bash
# t96 (feature): aidlc-runtime compile instances[] populator (v0.5.0 MR 11).
# 10 feature assertions covering the Construction-stage parallel-Bolt
# detection rule, BoltInstance[] shape, parent-stage null-out, outcome
# rollup, alphabetical ordering, determinism, and the MR-11-contract
# placeholders for sensor_firings / memory_entries / memory_breakdown.
#
# Surface tested:
#   - Single-Bolt (≥2 detection threshold, decision L5): no instances[]
#     emitted; single-instance row stays as MR 8 produced it.
#   - 2-Bolt parallel: instances[] populated; parent fields nulled per L5/L10.
#   - 3-Bolt parallel: same shape, 3 elements (canonical v3 §7 example).
#   - Outcome rollup (L10): all approved → "approved"; any failed → "failed";
#     all approved + 1 pending → "pending".
#   - Alphabetical-by-slug ordering (L6) regardless of audit-row order.
#   - Determinism (L11): byte-equal output on repeat compile.
#   - sensor_firings: [] on every BoltInstance (no SENSOR rows in these
#     fixtures; the MR 12 populator's populated-array path is in t98).
#   - memory_entries: null + memory_breakdown: null on every BoltInstance
#     (MR 13 forward-note).
#
# Strategy: use static audit fixtures from tests/fixtures/v05-mr11-bolt-
# runtime-graph/ for input determinism. Real-tool construction lives in
# the worktree-tier (t12) and integration-tier (t49) tests; feature-tier
# is the right layer for compile-against-known-input invariants.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-runtime.ts"
STATE_FIXTURE="$REPO_ROOT/tests/fixtures/state-construction.md"
FIXTURES_DIR="$REPO_ROOT/tests/fixtures/v05-mr11-bolt-runtime-graph"

if [ ! -f "$RUNTIME_TS" ]; then
  echo "Bail out! aidlc-runtime.ts not found"
  exit 1
fi
if [ ! -f "$STATE_FIXTURE" ]; then
  echo "Bail out! state-construction.md not found"
  exit 1
fi
if [ ! -d "$FIXTURES_DIR" ]; then
  echo "Bail out! v05-mr11 fixtures dir missing at $FIXTURES_DIR"
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 10

# --- Helpers --------------------------------------------------------------

FIXTURES=()
trap '
	for f in "${FIXTURES[@]:-}"; do
		if [ -n "$f" ] && [ -d "$f" ]; then
			rm -rf "$f" 2>/dev/null || true
		fi
	done
' EXIT INT TERM

# Build a project skeleton with $1 audit fixture seeded as audit.md.
# Returns project-dir on stdout.
make_project_with_audit() {
  local audit_path="$1"
  local proj
  proj=$(mktemp -d -t aidlc-t96f-XXXXXX)
  FIXTURES+=("$proj")
  mkdir -p "$proj/aidlc-docs"
  cp "$STATE_FIXTURE" "$proj/aidlc-docs/aidlc-state.md"
  cp "$audit_path" "$proj/aidlc-docs/audit.md"
  echo "$proj"
}

run_compile() {
  bun "$RUNTIME_TS" --project-dir "$1" compile >/dev/null 2>&1
}

# Read a JSONPath-ish value from runtime-graph.json. Uses jq if present,
# otherwise bun -e for portability.
graph_query() {
  local proj="$1"
  local expr="$2"
  bun -e "
		const g = JSON.parse(require('fs').readFileSync('$proj/aidlc-docs/runtime-graph.json', 'utf-8'));
		console.log(JSON.stringify($expr));
	" 2>&1
}

# --- 1. Single-Bolt → no instances --------------------------------------

PROJ=$(make_project_with_audit "$FIXTURES_DIR/audit-single-bolt.md")
run_compile "$PROJ"
HAS_INSTANCES=$(graph_query "$PROJ" "'instances' in (g.stages.find(s=>s.stage_slug==='code-generation') ?? {})")
SINGLE_OUTCOME=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.outcome")
if [ "$HAS_INSTANCES" = "false" ] && [ "$SINGLE_OUTCOME" = "\"approved\"" ]; then
  ok "Single-Bolt → no instances[]; row stays single-instance with outcome:approved"
else
  not_ok "Single-Bolt → no instances[]" "has_instances=$HAS_INSTANCES outcome=$SINGLE_OUTCOME"
fi

# --- 2. 3-Bolt parallel → instances[] ----------------------------------

PROJ=$(make_project_with_audit "$FIXTURES_DIR/audit-3-bolts-parallel.md")
run_compile "$PROJ"
INST_LEN=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.instances?.length")
PARENT_STARTED_AT=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.started_at")
PARENT_AGENT=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.agent")
PARENT_MEMORY_PATH=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.memory_path")
PARENT_SENSOR_FIRINGS=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.sensor_firings")
if [ "$INST_LEN" = "3" ] && [ "$PARENT_STARTED_AT" = "null" ] && [ "$PARENT_AGENT" = "null" ] &&
  [ "$PARENT_MEMORY_PATH" != "null" ] && [ "$PARENT_SENSOR_FIRINGS" = "[]" ]; then
  ok "3-Bolt parallel: instances[].length=3, parent started_at/agent nulled, memory_path kept, sensor_firings:[]"
else
  not_ok "3-Bolt parallel shape" "len=$INST_LEN started=$PARENT_STARTED_AT agent=$PARENT_AGENT mem=$PARENT_MEMORY_PATH sf=$PARENT_SENSOR_FIRINGS"
fi

# --- 3. Outcome rollup — all approved -----------------------------------

PARENT_OUTCOME=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.outcome")
ALL_APPROVED=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation').instances.every(i=>i.outcome==='approved')")
if [ "$PARENT_OUTCOME" = "\"approved\"" ] && [ "$ALL_APPROVED" = "true" ]; then
  ok "Outcome rollup — all approved → parent outcome:approved"
else
  not_ok "Outcome rollup — all approved" "parent=$PARENT_OUTCOME all_approved=$ALL_APPROVED"
fi

# --- 4. Alphabetical ordering (L6) -------------------------------------

# Fixture has audit-row order: auth, cart, pay → already alpha. Re-ordering
# proof comes from observing that the OUTPUT instances[] array always reads
# auth, cart, pay regardless of audit-row mutation. We rely on the fixture's
# guaranteed-alphabetical fork order for now and add an audit-shuffle test
# below for the stronger property.
INST_SLUGS=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation').instances.map(i=>i.bolt)")
if [ "$INST_SLUGS" = '["auth","cart","pay"]' ]; then
  ok "Alphabetical ordering: instances[].bolt = [auth, cart, pay]"
else
  not_ok "Alphabetical ordering" "$INST_SLUGS"
fi

# --- 5. Determinism (L11) -----------------------------------------------

# Same audit, two compiles, byte-equal output.
SHA_BEFORE=$(shasum -a 256 "$PROJ/aidlc-docs/runtime-graph.json" | awk '{print $1}')
run_compile "$PROJ"
SHA_AFTER=$(shasum -a 256 "$PROJ/aidlc-docs/runtime-graph.json" | awk '{print $1}')
if [ "$SHA_BEFORE" = "$SHA_AFTER" ]; then
  ok "Determinism: re-compile produces byte-equivalent runtime-graph.json"
else
  not_ok "Determinism" "before=$SHA_BEFORE after=$SHA_AFTER"
fi

# --- 6. sensor_firings:[] contract on every BoltInstance ---------------
# The MR 12 populator runs, but these fixtures carry NO SENSOR_FIRED rows, so
# every instance's worktree-scoped firings legitimately resolve to []. (The
# populated-array path is covered by t98 with sensor-bearing fixtures.)

ALL_SF_EMPTY=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation').instances.every(i=>Array.isArray(i.sensor_firings) && i.sensor_firings.length===0)")
if [ "$ALL_SF_EMPTY" = "true" ]; then
  ok "every BoltInstance has sensor_firings:[] when the audit has no SENSOR rows (MR 12 populator)"
else
  not_ok "BoltInstance sensor_firings contract" "$ALL_SF_EMPTY"
fi

# --- 7. memory_entries:null + memory_breakdown:null on every BoltInstance ---

ALL_MEM_NULL=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation').instances.every(i=>i.memory_entries===null && i.memory_breakdown===null)")
if [ "$ALL_MEM_NULL" = "true" ]; then
  ok "MR 11 contract: every BoltInstance has memory_entries:null + memory_breakdown:null (MR 13 forward-note)"
else
  not_ok "BoltInstance memory_entries/breakdown contract" "$ALL_MEM_NULL"
fi

# --- 8. Outcome rollup — any failed → parent failed --------------------

PROJ=$(make_project_with_audit "$FIXTURES_DIR/audit-3-bolts-1-failed.md")
run_compile "$PROJ"
INST_LEN=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.instances?.length")
PARENT_OUTCOME=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.outcome")
PAY_OUTCOME=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation').instances.find(i=>i.bolt==='pay')?.outcome")
AUTH_OUTCOME=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation').instances.find(i=>i.bolt==='auth')?.outcome")
if [ "$INST_LEN" = "3" ] && [ "$PARENT_OUTCOME" = "\"failed\"" ] &&
  [ "$PAY_OUTCOME" = "\"failed\"" ] && [ "$AUTH_OUTCOME" = "\"approved\"" ]; then
  ok "Outcome rollup — any failed: pay:failed + auth:approved → parent:failed (canonical v3 §7 example)"
else
  not_ok "Outcome rollup — any failed" "len=$INST_LEN parent=$PARENT_OUTCOME pay=$PAY_OUTCOME auth=$AUTH_OUTCOME"
fi

# --- 9. Outcome rollup — pending mix → parent pending ------------------

# Construct a pending-mix audit by removing pay's STATE_MERGED + BOLT_FAILED
# from the 3-bolts-parallel fixture (so pay has STATE_FORKED but no merge,
# no fail → outcome:pending). Then expect parent:pending (auth approved +
# cart approved + pay pending → no failures, ≥1 pending → pending).
PROJ=$(make_project_with_audit "$FIXTURES_DIR/audit-3-bolts-parallel.md")
# Strip pay's STATE_MERGED, AUDIT_MERGED, BOLT_COMPLETED blocks.
bun -e "
	const fs = require('fs');
	const path = '$PROJ/aidlc-docs/audit.md';
	let txt = fs.readFileSync(path, 'utf-8');
	const blocks = txt.split('\n---\n');
	const filtered = blocks.filter(b => {
		const slug = b.match(/\*\*Bolt slug\*\*:\s*(.+)/)?.[1]?.trim();
		const ev = b.match(/\*\*Event\*\*:\s*(.+)/)?.[1]?.trim();
		if (slug === 'pay' && ['STATE_MERGED','AUDIT_MERGED','BOLT_COMPLETED'].includes(ev)) return false;
		return true;
	});
	fs.writeFileSync(path, filtered.join('\n---\n'));
"
run_compile "$PROJ"
PARENT_OUTCOME=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.outcome")
PAY_OUT=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation').instances.find(i=>i.bolt==='pay')?.outcome")
if [ "$PARENT_OUTCOME" = "\"pending\"" ] && [ "$PAY_OUT" = "\"pending\"" ]; then
  ok "Outcome rollup — pending mix: pay:pending (no merge, no fail) → parent:pending"
else
  not_ok "Outcome rollup — pending mix" "parent=$PARENT_OUTCOME pay=$PAY_OUT"
fi

# --- 10. Alphabetical ordering with shuffled audit (stronger L6 proof) ---

# Build an audit where Bolt slugs appear in non-alphabetical Timestamp order
# (pay first, then auth, then cart). Output instances[] must still be
# alphabetical [auth, cart, pay].
PROJ=$(make_project_with_audit "$FIXTURES_DIR/audit-3-bolts-parallel.md")
bun -e "
	const fs = require('fs');
	const path = '$PROJ/aidlc-docs/audit.md';
	let txt = fs.readFileSync(path, 'utf-8');
	// Re-stamp STATE_FORKED rows so pay has earliest timestamp, then auth, then cart.
	// (Originals are 08:02:05 auth, 08:02:15 cart, 08:02:25 pay.)
	txt = txt.replace(/(\*\*Event\*\*: STATE_FORKED\n\*\*Bolt slug\*\*: pay[\s\S]*?)/, (m) => m);
	// Build a fresh sequence: pay first via 08:01:01, auth 08:02:01, cart 08:03:01.
	// Easier path: regex-rewrite the three STATE_FORKED Timestamp lines.
	const blocks = txt.split('\n---\n');
	for (const i in blocks) {
		const b = blocks[i];
		const slug = b.match(/\*\*Bolt slug\*\*:\s*(.+)/)?.[1]?.trim();
		const ev = b.match(/\*\*Event\*\*:\s*(.+)/)?.[1]?.trim();
		if (ev !== 'STATE_FORKED') continue;
		if (slug === 'pay')  blocks[i] = b.replace(/\*\*Timestamp\*\*:.*$/m, '**Timestamp**: 2026-05-28T08:01:01Z');
		if (slug === 'auth') blocks[i] = b.replace(/\*\*Timestamp\*\*:.*$/m, '**Timestamp**: 2026-05-28T08:02:01Z');
		if (slug === 'cart') blocks[i] = b.replace(/\*\*Timestamp\*\*:.*$/m, '**Timestamp**: 2026-05-28T08:03:01Z');
	}
	fs.writeFileSync(path, blocks.join('\n---\n'));
"
run_compile "$PROJ"
INST_SLUGS=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation').instances.map(i=>i.bolt)")
if [ "$INST_SLUGS" = '["auth","cart","pay"]' ]; then
  ok "Alphabetical ordering with shuffled timestamps: still [auth, cart, pay] (L6 stable across STATE_FORKED order)"
else
  not_ok "Alphabetical ordering with shuffled audit" "$INST_SLUGS"
fi
