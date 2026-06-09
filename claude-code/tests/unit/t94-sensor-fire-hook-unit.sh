#!/bin/bash
# t94: Behavioural contract for `aidlc-sensor-fire.ts` PostToolUse hook
# (v0.5.0 MR 10). 18 unit assertions covering every guard + early-exit
# branch in the 12-step flow.
#
# Surface tested:
#   - TTY guard / malformed JSON / empty file_path: exit 0, no work.
#   - Recursion guard (writes to aidlc-docs/.aidlc-sensors/) → exit 0.
#   - Pre-init guard: no audit.md OR no aidlc-state.md → exit 0, NO
#     heartbeat (heartbeat is post-state-existence).
#   - Test Run Mode skip (G2): true → sensor-fire.skipped appended, NO
#     heartbeat, NO subprocess fork. false → continues to heartbeat.
#   - Heartbeat (G3): sensor-fire.last written with ISO timestamp.
#   - Active-stage early-exits: missing Current Stage; "none". No spawn.
#   - Stage-graph early-exits: AIDLC_STAGE_GRAPH points at missing
#     file (loadGraph throws); stage slug not in graph; empty
#     sensors_applicable (matches workspace-scaffold per
#     stage-graph.json:32). All exit 0, no spawn.
#   - Glob filter (matches absent on a SensorResolution entry) → no
#     fire (G1 lock-in: matches IS the filter).
#
# Strategy: build a self-contained project skeleton under tempdir; the
# hook resolves project paths via CLAUDE_PROJECT_DIR. A stub
# aidlc-sensor.ts at <proj>/.claude/tools/aidlc-sensor.ts records argv
# to a per-test SPAWN_LOG file — its absence after a hook run proves
# "no spawn" for the no-fire cases. AIDLC_STAGE_GRAPH overrides the
# default stage-graph.json lookup for the synthetic-graph cases.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_TOOLS="$REPO_ROOT/dist/claude/.claude/tools"
SRC_HOOKS="$REPO_ROOT/dist/claude/.claude/hooks"
HOOK_TS="$SRC_HOOKS/aidlc-sensor-fire.ts"
FRAMEWORK_GRAPH="$SRC_TOOLS/data/stage-graph.json"
FIXTURES="$REPO_ROOT/tests/fixtures/v05-mr10-sensor-fire"

if [ ! -f "$HOOK_TS" ]; then
	echo "Bail out! aidlc-sensor-fire.ts not found at $HOOK_TS"
	exit 1
fi
if [ ! -f "$FRAMEWORK_GRAPH" ]; then
	echo "Bail out! framework stage-graph.json not found"
	exit 1
fi

plan 18

# --- Helpers --------------------------------------------------------------

# Build a project skeleton that the hook + loadGraph can resolve against.
# The hook is run in-place from $HOOK_TS (no copy). CLAUDE_PROJECT_DIR
# routes auditFilePath / stateFilePath / health-dir into $proj.
make_project() {
	local proj
	proj=$(mktemp -d -t aidlc-t94-XXXXXX)
	mkdir -p "$proj/aidlc-docs" "$proj/.claude/tools/data" "$proj/.claude/tools" "$proj/.claude/hooks"

	# Stub aidlc-sensor.ts: records argv to $T94_SPAWN_LOG and exits 0.
	# The hook's spawnSync target. Absence of this file after a hook run
	# would surface as a thrown ENOENT inside try/catch → recordHookDrop
	# (sensor-fire.drops); for "no spawn" cases we assert the SPAWN_LOG
	# file does not exist.
	cat >"$proj/.claude/tools/aidlc-sensor.ts" <<'EOF'
// @ts-nocheck
// t94 stub: capture argv and exit 0. Hook spawns this; tests assert
// on the per-fire log file's existence + content.
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const out = process.env.T94_SPAWN_LOG;
if (out) {
	mkdirSync(dirname(out), { recursive: true });
	const line = JSON.stringify(process.argv) + "\n";
	if (existsSync(out)) appendFileSync(out, line);
	else writeFileSync(out, line);
}
process.stdout.write("{\"pass\": true}\n");
process.exit(0);
EOF

	echo "$proj"
}

# Fresh project + a state.md with Current Stage that has matching sensors
# in the FRAMEWORK graph (we use requirements-analysis: it carries
# required-sections + upstream-coverage with the new matches glob).
# Caller writes audit.md and stage-graph customisations as needed.
make_project_active() {
	local proj
	proj=$(make_project)
	cat >"$proj/aidlc-docs/aidlc-state.md" <<'EOF'
# AI-DLC State (t94 fixture)

- **Workflow**: bugfix
- **Scope**: bugfix
- **Phase**: inception
- **Current Stage**: requirements-analysis
EOF
	# audit.md presence is the "active workflow" gate (Step 6).
	echo "audit fixture" >"$proj/aidlc-docs/audit.md"
	echo "$proj"
}

# Run hook with explicit env. SPAWN_LOG defaults to $proj/.spawn.log;
# AIDLC_STAGE_GRAPH defaults to the framework graph (so loadGraph picks
# the regenerated one with MR 10's matches glob in place).
run_hook() {
	local proj="$1"
	local payload="$2"
	local graph="${3:-$FRAMEWORK_GRAPH}"
	local rc=0
	echo "$payload" | \
		CLAUDE_PROJECT_DIR="$proj" \
		AIDLC_STAGE_GRAPH="$graph" \
		T94_SPAWN_LOG="$proj/.spawn.log" \
		timeout 15 bun "$HOOK_TS" >/dev/null 2>&1 || rc=$?
	return $rc
}

heartbeat_path() {
	echo "$1/aidlc-docs/.aidlc-hooks-health/sensor-fire.last"
}

skipped_path() {
	echo "$1/aidlc-docs/.aidlc-hooks-health/sensor-fire.skipped"
}

# --- Case 1: TTY guard (no piped stdin) ----------------------------------
PROJ=$(make_project_active)
rc=0
CLAUDE_PROJECT_DIR="$PROJ" \
	AIDLC_STAGE_GRAPH="$FRAMEWORK_GRAPH" \
	T94_SPAWN_LOG="$PROJ/.spawn.log" \
	timeout 5 bun "$HOOK_TS" </dev/null >/dev/null 2>&1 || rc=$?
assert_eq "$rc" "0" "TTY/empty-stdin guard → exit 0"
rm -rf "$PROJ"

# --- Case 2: malformed JSON stdin → exit 0, no work ----------------------
PROJ=$(make_project_active)
echo "this is not json" | \
	CLAUDE_PROJECT_DIR="$PROJ" \
	AIDLC_STAGE_GRAPH="$FRAMEWORK_GRAPH" \
	T94_SPAWN_LOG="$PROJ/.spawn.log" \
	timeout 5 bun "$HOOK_TS" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ ! -f "$PROJ/.spawn.log" ]; then
	ok "malformed JSON → exit 0, no spawn"
else
	not_ok "malformed JSON → exit 0, no spawn" "rc=$rc spawn_log_exists=$([ -f $PROJ/.spawn.log ] && echo yes || echo no)"
fi
rm -rf "$PROJ"

# --- Case 3: valid PostToolUse payload (proceeds; spawn happens) ---------
PROJ=$(make_project_active)
PAYLOAD=$(cat "$FIXTURES/posttool-write-payload.json" | sed "s|/proj/|$PROJ/|g")
run_hook "$PROJ" "$PAYLOAD" >/dev/null
if [ -f "$PROJ/.spawn.log" ]; then
	ok "valid payload + applicable sensors → spawn fires"
else
	not_ok "valid payload + applicable sensors → spawn fires" "no spawn log written"
fi
rm -rf "$PROJ"

# --- Case 4: recursion guard (path inside .aidlc-sensors/) ---------------
PROJ=$(make_project_active)
PAYLOAD=$(jq -nc \
	--arg path "$PROJ/aidlc-docs/.aidlc-sensors/foo/bar.md" \
	'{tool_name:"Write", tool_input:{file_path:$path}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
if [ ! -f "$PROJ/.spawn.log" ]; then
	ok "recursion guard (.aidlc-sensors/) → no spawn"
else
	not_ok "recursion guard (.aidlc-sensors/) → no spawn" "spawn unexpectedly fired"
fi
rm -rf "$PROJ"

# --- Case 5: empty file_path → exit 0, no spawn ---------------------------
PROJ=$(make_project_active)
PAYLOAD='{"tool_name":"Write","tool_input":{}}'
run_hook "$PROJ" "$PAYLOAD" >/dev/null
if [ ! -f "$PROJ/.spawn.log" ]; then
	ok "empty file_path → no spawn"
else
	not_ok "empty file_path → no spawn" "spawn unexpectedly fired"
fi
rm -rf "$PROJ"

# --- Case 6: non-aidlc path (no glob matches it) → no spawn ---------------
PROJ=$(make_project_active)
PAYLOAD=$(jq -nc '{tool_name:"Write", tool_input:{file_path:"/tmp/scratch/notes.txt"}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
if [ ! -f "$PROJ/.spawn.log" ]; then
	ok "non-aidlc path → no glob match → no spawn"
else
	not_ok "non-aidlc path → no spawn" "spawn unexpectedly fired"
fi
rm -rf "$PROJ"

# --- Case 7: no audit.md → exit 0, no heartbeat --------------------------
PROJ=$(make_project)
# state.md present but audit.md absent
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
- **Current Stage**: requirements-analysis
EOF
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
HB=$(heartbeat_path "$PROJ")
if [ ! -f "$HB" ] && [ ! -f "$PROJ/.spawn.log" ]; then
	ok "no audit.md → exit 0, no heartbeat, no spawn"
else
	not_ok "no audit.md → exit 0, no heartbeat" "heartbeat=$([ -f $HB ] && echo yes || echo no) spawn=$([ -f $PROJ/.spawn.log ] && echo yes || echo no)"
fi
rm -rf "$PROJ"

# --- Case 8: no aidlc-state.md (audit.md present) → exit 0, no heartbeat -
PROJ=$(make_project)
echo "audit fixture" >"$PROJ/aidlc-docs/audit.md"
# NB: state.md not created
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
HB=$(heartbeat_path "$PROJ")
if [ ! -f "$HB" ] && [ ! -f "$PROJ/.spawn.log" ]; then
	ok "no state.md → exit 0, no heartbeat (state-existence guard precedes heartbeat)"
else
	not_ok "no state.md → exit 0, no heartbeat" "heartbeat=$([ -f $HB ] && echo yes || echo no)"
fi
rm -rf "$PROJ"

# --- Case 9: Test Run Mode: true → skipped-file appended, no heartbeat ---
PROJ=$(make_project)
echo "audit fixture" >"$PROJ/aidlc-docs/audit.md"
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
- **Current Stage**: requirements-analysis
- **Test Run Mode**: true
EOF
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
HB=$(heartbeat_path "$PROJ")
SKIP=$(skipped_path "$PROJ")
if [ -f "$SKIP" ] && [ ! -f "$HB" ] && [ ! -f "$PROJ/.spawn.log" ]; then
	ok "Test Run Mode: true → skipped-file appended, no heartbeat, no spawn"
else
	not_ok "Test Run Mode: true → skipped-file appended" "skip=$([ -f $SKIP ] && echo yes || echo no) hb=$([ -f $HB ] && echo yes || echo no) spawn=$([ -f $PROJ/.spawn.log ] && echo yes || echo no)"
fi
# Verify the appended timestamp shape (ISO-8601-ish: starts with YYYY-MM-DD)
SKIP_LINE=$(head -1 "$SKIP" 2>/dev/null || echo "")
assert_match "$SKIP_LINE" "^[0-9]{4}-[0-9]{2}-[0-9]{2}T" "skipped file carries ISO timestamp"
rm -rf "$PROJ"

# --- Case 10: Test Run Mode: false → continues (heartbeat written) -------
# Use a non-aidlc path so we don't fire any sensors but still pass the
# test-run guard and write the heartbeat.
PROJ=$(make_project)
echo "audit fixture" >"$PROJ/aidlc-docs/audit.md"
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
- **Current Stage**: requirements-analysis
- **Test Run Mode**: false
EOF
PAYLOAD=$(jq -nc --arg p "/tmp/scratch/x.txt" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
HB=$(heartbeat_path "$PROJ")
if [ -f "$HB" ] && [ ! -f "$PROJ/.spawn.log" ]; then
	ok "Test Run Mode: false → heartbeat written, no spawn (path filter)"
else
	not_ok "Test Run Mode: false → heartbeat" "hb=$([ -f $HB ] && echo yes || echo no) spawn=$([ -f $PROJ/.spawn.log ] && echo yes || echo no)"
fi
rm -rf "$PROJ"

# --- Case 11: heartbeat writes ISO timestamp -----------------------------
PROJ=$(make_project_active)
PAYLOAD=$(jq -nc --arg p "/tmp/scratch/x.txt" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
HB=$(heartbeat_path "$PROJ")
HB_CONTENT=$(cat "$HB" 2>/dev/null || echo "")
assert_match "$HB_CONTENT" "^[0-9]{4}-[0-9]{2}-[0-9]{2}T" "heartbeat file carries ISO timestamp"
rm -rf "$PROJ"

# --- Case 12: missing Current Stage → exit 0, no spawn -------------------
PROJ=$(make_project)
echo "audit fixture" >"$PROJ/aidlc-docs/audit.md"
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
- **Workflow**: bugfix
EOF
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
if [ ! -f "$PROJ/.spawn.log" ]; then
	ok "missing Current Stage → no spawn"
else
	not_ok "missing Current Stage → no spawn" "spawn unexpectedly fired"
fi
rm -rf "$PROJ"

# --- Case 13: Current Stage: none → exit 0, no spawn ---------------------
PROJ=$(make_project)
echo "audit fixture" >"$PROJ/aidlc-docs/audit.md"
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
- **Current Stage**: none
EOF
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
if [ ! -f "$PROJ/.spawn.log" ]; then
	ok "Current Stage: none → no spawn"
else
	not_ok "Current Stage: none → no spawn" "spawn unexpectedly fired"
fi
rm -rf "$PROJ"

# --- Case 14: missing stage-graph.json → loadGraph throws → no spawn -----
PROJ=$(make_project_active)
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" "/nonexistent/stage-graph.json" >/dev/null
HB=$(heartbeat_path "$PROJ")
if [ ! -f "$PROJ/.spawn.log" ] && [ -f "$HB" ]; then
	ok "missing stage-graph.json → no spawn (heartbeat still written: G3 placement)"
else
	not_ok "missing stage-graph.json → no spawn" "spawn=$([ -f $PROJ/.spawn.log ] && echo yes || echo no) hb=$([ -f $HB ] && echo yes || echo no)"
fi
rm -rf "$PROJ"

# --- Case 15: stage slug not in graph → no spawn -------------------------
PROJ=$(make_project)
echo "audit fixture" >"$PROJ/aidlc-docs/audit.md"
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
- **Current Stage**: nonexistent-stage-slug
EOF
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
if [ ! -f "$PROJ/.spawn.log" ]; then
	ok "stage slug not in graph → no spawn"
else
	not_ok "stage slug not in graph → no spawn" "spawn unexpectedly fired"
fi
rm -rf "$PROJ"

# --- Case 16: empty sensors_applicable (workspace-scaffold) → no spawn ----
PROJ=$(make_project)
echo "audit fixture" >"$PROJ/aidlc-docs/audit.md"
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
- **Current Stage**: workspace-scaffold
EOF
# workspace-scaffold has sensors_applicable: [] in the framework graph
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" >/dev/null
HB=$(heartbeat_path "$PROJ")
if [ ! -f "$PROJ/.spawn.log" ] && [ -f "$HB" ]; then
	ok "workspace-scaffold (empty sensors_applicable) → no spawn, heartbeat present"
else
	not_ok "workspace-scaffold → no spawn, heartbeat" "spawn=$([ -f $PROJ/.spawn.log ] && echo yes || echo no) hb=$([ -f $HB ] && echo yes || echo no)"
fi
rm -rf "$PROJ"

# --- Case 17: glob filter — entry without `matches` → no fire ------------
# Build a synthetic graph with one stage whose sensors_applicable carries
# an entry missing the `matches` field. Hook should `continue` on it.
PROJ=$(make_project_active)
SYN_GRAPH=$(mktemp -t aidlc-t94-syn.XXXXXX.json)
cat >"$SYN_GRAPH" <<'EOF'
[
	{
		"slug": "requirements-analysis",
		"number": "1.1",
		"name": "Requirements Analysis",
		"phase": "inception",
		"execution": "ALWAYS",
		"lead_agent": "aidlc-product-agent",
		"support_agents": [],
		"mode": "inline",
		"produces": [],
		"consumes": [],
		"requires_stage": [],
		"inputs": "",
		"outputs": "",
		"rules_in_context": [],
		"sensors_applicable": [
			{
				"id": "no-matches-sensor",
				"path": ".claude/sensors/aidlc-no-matches-sensor.md"
			}
		]
	}
]
EOF
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook "$PROJ" "$PAYLOAD" "$SYN_GRAPH" >/dev/null
if [ ! -f "$PROJ/.spawn.log" ]; then
	ok "entry without matches → no fire (G1 lock-in: matches IS the filter)"
else
	not_ok "entry without matches → no fire" "spawn unexpectedly fired"
fi
rm -f "$SYN_GRAPH"
rm -rf "$PROJ"

finish
