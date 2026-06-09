#!/bin/bash
# t57: Workflow test — backward jump resets target + downstream stages (5 tests)
#
# Exercises the backward-jump semantics documented in aidlc-jump.ts (executeJump,
# direction === "backward"): downstream EXECUTE stages that were [x]/[-]/[?]/[R]/[S]
# are reset to [ ] (pending), Current Stage pivots to the target, and Lifecycle
# Phase is rewritten. There is no automatic replay — the orchestrator re-runs
# reset stages, so by end-of-run the target may be [x]. The target-checkbox
# [-] state is transient (see t19-tool-jump for the tool-level assertion).
# Mirrors the invariants validated in t26-integration-backward-jump.sh.
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 5

# Fixture: construction-phase workflow with 19 completed stages. Backward-jump
# target is reverse-engineering (2.1) — an inception stage that EXECUTES under
# feature scope per data/scope-mapping.json.
PROJ=$(setup_integration_project --with-state "$FIXTURES_DIR/state-construction.md")
run_claude "$PROJ" "/aidlc --stage reverse-engineering --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# Test 1: Current Stage pivoted to the jump target. This is the observable,
# end-to-end invariant of a backward jump — the jump tool sets Current Stage,
# and no downstream orchestrator step rewrites it back. Unlike the target
# checkbox (which the tool marks [-] but the orchestrator executes to [x] under
# --test-run), Current Stage survives the full workflow turn.
if [ -f "$STATE" ]; then
  CURRENT=$(sed -n 's/.*\*\*Current Stage\*\*: //p' "$STATE" | head -1)
  if [ "$CURRENT" = "reverse-engineering" ]; then
    ok "Current Stage pivoted to jump target"
  else
    not_ok "Current Stage pivoted to jump target" \
      "Current Stage is '$CURRENT'"
  fi
else
  not_ok "Current Stage pivoted to jump target" "aidlc-state.md not found"
fi

# Test 2: downstream stages that were previously [x] are now [ ]. Fixture had
# 19 [x] before the jump; after jumping to RE (index 10), at least 9 of those
# should reset. Assert the Completed counter dropped below 15.
if [ -f "$STATE" ]; then
  X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_lt "$X_COUNT" 15 "significant downstream reset ($X_COUNT [x], was 19)"
else
  not_ok "significant downstream reset" "aidlc-state.md not found"
fi

# Test 3: audit records the backward jump with the standard STAGE_JUMPED event.
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" 'STAGE_JUMPED' "audit has STAGE_JUMPED event"
else
  not_ok "audit has STAGE_JUMPED event" "audit.md not found"
fi

# Test 4: audit explicitly tags the direction as BACKWARD so downstream
# consumers can distinguish forward from backward jumps.
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" 'BACKWARD' "audit records backward direction"
else
  not_ok "audit records backward direction" "audit.md not found"
fi

# Test 5: Lifecycle Phase updated to INCEPTION (jump tool rewrites it per target).
if [ -f "$STATE" ]; then
  PHASE=$(sed -n 's/.*\*\*Lifecycle Phase\*\*: //p' "$STATE" | head -1)
  if [ "$PHASE" = "INCEPTION" ]; then
    ok "Lifecycle Phase rewritten to INCEPTION"
  else
    not_ok "Lifecycle Phase rewritten to INCEPTION" "Lifecycle Phase is '$PHASE'"
  fi
else
  not_ok "Lifecycle Phase rewritten to INCEPTION" "aidlc-state.md not found"
fi

cleanup_test_project "$PROJ"

finish
