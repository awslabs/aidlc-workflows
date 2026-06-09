#!/bin/bash
# t133 (unit): Bolt-DAG runtime compile + gate-time edge-block sensor.
#
# units-generation (2.7) gains a required fenced ```yaml units: edge block on
# unit-of-work-dependency.md; aidlc-runtime compile parses THAT data (no model
# call) into a bolt_dag node on runtime-graph.json, and the required-sections
# sensor validates the block at the 2.7 gate. Pure data → byte-identical
# recompile. Cyclic/malformed/absent blocks omit the node (compile) and fail
# the sensor (gate), never a wrong-but-valid DAG. Pure bash + bun, no LLM
# (10 tests).
#
# Assertions (10):
#   1. valid edge block → bolt_dag node present with units + batches
#   2. batches are correct topological levels (sorted, deps satisfied)
#   3. second compile is byte-identical (determinism, pure-data parse)
#   4. cyclic edge block → bolt_dag omitted + stderr diagnostic
#   5. malformed (dangling dep) → bolt_dag omitted + stderr diagnostic
#   6. absent artifact → envelope byte-identical to the no-bolt_dag shape
#   7. sensor: valid block → pass:true, edge_block:ok
#   8. sensor: cyclic block → pass:false, edge_block:cyclic
#   9. sensor: absent block → pass:false, edge_block:absent
#  10. sensor: a non-target markdown file keeps the generic check (no edge_block)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-runtime.ts"
SENSOR_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-sensor-required-sections.ts"
STATE_FIXTURE="$REPO_ROOT/tests/fixtures/state-construction.md"

if [ ! -f "$RUNTIME_TS" ]; then
  echo "Bail out! aidlc-runtime.ts not found at $RUNTIME_TS"
  exit 1
fi
if [ ! -f "$SENSOR_TS" ]; then
  echo "Bail out! aidlc-sensor-required-sections.ts not found at $SENSOR_TS"
  exit 1
fi
if [ ! -f "$STATE_FIXTURE" ]; then
  echo "Bail out! state-construction.md fixture not found at $STATE_FIXTURE"
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

# Build a project skeleton: aidlc-state.md + an audit.md carrying a
# WORKFLOW_STARTED row (so compile builds a real header rather than the
# empty-graph short-circuit). Prints the project root on stdout.
make_project() {
  local proj
  proj=$(mktemp -d -t aidlc-t133-XXXXXX)
  FIXTURES+=("$proj")
  mkdir -p "$proj/aidlc-docs/inception/units-generation"
  cp "$STATE_FIXTURE" "$proj/aidlc-docs/aidlc-state.md"
  cat >"$proj/aidlc-docs/audit.md" <<'EOF'
# AI-DLC Audit Log

## Workflow Started
**Timestamp**: 2026-06-06T08:00:00Z
**Event**: WORKFLOW_STARTED
**Workflow ID**: t133-fixture
**Scope**: feature

---

## Stage Started
**Timestamp**: 2026-06-06T08:01:00Z
**Event**: STAGE_STARTED
**Stage**: units-generation
**Agent**: aidlc-architect-agent

---

## Stage Completed
**Timestamp**: 2026-06-06T08:02:00Z
**Event**: STAGE_COMPLETED
**Stage**: units-generation

---
EOF
  echo "$proj"
}

# Write the unit-of-work-dependency.md artifact with the given fenced block body.
write_uowd() {
  local proj="$1"
  local block="$2"
  {
    echo "# Unit Dependency DAG"
    echo ""
    echo "## Dependencies"
    echo "$block"
    echo ""
    echo "## Integration Points"
    echo "REST APIs between units."
  } >"$proj/aidlc-docs/inception/units-generation/unit-of-work-dependency.md"
}

uowd_path() {
  echo "$1/aidlc-docs/inception/units-generation/unit-of-work-dependency.md"
}

graph_path() {
  echo "$1/aidlc-docs/runtime-graph.json"
}

run_compile() {
  COMPILE_ERR="$(bun "$RUNTIME_TS" compile --project-dir "$1" 2>&1 >/dev/null)"
  return 0
}

VALID_BLOCK='```yaml
units:
  - name: api
    depends_on: [auth, db]
  - name: auth
    depends_on: []
  - name: db
    depends_on: []
  - name: ui
    depends_on: [api]
```'

# --- 1 & 2: valid block → bolt_dag node + correct batches ------------------

PROJ=$(make_project)
write_uowd "$PROJ" "$VALID_BLOCK"
run_compile "$PROJ"
GP=$(graph_path "$PROJ")

HAS_NODE=$(bun -e "const g=require('$GP'); process.stdout.write(('bolt_dag' in g && Array.isArray(g.bolt_dag.units) && g.bolt_dag.units.length===4) ? 'yes':'no')")
if [ "$HAS_NODE" = "yes" ]; then
  ok "valid edge block: runtime-graph.json gains a bolt_dag node with 4 units"
else
  not_ok "valid edge block: bolt_dag node present with units" "node-check=$HAS_NODE err='$COMPILE_ERR'"
fi

# batches must be [[auth,db],[api],[ui]] — topological levels, each sorted.
BATCHES=$(bun -e "const g=require('$GP'); process.stdout.write(JSON.stringify(g.bolt_dag.batches))")
if [ "$BATCHES" = '[["auth","db"],["api"],["ui"]]' ]; then
  ok "valid edge block: batches are correct sorted topological levels"
else
  not_ok "batches correct" "got=$BATCHES"
fi

# --- 3: byte-identical re-compile (determinism) ----------------------------

FIRST="$PROJ/first-graph.json"
cp "$GP" "$FIRST"
run_compile "$PROJ"
if diff -q "$FIRST" "$GP" >/dev/null 2>&1; then
  ok "second compile is byte-identical (pure-data parse, no Date.now)"
else
  not_ok "byte-identical re-compile" "diff: $(diff "$FIRST" "$GP" | head -5)"
fi

# --- 4: cyclic block → node omitted + stderr diagnostic --------------------

PROJ=$(make_project)
write_uowd "$PROJ" '```yaml
units:
  - name: a
    depends_on: [b]
  - name: b
    depends_on: [a]
```'
run_compile "$PROJ"
GP=$(graph_path "$PROJ")
HAS_NODE=$(bun -e "const g=require('$GP'); process.stdout.write(('bolt_dag' in g) ? 'yes':'no')")
if [ "$HAS_NODE" = "no" ] && echo "$COMPILE_ERR" | grep -q "cyclic"; then
  ok "cyclic edge block: bolt_dag omitted + stderr names 'cyclic'"
else
  not_ok "cyclic rejected" "has_node=$HAS_NODE err='$COMPILE_ERR'"
fi

# --- 5: malformed (dangling dep) → node omitted + stderr diagnostic --------

PROJ=$(make_project)
write_uowd "$PROJ" '```yaml
units:
  - name: a
    depends_on: [does-not-exist]
```'
run_compile "$PROJ"
GP=$(graph_path "$PROJ")
HAS_NODE=$(bun -e "const g=require('$GP'); process.stdout.write(('bolt_dag' in g) ? 'yes':'no')")
if [ "$HAS_NODE" = "no" ] && echo "$COMPILE_ERR" | grep -q "malformed"; then
  ok "malformed edge block (dangling dep): bolt_dag omitted + stderr names 'malformed'"
else
  not_ok "malformed rejected" "has_node=$HAS_NODE err='$COMPILE_ERR'"
fi

# --- 6: absent artifact → envelope byte-identical to the no-bolt_dag shape --

PROJ=$(make_project) # no unit-of-work-dependency.md written
run_compile "$PROJ"
GP=$(graph_path "$PROJ")
KEYS=$(bun -e "const g=require('$GP'); process.stdout.write(Object.keys(g).join(','))")
if [ "$KEYS" = "workflow_id,scope,started_at,stages" ]; then
  ok "absent artifact: envelope keeps the pre-MR-15 4-key shape (no empty node)"
else
  not_ok "absent artifact byte-identical envelope" "keys=$KEYS"
fi

# --- 7-9: sensor edge-block validation -------------------------------------

PROJ=$(make_project)
UP=$(uowd_path "$PROJ")

write_uowd "$PROJ" '```yaml
units:
  - name: a
    depends_on: []
  - name: b
    depends_on: [a]
```'
S_OUT=$(bun "$SENSOR_TS" --stage units-generation --output-path "$UP")
if echo "$S_OUT" | grep -q '"pass":true' && echo "$S_OUT" | grep -q '"edge_block":"ok"'; then
  ok "sensor: valid block → pass:true, edge_block:ok"
else
  not_ok "sensor valid" "out=$S_OUT"
fi

write_uowd "$PROJ" '```yaml
units:
  - name: a
    depends_on: [b]
  - name: b
    depends_on: [a]
```'
S_OUT=$(bun "$SENSOR_TS" --stage units-generation --output-path "$UP")
if echo "$S_OUT" | grep -q '"pass":false' && echo "$S_OUT" | grep -q '"edge_block":"cyclic"'; then
  ok "sensor: cyclic block → pass:false, edge_block:cyclic"
else
  not_ok "sensor cyclic" "out=$S_OUT"
fi

# absent block: a doc with H2 headings but no fenced yaml units block
{
  echo "## Dependencies"
  echo "Prose only: a depends on b."
  echo "## Integration"
  echo "REST."
} >"$UP"
S_OUT=$(bun "$SENSOR_TS" --stage units-generation --output-path "$UP")
if echo "$S_OUT" | grep -q '"pass":false' && echo "$S_OUT" | grep -q '"edge_block":"absent"'; then
  ok "sensor: absent block → pass:false, edge_block:absent"
else
  not_ok "sensor absent" "out=$S_OUT"
fi

# --- 10: a non-target markdown file keeps the generic check (no edge_block) -

OTHER="$PROJ/aidlc-docs/inception/units-generation/unit-of-work.md"
{
  echo "## Units"
  echo "Body."
  echo "## Responsibilities"
  echo "More."
} >"$OTHER"
S_OUT=$(bun "$SENSOR_TS" --stage units-generation --output-path "$OTHER")
if echo "$S_OUT" | grep -q '"pass":true' && ! echo "$S_OUT" | grep -q 'edge_block'; then
  ok "sensor: non-target markdown keeps the generic H2 check (no edge_block field)"
else
  not_ok "sensor non-target unchanged" "out=$S_OUT"
fi

finish
