#!/bin/bash
# t51: End-to-end event parity test for the bugfix scope.
#
# Walks a bugfix workflow from init through complete-workflow by invoking
# the state tool directly (no claude CLI), capturing the full audit.md, and
# asserting the canonical event sequence appears in the expected order with
# the expected field shapes.
#
# Bugfix scope on a greenfield project executes 6 stages:
#   initialization: workspace-scaffold, workspace-detection, state-init (pre-completed by init)
#   inception:      requirements-analysis   (reverse-engineering SKIP-greenfield override)
#   construction:   code-generation, build-and-test
# (Ideation and operation are skipped entirely — PHASE_SKIPPED fires at init.)
#
# Expected event sequence:
#   WORKFLOW_STARTED
#   PHASE_STARTED (initialization)
#   PHASE_SKIPPED × 2 (ideation, operation)
#   STAGE_STARTED (workspace-scaffold)  [init pre-completes 3 init stages]
#   STAGE_COMPLETED workspace-scaffold
#   STAGE_STARTED workspace-detection
#   STAGE_COMPLETED workspace-detection
#   STAGE_STARTED state-init
#   STAGE_COMPLETED state-init
#   PHASE_COMPLETED (initialization)
#   PHASE_VERIFIED (initialization)
#   PHASE_STARTED (inception)
#   STAGE_STARTED reverse-engineering
#   — user simulation: gate-start → approve
#   STAGE_AWAITING_APPROVAL
#   GATE_APPROVED
#   STAGE_COMPLETED reverse-engineering
#   STAGE_STARTED requirements-analysis
#   STAGE_AWAITING_APPROVAL
#   GATE_APPROVED
#   STAGE_COMPLETED requirements-analysis
#   PHASE_COMPLETED (inception)
#   PHASE_VERIFIED (inception)
#   PHASE_STARTED (construction)
#   STAGE_STARTED code-generation
#   STAGE_AWAITING_APPROVAL
#   GATE_APPROVED
#   STAGE_COMPLETED code-generation
#   STAGE_STARTED build-and-test
#   STAGE_AWAITING_APPROVAL
#   GATE_APPROVED
#   STAGE_COMPLETED build-and-test
#   PHASE_COMPLETED (construction)
#   PHASE_VERIFIED (construction)
#   WORKFLOW_COMPLETED
#
# This is a workflow-tier test but runs as L1 because state-tool calls are
# deterministic and don't need a Claude CLI. Assertions cover:
#   1. Event counts match the expected sequence
#   2. Relative event ordering (GATE_APPROVED always precedes STAGE_COMPLETED
#      for a given stage)
#   3. Workflow terminates with Status=Completed, WORKFLOW_COMPLETED landed
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

plan 15

PROJ=$(create_test_project)

# --- Bootstrap via init (emits WORKFLOW_STARTED + init phase + 2× PHASE_SKIPPED) ---
AIDLC_WORKFLOW_INTENT="bugfix parity test" \
  bun "$UTIL" init --scope bugfix --project-dir "$PROJ" --test-run >/dev/null 2>&1

audit="$PROJ/aidlc-docs/audit.md"

# After init: the first post-init stage is reverse-engineering. Walk the rest
# by calling gate-start → approve for each remaining EXECUTE stage. approve
# auto-advances to the next in-scope stage (emitting STAGE_STARTED + phase
# boundary events), and on the final stage auto-completes the workflow
# (emitting PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED).
walk_stage() {
  local slug="$1"
  bun "$STATE" gate-start "$slug" --project-dir "$PROJ" >/dev/null 2>&1
  bun "$STATE" approve "$slug" --user-input "approve" --project-dir "$PROJ" >/dev/null 2>&1
}

walk_stage requirements-analysis
walk_stage code-generation
walk_stage build-and-test

# Helper: count events of a given type in the audit log.
count_event() {
  grep -cE "^\\*\\*Event\\*\\*: $1\$" "$audit" 2>/dev/null || echo 0
}

# --- Assertions on event counts ---
assert_eq 1 "$(count_event WORKFLOW_STARTED)"      "WORKFLOW_STARTED fires once"
assert_eq 1 "$(count_event WORKFLOW_COMPLETED)"    "WORKFLOW_COMPLETED fires once"
assert_eq 3 "$(count_event PHASE_STARTED)"         "PHASE_STARTED fires 3× (initialization, inception, construction)"
assert_eq 3 "$(count_event PHASE_COMPLETED)"       "PHASE_COMPLETED fires 3×"
assert_eq 3 "$(count_event PHASE_VERIFIED)"        "PHASE_VERIFIED fires 3×"
assert_eq 2 "$(count_event PHASE_SKIPPED)"         "PHASE_SKIPPED fires 2× (ideation, operation)"
# STAGE_STARTED: 3 init + 3 gated stages = 6
assert_eq 6 "$(count_event STAGE_STARTED)"         "STAGE_STARTED fires 6× (3 init + 3 gated)"
# STAGE_COMPLETED: 3 init + 3 approve = 6. On the final stage, approve
# delegates to complete-workflow internally; complete-workflow's
# alreadyMarkedCompleted guard suppresses the duplicate STAGE_COMPLETED.
assert_eq 6 "$(count_event STAGE_COMPLETED)"       "STAGE_COMPLETED fires 6×"
# STAGE_AWAITING_APPROVAL + GATE_APPROVED: one per gated stage = 3 each
assert_eq 3 "$(count_event STAGE_AWAITING_APPROVAL)" "STAGE_AWAITING_APPROVAL fires 3×"
assert_eq 3 "$(count_event GATE_APPROVED)"         "GATE_APPROVED fires 3×"

# --- Assertions on ordering ---
# WORKFLOW_STARTED must be the FIRST event in audit.md (after the header).
first_event=$(grep -m1 '^\*\*Event\*\*:' "$audit" | sed 's/^\*\*Event\*\*: //')
assert_eq "WORKFLOW_STARTED" "$first_event" "WORKFLOW_STARTED is first event"

# WORKFLOW_COMPLETED must be the LAST event.
last_event=$(grep '^\*\*Event\*\*:' "$audit" | tail -1 | sed 's/^\*\*Event\*\*: //')
assert_eq "WORKFLOW_COMPLETED" "$last_event" "WORKFLOW_COMPLETED is last event"

# For each gated stage, GATE_APPROVED must precede STAGE_COMPLETED in the audit stream.
# Extract (line, event) pairs and check ordering for the construction stages.
gate_line=$(grep -n '^\*\*Event\*\*: GATE_APPROVED' "$audit" | tail -1 | cut -d: -f1)
stage_line=$(grep -n '^\*\*Event\*\*: STAGE_COMPLETED' "$audit" | tail -1 | cut -d: -f1)
if [ -n "$gate_line" ] && [ -n "$stage_line" ] && [ "$gate_line" -lt "$stage_line" ]; then
  ok "GATE_APPROVED precedes STAGE_COMPLETED for final stage"
else
  not_ok "GATE_APPROVED precedes STAGE_COMPLETED for final stage" \
    "gate_line=$gate_line stage_line=$stage_line"
fi

# --- Assertions on terminal state ---
state="$PROJ/aidlc-docs/aidlc-state.md"
assert_grep "$state" '^- \*\*Status\*\*: Completed' "Status=Completed"
# All 7 EXECUTE stages should be [x]; skipped ones (ideation + operation) should be [S]
completed_count=$(grep -cE '^- \[x\] [a-z-]+' "$state" || echo 0)
assert_eq 6 "$completed_count" "6 stages marked [x] in final state"

cleanup_test_project "$PROJ"

finish
