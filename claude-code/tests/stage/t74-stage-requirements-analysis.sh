#!/bin/bash
# t74: Stage test — requirements analysis with brownfield stub + RE artifacts (12 assertions, 25 turns)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=900

plan 12

# Setup: scaffold project with brownfield stub, mid-inception state, and pre-seeded RE artifacts
PROJ=$(setup_integration_project \
  --with-state "$FIXTURES_DIR/state-mid-inception.md" \
  --with-brownfield-stub \
  --with-re-artifacts \
  --with-audit)

# Run the requirements-analysis stage
run_claude "$PROJ" "/aidlc --stage requirements-analysis --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
REQ_DIR="$PROJ/aidlc-docs/inception/requirements-analysis"

# Test 1: Requirements-analysis directory created
assert_dir_exists "$REQ_DIR" "requirements-analysis directory created"

# Test 2: Requirements file exists
if [ -d "$REQ_DIR" ]; then
  REQ_FILE=$(find "$REQ_DIR" -name "*requirements*" -not -name "*questions*" -type f 2>/dev/null | head -1)
  if [ -n "$REQ_FILE" ] && [ -f "$REQ_FILE" ]; then
    ok "requirements artifact exists"
  else
    not_ok "requirements artifact exists" "no requirements file found in $REQ_DIR"
  fi
else
  not_ok "requirements artifact exists" "requirements-analysis directory not found"
fi

# Test 3: Requirements file > 200 bytes
if [ -n "${REQ_FILE:-}" ] && [ -f "${REQ_FILE:-}" ]; then
  assert_file_min_size "$REQ_FILE" 200 "requirements artifact > 200 bytes"
else
  not_ok "requirements artifact > 200 bytes" "requirements file not found"
fi

# Test 4: Requirements file has markdown headings
if [ -n "${REQ_FILE:-}" ] && [ -f "${REQ_FILE:-}" ]; then
  if grep -q "^#" "$REQ_FILE" 2>/dev/null; then
    ok "requirements artifact has markdown headings"
  else
    not_ok "requirements artifact has markdown headings" "no headings found"
  fi
else
  not_ok "requirements artifact has markdown headings" "requirements file not found"
fi

# Test 5: Requirements mention Todo domain
if [ -n "${REQ_FILE:-}" ] && [ -f "${REQ_FILE:-}" ]; then
  if grep -qi "[Tt]odo" "$REQ_FILE" 2>/dev/null; then
    ok "requirements mention Todo domain"
  else
    skip "requirements do not mention Todo (LLM output varies)"
  fi
else
  not_ok "requirements mention Todo domain" "requirements file not found"
fi

# Test 6: Requirements reference React/TypeScript (from RE context)
if [ -n "${REQ_FILE:-}" ] && [ -f "${REQ_FILE:-}" ]; then
  if grep -qi "[Rr]eact\|[Tt]ype[Ss]cript" "$REQ_FILE" 2>/dev/null; then
    ok "requirements reference React/TypeScript"
  else
    skip "requirements do not reference React/TypeScript (LLM output varies)"
  fi
else
  not_ok "requirements reference React/TypeScript" "requirements file not found"
fi

# Test 7: Questions file exists
if [ -d "$REQ_DIR" ]; then
  QUESTIONS_FILE=$(find "$REQ_DIR" -name "*questions*" -type f 2>/dev/null | head -1)
  if [ -n "$QUESTIONS_FILE" ] && [ -f "$QUESTIONS_FILE" ]; then
    ok "requirements questions file exists"
  else
    not_ok "requirements questions file exists" "no questions file found in $REQ_DIR"
  fi
else
  not_ok "requirements questions file exists" "requirements-analysis directory not found"
fi

# Test 8: Questions file has [Answer]: tags filled
if [ -n "${QUESTIONS_FILE:-}" ] && [ -f "${QUESTIONS_FILE:-}" ]; then
  ANSWER_COUNT=$(grep -c '\[Answer\]:' "$QUESTIONS_FILE" || true)
  assert_gt "$ANSWER_COUNT" 0 "questions file has [Answer]: tags filled"
else
  not_ok "questions file has [Answer]: tags filled" "questions file not found"
fi

# Test 9: State marks requirements-analysis [x] completed
if [ -f "$STATE" ]; then
  if grep -qi '\[x\] requirements-analysis' "$STATE" 2>/dev/null; then
    ok "state marks requirements-analysis [x] completed"
  else
    not_ok "state marks requirements-analysis [x] completed" "stage not marked complete"
  fi
else
  not_ok "state marks requirements-analysis [x] completed" "aidlc-state.md not found"
fi

# Test 10: State current stage advanced past requirements-analysis.
# Fixture sets Current Stage == target (redo jump), so aidlc-jump doesn't
# terminate. After the stage's own gate runs approve, approve auto-advances
# to the next in-scope stage.
if [ -f "$STATE" ]; then
  CURRENT=$(grep -i "Current Stage" "$STATE" | head -1 || true)
  if echo "$CURRENT" | grep -qvi "requirements-analysis"; then
    ok "current stage advanced past requirements-analysis"
  else
    not_ok "current stage advanced past requirements-analysis" "Current Stage: $CURRENT"
  fi
else
  not_ok "current stage advanced past requirements-analysis" "aidlc-state.md not found"
fi

# Test 11: Completed count includes 3 init stages + RE + requirements = 5
if [ -f "$STATE" ]; then
  COMPLETED=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$COMPLETED" 4 "completed count > 4 (init + RE + requirements)"
else
  not_ok "completed count > 4 (init + RE + requirements)" "aidlc-state.md not found"
fi

# Test 12: RE artifacts are still intact (not overwritten)
if [ -d "$PROJ/aidlc-docs/inception/reverse-engineering" ]; then
  RE_COUNT=$(find "$PROJ/aidlc-docs/inception/reverse-engineering" -name "*.md" -type f | wc -l)
  assert_gt "$RE_COUNT" 3 "RE artifacts still intact (>= 4 files)"
else
  not_ok "RE artifacts still intact (>= 4 files)" "RE directory not found"
fi

cleanup_test_project "$PROJ"

finish
