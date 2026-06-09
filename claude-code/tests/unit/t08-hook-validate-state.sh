#!/bin/bash
# t08: Unit tests for validate-state.ts (14 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

HOOK="$AIDLC_SRC/hooks/aidlc-validate-state.ts"
MID_IDEATION="$FIXTURES_DIR/state-mid-ideation.md"

plan 14

# --- Test 1: Silent exit when no state file ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>&1)
if [ -z "$OUTPUT" ] || ! echo "$OUTPUT" | grep -qi "WARNING"; then
  ok "silent exit when no state file"
else
  not_ok "silent exit when no state file" "got output: $OUTPUT"
fi
cleanup_test_project "$PROJ"

# --- Test 2: Heartbeat written even without state file ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_file_exists "$PROJ/aidlc-docs/.aidlc-hooks-health/validate-state.last" "heartbeat written even without state file"
cleanup_test_project "$PROJ"

# --- Test 3: No recovery breadcrumb when no state file ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
if [ ! -f "$PROJ/aidlc-docs/.aidlc-recovery.md" ]; then
  ok "no recovery breadcrumb when no state file"
else
  not_ok "no recovery breadcrumb when no state file" ".aidlc-recovery.md was unexpectedly created"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Passes on valid fixture ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>&1)
if ! echo "$OUTPUT" | grep -qi "WARNING"; then
  ok "passes on valid fixture (no WARNING)"
else
  not_ok "passes on valid fixture (no WARNING)" "got WARNING: $OUTPUT"
fi
cleanup_test_project "$PROJ"

# --- Test 5: Warns on missing Stage Progress ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
EOF
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>&1)
assert_contains "$OUTPUT" "Stage Progress" "warns on missing Stage Progress"
cleanup_test_project "$PROJ"

# --- Test 6: Warns on missing Current Status ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Stage Progress
### IDEATION PHASE
- [-] feasibility — EXECUTE
EOF
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>&1)
assert_contains "$OUTPUT" "Current Status" "warns on missing Current Status"
cleanup_test_project "$PROJ"

# --- Test 7: Writes recovery breadcrumb ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_file_exists "$PROJ/aidlc-docs/.aidlc-recovery.md" "writes recovery breadcrumb"
cleanup_test_project "$PROJ"

# --- Test 8: Breadcrumb contains stage and status ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
RECOVERY="$PROJ/aidlc-docs/.aidlc-recovery.md"
assert_grep "$RECOVERY" "feasibility" "breadcrumb contains stage"
assert_grep "$RECOVERY" "valid" "breadcrumb contains valid status"
cleanup_test_project "$PROJ"

# --- Test 9/10: Breadcrumb shows INVALID when sections missing ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
EOF
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" >/dev/null 2>/dev/null
RECOVERY="$PROJ/aidlc-docs/.aidlc-recovery.md"
assert_grep "$RECOVERY" "INVALID" "breadcrumb shows INVALID when sections missing"
cleanup_test_project "$PROJ"

# --- Test 11: Warns on corrupted fixture (missing Stage Progress) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-corrupted.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>&1)
assert_contains "$OUTPUT" "Stage Progress" "warns on corrupted fixture missing Stage Progress"
cleanup_test_project "$PROJ"

# --- Test 12: Passes on completed fixture ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-completed.md"
OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>&1)
if ! echo "$OUTPUT" | grep -qi "WARNING"; then
  ok "passes on completed fixture (no WARNING)"
else
  not_ok "passes on completed fixture (no WARNING)" "got WARNING: $OUTPUT"
fi
cleanup_test_project "$PROJ"

# --- Test 13: PreCompact emits SESSION_COMPACTED when audit exists ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
seed_audit_file "$PROJ"
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
assert_grep "$PROJ/aidlc-docs/audit.md" "SESSION_COMPACTED" "PreCompact emits SESSION_COMPACTED when audit exists"
cleanup_test_project "$PROJ"

# --- Test 14: PreCompact does not emit when no audit.md ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
rm -f "$PROJ/aidlc-docs/audit.md"
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null
if [ ! -f "$PROJ/aidlc-docs/audit.md" ]; then
  ok "PreCompact does not auto-create audit.md"
else
  not_ok "PreCompact does not auto-create audit.md" "audit.md unexpectedly created"
fi
cleanup_test_project "$PROJ"

finish
