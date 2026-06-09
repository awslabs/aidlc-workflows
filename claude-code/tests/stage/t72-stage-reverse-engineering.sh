#!/bin/bash
# t72: Stage test — reverse engineering on brownfield stub (15 assertions, 25 turns)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=900

plan 15

# Setup: scaffold project with brownfield stub and state at init-done (RE next)
PROJ=$(setup_integration_project \
  --with-state "$FIXTURES_DIR/state-brownfield-init-done.md" \
  --with-brownfield-stub \
  --with-audit)

# Run the reverse-engineering stage
run_claude "$PROJ" "/aidlc --stage reverse-engineering --test-run"

STATE="$PROJ/aidlc-docs/aidlc-state.md"
RE_DIR="$PROJ/aidlc-docs/inception/reverse-engineering"

# Test 1: RE directory created
assert_dir_exists "$RE_DIR" "reverse-engineering directory created"

# Test 2: RE directory has at least 4 .md files
if [ -d "$RE_DIR" ]; then
  RE_COUNT=$(find "$RE_DIR" -name "*.md" -type f | wc -l)
  assert_gt "$RE_COUNT" 3 "RE directory has >= 4 .md artifacts"
else
  not_ok "RE directory has >= 4 .md artifacts" "RE directory not found"
fi

# Test 3: RE artifact mentions React
if [ -d "$RE_DIR" ]; then
  RE_REACT=$(grep -rl "[Rr]eact" "$RE_DIR" 2>/dev/null | wc -l)
  assert_gt "$RE_REACT" 0 "RE artifact mentions React"
else
  not_ok "RE artifact mentions React" "RE directory not found"
fi

# Test 4: RE artifact mentions TypeScript
if [ -d "$RE_DIR" ]; then
  RE_TS=$(grep -rl "[Tt]ype[Ss]cript" "$RE_DIR" 2>/dev/null | wc -l)
  assert_gt "$RE_TS" 0 "RE artifact mentions TypeScript"
else
  not_ok "RE artifact mentions TypeScript" "RE directory not found"
fi

# Test 5: RE artifact mentions Todo domain entity
if [ -d "$RE_DIR" ]; then
  RE_TODO=$(grep -rl "[Tt]odo" "$RE_DIR" 2>/dev/null | wc -l)
  assert_gt "$RE_TODO" 0 "RE artifact mentions Todo domain"
else
  not_ok "RE artifact mentions Todo domain" "RE directory not found"
fi

# Test 6: At least one RE artifact > 200 bytes
if [ -d "$RE_DIR" ]; then
  RE_BIG=$(find "$RE_DIR" -name "*.md" -type f -size +200c | wc -l)
  assert_gt "$RE_BIG" 0 "at least one RE artifact > 200 bytes"
else
  not_ok "at least one RE artifact > 200 bytes" "RE directory not found"
fi

# Test 7: RE artifacts have markdown headings
if [ -d "$RE_DIR" ]; then
  RE_HEADINGS=$(grep -rl "^#" "$RE_DIR" 2>/dev/null | wc -l)
  assert_gt "$RE_HEADINGS" 0 "RE artifacts have markdown headings"
else
  not_ok "RE artifacts have markdown headings" "RE directory not found"
fi

# Test 8: State marks reverse-engineering [x] completed
if [ -f "$STATE" ]; then
  if grep -qi '\[x\] reverse-engineering' "$STATE" 2>/dev/null; then
    ok "state marks reverse-engineering [x] completed"
  else
    not_ok "state marks reverse-engineering [x] completed" "stage not marked complete"
  fi
else
  not_ok "state marks reverse-engineering [x] completed" "aidlc-state.md not found"
fi

# Test 9: State current stage advanced past RE.
# Fixture sets Current Stage == target (redo jump, not forward), so
# aidlc-jump doesn't terminate the workflow. After the stage's own gate
# runs approve, approve auto-advances to the next in-scope stage —
# Current Stage moves to requirements-analysis.
if [ -f "$STATE" ]; then
  CURRENT=$(grep -i "Current Stage" "$STATE" | head -1 || true)
  if echo "$CURRENT" | grep -qvi "reverse-engineering"; then
    ok "current stage advanced past reverse-engineering"
  else
    not_ok "current stage advanced past reverse-engineering" "Current Stage: $CURRENT"
  fi
else
  not_ok "current stage advanced past reverse-engineering" "aidlc-state.md not found"
fi

# Test 10: RE artifact mentions component or module structure
if [ -d "$RE_DIR" ]; then
  RE_COMPONENT=$(grep -rl "[Cc]omponent\|[Mm]odule\|[Hh]ook" "$RE_DIR" 2>/dev/null | wc -l)
  assert_gt "$RE_COMPONENT" 0 "RE artifact mentions component/module structure"
else
  not_ok "RE artifact mentions component/module structure" "RE directory not found"
fi

# Test 11: RE artifact mentions Vite build system
if [ -d "$RE_DIR" ]; then
  if grep -rl "[Vv]ite" "$RE_DIR" 2>/dev/null | head -1 | grep -q .; then
    ok "RE artifact mentions Vite"
  else
    skip "RE artifact does not mention Vite (build tool detection may vary)"
  fi
else
  not_ok "RE artifact mentions Vite" "RE directory not found"
fi

# Test 12: Audit has stage completion event
if [ -f "$PROJ/aidlc-docs/audit.md" ]; then
  if grep -qi "reverse.engineering\|STAGE_COMPLETED\|stage.*complet" "$PROJ/aidlc-docs/audit.md" 2>/dev/null; then
    ok "audit has reverse-engineering completion event"
  else
    skip "audit completion event format may vary"
  fi
else
  not_ok "audit has reverse-engineering completion event" "audit.md not found"
fi

# Test 13: Completed count includes 3 init stages + RE = 4
if [ -f "$STATE" ]; then
  COMPLETED=$(grep -c '^\- \[x\]' "$STATE" || true)
  assert_gt "$COMPLETED" 3 "completed count > 3 (init + RE)"
else
  not_ok "completed count > 3 (init + RE)" "aidlc-state.md not found"
fi

# Test 14: RE directory has architecture or code-structure artifact
if [ -d "$RE_DIR" ]; then
  if find "$RE_DIR" -name "*architect*" -o -name "*code-structure*" -o -name "*technology*" 2>/dev/null | head -1 | grep -q .; then
    ok "RE directory has architecture/structure artifact"
  else
    skip "RE artifact naming may vary from expected patterns"
  fi
else
  not_ok "RE directory has architecture/structure artifact" "RE directory not found"
fi

# Test 15: Lifecycle phase is still INCEPTION
if [ -f "$STATE" ]; then
  assert_grep "$STATE" "INCEPTION" "lifecycle phase is INCEPTION"
else
  not_ok "lifecycle phase is INCEPTION" "aidlc-state.md not found"
fi

cleanup_test_project "$PROJ"

finish
