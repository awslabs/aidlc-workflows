#!/bin/bash
# t67: aidlc-utility scope-table + detect-scope --from-text (28 tests)
#
# MR 10 (#62). Covers the MR 10 tool surface:
#   - scope-table emission (alphabetical, deterministic, shape)
#   - scope-table --check drift guard (clean / drifted / missing markers)
#   - inferScopeFromText keyword matching with word-boundary safety
#     (so "debug" doesn't match "bug", "fixture" doesn't match "fix")
#   - inferScopeFromText >5-word fallback and empty-input fallback
#   - detect-scope --from-text audit event emission
#   - detect-scope --scope backward compatibility (pre-MR-10 callers)
#   - flag collision (--scope + --from-text) returns an error
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"
SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"

# Helper: infer scope from text via bun -e import; compare against expected.
# bun -e does not forward extra argv after `--`, so pass the input via env var.
assert_infer() {
  local input="$1"
  local expected="$2"
  local msg="${3:-inferScopeFromText(\"$input\") → $expected}"
  local actual
  actual=$(MR10_INFER_INPUT="$input" bun -e "
    import { inferScopeFromText } from '$UTIL';
    console.log(inferScopeFromText(process.env.MR10_INFER_INPUT ?? '').scope);
  " 2>&1 | tail -1)
  assert_eq "$actual" "$expected" "$msg"
}

plan 28

# ----- Section 1: scope-table emission shape (5 assertions) -----
OUT=$(bun "$UTIL" scope-table 2>&1)
assert_contains "$OUT" "BEGIN: compiled" "scope-table output has BEGIN marker"
assert_contains "$OUT" "END: compiled" "scope-table output has END marker"
assert_contains "$OUT" "| Scope" "scope-table output has table header"
assert_contains "$OUT" "| bugfix" "scope-table output includes bugfix row"
assert_contains "$OUT" "| workshop" "scope-table output includes workshop row"

# ----- Section 2: deterministic + alphabetical ordering (2 assertions) -----
OUT2=$(bun "$UTIL" scope-table 2>&1)
assert_eq "$OUT" "$OUT2" "scope-table output is deterministic across calls"

# Row order alphabetical
ROW_NAMES=$(echo "$OUT" | grep -oE '^\| [a-z-]+' | awk '{print $2}' | tr '\n' ' ' | sed 's/ $//')
EXPECTED="bugfix enterprise feature infra mvp poc refactor security-patch workshop"
assert_eq "$ROW_NAMES" "$EXPECTED" "scope-table rows sorted alphabetically"

# ----- Section 3: row count matches .claude/scopes/*.md count (1 assertion) -----
ROW_COUNT=$(echo "$OUT" | grep -cE '^\| [a-z-]+')
MD_COUNT=$(ls "$AIDLC_SRC/scopes/"aidlc-*.md 2>/dev/null | wc -l | tr -d ' ')
assert_eq "$ROW_COUNT" "$MD_COUNT" "scope-table row count matches .claude/scopes/*.md count"

# ----- Section 4: --check clean-exit-0 on real SKILL.md (1 assertion) -----
bun "$UTIL" scope-table --check >/dev/null 2>&1
RC=$?
assert_eq "$RC" "0" "scope-table --check on clean SKILL.md exits 0"

# ----- Section 5: --check exits 1 on drifted SKILL.md (2 assertions) -----
# Sandbox via AIDLC_SKILL_MD_PATH — never mutate the real SKILL.md.
DRIFT_FILE=$(mktemp "${TMPDIR:-/tmp}/mr10-skill-drift-XXXXXX.md")
cp "$SKILL" "$DRIFT_FILE"
sed_i 's/| bugfix         | Minimal/| bogus          | Minimal/' "$DRIFT_FILE"
set +e
AIDLC_SKILL_MD_PATH="$DRIFT_FILE" bun "$UTIL" scope-table --check >/dev/null 2>/tmp/mr10-drift-err.txt
RC=$?
set -e
assert_eq "$RC" "1" "scope-table --check exits 1 on drifted SKILL.md"
assert_contains "$(cat /tmp/mr10-drift-err.txt)" "out of date" "drift error mentions 'out of date'"
rm -f "$DRIFT_FILE" /tmp/mr10-drift-err.txt

# ----- Section 6: --check exits 1 on missing markers (1 assertion) -----
NOMARK_FILE=$(mktemp "${TMPDIR:-/tmp}/mr10-skill-nomark-XXXXXX.md")
echo "no markers in this file" > "$NOMARK_FILE"
set +e
AIDLC_SKILL_MD_PATH="$NOMARK_FILE" bun "$UTIL" scope-table --check >/dev/null 2>/tmp/mr10-nomark-err.txt
RC=$?
set -e
MSG_AND_RC_OK=$([ "$RC" = "1" ] && grep -q "missing scope-table markers" /tmp/mr10-nomark-err.txt && echo "true" || echo "false")
assert_eq "$MSG_AND_RC_OK" "true" "scope-table --check exits 1 with 'missing scope-table markers' on marker-less SKILL.md"
rm -f "$NOMARK_FILE" /tmp/mr10-nomark-err.txt

# ----- Section 7: inferScopeFromText keyword matching (7 assertions) -----
assert_infer "fix the login bug" "bugfix"
assert_infer "refactor this code" "refactor"
assert_infer "CVE patch" "security-patch"
assert_infer "run workshop today" "workshop"
assert_infer "spike prototype" "poc"
assert_infer "mvp" "mvp"
assert_infer "infra deploy" "infra"

# ----- Section 8: word-boundary false-positive guards (2 assertions) -----
# "debug" contains "bug" substring — word-boundary regex must NOT match.
assert_infer "debug this issue" "feature" "debug does not trigger bugfix (word-boundary)"
# "fixture" contains "fix" substring — same.
assert_infer "fixture scope testing" "feature" "fixture does not trigger bugfix (word-boundary)"

# ----- Section 8b: multi-word keyword handles whitespace variance (1 assertion) -----
# Multi-word keyword like "minimum viable" should match even if the input
# uses multiple spaces or tabs between the tokens.
assert_infer "minimum  viable" "mvp" "multi-word keyword matches despite extra whitespace"

# ----- Section 9: >5-word fallback (1 assertion) -----
assert_infer "I want to fix the broken auth flow quickly today" "feature" ">5-word input with keywords → feature default"

# ----- Section 10: empty input (1 assertion) -----
assert_infer "" "feature" "empty input → feature default"

# ----- Section 11: detect-scope --from-text emits audit + matches keyword (1 assertion) -----
PROJ=$(create_test_project)
bun "$UTIL" detect-scope --from-text --input "fix the login bug" --project-dir "$PROJ" >/dev/null 2>&1
AUDIT="$PROJ/aidlc-docs/audit.md"
if grep -q "Detected scope.*: bugfix" "$AUDIT" && grep -q "Source.*: keyword" "$AUDIT"; then
  ok "detect-scope --from-text emits SCOPE_DETECTED with scope=bugfix + Source=keyword"
else
  not_ok "detect-scope --from-text emits SCOPE_DETECTED with scope=bugfix + Source=keyword" \
    "audit content: $(cat "$AUDIT" | tail -15)"
fi
assert_contains "$(cat "$AUDIT")" "Matched keywords" "SCOPE_DETECTED audit includes Matched keywords field on keyword match"
cleanup_test_project "$PROJ"

# ----- Section 12: backward-compat — detect-scope --scope path (1 assertion) -----
PROJ=$(create_test_project)
bun "$UTIL" detect-scope --scope feature --input "build a todo app" --source freeform --project-dir "$PROJ" >/dev/null 2>&1
AUDIT="$PROJ/aidlc-docs/audit.md"
if grep -q "Detected scope.*: feature" "$AUDIT" && grep -q "Source.*: freeform" "$AUDIT"; then
  ok "detect-scope --scope (pre-MR-10 path) still emits SCOPE_DETECTED"
else
  not_ok "detect-scope --scope (pre-MR-10 path) still emits SCOPE_DETECTED" \
    "audit content: $(cat "$AUDIT" | tail -15)"
fi
cleanup_test_project "$PROJ"

# ----- Section 13: flag collision error (1 assertion) -----
PROJ=$(create_test_project)
set +e
bun "$UTIL" detect-scope --scope feature --from-text --input "fix bug" --project-dir "$PROJ" >/dev/null 2>/tmp/mr10-collide-err.txt
RC=$?
set -e
MSG_AND_RC_OK=$([ "$RC" = "1" ] && grep -q "Cannot combine --from-text and --scope" /tmp/mr10-collide-err.txt && echo "true" || echo "false")
assert_eq "$MSG_AND_RC_OK" "true" "detect-scope --scope + --from-text rejected with flag-collision error"
cleanup_test_project "$PROJ"
rm -f /tmp/mr10-collide-err.txt

finish
