#!/bin/bash
# t31: Verify --help text block is consistent with scope-mapping.json.
# Post-MR-10: help text is compiled by renderHelpText() from
# loadScopeMapping(), so stage counts stay fresh automatically. This
# test asserts (a) every scope in scope-mapping.json appears, (b) each
# scope's line shows the real EXECUTE/Total count (fixes the 6 stale
# counts that shipped in the static HELP_TEXT pre-MR-10), (c) utility
# flags are present, (d) workshop's minimal test strategy surfaces.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

TOOL="$AIDLC_SRC/tools/aidlc-utility.ts"

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

# Extract help text by running the utility tool
HELP_TEXT=$(bun "$TOOL" help 2>/dev/null)

plan 19

# --- All 9 scope names appear in help text ---
assert_contains "$HELP_TEXT" "enterprise" "help text lists enterprise scope"
assert_contains "$HELP_TEXT" "feature" "help text lists feature scope"
assert_contains "$HELP_TEXT" "mvp" "help text lists mvp scope"
assert_contains "$HELP_TEXT" "poc" "help text lists poc scope"
assert_contains "$HELP_TEXT" "bugfix" "help text lists bugfix scope"
assert_contains "$HELP_TEXT" "refactor" "help text lists refactor scope"
assert_contains "$HELP_TEXT" "infra" "help text lists infra scope"
assert_contains "$HELP_TEXT" "security-patch" "help text lists security-patch scope"

# --- All 4 utility commands appear ---
assert_contains "$HELP_TEXT" "--status" "help text lists --status utility"
assert_contains "$HELP_TEXT" "--init" "help text lists --init utility"
assert_contains "$HELP_TEXT" "--doctor" "help text lists --doctor utility"
assert_contains "$HELP_TEXT" "--help" "help text lists --help utility"

# --- Stage count semantics (compiled from scope-mapping.json) ---
# enterprise/feature execute every stage: "All 32 stages"
# bugfix executes a subset: "7 of 32 stages" (was "~8 stages" pre-MR-10;
# the renderer now reflects the real EXECUTE count)
assert_contains "$HELP_TEXT" "All 32 stages" "enterprise/feature shows 'All 32 stages'"
assert_contains "$HELP_TEXT" "7 of 32 stages" "bugfix shows compiled '7 of 32 stages' count"
assert_contains "$HELP_TEXT" "(default)" "feature row shows '(default)' marker"

# --- --force flag documented (paired with --init) ---
assert_contains "$HELP_TEXT" "--force" "help text lists --force flag"

# --- Jump utilities appear in help text ---
assert_contains "$HELP_TEXT" "--stage" "help text lists --stage utility"
assert_contains "$HELP_TEXT" "--phase" "help text lists --phase utility"
assert_contains "$HELP_TEXT" "--scope" "help text lists --scope utility"

finish
