#!/bin/bash
# t25: Integration test — backward --phase jump via claude CLI (6 tests)
# Tests --phase resolution: --phase ideation from CONSTRUCTION resolves to intent-capture
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

# No timeout guard: the jump handler completes in seconds (all file assertions pass),
# but --phase enters Stage Advancement which cascades through all ideation stages (~90s each).
# We set 300s as a reasonable ceiling — the jump itself is well under 60s.
AIDLC_TEST_TIMEOUT=300

plan 6

# Test: --phase ideation from construction resolves to first in-scope ideation stage (intent-capture)
PROJ=$(setup_integration_project --with-state "$FIXTURES_DIR/state-construction.md" --with-audit)
run_claude "$PROJ" "/aidlc --phase ideation --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# Phase should be IDEATION after backward jump
assert_grep "$STATE" 'IDEATION' "lifecycle phase is IDEATION"

# Completed count should be reduced (was 20 in construction fixture)
COMPLETED=$(grep 'Completed' "$STATE" | grep -oE '[0-9]+' | head -1 || true)
assert_lt "$COMPLETED" 20 "backward jump reduced completed count (was 20, now $COMPLETED)"

# Audit should record the jump target
assert_grep "$AUDIT" 'intent-capture' "audit records jump target intent-capture"

# --- Audit log integrity (written during jump handler, deterministic) ---
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" 'STAGE_JUMPED' "audit has STAGE_JUMPED event"
  assert_grep "$AUDIT" 'BACKWARD' "audit records backward direction"
  assert_grep "$AUDIT" 'Timestamp' "audit event has timestamp"
else
  not_ok "audit has STAGE_JUMPED event" "audit.md not found"
  not_ok "audit records backward direction" "audit.md not found"
  not_ok "audit event has timestamp" "audit.md not found"
fi

cleanup_test_project "$PROJ"

finish
