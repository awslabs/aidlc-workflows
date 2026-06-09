#!/bin/bash
# t95: Behavioural contract for `aidlc-sensor-fire.ts` end-to-end with
# a mock dispatcher (v0.5.0 MR 10). 19 feature assertions covering the
# spawn argv shape, multi-glob filtering at the stage level, hook
# error-recovery (timeout / spawn-failure / non-zero exit), the
# advisory-only contract, heartbeat coexistence, and skipped-file
# accumulation.
#
# Surface tested:
#   - Single-entry fire: hook spawns `aidlc-sensor.ts fire <id>
#     --stage <slug> --output-path <path>` exactly once with the
#     correct argv (verified via mock dispatcher that records argv).
#   - Multi-entry fire: stage with 2 sensors_applicable both matching
#     → 2 spawns, both args correct.
#   - Construction code path (multi-glob per stage): TS write at a
#     stage carrying linter (`**/*.{ts,js}`) + type-check
#     (`**/*.{ts,tsx}`) + markdown sensors (`**/aidlc-docs/**`)
#     fires only the code sensors (markdown filtered by glob mismatch).
#     Inverse for markdown writes.
#   - Subprocess timeout: dispatcher sleeps past the hook's timeout;
#     hook records the SIGTERM in sensor-fire.drops; exits 0.
#   - Subprocess failure: dispatcher exits non-zero; hook records
#     drop; exits 0.
#   - Exit code contract: hook never returns `{decision: block}`,
#     even when a sensor "fail" verdict is in play.
#   - Heartbeat coexistence: two sequential Writes each touch
#     `sensor-fire.last`; mtime advances per call.
#   - Skipped-file shape: Test Run Mode: true triggers two writes;
#     `sensor-fire.skipped` accumulates 2 timestamped lines.
#
# Strategy: each test stages a self-contained project skeleton with
# a per-test mock dispatcher (aidlc-sensor.ts) that records its argv
# to $T95_SPAWN_LOG. Custom synthetic stage-graph.json fixtures are
# generated inline for the multi-glob and dual-entry cases.
#
# Timeout test uses a patched copy of the hook with timeout=2000 to
# keep the test fast; production C2 (90s) is unchanged.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_TOOLS="$REPO_ROOT/dist/claude/.claude/tools"
SRC_HOOKS="$REPO_ROOT/dist/claude/.claude/hooks"
HOOK_TS="$SRC_HOOKS/aidlc-sensor-fire.ts"
FRAMEWORK_GRAPH="$SRC_TOOLS/data/stage-graph.json"

if [ ! -f "$HOOK_TS" ]; then
  echo "Bail out! aidlc-sensor-fire.ts not found at $HOOK_TS"
  exit 1
fi

plan 19

# --- Helpers --------------------------------------------------------------

# Stub aidlc-sensor.ts that records argv. Optional behaviour overrides
# via env: T95_STUB_MODE = "pass" (default) | "fail-exit-1" | "slow".
write_mock_dispatcher() {
  local target="$1"
  cat >"$target" <<'EOF'
// @ts-nocheck
// t95 mock dispatcher: record argv and exit per T95_STUB_MODE.
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const out = process.env.T95_SPAWN_LOG;
if (out) {
	mkdirSync(dirname(out), { recursive: true });
	const line = JSON.stringify(process.argv) + "\n";
	if (existsSync(out)) appendFileSync(out, line);
	else writeFileSync(out, line);
}
const mode = process.env.T95_STUB_MODE ?? "pass";
if (mode === "slow") {
	// Block long enough to exceed the hook's timeout.
	Bun.sleepSync(5000);
	process.stdout.write("{\"pass\":true}\n");
	process.exit(0);
} else if (mode === "fail-exit-1") {
	process.stderr.write("dispatcher invocation error: fixture\n");
	process.exit(1);
}
// default: pass
process.stdout.write("{\"pass\":true}\n");
process.exit(0);
EOF
}

make_project() {
  local proj
  proj=$(mktemp -d -t aidlc-t95-XXXXXX)
  mkdir -p "$proj/aidlc-docs" "$proj/.claude/tools" "$proj/.claude/hooks"
  write_mock_dispatcher "$proj/.claude/tools/aidlc-sensor.ts"
  echo "$proj"
}

# Project + state.md with active stage + audit.md so the hook reaches
# the dispatch loop. Caller passes the slug.
make_project_active() {
  local slug="${1:-requirements-analysis}"
  local proj
  proj=$(make_project)
  cat >"$proj/aidlc-docs/aidlc-state.md" <<EOF
- **Workflow**: bugfix
- **Current Stage**: $slug
EOF
  echo "audit fixture" >"$proj/aidlc-docs/audit.md"
  echo "$proj"
}

run_hook_with() {
  local proj="$1"
  local payload="$2"
  local graph="${3:-$FRAMEWORK_GRAPH}"
  local hook="${4:-$HOOK_TS}"
  local mode="${5:-pass}"
  local timeout_ms="${6:-}"
  local rc=0
  echo "$payload" |
    CLAUDE_PROJECT_DIR="$proj" \
      AIDLC_STAGE_GRAPH="$graph" \
      AIDLC_SENSOR_TIMEOUT_MS="$timeout_ms" \
      T95_SPAWN_LOG="$proj/.spawn.log" \
      T95_STUB_MODE="$mode" \
      timeout 30 bun "$hook" >/dev/null 2>&1 || rc=$?
  return $rc
}

# Build a synthetic stage-graph.json with a single stage carrying the
# given sensors_applicable[]. Caller passes a JSON array string.
synth_graph() {
  local slug="$1"
  local applicable_json="$2"
  local out
  out=$(mktemp -t aidlc-t95-syn.XXXXXX.json)
  cat >"$out" <<EOF
[
	{
		"slug": "$slug",
		"number": "1.0",
		"name": "Synthetic Stage",
		"phase": "construction",
		"execution": "ALWAYS",
		"lead_agent": "aidlc-developer-agent",
		"support_agents": [],
		"mode": "inline",
		"produces": [],
		"consumes": [],
		"requires_stage": [],
		"inputs": "",
		"outputs": "",
		"rules_in_context": [],
		"sensors_applicable": $applicable_json
	}
]
EOF
  echo "$out"
}

# --- Case 1: single-entry fire on Inception markdown ----------------------
PROJ=$(make_project_active "requirements-analysis")
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/requirements-analysis/intent.md" \
  '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook_with "$PROJ" "$PAYLOAD" >/dev/null
SPAWN_COUNT=$(wc -l <"$PROJ/.spawn.log" 2>/dev/null | tr -d ' ' || echo 0)
# requirements-analysis carries required-sections + upstream-coverage
# (both with matches: **/aidlc-docs/** after MR 10). Two should fire.
assert_eq "$SPAWN_COUNT" "2" "Inception markdown write fires 2 markdown sensors (required-sections + upstream-coverage)"
# Check argv shape on first entry: ["bun", ".../aidlc-sensor.ts", "fire", <id>, "--stage", "requirements-analysis", "--output-path", <path>]
LINE1=$(head -1 "$PROJ/.spawn.log")
assert_match "$LINE1" '"fire"' "argv carries fire subcommand"
assert_match "$LINE1" '"--stage","requirements-analysis"' "argv carries --stage requirements-analysis"
assert_match "$LINE1" '"--output-path"' "argv carries --output-path flag"
rm -rf "$PROJ"

# --- Case 2: multi-entry fire (synthetic stage with 2 matching) ----------
PROJ=$(make_project_active "synthetic-multi")
APPLICABLE='[
	{"id":"sensor-a","path":".claude/sensors/aidlc-a.md","matches":"**/aidlc-docs/**"},
	{"id":"sensor-b","path":".claude/sensors/aidlc-b.md","matches":"**/aidlc-docs/**"}
]'
GRAPH=$(synth_graph "synthetic-multi" "$APPLICABLE")
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/foo.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook_with "$PROJ" "$PAYLOAD" "$GRAPH" >/dev/null
SPAWN_COUNT=$(wc -l <"$PROJ/.spawn.log" 2>/dev/null | tr -d ' ' || echo 0)
assert_eq "$SPAWN_COUNT" "2" "stage with 2 matching sensors_applicable → 2 spawns"
LINE1=$(head -1 "$PROJ/.spawn.log")
LINE2=$(sed -n '2p' "$PROJ/.spawn.log")
if echo "$LINE1" | grep -q '"sensor-a"' && echo "$LINE2" | grep -q '"sensor-b"'; then
  ok "spawns preserve sensors_applicable order (sensor-a before sensor-b)"
else
  not_ok "spawns preserve order" "got line1=$LINE1 line2=$LINE2"
fi
rm -f "$GRAPH"
rm -rf "$PROJ"

# --- Case 3: Construction code path (multi-glob, TS write) ---------------
# Stage carries linter + type-check + markdown sensors. TS write should
# fire only the code sensors (linter, type-check); markdown sensors
# filter out by glob mismatch.
PROJ=$(make_project_active "code-generation-syn")
APPLICABLE='[
	{"id":"linter","path":".claude/sensors/aidlc-linter.md","matches":"**/*.{ts,js}"},
	{"id":"type-check","path":".claude/sensors/aidlc-type-check.md","matches":"**/*.{ts,tsx}"},
	{"id":"required-sections","path":".claude/sensors/aidlc-required-sections.md","matches":"**/aidlc-docs/**"},
	{"id":"upstream-coverage","path":".claude/sensors/aidlc-upstream-coverage.md","matches":"**/aidlc-docs/**"}
]'
GRAPH=$(synth_graph "code-generation-syn" "$APPLICABLE")
PAYLOAD=$(jq -nc --arg p "$PROJ/src/foo.ts" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook_with "$PROJ" "$PAYLOAD" "$GRAPH" >/dev/null
SPAWN_COUNT=$(wc -l <"$PROJ/.spawn.log" 2>/dev/null | tr -d ' ' || echo 0)
assert_eq "$SPAWN_COUNT" "2" "TS write at code-generation stage → only linter + type-check fire (markdown sensors filtered)"
LOG=$(cat "$PROJ/.spawn.log")
if echo "$LOG" | grep -q '"linter"' && echo "$LOG" | grep -q '"type-check"' && ! echo "$LOG" | grep -q '"required-sections"'; then
  ok "TS write fires linter + type-check, skips required-sections (multi-glob filter)"
else
  not_ok "TS write fires only code sensors" "log=$LOG"
fi
# Inverse: markdown write at the same stage fires only markdown sensors.
# `: >file` truncates without a command (bare `>file` would trip
# SC2188 as ambiguous).
: >"$PROJ/.spawn.log"
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/foo.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook_with "$PROJ" "$PAYLOAD" "$GRAPH" >/dev/null
SPAWN_COUNT=$(wc -l <"$PROJ/.spawn.log" 2>/dev/null | tr -d ' ' || echo 0)
assert_eq "$SPAWN_COUNT" "2" "markdown write at code-generation stage → only required-sections + upstream-coverage fire (code sensors filtered)"
rm -f "$GRAPH"
rm -rf "$PROJ"

# --- Case 4: glob filter (one matches, one does not) ---------------------
PROJ=$(make_project_active "glob-mixed")
APPLICABLE='[
	{"id":"sensor-md-only","path":".claude/sensors/aidlc-md.md","matches":"**/aidlc-docs/**"},
	{"id":"sensor-ts-only","path":".claude/sensors/aidlc-ts.md","matches":"**/*.{ts}"}
]'
GRAPH=$(synth_graph "glob-mixed" "$APPLICABLE")
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook_with "$PROJ" "$PAYLOAD" "$GRAPH" >/dev/null
SPAWN_COUNT=$(wc -l <"$PROJ/.spawn.log" 2>/dev/null | tr -d ' ' || echo 0)
assert_eq "$SPAWN_COUNT" "1" "mixed-glob stage on .md → only md sensor fires"
LINE1=$(head -1 "$PROJ/.spawn.log")
assert_match "$LINE1" '"sensor-md-only"' "spawned id is sensor-md-only (not sensor-ts-only)"
rm -f "$GRAPH"
rm -rf "$PROJ"

# --- Case 5: subprocess timeout → recordHookDrop, exit 0 ------------------
# Override the hook's subprocess timeout to 2s via AIDLC_SENSOR_TIMEOUT_MS
# env-var seam (see aidlc-sensor-fire.ts SUBPROCESS_TIMEOUT_MS
# resolution). Avoids the source-patch pattern (sed-rewrite of the
# production hook into hooks/) that earlier revisions used.
PROJ=$(make_project_active "requirements-analysis")
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/requirements-analysis/intent.md" \
  '{tool_name:"Write", tool_input:{file_path:$p}}')
START=$(date +%s)
set +e
run_hook_with "$PROJ" "$PAYLOAD" "$FRAMEWORK_GRAPH" "$HOOK_TS" "slow" "2000"
RC=$?
set -e
ELAPSED=$(($(date +%s) - START))
assert_eq "$RC" "0" "hook exit 0 even when subprocess times out (G5 advisory)"
DROPS="$PROJ/aidlc-docs/.aidlc-hooks-health/sensor-fire.drops"
if [ -f "$DROPS" ] && grep -q "subprocess killed by SIGTERM" "$DROPS"; then
  ok "timeout → recordHookDrop with SIGTERM/timeout reason"
else
  not_ok "timeout → recordHookDrop" "drops file=$([ -f $DROPS ] && cat $DROPS || echo MISSING) elapsed=${ELAPSED}s"
fi
rm -rf "$PROJ"

# --- Case 6: subprocess failure (exit 1) → recordHookDrop, exit 0 --------
PROJ=$(make_project_active "requirements-analysis")
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/requirements-analysis/intent.md" \
  '{tool_name:"Write", tool_input:{file_path:$p}}')
set +e
run_hook_with "$PROJ" "$PAYLOAD" "$FRAMEWORK_GRAPH" "$HOOK_TS" "fail-exit-1"
RC=$?
set -e
assert_eq "$RC" "0" "hook exit 0 even when subprocess exits non-zero (G5 advisory)"
DROPS="$PROJ/aidlc-docs/.aidlc-hooks-health/sensor-fire.drops"
if [ -f "$DROPS" ] && grep -q "dispatcher exit 1" "$DROPS"; then
  ok "subprocess exit 1 → recordHookDrop with dispatcher exit 1 reason"
else
  not_ok "subprocess exit 1 → recordHookDrop" "drops=$([ -f $DROPS ] && cat $DROPS || echo MISSING)"
fi
rm -rf "$PROJ"

# --- Case 7: exit code contract — never returns {decision: block} --------
# The hook does not write to stdout (per the precedent hooks). Verify
# stdout is empty even with all guards green.
PROJ=$(make_project_active "requirements-analysis")
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/requirements-analysis/intent.md" \
  '{tool_name:"Write", tool_input:{file_path:$p}}')
OUT=$(echo "$PAYLOAD" |
  CLAUDE_PROJECT_DIR="$PROJ" \
    AIDLC_STAGE_GRAPH="$FRAMEWORK_GRAPH" \
    T95_SPAWN_LOG="$PROJ/.spawn.log" \
    T95_STUB_MODE="pass" \
    timeout 15 bun "$HOOK_TS" 2>/dev/null || true)
if [ -z "$OUT" ] || ! echo "$OUT" | grep -q "decision"; then
  ok "hook stdout never carries {decision: block} (advisory contract)"
else
  not_ok "hook stdout carries decision JSON" "stdout=$OUT"
fi
rm -rf "$PROJ"

# --- Case 8: heartbeat coexistence (mtime advances per call) -------------
PROJ=$(make_project_active "requirements-analysis")
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/requirements-analysis/intent.md" \
  '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook_with "$PROJ" "$PAYLOAD" >/dev/null
HB="$PROJ/aidlc-docs/.aidlc-hooks-health/sensor-fire.last"
HB_MTIME_1=$(bun -e "console.log(require('fs').statSync('$HB').mtimeMs)")
sleep 1.1
run_hook_with "$PROJ" "$PAYLOAD" >/dev/null
HB_MTIME_2=$(bun -e "console.log(require('fs').statSync('$HB').mtimeMs)")
# Compare as decimals via awk to handle the millisecond precision.
IS_GREATER=$(awk -v a="$HB_MTIME_2" -v b="$HB_MTIME_1" 'BEGIN { print (a > b) ? 1 : 0 }')
if [ "$IS_GREATER" = "1" ]; then
  ok "heartbeat mtime advances on second invocation"
else
  not_ok "heartbeat mtime advances" "mtime1=$HB_MTIME_1 mtime2=$HB_MTIME_2"
fi
rm -rf "$PROJ"

# --- Case 9: skipped-file shape (Test Run Mode: true, 2 writes) ----------
PROJ=$(make_project)
echo "audit fixture" >"$PROJ/aidlc-docs/audit.md"
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
- **Current Stage**: requirements-analysis
- **Test Run Mode**: true
EOF
PAYLOAD=$(jq -nc --arg p "$PROJ/aidlc-docs/inception/x.md" '{tool_name:"Write", tool_input:{file_path:$p}}')
run_hook_with "$PROJ" "$PAYLOAD" >/dev/null
sleep 0.05
run_hook_with "$PROJ" "$PAYLOAD" >/dev/null
SKIP="$PROJ/aidlc-docs/.aidlc-hooks-health/sensor-fire.skipped"
SKIP_LINES=$(wc -l <"$SKIP" | tr -d ' ')
assert_eq "$SKIP_LINES" "2" "two Test-Run writes → sensor-fire.skipped has 2 timestamped lines"
# Both lines must look like ISO timestamps.
INVALID_LINES=$(grep -cv "^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T" "$SKIP" || true)
assert_eq "$INVALID_LINES" "0" "every line in sensor-fire.skipped is ISO timestamp"
rm -rf "$PROJ"

finish
