#!/bin/bash
# t93: Behavioural contract for `aidlc-sensor.ts` read-only subcommands
# (v0.5.0 MR 9). 12 tests.
#
# Surface tested:
#   - `list` enumerates the 4 framework sensors in deterministic alpha
#     order with id + kind + description columns.
#   - `describe <id>` for each of the 4 framework sensors.
#   - `describe required-sections` and `describe upstream-coverage`
#     include `matches: **/aidlc-docs/**` (G1.5 from v0.5.0 MR 10:
#     markdown sensors scope themselves to aidlc-docs/ via manifest).
#   - `describe linter` includes `matches: **/*.{ts,js}`.
#   - `describe <unknown-id>` exits 1 with a known-ids hint.
#   - `--help` / `-h` prints usage.
#   - No subcommand → exit 1 with usage hint.
#
# Read-only — no temp project setup needed. Runs against the framework's
# real sensors dir (dist/claude/.claude/sensors/) so this also
# acts as a forward-check that the 4 manifests stay shipped + parseable.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SENSOR_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-sensor.ts"

if [ ! -f "$SENSOR_TS" ]; then
	echo "Bail out! aidlc-sensor.ts not found at $SENSOR_TS"
	exit 1
fi

plan 12

# --- Case 1: `list` enumerates exactly 4 sensors ---
LIST_OUT=$(bun "$SENSOR_TS" list 2>&1)
LIST_LINES=$(printf '%s\n' "$LIST_OUT" | grep -c '	' || true)
assert_eq "$LIST_LINES" "4" "list emits 4 framework sensors"

# --- Case 2: list rows are id<TAB>kind<TAB>description ---
# All 4 are kind=deterministic in v0.5.0; verify column 2 of every row.
NON_DETERMINISTIC=$(printf '%s\n' "$LIST_OUT" | awk -F'\t' '$2 != "deterministic"' | wc -l | tr -d ' ')
assert_eq "$NON_DETERMINISTIC" "0" "list column 2 is 'deterministic' for every row"

# --- Case 3: list is in deterministic alpha order by id ---
# Extract column 1 and verify it equals its sorted form.
IDS=$(printf '%s\n' "$LIST_OUT" | awk -F'\t' '{print $1}')
SORTED_IDS=$(printf '%s\n' "$IDS" | sort)
if [ "$IDS" = "$SORTED_IDS" ]; then
	ok "list is alpha-sorted by id"
else
	not_ok "list is alpha-sorted by id" "got: $IDS"
fi

# --- Case 4: list includes the 4 expected ids ---
# Sentinel set — flag drift if a sensor is renamed or one is missing.
EXPECTED="linter required-sections type-check upstream-coverage"
ACTUAL=$(printf '%s\n' "$IDS" | tr '\n' ' ' | sed 's/ $//')
assert_eq "$ACTUAL" "$EXPECTED" "list returns exactly the 4 framework sensor ids"

# --- Case 5: describe required-sections has the canonical fields ---
# Must include id, kind, command, description, default_severity, and
# matches: **/aidlc-docs/** (G1.5 — markdown sensors scope themselves
# to aidlc-docs/ via manifest, fires hook-side at fire time).
RS_OUT=$(bun "$SENSOR_TS" describe required-sections 2>&1)
if printf '%s\n' "$RS_OUT" | grep -q '^id: required-sections$' &&
	printf '%s\n' "$RS_OUT" | grep -q '^kind: deterministic$' &&
	printf '%s\n' "$RS_OUT" | grep -q '^command: bun .claude/tools/aidlc-sensor-required-sections.ts$' &&
	printf '%s\n' "$RS_OUT" | grep -q '^default_severity: advisory$' &&
	printf '%s\n' "$RS_OUT" | grep -q '^matches: \*\*/aidlc-docs/\*\*$'; then
	ok "describe required-sections lists canonical fields including matches: **/aidlc-docs/**"
else
	not_ok "describe required-sections lists canonical fields including matches: **/aidlc-docs/**" "got: $RS_OUT"
fi

# --- Case 6: describe upstream-coverage has the canonical fields ---
UC_OUT=$(bun "$SENSOR_TS" describe upstream-coverage 2>&1)
if printf '%s\n' "$UC_OUT" | grep -q '^id: upstream-coverage$' &&
	printf '%s\n' "$UC_OUT" | grep -q '^command: bun .claude/tools/aidlc-sensor-upstream-coverage.ts$' &&
	printf '%s\n' "$UC_OUT" | grep -q '^matches: \*\*/aidlc-docs/\*\*$'; then
	ok "describe upstream-coverage lists canonical fields including matches: **/aidlc-docs/**"
else
	not_ok "describe upstream-coverage lists canonical fields including matches: **/aidlc-docs/**" "got: $UC_OUT"
fi

# --- Case 7: describe linter includes matches: **/*.{ts,js} ---
LIN_OUT=$(bun "$SENSOR_TS" describe linter 2>&1)
if printf '%s\n' "$LIN_OUT" | grep -q '^id: linter$' &&
	printf '%s\n' "$LIN_OUT" | grep -q '^matches: \*\*/\*\.{ts,js}$' &&
	printf '%s\n' "$LIN_OUT" | grep -q '^command: bun .claude/tools/aidlc-sensor-linter.ts$'; then
	ok "describe linter includes matches: **/*.{ts,js} and canonical fields"
else
	not_ok "describe linter includes matches: **/*.{ts,js}" "got: $LIN_OUT"
fi

# --- Case 8: describe type-check includes matches: **/*.{ts,tsx} ---
TC_OUT=$(bun "$SENSOR_TS" describe type-check 2>&1)
if printf '%s\n' "$TC_OUT" | grep -q '^id: type-check$' &&
	printf '%s\n' "$TC_OUT" | grep -q '^matches: \*\*/\*\.{ts,tsx}$' &&
	printf '%s\n' "$TC_OUT" | grep -q '^command: bun .claude/tools/aidlc-sensor-type-check.ts$'; then
	ok "describe type-check includes matches: **/*.{ts,tsx} and canonical fields"
else
	not_ok "describe type-check includes matches" "got: $TC_OUT"
fi

# --- Case 9: describe <unknown-id> exits 1 with a known-ids hint ---
set +e
UNK_OUT=$(bun "$SENSOR_TS" describe definitely-not-a-real-sensor-id 2>&1)
UNK_RC=$?
set -e
if [ "$UNK_RC" -ne 0 ] && printf '%s\n' "$UNK_OUT" | grep -q 'unknown sensor id'; then
	ok "describe <unknown-id> exits non-zero with known-ids hint"
else
	not_ok "describe <unknown-id> exits non-zero with hint" "rc=$UNK_RC, out=$UNK_OUT"
fi

# --- Case 10: --help prints usage with all 3 subcommands ---
HELP_OUT=$(bun "$SENSOR_TS" --help 2>&1)
if printf '%s\n' "$HELP_OUT" | grep -q 'Usage: aidlc-sensor' &&
	printf '%s\n' "$HELP_OUT" | grep -q 'list' &&
	printf '%s\n' "$HELP_OUT" | grep -q 'describe' &&
	printf '%s\n' "$HELP_OUT" | grep -q 'fire'; then
	ok "--help prints usage covering all 3 subcommands"
else
	not_ok "--help prints usage covering all 3 subcommands" "got: $HELP_OUT"
fi

# --- Case 11: -h is alias for --help ---
H_OUT=$(bun "$SENSOR_TS" -h 2>&1)
if printf '%s\n' "$H_OUT" | grep -q 'Usage: aidlc-sensor'; then
	ok "-h prints the same usage banner"
else
	not_ok "-h prints usage" "got: $H_OUT"
fi

# --- Case 12: no subcommand → exit 1 + usage hint ---
set +e
NOSUB_OUT=$(bun "$SENSOR_TS" 2>&1)
NOSUB_RC=$?
set -e
if [ "$NOSUB_RC" -ne 0 ] && printf '%s\n' "$NOSUB_OUT" | grep -q 'Usage: aidlc-sensor'; then
	ok "no subcommand → exit non-zero with usage hint"
else
	not_ok "no subcommand → exit non-zero with usage hint" "rc=$NOSUB_RC, out=$NOSUB_OUT"
fi

finish
