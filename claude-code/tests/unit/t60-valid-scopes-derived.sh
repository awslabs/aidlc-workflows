#!/bin/bash
# t60: validScopes() derives from .claude/scopes/*.md presence (9 tests)
#
# Dropping a .claude/scopes/aidlc-<name>.md file makes <name> a valid scope
# that flows through every tool that validates scopes (init, scope-change,
# resolve-env-scope, doctor) with no code change. MR 12 moved scope
# authoring off scope-mapping.json onto per-scope .md files (frontmatter
# name/depth/keywords/description) + the per-stage scopes: transpose.
#
# Six structural assertions + three keyword/inference extensions:
#   1. Static grep — VALID_SCOPES symbol is gone from tools/
#   2. Runtime — validScopes() returns the 9 shipped scopes, alphabetical
#   3. Fixture accept — init --scope fixture-scope succeeds (dropped .md)
#   4. Fixture reject — init --scope bogus errors with fixture-scope in message
#   5. Fixture scope-change — scope-change to fixture-scope succeeds (state tool)
#   6. Fixture doctor — invalid env var fix hint lists fixture-scope
#   7. fixture-scope with keywords → detect-scope --from-text matches it
#   8. scope-table includes fixture-scope row when its .md is present
#   9. detect-scope emits SCOPE_DETECTED with Source=keyword for fixture-scope
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 9

# --- Test 1: static grep — VALID_SCOPES gone from tools/ ---
HITS=$(grep -rE 'VALID_SCOPES' "$AIDLC_SRC/tools/" 2>/dev/null || true)
if [ -z "$HITS" ]; then
  ok "no VALID_SCOPES references in tools/"
else
  not_ok "no VALID_SCOPES references in tools/" "found: $HITS"
fi

# --- Test 2: runtime — validScopes() default returns 9 alphabetical scopes ---
LIB="$AIDLC_SRC/tools/aidlc-lib.ts"
EXPECTED="bugfix,enterprise,feature,infra,mvp,poc,refactor,security-patch,workshop"
ACTUAL=$(bun -e "import { validScopes } from '$LIB'; console.log([...validScopes()].join(','));" 2>&1 | tail -1)
assert_eq "$ACTUAL" "$EXPECTED" "validScopes() returns 9 alphabetically-sorted scopes"

# --- Shared fixture setup for tests 3-6 ---
# Start from an integration sandbox (copies .claude/ including
# .claude/scopes/ and the compiled scope-grid.json). Author a NEW scope the
# same way a harness engineer would: drop one .claude/scopes/aidlc-<name>.md
# file. No JSON edit, no code change. The scope's EXECUTE/SKIP grid column is
# empty (no stage frontmatter names it) — init tolerates that (it stamps the
# scope name + the always-EXECUTE init stages), which is all tests 3-6 assert.
setup_fixture_scope() {
  local proj="$1"
  local kw="${2:-}"
  local scopes_dir="$proj/.claude/scopes"
  mkdir -p "$scopes_dir"
  local kw_block=""
  if [ -n "$kw" ]; then
    kw_block="keywords:
  - $kw"
  else
    kw_block="keywords: []"
  fi
  cat > "$scopes_dir/aidlc-fixture-scope.md" <<EOF
---
name: fixture-scope
depth: Minimal
$kw_block
description: Fixture scope for t60 derivation tests
---

# fixture-scope

Test-only scope dropped to prove validScopes() derives from
.claude/scopes/*.md presence with no code change.
EOF
}

# --- Test 3: fixture accept — init --scope fixture-scope succeeds ---
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
setup_fixture_scope "$PROJ"
set +e
OUT=$(bun "$PROJ/.claude/tools/aidlc-utility.ts" init --scope fixture-scope --project-dir "$PROJ" 2>&1)
RC=$?
set -e
if [ $RC -eq 0 ] && grep -qE '^- \*\*Scope\*\*: fixture-scope$' "$PROJ/aidlc-docs/aidlc-state.md"; then
  ok "init --scope fixture-scope succeeds against dropped .claude/scopes/ file"
else
  not_ok "init --scope fixture-scope succeeds against dropped .claude/scopes/ file" "rc=$RC, out=$OUT"
fi
cleanup_test_project "$PROJ"

# --- Test 4: fixture reject — init --scope bogus includes fixture-scope in error ---
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
setup_fixture_scope "$PROJ"
set +e
OUT=$(bun "$PROJ/.claude/tools/aidlc-utility.ts" init --scope bogus-notascope --project-dir "$PROJ" 2>&1)
set -e
assert_contains "$OUT" "fixture-scope" "init --scope bogus error message lists fixture-scope (derivation flowing through)"
cleanup_test_project "$PROJ"

# --- Test 5: fixture scope-change — scope-change to fixture-scope succeeds ---
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope --with-state "$REPO_ROOT/tests/fixtures/state-mid-ideation.md" --with-audit)
setup_fixture_scope "$PROJ"
set +e
bun "$PROJ/.claude/tools/aidlc-utility.ts" scope-change --scope fixture-scope --project-dir "$PROJ" >/dev/null 2>&1
set -e
if grep -qE '^- \*\*Scope\*\*: fixture-scope$' "$PROJ/aidlc-docs/aidlc-state.md"; then
  ok "scope-change --scope fixture-scope succeeds (covers aidlc-state.ts surface)"
else
  not_ok "scope-change --scope fixture-scope succeeds (covers aidlc-state.ts surface)"
fi
cleanup_test_project "$PROJ"

# --- Test 6: fixture doctor — invalid env var fix hint derives from mapping ---
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
setup_fixture_scope "$PROJ"
set +e
OUT=$(AWS_AIDLC_DEFAULT_SCOPE=still-bogus bun "$PROJ/.claude/tools/aidlc-utility.ts" doctor --project-dir "$PROJ" 2>&1)
set -e
assert_contains "$OUT" "fixture-scope" "doctor fix hint for invalid AWS_AIDLC_DEFAULT_SCOPE lists fixture-scope"
cleanup_test_project "$PROJ"

# --- Tests 7-9: fixture-scope with keywords end-to-end ---
# Drop a fixture scope file WITH its own NL trigger keyword, then verify the
# keyword surfaces (detect-scope --from-text, scope-table) pick it up with no
# SKILL.md edit and no JSON — purely from the .claude/scopes/*.md frontmatter.
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
setup_fixture_scope "$PROJ" "fixturetrigger"

# Test 7: inferScopeFromText picks up fixture-scope when its keyword fires.
# The keyword is read from the dropped .claude/scopes/aidlc-fixture-scope.md
# frontmatter via loadScopeMapping()'s metadata source — no env var.
ACTUAL=$(MR12_INPUT="fixturetrigger test" bun -e "
    import { inferScopeFromText } from '$PROJ/.claude/tools/aidlc-utility.ts';
    console.log(inferScopeFromText(process.env.MR12_INPUT).scope);
  " 2>&1 | tail -1)
assert_eq "$ACTUAL" "fixture-scope" "inferScopeFromText picks fixture-scope from its .md keyword"

# Test 8: scope-table includes fixture-scope row from the dropped .md file.
OUT=$(bun "$PROJ/.claude/tools/aidlc-utility.ts" scope-table 2>&1)
assert_contains "$OUT" "| fixture-scope" "scope-table includes fixture-scope row from dropped .claude/scopes/ file"

# Test 9: detect-scope --from-text emits SCOPE_DETECTED with Source=keyword.
bun "$PROJ/.claude/tools/aidlc-utility.ts" detect-scope --from-text \
  --input "fixturetrigger" --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "Detected scope.*: fixture-scope" "$PROJ/aidlc-docs/audit.md" && \
   grep -q "Source.*: keyword" "$PROJ/aidlc-docs/audit.md"; then
  ok "detect-scope --from-text emits SCOPE_DETECTED for fixture-scope (Source=keyword)"
else
  not_ok "detect-scope --from-text emits SCOPE_DETECTED for fixture-scope (Source=keyword)" \
    "audit: $(tail -20 "$PROJ/aidlc-docs/audit.md")"
fi
cleanup_test_project "$PROJ"

finish
