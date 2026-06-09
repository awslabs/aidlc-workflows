#!/bin/bash
# t54: Workflow test — audit trail completeness during bugfix (10 tests)
# Requires: claude CLI
# Verifies audit log structure, auto-approve entries, timestamps, and no duplicates.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 10

PROJ=$(setup_integration_project --no-aidlc-docs)

# Run a bugfix workflow with --test-run flag
run_claude "$PROJ" "/aidlc bugfix --test-run"

AUDIT="$PROJ/aidlc-docs/audit.md"

# Test 1: Audit file exists
assert_file_exists "$AUDIT" "audit file exists"

# Test 2: Audit file > 200 bytes
if [ -f "$AUDIT" ]; then
  AUDIT_SIZE=$(wc -c < "$AUDIT")
  assert_gt "$AUDIT_SIZE" 200 "audit file > 200 bytes"
else
  not_ok "audit file > 200 bytes" "audit.md not found"
fi

# Test 3: Contains at least one stage completion entry
if [ -f "$AUDIT" ]; then
  STAGE_COMPLETIONS=$(grep -c 'STAGE_COMPLETED' "$AUDIT" || true)
  assert_gt "$STAGE_COMPLETIONS" 2 "audit contains stage completion entries (≥3 for post-init stages)"
else
  not_ok "audit contains stage completion entries" "audit.md not found"
fi

# Test 4: Audit tags test-run entries with Test-Run: true on canonical events.
# Phase 11 (#50) collapsed the five `*_AUTO_*` event types
# (GATE_AUTO_APPROVED, OPTION_AUTO_SELECTED, ACTION_AUTO_CONFIRMED,
# QUESTION_AUTO_ANSWERED, JUMP_AUTO_STOPPED) into a `Test-Run: true` field
# on canonical events (GATE_APPROVED, QUESTION_ANSWERED, STAGE_JUMPED, etc.).
# A --test-run workflow should have at least one event tagged with this field.
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" '\*\*Test-Run\*\*: true' "audit tags canonical events with Test-Run: true"
else
  not_ok "audit tags canonical events with Test-Run: true" "audit.md not found"
fi

# Test 5: All entries have ISO timestamps (YYYY-MM-DDTHH:MM:SSZ pattern)
if [ -f "$AUDIT" ]; then
  TIMESTAMP_COUNT=$(grep -cE '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z' "$AUDIT" || true)
  assert_gt "$TIMESTAMP_COUNT" 0 "audit entries have ISO timestamps"
else
  not_ok "audit entries have ISO timestamps" "audit.md not found"
fi

# Test 6: No duplicate SESSION_STARTED entries
if [ -f "$AUDIT" ]; then
  SESSION_STARTS=$(grep -ci 'SESSION_STARTED' "$AUDIT" || true)
  if [ "$SESSION_STARTS" -le 1 ]; then
    ok "no duplicate SESSION_STARTED entries (found $SESSION_STARTS)"
  else
    not_ok "no duplicate SESSION_STARTED entries" "found $SESSION_STARTS SESSION_STARTED entries"
  fi
else
  not_ok "no duplicate SESSION_STARTED entries" "audit.md not found"
fi

# Test 7: Audit has the AI-DLC Audit Log header
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" "Audit Log" "audit has header"
else
  not_ok "audit has header" "audit.md not found"
fi

# Test 8: Audit contains Timestamp fields
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" "\*\*Timestamp\*\*" "audit contains Timestamp fields"
else
  not_ok "audit contains Timestamp fields" "audit.md not found"
fi

# Test 9: Audit entries have horizontal rule separators
if [ -f "$AUDIT" ]; then
  HR_COUNT=$(grep -c '^---' "$AUDIT" || true)
  assert_gt "$HR_COUNT" 0 "audit has horizontal rule separators"
else
  not_ok "audit has horizontal rule separators" "audit.md not found"
fi

# Test 10: Multiple audit events logged (at least 3 — session start + init stages + post-init)
if [ -f "$AUDIT" ]; then
  EVENT_COUNT=$(grep -ciE '\*\*Event\*\*:' "$AUDIT" || true)
  assert_gt "$EVENT_COUNT" 2 "multiple audit events logged (found $EVENT_COUNT)"
else
  not_ok "multiple audit events logged" "audit.md not found"
fi

cleanup_test_project "$PROJ"

finish
