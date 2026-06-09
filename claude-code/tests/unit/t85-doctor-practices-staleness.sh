#!/bin/bash
# t85: Unit tests for v0.4.0 MR 15 practices-staleness check (6 tests).
#
# Covers Check 5 of MR 15's doctor extensions (MR 6 forward-note). Reads
# `Practices Affirmed Timestamp` from main state. Compares to now.
#
# Tests:
#   1. Empty placeholder (`[ISO 8601 timestamp on affirmation]`) — info pass
#   2. Affirmed within PRACTICES_STALENESS_DAYS (90) — ✓ pass with day count
#   3. Affirmed beyond 90 days — advisory ⚠ (pass=true with "advisory" label)
#   4. Invalid ISO string — ✗ readable
#   5. Missing field entirely — info pass (informational)
#   6. Future-dated timestamp (clock skew or hand-edit) — advisory pass=true
#       with explanatory label (regression for the MINOR fix; pre-fix produced
#       a nonsense `affirmed -26525 days ago` label)
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 6

# --- Test 1: Empty placeholder (template default) — informational pass ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# state-mid-ideation.md ships with the v7 template default value.
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Practices staleness: never affirmed (informational)"; then
  ok "Empty/template-default Practices Affirmed Timestamp → never affirmed"
else
  not_ok "Empty/template-default Practices Affirmed Timestamp → never affirmed" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 2: Affirmed within 90 days — ✓ ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# Set timestamp to 30 days ago (well within window).
RECENT_TS=$(date -u -v-30d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "30 days ago" +"%Y-%m-%dT%H:%M:%SZ")
sed_i "s|^- \\*\\*Practices Affirmed Timestamp\\*\\*:.*$|- **Practices Affirmed Timestamp**: $RECENT_TS|" "$PROJ/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Practices staleness: affirmed [0-9]+ days? ago$" && ! echo "$out" | grep -q "advisory"; then
  ok "Affirmed within 90 days reports day count without advisory"
else
  not_ok "Affirmed within 90 days reports day count without advisory" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 3: Affirmed beyond 90 days — advisory pass=true ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
OLD_TS=$(date -u -v-180d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "180 days ago" +"%Y-%m-%dT%H:%M:%SZ")
sed_i "s|^- \\*\\*Practices Affirmed Timestamp\\*\\*:.*$|- **Practices Affirmed Timestamp**: $OLD_TS|" "$PROJ/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
# Must be pass=true (no ✗ on the practices-staleness line) but include
# the "advisory" word and the threshold value.
if echo "$out" | grep -qE "✓.*Practices staleness: affirmed [0-9]+ days ago \(advisory" && echo "$out" | grep -q "> 90 days"; then
  ok "Affirmed > 90 days is advisory pass=true with explanatory label"
else
  not_ok "Affirmed > 90 days is advisory pass=true with explanatory label" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Invalid ISO string — ✗ readable ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
sed_i 's|^- \*\*Practices Affirmed Timestamp\*\*:.*$|- **Practices Affirmed Timestamp**: not-a-real-iso-string|' "$PROJ/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Practices staleness: timestamp unreadable" && echo "$out" | grep -q "not-a-real-iso-string"; then
  ok "Invalid ISO 8601 timestamp is flagged readable"
else
  not_ok "Invalid ISO 8601 timestamp is flagged readable" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 5: Missing field entirely — informational pass ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# Remove the entire field bullet line — getField returns null → check skips.
sed_i '/^- \*\*Practices Affirmed Timestamp\*\*:/d' "$PROJ/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Practices staleness: never affirmed (informational)"; then
  ok "Missing Practices Affirmed Timestamp field treated as never-affirmed (informational)"
else
  not_ok "Missing Practices Affirmed Timestamp field treated as never-affirmed (informational)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 6: Future-dated timestamp — advisory pass with explanatory label ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
sed_i 's|^- \*\*Practices Affirmed Timestamp\*\*:.*$|- **Practices Affirmed Timestamp**: 2099-01-01T00:00:00Z|' "$PROJ/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "✓.*Practices staleness: affirmed in the future" && echo "$out" | grep -q "clock skew"; then
  ok "Future-dated timestamp is advisory pass with clock-skew label"
else
  not_ok "Future-dated timestamp is advisory pass with clock-skew label" "got:\n$out"
fi
cleanup_test_project "$PROJ"

finish
