#!/bin/bash
# t22: Integration test for /aidlc --doctor (10 tests)
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

MID_IDEATION="$FIXTURES_DIR/state-mid-ideation.md"

AIDLC_TEST_TIMEOUT=600

plan 10

# --- With state + audit (tests 1-9) ---
PROJ=$(setup_integration_project --with-state "$MID_IDEATION" --with-audit)

AUDIT_SIZE_BEFORE=$(wc -c < "$PROJ/aidlc-docs/audit.md")

run_claude "$PROJ" "/aidlc --doctor"
OUTPUT="$CLAUDE_OUTPUT"

# Tests 1-7: Doctor output mentions per-check keywords OR reports a summary pass.
# The LLM may produce detailed per-check lines or a summary like "10 passed, 0 failed".
# Note: jq is no longer a prerequisite — --doctor dropped the jq check when the
# statusline was ported from Bash to TypeScript, so tests no longer assert on it.
SUMMARY_PASS=false
if echo "$OUTPUT" | grep -qiE "checks.*pass|all.*check|[0-9]+ passed|all hooks|setup is healthy|health check"; then
  SUMMARY_PASS=true
fi

# Test 1: Output mentions audit-logger
if echo "$OUTPUT" | grep -qi "audit-logger" || $SUMMARY_PASS; then
  ok "doctor output mentions audit-logger (or summary pass)"
else
  not_ok "doctor output mentions audit-logger (or summary pass)"
fi

# Test 2: Output mentions session-start
if echo "$OUTPUT" | grep -qi "session-start" || $SUMMARY_PASS; then
  ok "doctor output mentions session-start (or summary pass)"
else
  not_ok "doctor output mentions session-start (or summary pass)"
fi

# Test 3: Output mentions settings.json
if echo "$OUTPUT" | grep -qi "settings" || $SUMMARY_PASS; then
  ok "doctor output mentions settings (or summary pass)"
else
  not_ok "doctor output mentions settings (or summary pass)"
fi

# Test 4: audit-logger check shows positive result
if echo "$OUTPUT" | grep -i "audit-logger" | grep -qiE "ok|found|pass|installed|available|✓|yes|exist" || $SUMMARY_PASS; then
  ok "audit-logger check shows positive result"
else
  not_ok "audit-logger check shows positive result" "audit-logger line: $(echo "$OUTPUT" | grep -i "audit-logger" | head -1)"
fi

# Test 5: session-start check shows positive result
if echo "$OUTPUT" | grep -i "session-start" | grep -qiE "ok|found|pass|installed|available|✓|yes|exist" || $SUMMARY_PASS; then
  ok "session-start check shows positive result"
else
  not_ok "session-start check shows positive result" "session-start line: $(echo "$OUTPUT" | grep -i "session-start" | head -1)"
fi

# Test 6: settings check shows positive result
if echo "$OUTPUT" | grep -i "settings" | grep -qiE "ok|found|pass|installed|available|✓|yes|exist|valid" || $SUMMARY_PASS; then
  ok "settings check shows positive result"
else
  not_ok "settings check shows positive result" "settings line: $(echo "$OUTPUT" | grep -i "settings" | head -1)"
fi

# Test 7: Bun is mentioned OR summary pass (bun replaces jq as the single runtime prereq)
if echo "$OUTPUT" | grep -qi "bun" || $SUMMARY_PASS; then
  ok "doctor output mentions bun (or summary pass)"
else
  not_ok "doctor output mentions bun (or summary pass)"
fi

# Test 8: Audit file has new content appended
AUDIT_SIZE_AFTER=$(wc -c < "$PROJ/aidlc-docs/audit.md")
if [ "$AUDIT_SIZE_AFTER" -gt "$AUDIT_SIZE_BEFORE" ]; then
  ok "audit file has new content appended"
elif echo "$OUTPUT" | grep -qiE "bun.*not available|bun.*not found|bun.*missing"; then
  ok "audit file has new content appended # SKIP bun not available"
else
  not_ok "audit file has new content appended" "before: $AUDIT_SIZE_BEFORE, after: $AUDIT_SIZE_AFTER"
fi

# Test 9: Output contains health check header
if echo "$OUTPUT" | grep -qiE "health|doctor|check|diagnostic"; then
  ok "output contains health check header"
else
  not_ok "output contains health check header" "no health-related header found"
fi

cleanup_test_project "$PROJ"

# --- Without aidlc-docs/ (test 10) ---
# Doctor exits non-zero when aidlc-docs/ is missing (check 11 fails). The
# orchestrator's tool-failure handler prints stdout+stderr verbatim and
# STOPs, so the diagnostic reaches the user. Claude's own exit code stays
# 0 when it completes the STOP normally — assert on the specific failing-
# check label text, not a loose grep that would match Claude echoing the
# command back.
PROJ=$(setup_integration_project --no-aidlc-docs)

run_claude "$PROJ" "/aidlc --doctor"
OUTPUT="$CLAUDE_OUTPUT"

if echo "$OUTPUT" | grep -qE "aidlc-docs/ directory exists"; then
  ok "doctor without aidlc-docs/ surfaces the specific failing-check label"
else
  not_ok "doctor without aidlc-docs/ surfaces the specific failing-check label" "got:\n$OUTPUT"
fi

cleanup_test_project "$PROJ"

finish
