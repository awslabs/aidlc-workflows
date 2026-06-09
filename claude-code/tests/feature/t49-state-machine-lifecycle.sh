#!/bin/bash
# t48: Feature-tier walk through the full stage lifecycle
#      [ ] → [-] → [?] → [R] → [?] → [x] via state-tool commands,
#      asserting the audit stream records the right events in the right order.
#
# This is the integration-style test for the state machine's happy path +
# revision loop. Unit tests (t17) cover individual commands in isolation;
# this walks them as a sequence and verifies the audit trail is complete.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
STATE="$AIDLC_SRC/tools/aidlc-state.ts"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 14

# Set up a fresh bugfix workflow — short scope, quick to walk end-to-end
PROJ=$(create_test_project)
bun "$UTIL" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1

# After init, Current Stage should be requirements-analysis (first in-scope stage)
CURRENT=$(bun "$STATE" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$CURRENT" "requirements-analysis" "init lands on requirements-analysis"

# --- Step 1: gate-start transitions [-] → [?] ---
bun "$STATE" gate-start requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[?\] requirements-analysis' "step 1: [-] → [?]"

# --- Step 2: reject transitions [?] → [R], increments Revision Count ---
bun "$STATE" reject requirements-analysis --feedback "needs acceptance criteria" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[R\] requirements-analysis' "step 2: [?] → [R]"
REV=$(bun "$STATE" get "Revision Count" --project-dir "$PROJ" 2>&1)
assert_eq "$REV" "1" "step 2: Revision Count incremented to 1"

# --- Step 3: revise transitions [R] → [?] (re-enter gate) ---
bun "$STATE" revise requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[?\] requirements-analysis' "step 3: [R] → [?]"

# --- Step 4: approve transitions [?] → [x] ---
bun "$STATE" approve requirements-analysis --user-input "Accepted with changes" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[x\] requirements-analysis' "step 4: [?] → [x]"

# --- Step 5: advance → next stage in bugfix scope ---
bun "$STATE" advance requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
NEXT=$(bun "$STATE" get "Current Stage" --project-dir "$PROJ" 2>&1)
# Bugfix next stage after requirements-analysis should be something downstream — not the same
assert_not_eq "$NEXT" "requirements-analysis" "step 5: advance moves Current Stage forward"

# --- Audit stream shape ---
AUDIT="$PROJ/aidlc-docs/audit.md"

# gate-start emits STAGE_AWAITING_APPROVAL (at least once — once for gate-start,
# once for revise re-entry — so expect >= 2)
AWAIT_COUNT=$(grep -c "^\*\*Event\*\*: STAGE_AWAITING_APPROVAL" "$AUDIT")
assert_gt "$AWAIT_COUNT" "1" "audit: STAGE_AWAITING_APPROVAL emitted for gate-start and revise"

# Exactly one GATE_REJECTED
REJECT_COUNT=$(grep -c "^\*\*Event\*\*: GATE_REJECTED" "$AUDIT")
assert_eq "$REJECT_COUNT" "1" "audit: exactly one GATE_REJECTED"

# Exactly one STAGE_REVISING
REVISING_COUNT=$(grep -c "^\*\*Event\*\*: STAGE_REVISING" "$AUDIT")
assert_eq "$REVISING_COUNT" "1" "audit: exactly one STAGE_REVISING"

# Exactly one GATE_APPROVED for this stage
APPROVED_COUNT=$(grep -c "^\*\*Event\*\*: GATE_APPROVED" "$AUDIT")
assert_eq "$APPROVED_COUNT" "1" "audit: exactly one GATE_APPROVED"

# Exactly one STAGE_COMPLETED for requirements-analysis (from approve, not from advance)
COMPLETED_COUNT=$(grep -A 4 "^\*\*Event\*\*: STAGE_COMPLETED" "$AUDIT" | \
                  grep -c "\*\*Stage\*\*: requirements-analysis")
assert_eq "$COMPLETED_COUNT" "1" "audit: exactly one STAGE_COMPLETED for requirements-analysis (no duplicate from advance)"

# --- Ordering: STAGE_AWAITING_APPROVAL precedes GATE_REJECTED which precedes STAGE_REVISING ---
# Extract just the event types in order
EVENT_SEQUENCE=$(grep "^\*\*Event\*\*:" "$AUDIT" | awk '{print $2}')
# The first STAGE_AWAITING_APPROVAL (before any GATE_REJECTED)
FIRST_AWAIT_LINE=$(grep -n "^\*\*Event\*\*: STAGE_AWAITING_APPROVAL" "$AUDIT" | head -1 | cut -d: -f1)
FIRST_REJECT_LINE=$(grep -n "^\*\*Event\*\*: GATE_REJECTED" "$AUDIT" | head -1 | cut -d: -f1)
FIRST_REVISING_LINE=$(grep -n "^\*\*Event\*\*: STAGE_REVISING" "$AUDIT" | head -1 | cut -d: -f1)
if [ "$FIRST_AWAIT_LINE" -lt "$FIRST_REJECT_LINE" ] && [ "$FIRST_REJECT_LINE" -lt "$FIRST_REVISING_LINE" ]; then
  ok "audit ordering: STAGE_AWAITING_APPROVAL → GATE_REJECTED → STAGE_REVISING"
else
  not_ok "audit ordering: STAGE_AWAITING_APPROVAL → GATE_REJECTED → STAGE_REVISING" \
    "await=$FIRST_AWAIT_LINE reject=$FIRST_REJECT_LINE revising=$FIRST_REVISING_LINE"
fi

# --- GATE_APPROVED comes AFTER the revision loop (from the second gate entry) ---
FIRST_APPROVED_LINE=$(grep -n "^\*\*Event\*\*: GATE_APPROVED" "$AUDIT" | head -1 | cut -d: -f1)
if [ "$FIRST_APPROVED_LINE" -gt "$FIRST_REVISING_LINE" ]; then
  ok "audit ordering: GATE_APPROVED follows STAGE_REVISING (revision loop resolved)"
else
  not_ok "audit ordering: GATE_APPROVED follows STAGE_REVISING"
fi

cleanup_test_project "$PROJ"

finish
