#!/bin/bash
# t73: Stage test — intent capture with greenfield stub (12 assertions, 25 turns)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=900

plan 12

# Setup: scaffold project with greenfield stub and state at init-done (intent-capture next)
PROJ=$(setup_integration_project \
  --with-state "$FIXTURES_DIR/state-initialization-done.md" \
  --with-greenfield-stub \
  --with-audit)

# Run the intent-capture stage
run_claude "$PROJ" "/aidlc --stage intent-capture --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
IC_DIR="$PROJ/aidlc-docs/ideation/intent-capture"

# Test 1: Intent-capture directory created
assert_dir_exists "$IC_DIR" "intent-capture directory created"

# Test 2: Questions file exists
if [ -d "$IC_DIR" ]; then
  QUESTIONS_FILE=$(find "$IC_DIR" -name "*questions*" -type f 2>/dev/null | head -1)
  if [ -n "$QUESTIONS_FILE" ] && [ -f "$QUESTIONS_FILE" ]; then
    ok "intent-capture questions file exists"
  else
    not_ok "intent-capture questions file exists" "no questions file found in $IC_DIR"
  fi
else
  not_ok "intent-capture questions file exists" "intent-capture directory not found"
fi

# Test 3: Questions file has [Answer]: tags filled
if [ -n "${QUESTIONS_FILE:-}" ] && [ -f "${QUESTIONS_FILE:-}" ]; then
  ANSWER_COUNT=$(grep -c '\[Answer\]:' "$QUESTIONS_FILE" || true)
  assert_gt "$ANSWER_COUNT" 0 "questions file has [Answer]: tags"
else
  not_ok "questions file has [Answer]: tags" "questions file not found"
fi

# Test 4: Intent statement artifact exists
if [ -d "$IC_DIR" ]; then
  INTENT_FILE=$(find "$IC_DIR" -name "*intent*statement*" -o -name "*intent-statement*" 2>/dev/null | head -1)
  if [ -n "$INTENT_FILE" ] && [ -f "$INTENT_FILE" ]; then
    ok "intent statement artifact exists"
  else
    not_ok "intent statement artifact exists" "no intent-statement file found in $IC_DIR"
  fi
else
  not_ok "intent statement artifact exists" "intent-capture directory not found"
fi

# Test 5: Intent statement > 100 bytes
if [ -n "${INTENT_FILE:-}" ] && [ -f "${INTENT_FILE:-}" ]; then
  assert_file_min_size "$INTENT_FILE" 100 "intent statement > 100 bytes"
else
  not_ok "intent statement > 100 bytes" "intent statement file not found"
fi

# Test 6: Intent statement has markdown headings
if [ -n "${INTENT_FILE:-}" ] && [ -f "${INTENT_FILE:-}" ]; then
  if grep -q "^#" "$INTENT_FILE" 2>/dev/null; then
    ok "intent statement has markdown headings"
  else
    not_ok "intent statement has markdown headings" "no headings found"
  fi
else
  not_ok "intent statement has markdown headings" "intent statement file not found"
fi

# Test 7: Intent artifact mentions Todo or task context (from README)
if [ -n "${INTENT_FILE:-}" ] && [ -f "${INTENT_FILE:-}" ]; then
  if grep -qi "[Tt]odo\|[Tt]ask" "$INTENT_FILE" 2>/dev/null; then
    ok "intent artifact mentions Todo/task context"
  else
    skip "intent artifact does not mention Todo/task (LLM output varies)"
  fi
else
  not_ok "intent artifact mentions Todo/task context" "intent statement file not found"
fi

# Test 8: Stakeholder map exists
if [ -d "$IC_DIR" ]; then
  STAKEHOLDER_FILE=$(find "$IC_DIR" -name "*stakeholder*" -type f 2>/dev/null | head -1)
  if [ -n "$STAKEHOLDER_FILE" ] && [ -f "$STAKEHOLDER_FILE" ]; then
    ok "stakeholder map artifact exists"
  else
    not_ok "stakeholder map artifact exists" "no stakeholder file found in $IC_DIR"
  fi
else
  not_ok "stakeholder map artifact exists" "intent-capture directory not found"
fi

# --- Invariant assertions (hold regardless of how far execution advances) ---

# Test 9: Completed counter matches [x] count (internal consistency)
if [ -f "$STATE" ]; then
  X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
  COMPLETED=$(grep 'Completed' "$STATE" | grep -oE '[0-9]+' | head -1)
  assert_eq "$X_COUNT" "$COMPLETED" "Completed counter ($COMPLETED) matches [x] count ($X_COUNT)"
else
  not_ok "Completed counter matches [x] count" "aidlc-state.md not found"
fi

# Test 10: If intent-capture [x], then Current Stage != intent-capture (advanced).
# Fixture sets Current Stage == target (redo jump), so aidlc-jump doesn't
# terminate. After the stage's own gate runs approve, approve auto-advances
# to the next in-scope stage — Current Stage moves to market-research.
if [ -f "$STATE" ] && grep -qi '\[x\] intent-capture' "$STATE" 2>/dev/null; then
  CURRENT=$(grep -i "Current Stage" "$STATE" | head -1 || true)
  if echo "$CURRENT" | grep -qvi "intent-capture"; then
    ok "intent-capture done => current stage advanced past intent-capture"
  else
    not_ok "intent-capture done => current stage advanced past intent-capture" "Current Stage: $CURRENT"
  fi
else
  skip "intent-capture not yet [x] — stage advancement check skipped"
fi

# Test 11: Lifecycle phase is IDEATION (set by fixture, always true)
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "IDEATION" "lifecycle phase is IDEATION"
else
  not_ok "lifecycle phase is IDEATION" "aidlc-state.md not found"
fi

# Test 12: Completed >= 4 (monotonic: can't decrease from fixture's 4)
if [ -f "$STATE" ]; then
  X_COUNT=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$X_COUNT" 3 "completed >= 4 (monotonic from fixture's 4, got $X_COUNT)"
else
  not_ok "completed >= 4" "aidlc-state.md not found"
fi

cleanup_test_project "$PROJ"

finish
