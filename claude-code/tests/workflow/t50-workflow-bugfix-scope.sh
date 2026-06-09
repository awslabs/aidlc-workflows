#!/bin/bash
# t50: Workflow test — bugfix scope full lifecycle via --test-run (24 tests)
# Requires: claude CLI
# This test runs a complete bugfix workflow with --test-run auto-approving all gates.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 24

PROJ=$(setup_integration_project --no-aidlc-docs --with-brownfield-stub)

# Run a bugfix workflow with --test-run flag
run_claude "$PROJ" "/aidlc bugfix --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# Test 1: State file created
assert_file_exists "$STATE" "state file created"

# Test 2: Audit file created
assert_file_exists "$AUDIT" "audit file created"

# Test 3: State file records bugfix scope
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "[Bb]ugfix" "state file records bugfix scope"
else
  not_ok "state file records bugfix scope" "aidlc-state.md not found"
fi

# Tests 4-6: All 3 init stages marked completed
for stage in workspace-scaffold workspace-detection state-init; do
  if [ -f "$STATE" ]; then
    if grep -qi "\[x\] $stage" "$STATE" 2>/dev/null; then
      ok "[x] $stage in state file"
    else
      not_ok "[x] $stage in state file" "stage not marked complete"
    fi
  else
    not_ok "[x] $stage in state file" "aidlc-state.md not found"
  fi
done

# Test 8: At least one Inception stage progressed (reverse-engineering or requirements-analysis)
if [ -f "$STATE" ]; then
  INCEPTION_PROGRESS=$(grep -ciE '\[x\] (reverse-engineering|requirements-analysis)' "$STATE" || true)
  assert_gt "$INCEPTION_PROGRESS" 0 "at least one Inception stage progressed"
else
  not_ok "at least one Inception stage progressed" "aidlc-state.md not found"
fi

# Test 9: At least one Construction stage progressed (code-generation or build-and-test)
if [ -f "$STATE" ]; then
  CONSTRUCTION_PROGRESS=$(grep -ciE '\[x\] (code-generation|build-and-test)' "$STATE" || true)
  assert_gt "$CONSTRUCTION_PROGRESS" 0 "at least one Construction stage progressed"
else
  not_ok "at least one Construction stage progressed" "aidlc-state.md not found"
fi

# Test 10: Audit log tags test-run entries with Test-Run: true on canonical events
# (Phase 11 collapsed auto-event types into a Test-Run field on GATE_APPROVED /
# QUESTION_ANSWERED / STAGE_JUMPED; the literal "test-run mode" phrase is gone.)
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" '\*\*Test-Run\*\*: true' "audit tags canonical events with Test-Run: true"
else
  not_ok "audit tags canonical events with Test-Run: true" "audit.md not found"
fi

# Test 11: Knowledge directory created
assert_dir_exists "$PROJ/aidlc-docs/knowledge" "knowledge directory created"

# Test 12: State Version is 7
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "State Version.*: 7$" "state version is 7"
else
  not_ok "state version is 7" "aidlc-state.md not found"
fi

# Test 13: More than 4 stages completed (init + at least one post-init)
if [ -f "$STATE" ]; then
  COMPLETED=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$COMPLETED" 4 "more than 4 stages completed (init + post-init)"
else
  not_ok "more than 4 stages completed (init + post-init)" "aidlc-state.md not found"
fi

# Test 14: Audit file has substantial content (> 200 bytes)
if [ -f "$AUDIT" ]; then
  AUDIT_SIZE=$(wc -c < "$AUDIT")
  assert_gt "$AUDIT_SIZE" 200 "audit file > 200 bytes"
else
  not_ok "audit file > 200 bytes" "audit.md not found"
fi

# Test 15: State file has Test Run Mode field
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Test Run Mode.*true" "state file has Test Run Mode: true"
else
  not_ok "state file has Test Run Mode: true" "aidlc-state.md not found"
fi

# Test 16: State mentions brownfield classification
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "[Bb]rownfield" "state classifies project as brownfield"
else
  not_ok "state classifies project as brownfield" "aidlc-state.md not found"
fi

# Test 17: State mentions React
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "[Rr]eact" "state mentions React"
else
  not_ok "state mentions React" "aidlc-state.md not found"
fi

# Test 18: RE directory exists
RE_DIR="$PROJ/aidlc-docs/inception/reverse-engineering"
assert_dir_exists "$RE_DIR" "reverse-engineering directory created"

# Test 19: RE directory has at least 4 artifacts
if [ -d "$RE_DIR" ]; then
  RE_COUNT=$(find "$RE_DIR" -name "*.md" -type f | wc -l)
  assert_gt "$RE_COUNT" 3 "RE directory has >= 4 .md artifacts"
else
  not_ok "RE directory has >= 4 .md artifacts" "RE directory not found"
fi

# Test 20: RE artifact mentions React
if [ -d "$RE_DIR" ]; then
  RE_REACT=$(grep -rl "[Rr]eact" "$RE_DIR" 2>/dev/null | wc -l)
  assert_gt "$RE_REACT" 0 "RE artifact mentions React"
else
  not_ok "RE artifact mentions React" "RE directory not found"
fi

# Test 21: RE artifact mentions Todo domain
if [ -d "$RE_DIR" ]; then
  RE_TODO=$(grep -rl "[Tt]odo" "$RE_DIR" 2>/dev/null | wc -l)
  assert_gt "$RE_TODO" 0 "RE artifact mentions Todo domain"
else
  not_ok "RE artifact mentions Todo domain" "RE directory not found"
fi

# Test 22: RE artifacts have structure (markdown headings)
if [ -d "$RE_DIR" ]; then
  RE_HEADINGS=$(grep -rl "^#" "$RE_DIR" 2>/dev/null | wc -l)
  assert_gt "$RE_HEADINGS" 0 "RE artifacts have markdown headings"
else
  not_ok "RE artifacts have markdown headings" "RE directory not found"
fi

# Test 23: At least one RE artifact > 200 bytes
if [ -d "$RE_DIR" ]; then
  RE_BIG=$(find "$RE_DIR" -name "*.md" -type f -size +200c | wc -l)
  assert_gt "$RE_BIG" 0 "at least one RE artifact > 200 bytes"
else
  not_ok "at least one RE artifact > 200 bytes" "RE directory not found"
fi

# Test 24: Requirements directory exists (if requirements-analysis completed)
REQ_DIR="$PROJ/aidlc-docs/inception/requirements-analysis"
if [ -d "$REQ_DIR" ]; then
  ok "requirements-analysis directory created"
else
  skip "requirements-analysis directory not created (may not have reached this stage)"
fi

# Test 25: Requirements artifact mentions Todo domain
if [ -d "$REQ_DIR" ]; then
  REQ_TODO=$(grep -rl "[Tt]odo" "$REQ_DIR" 2>/dev/null | wc -l)
  if [ "$REQ_TODO" -gt 0 ]; then
    ok "requirements artifact mentions Todo domain"
  else
    skip "requirements artifact does not mention Todo (may depend on LLM output)"
  fi
else
  skip "requirements directory not found — skipping domain check"
fi

cleanup_test_project "$PROJ"

finish
