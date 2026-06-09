#!/bin/bash
# t45: Integration test — revision-loop on a gated stage.
#
# Exercises the gate → reject → revise → gate cycle multiple times. Verifies:
#   - Revision Count increments on each reject
#   - GATE_REJECTED + STAGE_REVISING emit as a pair each cycle
#   - STAGE_AWAITING_APPROVAL emits on each re-entry via `revise`
#   - After 3 rejections, a 4th approval still lands the stage at [x]
#
# Tests the state-tool transitions end-to-end; no claude CLI. Runs as
# integration tier because it spans multiple tool invocations and asserts on
# their cumulative audit trail.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"
STATE="$AIDLC_SRC/tools/aidlc-state.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 10

PROJ=$(create_test_project)

# Init bugfix scope — leaves requirements-analysis in [-] ready to gate.
AIDLC_WORKFLOW_INTENT="revision loop test" \
  bun "$UTIL" init --scope bugfix --project-dir "$PROJ" --test-run >/dev/null 2>&1

audit="$PROJ/aidlc-docs/audit.md"
state="$PROJ/aidlc-docs/aidlc-state.md"

# --- Cycle 1: gate-start → reject ---
bun "$STATE" gate-start requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE" reject requirements-analysis --feedback "needs more detail" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$state" '^- \*\*Revision Count\*\*: 1' "Revision Count=1 after first reject"
assert_grep "$state" '^- \[R\] requirements-analysis' "checkbox becomes [R] after reject"

# --- Cycle 2: revise → gate-start (from [R]) → reject ---
bun "$STATE" revise requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$state" '^- \[?\] requirements-analysis' "checkbox flips back to [?] after revise"
bun "$STATE" reject requirements-analysis --feedback "still not enough" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$state" '^- \*\*Revision Count\*\*: 2' "Revision Count=2 after second reject"

# --- Cycle 3: revise → reject ---
bun "$STATE" revise requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE" reject requirements-analysis --feedback "one more round" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$state" '^- \*\*Revision Count\*\*: 3' "Revision Count=3 after third reject"

# --- Final: revise → approve (escape hatch or natural approval after 3 cycles) ---
bun "$STATE" revise requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE" approve requirements-analysis --user-input "accept as-is" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$state" '^- \[x\] requirements-analysis' "final approve lands [x]"

# --- Audit assertions ---
count_event() {
  grep -cE "^\\*\\*Event\\*\\*: $1\$" "$audit" 2>/dev/null || echo 0
}

assert_eq 3 "$(count_event GATE_REJECTED)"         "GATE_REJECTED fires 3×"
assert_eq 3 "$(count_event STAGE_REVISING)"        "STAGE_REVISING fires 3×"
# STAGE_AWAITING_APPROVAL: 1 from initial gate-start + 3 from revise = 4
assert_eq 4 "$(count_event STAGE_AWAITING_APPROVAL)" "STAGE_AWAITING_APPROVAL fires 4× (1 gate-start + 3 revise)"
assert_eq 1 "$(count_event GATE_APPROVED)"         "GATE_APPROVED fires once (final approval)"

cleanup_test_project "$PROJ"

finish
