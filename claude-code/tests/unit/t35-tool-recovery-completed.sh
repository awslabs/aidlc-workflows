#!/bin/bash
# t35: Unit tests for RECOVERY_COMPLETED emission via acknowledge-compaction
#
# The orchestrator's compaction-awareness flow:
#   1. `aidlc-state resume` reports `compaction_pending: true` if the latest
#      audit event is SESSION_COMPACTED with no subsequent stage activity.
#   2. Orchestrator surfaces AskUserQuestion (continue/review/restart).
#   3. After user answers, orchestrator calls:
#        aidlc-state acknowledge-compaction --choice <continue|review|restart>
#      which emits RECOVERY_COMPLETED and closes the pending window.
#
# These tests exercise the acknowledge-compaction command directly:
#   - Emits RECOVERY_COMPLETED with Choice + Current Stage fields
#   - Rejects invalid --choice values
#   - Requires --choice flag
#   - Only emits when a pending compaction exists
#   - After acknowledge, subsequent resume reports compaction_pending: false
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
STATE="$AIDLC_SRC/tools/aidlc-state.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

# Helper: append a SESSION_COMPACTED event to a project's audit.md.
# Required for tests that exercise the "pending compaction" flow.
inject_session_compacted() {
  local proj="$1"
  cat >> "$proj/aidlc-docs/audit.md" <<'EOF'

## Session Compacted
**Timestamp**: 2026-05-03T00:00:00Z
**Event**: SESSION_COMPACTED
**Source**: compact

---
EOF
}

plan 11

# Tests 1-3 = 3 assertions (event + 2 field checks)
# Test 4  = 3 assertions (one per valid choice)
# Tests 5-8 = 4 assertions (invalid choice, missing flag, no compaction, post-activity)
# Test 9  = 1 assertion (resume reports compaction_pending=false after acknowledge)
# Total = 11

# --- Test 1: acknowledge-compaction with pending compaction emits RECOVERY_COMPLETED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
inject_session_compacted "$PROJ"
bun "$STATE" acknowledge-compaction --choice continue --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '^\*\*Event\*\*: RECOVERY_COMPLETED' "acknowledge emits RECOVERY_COMPLETED"
cleanup_test_project "$PROJ"

# --- Test 2: Records Choice field ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
inject_session_compacted "$PROJ"
bun "$STATE" acknowledge-compaction --choice review --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Choice\*\*: review' "RECOVERY_COMPLETED records Choice"
cleanup_test_project "$PROJ"

# --- Test 3: Records Current Stage field ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
inject_session_compacted "$PROJ"
bun "$STATE" acknowledge-compaction --choice continue --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Current Stage\*\*:' "RECOVERY_COMPLETED records Current Stage"
cleanup_test_project "$PROJ"

# --- Test 4: All three valid choices are accepted ---
for choice in continue review restart; do
  PROJ=$(create_test_project)
  seed_audit_file "$PROJ"
  seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
  inject_session_compacted "$PROJ"
  bun "$STATE" acknowledge-compaction --choice "$choice" --project-dir "$PROJ" >/dev/null 2>&1 || true
  assert_grep "$PROJ/aidlc-docs/audit.md" "\\*\\*Choice\\*\\*: $choice" "choice=$choice accepted"
  cleanup_test_project "$PROJ"
done

# --- Test 5: Invalid --choice value rejected ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
inject_session_compacted "$PROJ"
set +e
out=$(bun "$STATE" acknowledge-compaction --choice bogus --project-dir "$PROJ" 2>&1)
rc=$?
set -e
assert_eq 1 "$rc" "invalid choice exits 1"
cleanup_test_project "$PROJ"

# --- Test 6: Missing --choice flag rejected ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
inject_session_compacted "$PROJ"
set +e
out=$(bun "$STATE" acknowledge-compaction --project-dir "$PROJ" 2>&1)
rc=$?
set -e
assert_eq 1 "$rc" "missing --choice exits 1"
cleanup_test_project "$PROJ"

# --- Test 7: No emission when no SESSION_COMPACTED event in audit ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# audit-sample.md already seeded, but no SESSION_COMPACTED was injected
set +e
bun "$STATE" acknowledge-compaction --choice continue --project-dir "$PROJ" >/dev/null 2>&1
rc=$?
set -e
assert_eq 1 "$rc" "refuses when no pending compaction"
cleanup_test_project "$PROJ"

# --- Test 8: After stage activity follows SESSION_COMPACTED, compaction is no longer pending ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
inject_session_compacted "$PROJ"
# Append a STAGE_STARTED event AFTER the SESSION_COMPACTED — simulates user
# continuing to work after a compaction without acknowledging it explicitly.
cat >> "$PROJ/aidlc-docs/audit.md" <<'EOF'

## Stage Start
**Timestamp**: 2026-05-03T00:05:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture

---
EOF
set +e
bun "$STATE" acknowledge-compaction --choice continue --project-dir "$PROJ" >/dev/null 2>&1
rc=$?
set -e
assert_eq 1 "$rc" "refuses when stage activity already followed the compaction"
cleanup_test_project "$PROJ"

# --- Test 9: After acknowledge, resume reports compaction_pending: false ---
# RECOVERY_COMPLETED is part of the detection exclusion list in handleResume
# (alongside STAGE_STARTED / STAGE_COMPLETED / GATE_APPROVED / SESSION_RESUMED),
# so once we acknowledge, the "pending compaction" window closes.
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
inject_session_compacted "$PROJ"
bun "$STATE" acknowledge-compaction --choice continue --project-dir "$PROJ" >/dev/null 2>&1 || true
resume_json=$(bun "$STATE" resume --project-dir "$PROJ" 2>/dev/null || true)
echo "$resume_json" | grep -q '"compaction_pending":false'
rc=$?
assert_eq 0 "$rc" "resume reports compaction_pending:false after acknowledge"
cleanup_test_project "$PROJ"

finish
