#!/bin/bash
# t31: Unit tests for aidlc-log.ts (decision, answer)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-log.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 21

# --- Test 1: decision emits DECISION_RECORDED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" decision --stage feasibility --decision "Pick a framework" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: DECISION_RECORDED" "decision emits DECISION_RECORDED"
cleanup_test_project "$PROJ"

# --- Test 2: decision records Stage field ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" decision --stage feasibility --decision "Pick a framework" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Stage\*\*: feasibility' "decision records Stage field"
cleanup_test_project "$PROJ"

# --- Test 3: decision records Decision field ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" decision --stage feasibility --decision "Pick a framework" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Decision\*\*: Pick a framework' "decision records Decision field"
cleanup_test_project "$PROJ"

# --- Test 4: decision --options is recorded when supplied ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" decision --stage feasibility --decision "Pick a framework" --options "React,Vue,Svelte" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Options\*\*: React,Vue,Svelte' "decision records Options field"
cleanup_test_project "$PROJ"

# --- Test 5: decision --rationale is recorded when supplied ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" decision --stage feasibility --decision "Pick a framework" --rationale "Align with team skillset" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Rationale\*\*: Align with team skillset' "decision records Rationale field"
cleanup_test_project "$PROJ"

# --- Test 6: decision --test-run flags Test-Run=true ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" decision --stage feasibility --decision "Pick a framework" --test-run --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Test-Run\*\*: true' "decision --test-run emits Test-Run=true"
cleanup_test_project "$PROJ"

# --- Test 7: decision missing --stage exits 1 ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" decision --decision "x" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "decision missing --stage exits 1"
cleanup_test_project "$PROJ"

# --- Test 8: decision missing --decision exits 1 ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" decision --stage feasibility --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "decision missing --decision exits 1"
cleanup_test_project "$PROJ"

# --- Test 9: answer emits QUESTION_ANSWERED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" answer --stage feasibility --details "User chose React" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: QUESTION_ANSWERED" "answer emits QUESTION_ANSWERED"
cleanup_test_project "$PROJ"

# --- Test 10: answer records Stage and Details ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" answer --stage feasibility --details "User chose React" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Details\*\*: User chose React' "answer records Details field"
cleanup_test_project "$PROJ"

# --- Test 11: answer --test-run flags Test-Run=true ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" answer --stage feasibility --details "auto-selected" --test-run --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Test-Run\*\*: true' "answer --test-run emits Test-Run=true"
cleanup_test_project "$PROJ"

# --- Test 12: answer missing --stage exits 1 ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" answer --details "x" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "answer missing --stage exits 1"
cleanup_test_project "$PROJ"

# --- Test 13: answer missing --details exits 1 ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" answer --stage feasibility --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "answer missing --details exits 1"
cleanup_test_project "$PROJ"

# --- Test 14: unknown subcommand exits 1 ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" bogus --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "unknown subcommand exits 1"
cleanup_test_project "$PROJ"

# --- Test 15: answer --test-run emits canonical QUESTION_ANSWERED, NOT deleted auto-event ---
# Regression guard: --test-run mode must tag the canonical event, not reintroduce
# QUESTION_AUTO_ANSWERED (removed from taxonomy in Phase 1).
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" answer --stage feasibility --details "auto" --test-run --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: QUESTION_ANSWERED" \
  "answer --test-run emits canonical QUESTION_ANSWERED"
assert_not_grep "$PROJ/aidlc-docs/audit.md" "QUESTION_AUTO_ANSWERED" \
  "answer --test-run does NOT emit deleted QUESTION_AUTO_ANSWERED"
cleanup_test_project "$PROJ"

# --- Test 16: decision without --options omits Options field entirely ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" decision --stage feasibility --decision "Pick one" --project-dir "$PROJ" >/dev/null 2>&1
assert_not_grep "$PROJ/aidlc-docs/audit.md" '\*\*Options\*\*:' \
  "decision without --options does not emit empty Options field"
cleanup_test_project "$PROJ"

# --- Test 17: parseFlags rejects --flag without value ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" decision --stage --decision "x" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "decision --stage without value (followed by --decision) errors cleanly"
cleanup_test_project "$PROJ"

# --- Test 18: parseFlags rejects trailing --flag at end of args ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" decision --stage feasibility --decision --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "decision --decision at end of args errors cleanly"
cleanup_test_project "$PROJ"

# --- Test 19: decision prints JSON ack on stdout ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
OUT=$(bun "$TOOL" decision --stage feasibility --decision "Pick one" --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"emitted":"DECISION_RECORDED"' "decision prints JSON with emitted field"
cleanup_test_project "$PROJ"

# --- Test 20: answer prints JSON ack on stdout ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
OUT=$(bun "$TOOL" answer --stage feasibility --details "x" --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"emitted":"QUESTION_ANSWERED"' "answer prints JSON with emitted field"
cleanup_test_project "$PROJ"

finish
