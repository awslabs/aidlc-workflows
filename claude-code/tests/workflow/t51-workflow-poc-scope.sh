#!/bin/bash
# t51: Workflow test — POC scope via --test-run (19 tests)
# Requires: claude CLI
# POC scope (8 of 31 stages) includes Ideation, which bugfix skips.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

plan 19

PROJ=$(setup_integration_project --no-aidlc-docs --with-greenfield-stub)

# Run a POC workflow with --test-run flag
run_claude "$PROJ" "/aidlc poc --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
AUDIT="$PROJ/aidlc-docs/audit.md"

# Test 1: State file created
assert_file_exists "$STATE" "state file created"

# Test 2: POC scope recorded in state file
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "[Pp][Oo][Cc]" "POC scope recorded in state file"
else
  not_ok "POC scope recorded in state file" "aidlc-state.md not found"
fi

# Test 3: Ideation directory created (POC includes ideation, unlike bugfix)
assert_dir_exists "$PROJ/aidlc-docs/ideation" "ideation directory created"

# Test 4: Intent-capture questions file exists
if [ -d "$PROJ/aidlc-docs/ideation" ]; then
  QUESTIONS_FILE=$(find "$PROJ/aidlc-docs/ideation" -name "*questions*" -type f 2>/dev/null | head -1)
  if [ -n "$QUESTIONS_FILE" ]; then
    ok "intent-capture questions file exists"
  else
    not_ok "intent-capture questions file exists" "no questions file found in ideation/"
  fi
else
  not_ok "intent-capture questions file exists" "ideation/ directory not found"
fi

# Test 5: Questions file has [Answer]: tags filled (auto-answered)
if [ -n "${QUESTIONS_FILE:-}" ] && [ -f "${QUESTIONS_FILE:-}" ]; then
  ANSWER_COUNT=$(grep -c '\[Answer\]:' "$QUESTIONS_FILE" || true)
  assert_gt "$ANSWER_COUNT" 0 "questions file has [Answer]: tags"
else
  not_ok "questions file has [Answer]: tags" "questions file not found"
fi

# Tests 6-8: All 3 init stages marked completed
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

# Test 10: More stages completed than bugfix would produce (> 6)
if [ -f "$STATE" ]; then
  COMPLETED=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$COMPLETED" 6 "POC has more than 6 completed stages"
else
  not_ok "POC has more than 6 completed stages" "aidlc-state.md not found"
fi

# Test 11: Audit log exists with content
if [ -f "$AUDIT" ]; then
  AUDIT_SIZE=$(wc -c < "$AUDIT")
  assert_gt "$AUDIT_SIZE" 200 "audit file has substantial content"
else
  not_ok "audit file has substantial content" "audit.md not found"
fi

# Test 12: State file has Test Run Mode field
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "Test Run Mode.*true" "state file has Test Run Mode: true"
else
  not_ok "state file has Test Run Mode: true" "aidlc-state.md not found"
fi

# Test 13: State classifies greenfield
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "[Gg]reenfield" "state classifies project as greenfield"
else
  not_ok "state classifies project as greenfield" "aidlc-state.md not found"
fi

# Test 14: Intent-capture directory exists
IC_DIR="$PROJ/aidlc-docs/ideation/intent-capture"
if [ -d "$IC_DIR" ]; then
  ok "intent-capture directory exists"
else
  not_ok "intent-capture directory exists" "directory not found"
fi

# Test 15: Intent statement artifact exists and mentions Todo
if [ -d "$IC_DIR" ]; then
  INTENT_FILE=$(find "$IC_DIR" -name "*intent*statement*" -o -name "*intent-statement*" -type f 2>/dev/null | head -1)
  if [ -n "$INTENT_FILE" ] && [ -f "$INTENT_FILE" ]; then
    ok "intent statement artifact exists"
  else
    not_ok "intent statement artifact exists" "no intent statement found in $IC_DIR"
  fi
else
  not_ok "intent statement artifact exists" "intent-capture directory not found"
fi

# Test 16: Intent artifact mentions Todo or task
if [ -n "${INTENT_FILE:-}" ] && [ -f "${INTENT_FILE:-}" ]; then
  if grep -qi "[Tt]odo\|[Tt]ask" "$INTENT_FILE" 2>/dev/null; then
    ok "intent artifact mentions Todo/task"
  else
    skip "intent artifact does not mention Todo/task (LLM output varies)"
  fi
else
  skip "intent statement file not found — skipping domain check"
fi

# Test 17: Questions file has answers filled
if [ -n "${QUESTIONS_FILE:-}" ] && [ -f "${QUESTIONS_FILE:-}" ]; then
  FILLED_ANSWERS=$(grep -c '\[Answer\]:.*[A-Za-z]' "$QUESTIONS_FILE" || true)
  assert_gt "$FILLED_ANSWERS" 0 "questions file has filled [Answer]: tags"
else
  not_ok "questions file has filled [Answer]: tags" "questions file not found"
fi

# Test 18: Ideation artifacts have structure (markdown headings)
if [ -d "$PROJ/aidlc-docs/ideation" ]; then
  IDEATION_HEADINGS=$(grep -rl "^#" "$PROJ/aidlc-docs/ideation" 2>/dev/null | wc -l)
  assert_gt "$IDEATION_HEADINGS" 0 "ideation artifacts have markdown headings"
else
  not_ok "ideation artifacts have markdown headings" "ideation directory not found"
fi

# Test 19: At least one ideation artifact > 100 bytes
if [ -d "$PROJ/aidlc-docs/ideation" ]; then
  IDEATION_BIG=$(find "$PROJ/aidlc-docs/ideation" -name "*.md" -type f -size +100c | wc -l)
  assert_gt "$IDEATION_BIG" 0 "at least one ideation artifact > 100 bytes"
else
  not_ok "at least one ideation artifact > 100 bytes" "ideation directory not found"
fi

# Test 20: Stakeholder map exists
if [ -d "$IC_DIR" ]; then
  STAKEHOLDER_FILE=$(find "$IC_DIR" -name "*stakeholder*" -type f 2>/dev/null | head -1)
  if [ -n "$STAKEHOLDER_FILE" ] && [ -f "$STAKEHOLDER_FILE" ]; then
    ok "stakeholder map artifact exists"
  else
    skip "stakeholder map not found (optional artifact)"
  fi
else
  skip "intent-capture directory not found — skipping stakeholder check"
fi

cleanup_test_project "$PROJ"

finish
