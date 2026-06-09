#!/bin/bash
# t92: Behavioural contract for `aidlc-sensor.ts fire` (v0.5.0 MR 9). 43 tests.
#
# Surface tested:
#   - Argv validation (exit 1, NO audit emit) for all 7 invalid invocation
#     shapes: missing/unknown id, missing/unknown stage, missing/missing-on-disk
#     output path, matches-rejection.
#   - Round-trip per sensor (PASSED + FAILED) for all 4 framework sensors,
#     covering the 4 distinct findings-count derivation rules
#     (required-sections: max(0,2-h2_count); upstream-coverage:
#     unreferenced.length; linter: errorCount; type-check: errors.length).
#   - Truth-table branches: a (BUDGET_OVERRIDE), b (tool-unavailable, exit 127),
#     c (FAILED), d (PASSED), e (script-error: exit-N), f (script-error:
#     bad-output), and detail-write-failed fallback.
#   - Concurrency invariants: lock-released-across-spawn (split lock window
#     A/B); 5-fan-out happy path keeps pairs coherent; lock-orphan recovery
#     after process.exit() inside withAuditLock.
#   - Detail-file body shape (heading, Fire id, Pass:false, Findings JSON
#     block) per sensor; Fire id keyed paths are collision-free.
#   - Audit-row required-fields per event type (FIRED/PASSED/FAILED/
#     BUDGET_OVERRIDE), including no-extra-fields invariant.
#   - Path normalisation: relative --output-path → project-relative Output
#     path in audit row (relativizePath() trims the projectDir prefix; the
#     real-fixture round-trips in groups B/C assert the slimmed form).
#   - upstream-coverage --consumes flag is sourced from stage.consumes[]
#     via loadGraph() (pre-lock), passed to the per-sensor script.
#
# Strategy: REAL-fixture coverage for the per-sensor scripts (groups B,
# C, F-defensive, M) — fixtures under tests/fixtures/v05-mr9-sensor-fire/
# (passing-markdown, failing-required-sections, failing-upstream-coverage,
# passing-typescript, failing-linter, failing-type-check, slow-command)
# are copied into per-test temp project trees so the shipped per-sensor
# scripts run against authentic markdown / .ts content. Stub fixture
# scripts (stub-pass / stub-fail / stub-127 / stub-exit2 / stub-bad /
# stub-slow) remain for argv-validation, truth-table-branch, concurrency,
# audit-row shape, and tool-unavailable groups; they get copied next to
# the dispatcher (sibling resolution) at suite start and removed in an
# EXIT trap. Per-test fork sensor manifests live in a temp
# AIDLC_SENSORS_DIR with `command:` pointing at the appropriate stub.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SENSOR_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-sensor.ts"
TOOLS_DIR="$REPO_ROOT/dist/claude/.claude/tools"
STUBS_DIR="$REPO_ROOT/tests/fixtures/v05-mr9-sensor-fire/scripts"

if [ ! -f "$SENSOR_TS" ]; then
  echo "Bail out! aidlc-sensor.ts not found at $SENSOR_TS"
  exit 1
fi

# --- Stub setup: copy fixture per-sensor scripts next to the dispatcher
# so __FILE_DIR-based sibling resolution finds them. Cleaned on EXIT.
COPIED_STUBS=()
copy_stub() {
  local name="$1"
  cp "$STUBS_DIR/$name" "$TOOLS_DIR/$name"
  COPIED_STUBS+=("$TOOLS_DIR/$name")
}
TEMP_DIRS=()
register_tmpdir() { TEMP_DIRS+=("$1"); }
cleanup_all() {
  for f in "${COPIED_STUBS[@]:-}"; do
    [ -n "$f" ] && rm -f "$f"
  done
  for d in "${TEMP_DIRS[@]:-}"; do
    [ -n "$d" ] && [ -d "$d" ] && rm -rf "$d"
  done
  # Also clean any inline stub we may have written.
  rm -f "$TOOLS_DIR/aidlc-sensor-stub-argv.ts"
}
trap cleanup_all EXIT

copy_stub "aidlc-sensor-stub-pass.ts"
copy_stub "aidlc-sensor-stub-fail.ts"
copy_stub "aidlc-sensor-stub-127.ts"
copy_stub "aidlc-sensor-stub-exit2.ts"
copy_stub "aidlc-sensor-stub-bad.ts"
copy_stub "aidlc-sensor-stub-slow.ts"

# Inline argv-capture stub used by the upstream-coverage consumes test
# (Group M). Writes process.argv as JSON to the path in
# AIDLC_T92_ARGV_OUT, then emits {"pass": true}. Lives next to the
# dispatcher for the test run; cleaned by trap. Mirrors the shape of
# the other stub fixtures (@ts-nocheck so the tools tsconfig doesn't
# fight it).
cat >"$TOOLS_DIR/aidlc-sensor-stub-argv.ts" <<'EOF'
// @ts-nocheck
// t92 fixture: argv-capture stub. Writes process.argv to
// $AIDLC_T92_ARGV_OUT and emits {"pass": true}. Used to verify the
// dispatcher passes the expected --consumes / --stage / --output-path
// flags through to per-sensor scripts.
import { writeFileSync } from "node:fs";
const out = process.env.AIDLC_T92_ARGV_OUT;
if (out) writeFileSync(out, JSON.stringify(process.argv));
process.stdout.write(JSON.stringify({ pass: true }) + "\n");
process.exit(0);
EOF

# --- Helpers ---

make_proj() {
  local proj
  proj=$(mktemp -d -t aidlc-t92-proj-XXXXXX)
  mkdir -p "$proj/aidlc-docs"
  register_tmpdir "$proj"
  echo "$proj"
}

# Write a single fork sensor manifest. Args: <id> <command> [matches] [timeout].
make_fork_sensors() {
  local id="$1"
  local cmd="$2"
  local matches="${3:-}"
  local timeout="${4:-5}"
  local dir
  dir=$(mktemp -d -t aidlc-t92-sensors-XXXXXX)
  register_tmpdir "$dir"
  {
    echo "---"
    echo "id: $id"
    echo "kind: deterministic"
    echo "command: $cmd"
    echo "default_severity: advisory"
    echo "description: t92 fork manifest"
    [ -n "$matches" ] && echo "matches: \"$matches\""
    echo "input_schema: {}"
    echo "output_schema: {}"
    echo "timeout_seconds: $timeout"
    echo "---"
    echo "# stub"
  } >"$dir/aidlc-${id}.md"
  echo "$dir"
}

# Count the number of bodies with `**Event**: <type>` in an audit file.
audit_event_count() {
  local file="$1"
  local ev="$2"
  [ -f "$file" ] || {
    echo 0
    return
  }
  grep -c "^\*\*Event\*\*: ${ev}\$" "$file" 2>/dev/null || true
}

# Extract the value of a single field from the FIRST audit block whose
# `**Event**:` matches $ev. Walks the file with awk, prints the value.
# Uses index/substr to split on the literal '**: ' separator (awk's
# split() regex would choke on the `**`).
audit_field() {
  local file="$1"
  local ev="$2"
  local key="$3"
  awk -v ev="$ev" -v key="$key" '
		/^## / { in_block = 0; matched = 0; next }
		/^---$/ { if (matched && !found) { print ""; exit }; in_block = 0; matched = 0; next }
		/^\*\*Event\*\*: / {
			if ($0 == "**Event**: " ev) { matched = 1; in_block = 1 }
			else { in_block = 0 }
			next
		}
		matched && /^\*\*/ {
			line = $0
			sub(/^\*\*/, "", line)
			pos = index(line, "**: ")
			if (pos > 0) {
				label = substr(line, 1, pos - 1)
				value = substr(line, pos + 4)
				if (label == key) { print value; found = 1; exit }
			}
		}
	' "$file"
}

# Count `**…**: ` lines within the FIRST audit block whose `**Event**:`
# matches $ev. Walks the file and counts every `**field**:` line between
# the `## ` heading and the next `---` separator, including `**Timestamp**`
# and `**Event**` themselves (so the count matches the audit-format spec's
# Required Fields list).
audit_field_count() {
  local file="$1"
  local ev="$2"
  awk -v ev="$ev" '
		BEGIN { in_section = 0; n = 0; matches_ev = 0 }
		/^## / { in_section = 1; n = 0; matches_ev = 0; next }
		/^---$/ {
			if (in_section && matches_ev) { print n; exit }
			in_section = 0; n = 0; matches_ev = 0; next
		}
		in_section && /^\*\*Event\*\*: / {
			if ($0 == "**Event**: " ev) matches_ev = 1
		}
		in_section && /^\*\*/ { n++ }
	' "$file"
}

plan 43

# ============================================================
# Group A — Argv parsing (8): exit 1 on every invalid invocation,
# and verify NO audit file ever appears (validate-before-lock).
# ============================================================

ARGV_PROJ=$(make_proj)
echo "stub" >"$ARGV_PROJ/aidlc-docs/test.md"

# 1: no positional id
set +e
A1_OUT=$(CLAUDE_PROJECT_DIR="$ARGV_PROJ" bun "$SENSOR_TS" fire --stage intent-capture --output-path "$ARGV_PROJ/aidlc-docs/test.md" 2>&1)
A1_RC=$?
set -e
if [ "$A1_RC" -ne 0 ] && printf '%s\n' "$A1_OUT" | grep -q 'fire requires a sensor id'; then
  ok "fire with no positional id → exit 1 + clear error"
else
  not_ok "fire with no positional id → exit 1" "rc=$A1_RC, out=$A1_OUT"
fi

# 2: unknown sensor id
set +e
A2_OUT=$(CLAUDE_PROJECT_DIR="$ARGV_PROJ" bun "$SENSOR_TS" fire no-such-sensor --stage intent-capture --output-path "$ARGV_PROJ/aidlc-docs/test.md" 2>&1)
A2_RC=$?
set -e
if [ "$A2_RC" -ne 0 ] && printf '%s\n' "$A2_OUT" | grep -q 'unknown sensor id'; then
  ok "fire with unknown sensor id → exit 1 + known-ids hint"
else
  not_ok "fire with unknown sensor id → exit 1" "rc=$A2_RC, out=$A2_OUT"
fi

# 3: missing --stage
set +e
A3_OUT=$(CLAUDE_PROJECT_DIR="$ARGV_PROJ" bun "$SENSOR_TS" fire required-sections --output-path "$ARGV_PROJ/aidlc-docs/test.md" 2>&1)
A3_RC=$?
set -e
if [ "$A3_RC" -ne 0 ] && printf '%s\n' "$A3_OUT" | grep -q 'fire requires --stage'; then
  ok "fire without --stage → exit 1 + clear error"
else
  not_ok "fire without --stage → exit 1" "rc=$A3_RC, out=$A3_OUT"
fi

# 4: unknown stage slug
set +e
A4_OUT=$(CLAUDE_PROJECT_DIR="$ARGV_PROJ" bun "$SENSOR_TS" fire required-sections --stage no-such-stage --output-path "$ARGV_PROJ/aidlc-docs/test.md" 2>&1)
A4_RC=$?
set -e
if [ "$A4_RC" -ne 0 ] && printf '%s\n' "$A4_OUT" | grep -q 'unknown stage slug'; then
  ok "fire with unknown stage slug → exit 1 + known-stages hint"
else
  not_ok "fire with unknown stage slug → exit 1" "rc=$A4_RC, out=$A4_OUT"
fi

# 5: missing --output-path
set +e
A5_OUT=$(CLAUDE_PROJECT_DIR="$ARGV_PROJ" bun "$SENSOR_TS" fire required-sections --stage intent-capture 2>&1)
A5_RC=$?
set -e
if [ "$A5_RC" -ne 0 ] && printf '%s\n' "$A5_OUT" | grep -q 'fire requires --output-path'; then
  ok "fire without --output-path → exit 1 + clear error"
else
  not_ok "fire without --output-path → exit 1" "rc=$A5_RC, out=$A5_OUT"
fi

# 6: --output-path file not on disk
set +e
A6_OUT=$(CLAUDE_PROJECT_DIR="$ARGV_PROJ" bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path /var/empty/definitely-missing-aidlc-t92.md 2>&1)
A6_RC=$?
set -e
if [ "$A6_RC" -ne 0 ] && printf '%s\n' "$A6_OUT" | grep -q 'output path does not exist'; then
  ok "fire with output-path missing on disk → exit 1 + clear error"
else
  not_ok "fire with missing output-path file → exit 1" "rc=$A6_RC, out=$A6_OUT"
fi

# 7: matches-rejection — linter ships matches=**/*.{ts,js}, fire it on
# a .md → dispatcher rejects pre-lock.
set +e
A7_OUT=$(CLAUDE_PROJECT_DIR="$ARGV_PROJ" bun "$SENSOR_TS" fire linter --stage code-generation --output-path "$ARGV_PROJ/aidlc-docs/test.md" 2>&1)
A7_RC=$?
set -e
if [ "$A7_RC" -ne 0 ] && printf '%s\n' "$A7_OUT" | grep -q 'does not match sensor "linter" filter'; then
  ok "fire with matches-rejection → exit 1 + clear error"
else
  not_ok "fire with matches-rejection → exit 1" "rc=$A7_RC, out=$A7_OUT"
fi

# 8: cumulative — none of the above 7 invalid invocations created an audit file.
if [ ! -f "$ARGV_PROJ/aidlc-docs/audit.md" ]; then
  ok "validate-before-lock: 7 invalid invocations created NO audit file"
else
  not_ok "validate-before-lock: no audit file" "audit file exists: $(ls -la "$ARGV_PROJ/aidlc-docs/audit.md")"
fi

# ============================================================
# Group B — PASSED round-trip per sensor, REAL fixtures (4):
# fires the actual shipped per-sensor scripts (no stub) against real
# fixture content under tests/fixtures/v05-mr9-sensor-fire/. Each
# case validates its sensor-specific PASS path:
#   B1 required-sections: passing-markdown/intent-statement.md (3 H2s
#      → h2_count >= 2 → pass=true).
#   B2 upstream-coverage: same fixture under intent-capture (consumes
#      list is empty in stage frontmatter → "no upstream" early-pass).
#   B3 linter:            passing-typescript/sample.ts + flat eslint
#      config (errorCount=0 → pass=true).
#   B4 type-check:        passing-typescript/sample.ts + tsconfig with
#      strict tolerances (errors=0 → pass=true).
# Asserts: FIRED + PASSED pair, Fire id correlation, Duration ms is
# integer, no detail dir (PASSED never writes one), AND Output path
# is the project-relative form emitted by relativizePath().
# AIDLC_SENSORS_DIR is unset so the SHIPPED sensor manifests load
# (their command: routes to the real .claude/tools/aidlc-sensor-<id>.ts
# scripts via the dispatcher's sibling-resolver).
# ============================================================

FIXTURES_ROOT="$REPO_ROOT/tests/fixtures/v05-mr9-sensor-fire"

# Markdown PASSED helper. Copies a fixture .md into projectDir/aidlc-docs/,
# fires the real sensor, asserts the PASS row shape AND Output path is
# relativized to "aidlc-docs/<basename>".
run_passed_md_real() {
  local id="$1"
  local stage="$2"
  local fixture_md="$3"
  local proj
  proj=$(make_proj)
  local outname
  outname=$(basename "$fixture_md")
  cp "$fixture_md" "$proj/aidlc-docs/$outname"
  CLAUDE_PROJECT_DIR="$proj" \
    bun "$SENSOR_TS" fire "$id" --stage "$stage" --output-path "$proj/aidlc-docs/$outname" >/dev/null 2>&1
  local fired passed dur firedid passedid path detail_dir
  fired=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_FIRED)
  passed=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_PASSED)
  dur=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_PASSED "Duration ms")
  firedid=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FIRED "Fire id")
  passedid=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_PASSED "Fire id")
  path=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_PASSED "Output path")
  detail_dir="$proj/aidlc-docs/.aidlc-sensors"
  local expected_path="aidlc-docs/$outname"
  if [ "$fired" = "1" ] && [ "$passed" = "1" ] &&
    [ -n "$firedid" ] && [ "$firedid" = "$passedid" ] &&
    [[ "$dur" =~ ^[0-9]+$ ]] && [ ! -d "$detail_dir" ] &&
    [ "$path" = "$expected_path" ]; then
    ok "PASSED real round-trip — sensor=$id: real markdown $(basename "$fixture_md") → PASSED, Output path=$path (relative), Duration ms=$dur"
  else
    not_ok "PASSED real round-trip — sensor=$id" "fired=$fired passed=$passed dur=$dur fire_id=$firedid passed_id=$passedid path=$path expected=$expected_path detail_exists=$([ -d "$detail_dir" ] && echo yes || echo no)"
  fi
}

# TS PASSED helper. Copies the fixture tree (sample.ts + package.json +
# eslint.config.js + tsconfig.json) into projectDir/<fixture-basename>/
# so the per-sensor script's walk-up project-root resolution finds the
# fixture's package.json (linter) / tsconfig.json (type-check). Asserts
# Output path is "<fixture-basename>/sample.ts".
run_passed_ts_real() {
  local id="$1"
  local stage="$2"
  local fixture_dir="$3"
  local proj
  proj=$(make_proj)
  local subdir
  subdir=$(basename "$fixture_dir")
  cp -R "$fixture_dir" "$proj/$subdir"
  CLAUDE_PROJECT_DIR="$proj" \
    bun "$SENSOR_TS" fire "$id" --stage "$stage" --output-path "$proj/$subdir/sample.ts" >/dev/null 2>&1
  local fired passed dur firedid passedid path detail_dir note
  fired=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_FIRED)
  passed=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_PASSED)
  dur=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_PASSED "Duration ms")
  firedid=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FIRED "Fire id")
  passedid=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_PASSED "Fire id")
  path=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_PASSED "Output path")
  note=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_PASSED "Note")
  detail_dir="$proj/aidlc-docs/.aidlc-sensors"
  local expected_path="$subdir/sample.ts"
  # Note must be empty for a true PASS (no tool-unavailable / script-error).
  if [ "$fired" = "1" ] && [ "$passed" = "1" ] &&
    [ -n "$firedid" ] && [ "$firedid" = "$passedid" ] &&
    [[ "$dur" =~ ^[0-9]+$ ]] && [ ! -d "$detail_dir" ] &&
    [ "$path" = "$expected_path" ] && [ -z "$note" ]; then
    ok "PASSED real round-trip — sensor=$id: real TS fixture $subdir → PASSED, Output path=$path (relative), Duration ms=$dur, no Note"
  else
    not_ok "PASSED real round-trip — sensor=$id" "fired=$fired passed=$passed dur=$dur fire_id=$firedid passed_id=$passedid path=$path expected=$expected_path note='$note' detail_exists=$([ -d "$detail_dir" ] && echo yes || echo no)"
  fi
}

# 9: required-sections — passing-markdown/intent-statement.md (3 H2s).
run_passed_md_real "required-sections" "intent-capture" "$FIXTURES_ROOT/passing-markdown/intent-statement.md"
# 10: upstream-coverage — same fixture, intent-capture (consumes:[]).
run_passed_md_real "upstream-coverage" "intent-capture" "$FIXTURES_ROOT/passing-markdown/intent-statement.md"
# 11: linter — passing-typescript/sample.ts (errorCount=0).
run_passed_ts_real "linter" "code-generation" "$FIXTURES_ROOT/passing-typescript"
# 12: type-check — passing-typescript/sample.ts (errors=0).
run_passed_ts_real "type-check" "code-generation" "$FIXTURES_ROOT/passing-typescript"

# ============================================================
# Group C — FAILED round-trip per sensor, REAL fixtures (4):
# fires the actual shipped per-sensor scripts against real fixture
# content that triggers each sensor's FAIL path. Each case validates
# its sensor-specific findings-count derivation:
#   C1 required-sections: failing-required-sections/intent-statement.md
#      (zero H2s) → h2_count=0 → Findings count = max(0, 2-0) = 2.
#   C2 upstream-coverage: failing-upstream-coverage/market-research.md
#      (no intent-statement reference) under stage market-research
#      whose frontmatter consumes: [intent-statement]. → unreferenced
#      = ["intent-statement"] → Findings count = 1.
#   C3 linter:            failing-linter/sample.ts + flat eslint config
#      with no-unused-vars: error → errorCount=1 → Findings count = 1.
#   C4 type-check:        failing-type-check/sample.ts + strict tsconfig
#      ('"string"' assigned to number) → errors.length=1 (after
#      filterToFilePath) → Findings count = 1.
# Asserts: FIRED + FAILED pair with Fire id correlation, detail file
# at canonical aidlc-docs/.aidlc-sensors/<stage>/<id>-<fireid>.md path,
# project-relative Output path, and Findings count matches the value
# the dispatcher's computeFindingsCount() derives from each script's
# real stdout JSON shape.
# ============================================================

# Markdown FAILED helper. Copies fixture .md into projectDir/aidlc-docs/,
# fires real sensor, asserts FAIL row shape + findings + detail file.
run_failed_md_real() {
  local id="$1"
  local stage="$2"
  local fixture_md="$3"
  local expected_findings="$4"
  local proj
  proj=$(make_proj)
  local outname
  outname=$(basename "$fixture_md")
  cp "$fixture_md" "$proj/aidlc-docs/$outname"
  CLAUDE_PROJECT_DIR="$proj" \
    bun "$SENSOR_TS" fire "$id" --stage "$stage" --output-path "$proj/aidlc-docs/$outname" >/dev/null 2>&1
  local fired failed firedid failedid findings detail_path path
  fired=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_FIRED)
  failed=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_FAILED)
  firedid=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FIRED "Fire id")
  failedid=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FAILED "Fire id")
  findings=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FAILED "Findings count")
  detail_path=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FAILED "Detail path")
  path=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FAILED "Output path")
  local expected_dir="aidlc-docs/.aidlc-sensors/$stage/${id}-${firedid}.md"
  local expected_path="aidlc-docs/$outname"
  if [ "$fired" = "1" ] && [ "$failed" = "1" ] &&
    [ -n "$firedid" ] && [ "$firedid" = "$failedid" ] &&
    [ "$findings" = "$expected_findings" ] &&
    [ "$detail_path" = "$expected_dir" ] &&
    [ -f "$proj/$detail_path" ] &&
    [ "$path" = "$expected_path" ]; then
    ok "FAILED real round-trip — sensor=$id: real markdown $(basename "$fixture_md") → FAILED, Findings count=$findings (expected $expected_findings, derived from real stdout)"
  else
    not_ok "FAILED real round-trip — sensor=$id" "fired=$fired failed=$failed findings=$findings (want $expected_findings) detail=$detail_path expected=$expected_dir path=$path expected_path=$expected_path file_exists=$([ -f "$proj/$detail_path" ] && echo yes || echo no)"
  fi
}

# TS FAILED helper. Copies fixture tree, fires real sensor on sample.ts,
# asserts FAIL row shape + findings + detail file + relative Output path.
run_failed_ts_real() {
  local id="$1"
  local stage="$2"
  local fixture_dir="$3"
  local expected_findings="$4"
  local proj
  proj=$(make_proj)
  local subdir
  subdir=$(basename "$fixture_dir")
  cp -R "$fixture_dir" "$proj/$subdir"
  CLAUDE_PROJECT_DIR="$proj" \
    bun "$SENSOR_TS" fire "$id" --stage "$stage" --output-path "$proj/$subdir/sample.ts" >/dev/null 2>&1
  local fired failed firedid failedid findings detail_path path
  fired=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_FIRED)
  failed=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_FAILED)
  firedid=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FIRED "Fire id")
  failedid=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FAILED "Fire id")
  findings=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FAILED "Findings count")
  detail_path=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FAILED "Detail path")
  path=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_FAILED "Output path")
  local expected_dir="aidlc-docs/.aidlc-sensors/$stage/${id}-${firedid}.md"
  local expected_path="$subdir/sample.ts"
  if [ "$fired" = "1" ] && [ "$failed" = "1" ] &&
    [ -n "$firedid" ] && [ "$firedid" = "$failedid" ] &&
    [ "$findings" = "$expected_findings" ] &&
    [ "$detail_path" = "$expected_dir" ] &&
    [ -f "$proj/$detail_path" ] &&
    [ "$path" = "$expected_path" ]; then
    ok "FAILED real round-trip — sensor=$id: real TS fixture $subdir → FAILED, Findings count=$findings (expected $expected_findings, derived from real $id stdout)"
  else
    not_ok "FAILED real round-trip — sensor=$id" "fired=$fired failed=$failed findings=$findings (want $expected_findings) detail=$detail_path expected=$expected_dir path=$path expected_path=$expected_path file_exists=$([ -f "$proj/$detail_path" ] && echo yes || echo no)"
  fi
}

# 13: required-sections — failing-required-sections/intent-statement.md
#     (0 H2 headings) → Findings count = max(0, 2 - 0) = 2.
run_failed_md_real "required-sections" "intent-capture" "$FIXTURES_ROOT/failing-required-sections/intent-statement.md" 2
# 14: upstream-coverage — failing-upstream-coverage/market-research.md
#     (no intent-statement reference) under market-research stage whose
#     frontmatter declares consumes: [intent-statement]. Findings count = 1.
run_failed_md_real "upstream-coverage" "market-research" "$FIXTURES_ROOT/failing-upstream-coverage/market-research.md" 1
# 15: linter — failing-linter/sample.ts (unused const + no-unused-vars
#     rule set to error in flat config). Findings count = errorCount = 1.
run_failed_ts_real "linter" "code-generation" "$FIXTURES_ROOT/failing-linter" 1
# 16: type-check — failing-type-check/sample.ts (string assigned to
#     number-typed const + strict tsconfig). Findings count = errors.length
#     = 1 after filterToFilePath() narrows to sample.ts.
run_failed_ts_real "type-check" "code-generation" "$FIXTURES_ROOT/failing-type-check" 1

# ============================================================
# Group D — Tool-unavailable (2): per-sensor script exits 127.
# Dispatcher classifies branch b → SENSOR_PASSED Note=tool-unavailable.
# ============================================================

run_tool_unavailable() {
  local id="$1"
  local stage="$2"
  local matches="$3"
  local proj
  proj=$(make_proj)
  echo "stub" >"$proj/aidlc-docs/output.ts"
  local sensors_dir
  sensors_dir=$(make_fork_sensors "$id" "bun .claude/tools/aidlc-sensor-stub-127.ts" "$matches")
  CLAUDE_PROJECT_DIR="$proj" AIDLC_SENSORS_DIR="$sensors_dir" \
    bun "$SENSOR_TS" fire "$id" --stage "$stage" --output-path "$proj/aidlc-docs/output.ts" >/dev/null 2>&1
  local passed note
  passed=$(audit_event_count "$proj/aidlc-docs/audit.md" SENSOR_PASSED)
  note=$(audit_field "$proj/aidlc-docs/audit.md" SENSOR_PASSED "Note")
  if [ "$passed" = "1" ] && [ "$note" = "tool-unavailable" ]; then
    ok "tool-unavailable — sensor=$id: SENSOR_PASSED with Note=tool-unavailable"
  else
    not_ok "tool-unavailable — sensor=$id" "passed=$passed note=$note"
  fi
}

# 17, 18
run_tool_unavailable "linter" "code-generation" "**/*.{ts,js}"
run_tool_unavailable "type-check" "code-generation" "**/*.{ts,tsx}"

# ============================================================
# Group E — Script-error fall-through (3): branches e (exit-N), f
# (bad-output), and the detail-write-failed fallback.
# ============================================================

# 19: exit 2 (non-zero, non-127, non-timeout)
E_PROJ=$(make_proj)
echo "stub" >"$E_PROJ/aidlc-docs/test.md"
E_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-exit2.ts")
CLAUDE_PROJECT_DIR="$E_PROJ" AIDLC_SENSORS_DIR="$E_SENSORS" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$E_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
E_NOTE=$(audit_field "$E_PROJ/aidlc-docs/audit.md" SENSOR_PASSED "Note")
assert_eq "$E_NOTE" "script-error: exit-2" "script-error — branch e: exit 2 → Note=script-error: exit-2"

# 20: bad JSON stdout
E_PROJ2=$(make_proj)
echo "stub" >"$E_PROJ2/aidlc-docs/test.md"
E_SENSORS2=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-bad.ts")
CLAUDE_PROJECT_DIR="$E_PROJ2" AIDLC_SENSORS_DIR="$E_SENSORS2" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$E_PROJ2/aidlc-docs/test.md" >/dev/null 2>&1
E2_NOTE=$(audit_field "$E_PROJ2/aidlc-docs/audit.md" SENSOR_PASSED "Note")
assert_eq "$E2_NOTE" "script-error: bad-output" "script-error — branch f: garbage stdout → Note=script-error: bad-output"

# 21: detail-write failure — pre-create the per-stage detail dir as a
# regular FILE so the dispatcher's mkdirSync(detailDir, {recursive:true})
# throws ENOTDIR. Branch c degrades to PASSED with Note=detail-write-failed.
E_PROJ3=$(make_proj)
echo "stub" >"$E_PROJ3/aidlc-docs/test.md"
mkdir -p "$E_PROJ3/aidlc-docs/.aidlc-sensors"
# Block intent-capture/ as a regular file → mkdir-recursive can't create it.
echo "block" >"$E_PROJ3/aidlc-docs/.aidlc-sensors/intent-capture"
E_SENSORS3=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-fail.ts")
CLAUDE_PROJECT_DIR="$E_PROJ3" AIDLC_SENSORS_DIR="$E_SENSORS3" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$E_PROJ3/aidlc-docs/test.md" >/dev/null 2>&1
E3_NOTE=$(audit_field "$E_PROJ3/aidlc-docs/audit.md" SENSOR_PASSED "Note")
if printf '%s\n' "$E3_NOTE" | grep -q '^script-error: detail-write-failed'; then
  ok "script-error — detail-write-failed: blocked detail dir → Note=script-error: detail-write-failed"
else
  not_ok "script-error — detail-write-failed" "got Note=$E3_NOTE"
fi

# ============================================================
# Group F — Budget override (2): stub-slow + timeout_seconds=1, plus
# a defensive sub-case using the slow-command/sample.ts fixture as the
# --output-path to assert Observed value >= Cap value (proving the
# SIGTERM-killed timeout, not a coincidence) and Output path is the
# project-relative "slow-command/sample.ts" form.
# ============================================================

F_PROJ=$(make_proj)
echo "stub" >"$F_PROJ/aidlc-docs/test.md"
F_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-slow.ts" "" 1)
CLAUDE_PROJECT_DIR="$F_PROJ" AIDLC_SENSORS_DIR="$F_SENSORS" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$F_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
F_BUDGET=$(audit_event_count "$F_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE)
F_LAYER=$(audit_field "$F_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Cap layer")
F_CAP=$(audit_field "$F_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Cap value")
F_OBS=$(audit_field "$F_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Observed value")
if [ "$F_BUDGET" = "1" ] && [ "$F_LAYER" = "registry" ] && [ "$F_CAP" = "1" ] && [[ "$F_OBS" =~ ^[0-9]+$ ]] && [ "$F_OBS" -ge 1 ]; then
  ok "budget override — stub-slow + timeout=1 → SENSOR_BUDGET_OVERRIDE Cap layer=registry, Cap value=1, Observed value=$F_OBS"
else
  not_ok "budget override" "rows=$F_BUDGET layer=$F_LAYER cap=$F_CAP observed=$F_OBS"
fi

# 23 (defensive): slow-command/sample.ts fixture as the --output-path,
# stub-slow as the manifest's command:, timeout_seconds=1. Asserts:
# (a) SENSOR_BUDGET_OVERRIDE row landed; (b) Observed value >= Cap value
# strictness (proves SIGTERM-killed timeout, not coincidence; guards
# the branch-a-precedes-branch-0 ordering even though the narrowing
# makes them mutually exclusive); (c) Output path emitted as the
# project-relative form "slow-command/sample.ts" (relativizePath
# trims projectDir prefix).
F2_PROJ=$(make_proj)
mkdir -p "$F2_PROJ/slow-command"
cp "$FIXTURES_ROOT/slow-command/sample.ts" "$F2_PROJ/slow-command/sample.ts"
F2_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-slow.ts" "" 1)
CLAUDE_PROJECT_DIR="$F2_PROJ" AIDLC_SENSORS_DIR="$F2_SENSORS" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$F2_PROJ/slow-command/sample.ts" >/dev/null 2>&1
F2_BUDGET=$(audit_event_count "$F2_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE)
F2_LAYER=$(audit_field "$F2_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Cap layer")
F2_CAP=$(audit_field "$F2_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Cap value")
F2_OBS=$(audit_field "$F2_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Observed value")
F2_PATH=$(audit_field "$F2_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Output path")
if [ "$F2_BUDGET" = "1" ] && [ "$F2_LAYER" = "registry" ] && [[ "$F2_CAP" =~ ^[0-9]+$ ]] && [[ "$F2_OBS" =~ ^[0-9]+$ ]] && [ "$F2_OBS" -ge "$F2_CAP" ] && [ "$F2_PATH" = "slow-command/sample.ts" ]; then
  ok "budget override — slow-command fixture: Observed value=$F2_OBS >= Cap value=$F2_CAP, Output path=$F2_PATH (project-relative)"
else
  not_ok "budget override — slow-command fixture" "rows=$F2_BUDGET layer=$F2_LAYER cap=$F2_CAP observed=$F2_OBS path=$F2_PATH"
fi

# ============================================================
# Group G — Concurrency (3): happy path, lock-released-across-spawn,
# lock-orphan recovery.
# ============================================================

# 23: 5 parallel fires, all stub-pass → 5 FIRED + 5 PASSED, paired.
G_PROJ=$(make_proj)
echo "stub" >"$G_PROJ/aidlc-docs/test.md"
G_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-pass.ts")
for _ in 1 2 3 4 5; do
  CLAUDE_PROJECT_DIR="$G_PROJ" AIDLC_SENSORS_DIR="$G_SENSORS" \
    bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$G_PROJ/aidlc-docs/test.md" >/dev/null 2>&1 &
done
wait
G_FIRED=$(audit_event_count "$G_PROJ/aidlc-docs/audit.md" SENSOR_FIRED)
G_PASSED=$(audit_event_count "$G_PROJ/aidlc-docs/audit.md" SENSOR_PASSED)
G_PAIRS=$(awk '/^\*\*Fire id\*\*: / { print $3 }' "$G_PROJ/aidlc-docs/audit.md" | sort | uniq -c | awk '$1 == 2' | wc -l | tr -d ' ')
if [ "$G_FIRED" = "5" ] && [ "$G_PASSED" = "5" ] && [ "$G_PAIRS" = "5" ]; then
  ok "concurrency — happy path: 5 parallel fires → 5 FIRED + 5 PASSED, all 5 Fire ids paired exactly twice"
else
  not_ok "concurrency — happy path" "fired=$G_FIRED passed=$G_PASSED unique-paired-fire-ids=$G_PAIRS"
fi

# 24: lock-released-across-spawn — slow fire (timeout=10, sleeps 5s) +
# fast fire (stub-pass) backgrounded 200ms later. Expect: fast PASSED row
# lands BEFORE slow PASSED row in the audit file (proves lock released
# between FIRED and terminal of the slow fire).
G2_PROJ=$(make_proj)
echo "stub" >"$G2_PROJ/aidlc-docs/test.md"
G2_SLOW=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-slow.ts" "" 10)
G2_FAST=$(make_fork_sensors "linter" "bun .claude/tools/aidlc-sensor-stub-pass.ts" "**/*.{ts,js}")
G2_TS="$G2_PROJ/aidlc-docs/code.ts"
echo "stub" >"$G2_TS"
(
  CLAUDE_PROJECT_DIR="$G2_PROJ" AIDLC_SENSORS_DIR="$G2_SLOW" \
    bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$G2_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
) &
SLOW_PID=$!
sleep 0.2
(
  CLAUDE_PROJECT_DIR="$G2_PROJ" AIDLC_SENSORS_DIR="$G2_FAST" \
    bun "$SENSOR_TS" fire linter --stage code-generation --output-path "$G2_TS" >/dev/null 2>&1
) &
FAST_PID=$!
wait "$FAST_PID"
# Snapshot row order WHILE slow is still running (its terminal hasn't appended).
# This is the load-bearing assertion: fast PASSED is observable BEFORE slow PASSED.
SLOW_PASSED_VISIBLE=$(grep -c "^\*\*Sensor ID\*\*: required-sections\$" "$G2_PROJ/aidlc-docs/audit.md" || true)
FAST_DONE_VISIBLE=$(grep -c "^\*\*Sensor ID\*\*: linter\$" "$G2_PROJ/aidlc-docs/audit.md" || true)
wait "$SLOW_PID"
# After slow completes, both should be present. The mid-flight snapshot is
# the proof: required-sections had only its FIRED row (1) while linter had
# both FIRED+PASSED (2) — proving the slow fire's lock was released between
# windows A and B.
if [ "$SLOW_PASSED_VISIBLE" = "1" ] && [ "$FAST_DONE_VISIBLE" = "2" ]; then
  ok "concurrency — lock-released-across-spawn: fast PASSED landed during slow's spawn window (slow had 1 row, fast had 2 mid-flight)"
else
  not_ok "concurrency — lock-released-across-spawn" "slow visible=$SLOW_PASSED_VISIBLE (want 1) fast visible=$FAST_DONE_VISIBLE (want 2)"
fi

# 25: lock-orphan recovery — invoke aidlc-sensor-lock-exit.ts which
# process.exit(1)s while holding the lock. Then a fresh fire must
# acquire without burning the 5×100ms retry budget (i.e., succeeds in
# well under 5s).
copy_stub "aidlc-sensor-lock-exit.ts"
G3_PROJ=$(make_proj)
echo "stub" >"$G3_PROJ/aidlc-docs/test.md"
set +e
bun "$TOOLS_DIR/aidlc-sensor-lock-exit.ts" "$G3_PROJ" >/dev/null 2>&1
G3_LOCK_RC=$?
set -e
G3_START=$(date +%s)
G3_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-pass.ts")
CLAUDE_PROJECT_DIR="$G3_PROJ" AIDLC_SENSORS_DIR="$G3_SENSORS" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$G3_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
G3_END=$(date +%s)
G3_ELAPSED=$((G3_END - G3_START))
G3_PASSED=$(audit_event_count "$G3_PROJ/aidlc-docs/audit.md" SENSOR_PASSED)
if [ "$G3_LOCK_RC" -eq 1 ] && [ "$G3_PASSED" = "1" ] && [ "$G3_ELAPSED" -lt 3 ]; then
  ok "concurrency — lock-orphan recovery: process.exit(1)-inside-lock → next fire succeeds in ${G3_ELAPSED}s (no 5s retry burn)"
else
  not_ok "concurrency — lock-orphan recovery" "lock_rc=$G3_LOCK_RC passed=$G3_PASSED elapsed=${G3_ELAPSED}s"
fi

# ============================================================
# Group H — Detail-file body shape (4): per sensor, verify the
# detail file written on FAILED carries the canonical structure
# (heading, Fire id, Output path, Pass: false, ## Findings, JSON).
# ============================================================

run_detail_shape() {
  local id="$1"
  local stage="$2"
  local matches="${3:-}"
  local proj
  proj=$(make_proj)
  local outname="output.md"
  [ "$id" = "linter" ] && outname="output.ts"
  [ "$id" = "type-check" ] && outname="output.ts"
  echo "stub" >"$proj/aidlc-docs/$outname"
  local sensors_dir
  sensors_dir=$(make_fork_sensors "$id" "bun .claude/tools/aidlc-sensor-stub-fail.ts" "$matches")
  CLAUDE_PROJECT_DIR="$proj" AIDLC_SENSORS_DIR="$sensors_dir" \
    bun "$SENSOR_TS" fire "$id" --stage "$stage" --output-path "$proj/aidlc-docs/$outname" >/dev/null 2>&1
  local detail
  detail=$(find "$proj/aidlc-docs/.aidlc-sensors/$stage" -type f -name "${id}-*.md" | head -1)
  if [ -z "$detail" ] || [ ! -f "$detail" ]; then
    not_ok "detail-file shape — sensor=$id" "no detail file under $proj/aidlc-docs/.aidlc-sensors/$stage"
    return
  fi
  if grep -q "^# ${id} finding — ${stage}$" "$detail" &&
    grep -q '^\*\*Timestamp\*\*: ' "$detail" &&
    grep -qE '^\*\*Fire id\*\*: [0-9a-f]{8}$' "$detail" &&
    grep -q '^\*\*Output path\*\*: ' "$detail" &&
    grep -q '^\*\*Pass\*\*: false$' "$detail" &&
    grep -q '^## Findings$' "$detail" &&
    grep -q '^```json$' "$detail" &&
    grep -q '"pass": false' "$detail"; then
    ok "detail-file shape — sensor=$id: heading, Fire id, Output path, Pass:false, ## Findings, fenced JSON all present"
  else
    not_ok "detail-file shape — sensor=$id" "detail body missing required tokens; file=$detail"
  fi
}

# 26-29
run_detail_shape "required-sections" "intent-capture"
run_detail_shape "upstream-coverage" "intent-capture"
run_detail_shape "linter" "code-generation" "**/*.{ts,js}"
run_detail_shape "type-check" "code-generation" "**/*.{ts,tsx}"

# ============================================================
# Group I — Detail-file collision-free (1): two failing fires for the
# same (sensor, stage) must produce two distinct detail files (Fire id
# keys the path, so 8-hex randomness makes collisions ~4B-to-1).
# ============================================================

I_PROJ=$(make_proj)
echo "stub" >"$I_PROJ/aidlc-docs/test.md"
I_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-fail.ts")
for _ in 1 2; do
  CLAUDE_PROJECT_DIR="$I_PROJ" AIDLC_SENSORS_DIR="$I_SENSORS" \
    bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$I_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
done
I_DETAILS=$(find "$I_PROJ/aidlc-docs/.aidlc-sensors/intent-capture" -type f -name 'required-sections-*.md' 2>/dev/null | wc -l | tr -d ' ')
I_UNIQUE=$(find "$I_PROJ/aidlc-docs/.aidlc-sensors/intent-capture" -type f -name 'required-sections-*.md' 2>/dev/null | sort -u | wc -l | tr -d ' ')
if [ "$I_DETAILS" = "2" ] && [ "$I_UNIQUE" = "2" ]; then
  ok "detail-file collision-free: 2 FAILED fires → 2 distinct Fire-id-keyed paths"
else
  not_ok "detail-file collision-free" "files=$I_DETAILS unique=$I_UNIQUE"
fi

# ============================================================
# Group J — Audit-row required-fields (4): each event type carries
# every required field per audit-format.md and nothing extra leaks.
# ============================================================

# 31: SENSOR_FIRED — Timestamp + Event + Fire id + Sensor ID + Stage slug
# + Output path = 6 ** lines.
J_PROJ=$(make_proj)
echo "stub" >"$J_PROJ/aidlc-docs/test.md"
J_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-pass.ts")
CLAUDE_PROJECT_DIR="$J_PROJ" AIDLC_SENSORS_DIR="$J_SENSORS" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$J_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
J1_COUNT=$(audit_field_count "$J_PROJ/aidlc-docs/audit.md" SENSOR_FIRED)
J1_FIRED_ID=$(audit_field "$J_PROJ/aidlc-docs/audit.md" SENSOR_FIRED "Fire id")
J1_SID=$(audit_field "$J_PROJ/aidlc-docs/audit.md" SENSOR_FIRED "Sensor ID")
J1_STAGE=$(audit_field "$J_PROJ/aidlc-docs/audit.md" SENSOR_FIRED "Stage slug")
J1_PATH=$(audit_field "$J_PROJ/aidlc-docs/audit.md" SENSOR_FIRED "Output path")
if [ "$J1_COUNT" = "6" ] && [ -n "$J1_FIRED_ID" ] && [ "$J1_SID" = "required-sections" ] && [ "$J1_STAGE" = "intent-capture" ] && [ -n "$J1_PATH" ]; then
  ok "audit-row shape — SENSOR_FIRED: 6 fields (Timestamp, Event, Fire id, Sensor ID, Stage slug, Output path)"
else
  not_ok "audit-row shape — SENSOR_FIRED" "count=$J1_COUNT fire_id=$J1_FIRED_ID sid=$J1_SID stage=$J1_STAGE path=$J1_PATH"
fi

# 32: SENSOR_PASSED — adds Duration ms = 7 fields.
J2_DUR=$(audit_field "$J_PROJ/aidlc-docs/audit.md" SENSOR_PASSED "Duration ms")
J2_COUNT=$(audit_field_count "$J_PROJ/aidlc-docs/audit.md" SENSOR_PASSED)
if [ "$J2_COUNT" = "7" ] && [[ "$J2_DUR" =~ ^[0-9]+$ ]]; then
  ok "audit-row shape — SENSOR_PASSED: 7 fields including Duration ms (integer)"
else
  not_ok "audit-row shape — SENSOR_PASSED" "count=$J2_COUNT dur=$J2_DUR"
fi

# 33: SENSOR_FAILED — Timestamp + Event + Fire id + Sensor ID + Stage slug
# + Output path + Detail path + Findings count = 8 fields.
J3_PROJ=$(make_proj)
echo "stub" >"$J3_PROJ/aidlc-docs/test.md"
J3_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-fail.ts")
CLAUDE_PROJECT_DIR="$J3_PROJ" AIDLC_SENSORS_DIR="$J3_SENSORS" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$J3_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
J3_COUNT=$(audit_field_count "$J3_PROJ/aidlc-docs/audit.md" SENSOR_FAILED)
J3_DETAIL=$(audit_field "$J3_PROJ/aidlc-docs/audit.md" SENSOR_FAILED "Detail path")
J3_FIND=$(audit_field "$J3_PROJ/aidlc-docs/audit.md" SENSOR_FAILED "Findings count")
if [ "$J3_COUNT" = "8" ] && [ -n "$J3_DETAIL" ] && [[ "$J3_FIND" =~ ^[0-9]+$ ]]; then
  ok "audit-row shape — SENSOR_FAILED: 8 fields including Detail path + Findings count (integer)"
else
  not_ok "audit-row shape — SENSOR_FAILED" "count=$J3_COUNT detail=$J3_DETAIL findings=$J3_FIND"
fi

# 34: SENSOR_BUDGET_OVERRIDE — Timestamp + Event + Fire id + Sensor ID +
# Stage slug + Output path + Cap layer + Cap value + Observed value = 9.
J4_PROJ=$(make_proj)
echo "stub" >"$J4_PROJ/aidlc-docs/test.md"
J4_SENSORS=$(make_fork_sensors "required-sections" "bun .claude/tools/aidlc-sensor-stub-slow.ts" "" 1)
CLAUDE_PROJECT_DIR="$J4_PROJ" AIDLC_SENSORS_DIR="$J4_SENSORS" \
  bun "$SENSOR_TS" fire required-sections --stage intent-capture --output-path "$J4_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
J4_COUNT=$(audit_field_count "$J4_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE)
J4_LAYER=$(audit_field "$J4_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Cap layer")
J4_CAP=$(audit_field "$J4_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Cap value")
J4_OBS=$(audit_field "$J4_PROJ/aidlc-docs/audit.md" SENSOR_BUDGET_OVERRIDE "Observed value")
if [ "$J4_COUNT" = "9" ] && [ "$J4_LAYER" = "registry" ] && [[ "$J4_CAP" =~ ^[0-9]+$ ]] && [[ "$J4_OBS" =~ ^[0-9]+$ ]]; then
  ok "audit-row shape — SENSOR_BUDGET_OVERRIDE: 9 fields (+Cap layer/value, Observed value as integers)"
else
  not_ok "audit-row shape — SENSOR_BUDGET_OVERRIDE" "count=$J4_COUNT layer=$J4_LAYER cap=$J4_CAP obs=$J4_OBS"
fi

# ============================================================
# Group K — Manifest `command:` resolves on disk (4): for each
# shipped manifest, the basename of `command:` exists next to the
# dispatcher (where __FILE_DIR-based sibling resolution looks).
# ============================================================

assert_manifest_command_resolves() {
  local id="$1"
  local manifest="$REPO_ROOT/dist/claude/.claude/sensors/aidlc-${id}.md"
  local cmd
  cmd=$(awk '/^command:/ { sub(/^command:[[:space:]]*/, ""); print; exit }' "$manifest")
  # Basename: last whitespace-delimited token ending in .ts.
  local basename
  basename=$(printf '%s\n' "$cmd" | tr ' ' '\n' | grep '\.ts$' | tail -1 | awk -F/ '{print $NF}')
  local script="$TOOLS_DIR/$basename"
  if [ -n "$basename" ] && [ -f "$script" ]; then
    ok "manifest command resolves — sensor=$id: $basename exists in tools/"
  else
    not_ok "manifest command resolves — sensor=$id" "basename=$basename script=$script"
  fi
}

# 35-38
assert_manifest_command_resolves "required-sections"
assert_manifest_command_resolves "upstream-coverage"
assert_manifest_command_resolves "linter"
assert_manifest_command_resolves "type-check"

# ============================================================
# Group L — Validation order (3): pre-lock failures must NEVER
# emit SENSOR_FIRED. Each case uses a fresh projectDir.
# ============================================================

# 39: invalid stage slug
L1_PROJ=$(make_proj)
echo "stub" >"$L1_PROJ/aidlc-docs/test.md"
set +e
CLAUDE_PROJECT_DIR="$L1_PROJ" bun "$SENSOR_TS" fire required-sections --stage nonexistent-stage --output-path "$L1_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
set -e
if [ ! -f "$L1_PROJ/aidlc-docs/audit.md" ]; then
  ok "validation order — invalid stage slug exits before lock window A (no audit file created)"
else
  FIRED=$(audit_event_count "$L1_PROJ/aidlc-docs/audit.md" SENSOR_FIRED)
  if [ "$FIRED" = "0" ]; then
    ok "validation order — invalid stage slug exits before lock window A (zero SENSOR_FIRED rows)"
  else
    not_ok "validation order — invalid stage slug" "audit file has $FIRED SENSOR_FIRED rows"
  fi
fi

# 40: matches rejection
L2_PROJ=$(make_proj)
echo "stub" >"$L2_PROJ/aidlc-docs/test.md"
set +e
CLAUDE_PROJECT_DIR="$L2_PROJ" bun "$SENSOR_TS" fire linter --stage code-generation --output-path "$L2_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
set -e
if [ ! -f "$L2_PROJ/aidlc-docs/audit.md" ]; then
  ok "validation order — matches rejection exits before lock window A (no audit file created)"
else
  FIRED=$(audit_event_count "$L2_PROJ/aidlc-docs/audit.md" SENSOR_FIRED)
  if [ "$FIRED" = "0" ]; then
    ok "validation order — matches rejection exits before lock window A (zero SENSOR_FIRED rows)"
  else
    not_ok "validation order — matches rejection" "audit file has $FIRED SENSOR_FIRED rows"
  fi
fi

# 41: unknown sensor id
L3_PROJ=$(make_proj)
echo "stub" >"$L3_PROJ/aidlc-docs/test.md"
set +e
CLAUDE_PROJECT_DIR="$L3_PROJ" bun "$SENSOR_TS" fire totally-unknown-sensor --stage intent-capture --output-path "$L3_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
set -e
if [ ! -f "$L3_PROJ/aidlc-docs/audit.md" ]; then
  ok "validation order — unknown sensor id exits before lock window A (no audit file created)"
else
  FIRED=$(audit_event_count "$L3_PROJ/aidlc-docs/audit.md" SENSOR_FIRED)
  if [ "$FIRED" = "0" ]; then
    ok "validation order — unknown sensor id exits before lock window A (zero SENSOR_FIRED rows)"
  else
    not_ok "validation order — unknown sensor id" "audit file has $FIRED SENSOR_FIRED rows"
  fi
fi

# ============================================================
# Group M — upstream-coverage --consumes resolution (1): pick a
# stage with non-empty consumes (market-research consumes
# intent-statement); fire upstream-coverage with the argv-capture
# stub; verify the captured argv contains "--stage market-research"
# AND "--consumes intent-statement" (proves loadGraph() resolution
# ran pre-lock and pushed the right flag).
# ============================================================

M_PROJ=$(make_proj)
echo "stub" >"$M_PROJ/aidlc-docs/test.md"
M_SENSORS=$(make_fork_sensors "upstream-coverage" "bun .claude/tools/aidlc-sensor-stub-argv.ts")
M_ARGV_OUT="$M_PROJ/argv.json"
CLAUDE_PROJECT_DIR="$M_PROJ" AIDLC_SENSORS_DIR="$M_SENSORS" AIDLC_T92_ARGV_OUT="$M_ARGV_OUT" \
  bun "$SENSOR_TS" fire upstream-coverage --stage market-research --output-path "$M_PROJ/aidlc-docs/test.md" >/dev/null 2>&1
if [ -f "$M_ARGV_OUT" ] &&
  grep -q '"--stage"' "$M_ARGV_OUT" &&
  grep -q '"market-research"' "$M_ARGV_OUT" &&
  grep -q '"--consumes"' "$M_ARGV_OUT" &&
  grep -q '"intent-statement"' "$M_ARGV_OUT" &&
  grep -q '"--output-path"' "$M_ARGV_OUT"; then
  ok "upstream-coverage --consumes: stage.consumes[].artifact resolved via loadGraph() and passed to script"
else
  not_ok "upstream-coverage --consumes resolution" "argv=$([ -f "$M_ARGV_OUT" ] && cat "$M_ARGV_OUT" || echo MISSING)"
fi

finish
