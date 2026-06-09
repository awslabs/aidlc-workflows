#!/bin/bash
# t38: /aidlc --status output reflects gate state so the user knows when
# they are the blocker.
#
# Covers three outputs expected from the Phase 6 plan:
#   - Stage in [?] (awaiting-approval): "Awaiting your approval on <stage>"
#   - Stage in [R] (revising): "Revising <stage> (revision N of 3)"
#   - Stage in [-] (normal): neither phrase — shows "in-progress" / running
#
# Uses `--status` directly, no claude CLI. State file is mutated per test to
# set the checkbox and Revision Count to the required values.
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

plan 5

# --- Test 1: [?] state → "Awaiting your approval" phrase ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# state-mid-ideation has feasibility as [-]; flip it to [?]
sed_i 's/^- \[-\] feasibility/- [?] feasibility/' "$PROJ/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" status --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qi "awaiting your approval"; then
  ok "[?] state triggers 'Awaiting your approval' in --status"
else
  not_ok "[?] state triggers 'Awaiting your approval' in --status" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 2: [R] state → "Revising" phrase with revision count ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
sed_i 's/^- \[-\] feasibility/- [R] feasibility/' "$PROJ/aidlc-docs/aidlc-state.md"
sed_i 's/^- \*\*Revision Count\*\*: .*/- **Revision Count**: 2/' "$PROJ/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" status --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qi "revising"; then
  ok "[R] state triggers 'Revising' phrase in --status"
else
  not_ok "[R] state triggers 'Revising' phrase in --status" "got:\n$out"
fi
if echo "$out" | grep -qE "revision.*2.*of.*3"; then
  ok "[R] revision count 2 of 3 shown"
else
  not_ok "[R] revision count 2 of 3 shown" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 3: [-] normal state → no [?] / [R] phrases ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
out=$(bun "$UTIL" status --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qi "awaiting your approval\|revising"; then
  not_ok "[-] normal state doesn't leak gate phrases" "got:\n$out"
else
  ok "[-] normal state doesn't leak gate phrases"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Missing Revision Count falls back gracefully ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
sed_i 's/^- \[-\] feasibility/- [R] feasibility/' "$PROJ/aidlc-docs/aidlc-state.md"
sed_i '/^- \*\*Revision Count\*\*:/d' "$PROJ/aidlc-docs/aidlc-state.md"
set +e
out=$(bun "$UTIL" status --project-dir "$PROJ" 2>&1)
rc=$?
set -e
# Must not crash — the fallback should still produce sensible output.
assert_eq 0 "$rc" "--status handles missing Revision Count gracefully"
cleanup_test_project "$PROJ"

finish
