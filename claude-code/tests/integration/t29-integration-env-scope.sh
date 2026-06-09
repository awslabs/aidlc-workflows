#!/bin/bash
# t29: Integration test — AWS_AIDLC_DEFAULT_SCOPE env var via claude CLI
#
# Verifies the project-default scope mechanism:
#   - env var supplies the default scope when no --scope flag and no state file
#   - explicit --scope flag overrides env
#   - invalid env value errors without writing state
#   - existing state file ignores env (state is authoritative)
#
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

AIDLC_TEST_TIMEOUT=600

plan 5

# Start from a clean env so dev-shell or CI leakage can't shadow our cases.
reset_aidlc_env

# --- Case A: env supplies default scope on fresh project ---
PROJ_A=$(setup_integration_project --no-aidlc-docs)
export AWS_AIDLC_DEFAULT_SCOPE=workshop
run_claude "$PROJ_A" "/aidlc --test-run"
reset_aidlc_env

STATE_A="$PROJ_A/aidlc-docs/aidlc-state.md"

assert_grep "$STATE_A" '^- \*\*Scope\*\*: workshop' "env scope seeds state file Scope field"

cleanup_test_project "$PROJ_A"

# --- Case B: explicit --scope flag overrides env ---
PROJ_B=$(setup_integration_project --no-aidlc-docs)
export AWS_AIDLC_DEFAULT_SCOPE=workshop
run_claude "$PROJ_B" "/aidlc feature --test-run"
reset_aidlc_env

STATE_B="$PROJ_B/aidlc-docs/aidlc-state.md"

assert_grep "$STATE_B" '^- \*\*Scope\*\*: feature' "explicit scope wins over env"

cleanup_test_project "$PROJ_B"

# --- Case C: invalid env value errors, no state file written ---
# Strip AWS_AIDLC_DEFAULT_SCOPE from settings.json so the shell export of
# "bogus" is authoritative. The shipped .claude/settings.json has a
# `workshop` default that otherwise overrides the shell env.
PROJ_C=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
export AWS_AIDLC_DEFAULT_SCOPE=bogus
run_claude "$PROJ_C" "/aidlc --test-run"
reset_aidlc_env

assert_contains "$CLAUDE_OUTPUT" "Invalid AWS_AIDLC_DEFAULT_SCOPE" "invalid env value produces error"
if [ -f "$PROJ_C/aidlc-docs/aidlc-state.md" ]; then
  not_ok "invalid env scope did not write state file"
else
  ok "invalid env scope did not write state file"
fi

cleanup_test_project "$PROJ_C"

# --- Case D: existing state file ignores env (state is authoritative) ---
PROJ_D=$(setup_integration_project --with-state "$FIXTURES_DIR/state-mid-ideation.md" --with-audit)
export AWS_AIDLC_DEFAULT_SCOPE=workshop
# state-mid-ideation fixture uses scope=feature. Running /aidlc --status
# should NOT trigger scope-change or any mutation.
STATE_D="$PROJ_D/aidlc-docs/aidlc-state.md"
MD5_BEFORE=$(md5sum "$STATE_D" | awk '{print $1}')
run_claude "$PROJ_D" "/aidlc --status --test-run"
MD5_AFTER=$(md5sum "$STATE_D" | awk '{print $1}')
reset_aidlc_env

assert_eq "$MD5_BEFORE" "$MD5_AFTER" "env scope does not mutate existing state file"

cleanup_test_project "$PROJ_D"

finish
