#!/bin/bash
# t36: Unit tests for /aidlc --scope <x> on an active workflow.
#
# The initial Phase 6 plan said this should error with guidance telling the
# user to restart. Live user feedback (captured in MEMORY.md:
# feedback_scope_change_midworkflow.md) said mid-workflow scope change should
# be supported. Implementation honors the feedback:
#
#   - `aidlc-utility scope-change --scope <x>` atomically mutates the Scope
#     field and emits SCOPE_CHANGED.
#   - Invalid target scope rejected before any state mutation.
#   - Audit-first: SCOPE_CHANGED lands in audit.md even if state write fails
#     (diagnosable via --doctor drift check).
#
# These tests exercise the scope-change handler directly with no claude-CLI
# orchestration — pure L1 tier.
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

plan 7

# --- Test 1: scope-change on active workflow mutates Scope field ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$UTIL" scope-change --scope mvp --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\*\*Scope\*\*: mvp' "scope-change updates Scope field"
cleanup_test_project "$PROJ"

# --- Test 2: SCOPE_CHANGED audit event is emitted ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$UTIL" scope-change --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '^\*\*Event\*\*: SCOPE_CHANGED' "scope-change emits SCOPE_CHANGED"
cleanup_test_project "$PROJ"

# --- Test 3: Each of the 9 canonical scopes is accepted as a target ---
for target in enterprise feature mvp poc bugfix refactor infra security-patch workshop; do
  PROJ=$(create_test_project)
  seed_audit_file "$PROJ"
  seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
  bun "$UTIL" scope-change --scope "$target" --project-dir "$PROJ" >/dev/null 2>&1 || true
  if grep -qE "^- \*\*Scope\*\*: $target\$" "$PROJ/aidlc-docs/aidlc-state.md"; then
    : # skipped — batch check happens after loop
  else
    echo "# failed: scope=$target not applied"
    exit 1
  fi
  cleanup_test_project "$PROJ"
done
ok "all 9 scopes accepted as targets"

# --- Test 4: Invalid target scope rejected ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
set +e
out=$(bun "$UTIL" scope-change --scope totally-bogus --project-dir "$PROJ" 2>&1)
rc=$?
set -e
assert_eq 1 "$rc" "invalid scope rejected"
cleanup_test_project "$PROJ"

# --- Test 5: Missing --scope flag rejected ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
set +e
bun "$UTIL" scope-change --project-dir "$PROJ" >/dev/null 2>&1
rc=$?
set -e
assert_eq 1 "$rc" "missing --scope flag rejected"
cleanup_test_project "$PROJ"

# --- Test 6: scope-change preserves Current Stage (doesn't kick user back) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
before=$(grep "^- \*\*Current Stage\*\*:" "$PROJ/aidlc-docs/aidlc-state.md")
bun "$UTIL" scope-change --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1 || true
after=$(grep "^- \*\*Current Stage\*\*:" "$PROJ/aidlc-docs/aidlc-state.md")
if [ "$before" = "$after" ]; then
  ok "Current Stage preserved across scope-change"
else
  not_ok "Current Stage preserved across scope-change" "before='$before' after='$after'"
fi
cleanup_test_project "$PROJ"

# --- Test 7: From-scope recorded in SCOPE_CHANGED event ---
# The audit entry should record BOTH the original scope (From) and the new one (To),
# so log analysis can answer "what was the scope yesterday?" without reconstructing
# chronological state.
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$UTIL" scope-change --scope mvp --project-dir "$PROJ" >/dev/null 2>&1 || true
# state-mid-ideation.md has Scope: feature
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Old Scope\*\*: feature' "SCOPE_CHANGED records Old Scope=feature"
cleanup_test_project "$PROJ"

finish
