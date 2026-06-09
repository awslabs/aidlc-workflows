#!/bin/bash
# t75: Behavioural contract for `aidlc-state.ts practices-promote`.
#
# The cross-row promotion subcommand introduced in v0.4.0 MR 8 to fix the
# t55 regression where stage prose telling the LLM to write to
# `.claude/rules/` triggered a hallucinated permission policy
# under `claude -p`. This test pins the contract deterministically so the
# behaviour can't drift without a same-commit update.
#
# Surface tested:
#   - Reads team-practices.md draft, applies replaceSection x 5 to team.md.
#   - Reads discovered-rules.md draft, applies appendUnderHeading x 2 to
#     project-guardrails.md (Mandated, Forbidden) with `(affirmed YYYY-MM-DD)`
#     date stamps.
#   - Order: project-guardrails.md written before team.md (atomicity).
#   - On success: emits PRACTICES_AFFIRMED with the right fields, exits 0,
#     prints JSON envelope on stdout.
#   - On failure: emits PRACTICES_OVERRIDE with a Reason field, exits non-zero.
#   - Sections absent from draft leave live team.md sections untouched
#     (partial re-runs are valid).
#   - Idempotent on team.md (replaceSection overwrites; re-runs don't accumulate).
#   - Errors closed before any write when drafts or targets are missing.
#
# L1 — pure bash + bun + jq. No claude.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-state.ts"

if [ ! -f "$STATE_TS" ]; then
  echo "Bail out! aidlc-state.ts not found at $STATE_TS"
  exit 1
fi

plan 24

# --- Helper: build a clean fixture project with .claude/, drafts, and state ---
# Returns the project dir.
make_fixture() {
  local proj
  proj=$(create_test_project)

  mkdir -p "$proj/.claude/rules"
  mkdir -p "$proj/aidlc-docs/inception/practices-discovery"

  # Live aidlc-team.md with all five Title-Case sections, each pre-populated
  # so we can detect successful section-replace.
  cat > "$proj/.claude/rules/aidlc-team.md" <<'EOF'
# Team-Level Rules

> This team's affirmed practices and corrections.

## Way of Working

OLD_WAY_OF_WORKING_TEXT

## Walking Skeleton

OLD_WALKING_TEXT

## Testing Posture

OLD_TESTING_TEXT

## Deployment

OLD_DEPLOYMENT_TEXT

## Code Style

OLD_CODE_STYLE_TEXT
EOF

  # Live aidlc-project.md with the two append-target headings.
  cat > "$proj/.claude/rules/aidlc-project.md" <<'EOF'
# Project-Level Rules

## Decided

## Tech Stack

## Mandated

## Forbidden
EOF

  # Drafts in aidlc-docs/inception/practices-discovery/
  cat > "$proj/aidlc-docs/inception/practices-discovery/team-practices.md" <<'EOF'
# Team Practices Draft

## Way of Working

NEW_WAY_OF_WORKING_TEXT

## Walking Skeleton

NEW_WALKING_TEXT

## Testing Posture

NEW_TESTING_TEXT

## Deployment

NEW_DEPLOYMENT_TEXT

## Code Style

NEW_CODE_STYLE_TEXT
EOF

  cat > "$proj/aidlc-docs/inception/practices-discovery/discovered-rules.md" <<'EOF'
# Discovered Rules

## Mandated

ALWAYS use Result<T,E> for fallible operations
ALWAYS write tests before implementation

## Forbidden

NEVER throw exceptions across service boundaries
NEVER skip CI gates
EOF

  echo "$proj"
}

run_promote() {
  local proj="$1"; shift
  bun "$STATE_TS" practices-promote \
    --project-dir "$proj" \
    --team-practices "$proj/aidlc-docs/inception/practices-discovery/team-practices.md" \
    --discovered-rules "$proj/aidlc-docs/inception/practices-discovery/discovered-rules.md" \
    --affirming-user "test-user" \
    "$@" 2>&1
}

# --- Case A: happy path ---
PROJ=$(make_fixture)
OUT=$(run_promote "$PROJ")
EXIT_A=$?

# 1. Exit code is 0 on success.
assert_eq "$EXIT_A" "0" "happy path: exit 0"

# 2. JSON output reports PRACTICES_AFFIRMED.
assert_contains "$OUT" '"emitted":"PRACTICES_AFFIRMED"' "happy path: stdout JSON reports PRACTICES_AFFIRMED"

# 3. aidlc-team.md got the new content for all five sections.
TEAM_MD="$PROJ/.claude/rules/aidlc-team.md"
assert_grep "$TEAM_MD" "NEW_WAY_OF_WORKING_TEXT" "aidlc-team.md: Way of Working section replaced"
assert_grep "$TEAM_MD" "NEW_TESTING_TEXT" "aidlc-team.md: Testing Posture section replaced"
assert_grep "$TEAM_MD" "NEW_CODE_STYLE_TEXT" "aidlc-team.md: Code Style section replaced"
assert_not_grep "$TEAM_MD" "OLD_WAY_OF_WORKING_TEXT" "aidlc-team.md: old Way of Working content removed"
assert_not_grep "$TEAM_MD" "OLD_CODE_STYLE_TEXT" "aidlc-team.md: old Code Style content removed"

# 4. aidlc-project.md got the rules with date stamps.
GUARDRAILS="$PROJ/.claude/rules/aidlc-project.md"
TODAY=$(date -u +%Y-%m-%d)
assert_grep "$GUARDRAILS" "ALWAYS use Result<T,E> for fallible operations (affirmed $TODAY)" \
  "aidlc-project.md: Mandated rule appended with date stamp"
assert_grep "$GUARDRAILS" "NEVER throw exceptions across service boundaries (affirmed $TODAY)" \
  "aidlc-project.md: Forbidden rule appended with date stamp"

# 5. Audit emitted PRACTICES_AFFIRMED with the right fields.
AUDIT="$PROJ/aidlc-docs/audit.md"
assert_file_exists "$AUDIT" "audit file created on success"
assert_grep "$AUDIT" "PRACTICES_AFFIRMED" "audit contains PRACTICES_AFFIRMED event"
assert_grep "$AUDIT" "Affirming User.*test-user" "audit records affirming user"
assert_grep "$AUDIT" "Sections Written" "audit records sections written field"

cleanup_test_project "$PROJ"

# --- Case B: missing draft fails closed ---
PROJ=$(make_fixture)
rm "$PROJ/aidlc-docs/inception/practices-discovery/team-practices.md"
set +e
OUT=$(run_promote "$PROJ")
EXIT_B=$?
set -e
assert_not_eq "$EXIT_B" "0" "missing team-practices draft: exit non-zero"
assert_contains "$OUT" "team-practices draft not found" "missing draft: error message identifies the file"

# Even though the call failed, audit should record PRACTICES_OVERRIDE.
AUDIT="$PROJ/aidlc-docs/audit.md"
if [ -f "$AUDIT" ]; then
  assert_grep "$AUDIT" "PRACTICES_OVERRIDE" "missing draft: audit records PRACTICES_OVERRIDE"
else
  not_ok "missing draft: audit records PRACTICES_OVERRIDE" "audit file not created"
fi

# Targets must be untouched.
TEAM_MD="$PROJ/.claude/rules/aidlc-team.md"
assert_grep "$TEAM_MD" "OLD_WAY_OF_WORKING_TEXT" "missing draft: aidlc-team.md untouched"
cleanup_test_project "$PROJ"

# --- Case C: missing target file fails closed before any write ---
PROJ=$(make_fixture)
rm "$PROJ/.claude/rules/aidlc-project.md"
set +e
OUT=$(run_promote "$PROJ")
EXIT_C=$?
set -e
assert_not_eq "$EXIT_C" "0" "missing guardrails target: exit non-zero"
assert_contains "$OUT" "aidlc-project.md not found" "missing target: error names the file"
# aidlc-team.md must NOT be written when aidlc-project.md was missing —
# atomicity rule (project-first; abort before team if project would fail).
TEAM_MD="$PROJ/.claude/rules/aidlc-team.md"
assert_not_grep "$TEAM_MD" "NEW_WAY_OF_WORKING_TEXT" "missing target: aidlc-team.md NOT written (atomicity)"
cleanup_test_project "$PROJ"

# --- Case D: partial draft (only some sections) leaves others alone ---
PROJ=$(make_fixture)
# Rewrite team-practices.md with only Way of Working and Testing Posture.
cat > "$PROJ/aidlc-docs/inception/practices-discovery/team-practices.md" <<'EOF'
# Team Practices Draft

## Way of Working

PARTIAL_NEW_WAY_OF_WORKING

## Testing Posture

PARTIAL_NEW_TESTING
EOF
run_promote "$PROJ" >/dev/null
TEAM_MD="$PROJ/.claude/rules/aidlc-team.md"
assert_grep "$TEAM_MD" "PARTIAL_NEW_WAY_OF_WORKING" "partial draft: Way of Working replaced"
assert_grep "$TEAM_MD" "PARTIAL_NEW_TESTING" "partial draft: Testing Posture replaced"
# Sections not in the draft must keep their old content.
assert_grep "$TEAM_MD" "OLD_WALKING_TEXT" "partial draft: Walking Skeleton untouched"
assert_grep "$TEAM_MD" "OLD_DEPLOYMENT_TEXT" "partial draft: Deployment untouched"
cleanup_test_project "$PROJ"

# --- Case E: idempotency of replaceSection on team.md ---
# Re-running the same promote against the same drafts should produce the
# same final team.md (no duplicate sections, no accumulating content).
PROJ=$(make_fixture)
run_promote "$PROJ" >/dev/null
TEAM_FIRST=$(cat "$PROJ/.claude/rules/aidlc-team.md")
run_promote "$PROJ" >/dev/null
TEAM_SECOND=$(cat "$PROJ/.claude/rules/aidlc-team.md")
if [ "$TEAM_FIRST" = "$TEAM_SECOND" ]; then
  ok "idempotent: re-running promote produces identical team.md"
else
  not_ok "idempotent: re-running promote produces identical team.md" "team.md changed between runs"
fi
cleanup_test_project "$PROJ"
