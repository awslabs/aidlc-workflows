#!/bin/bash
# t34: Unit tests for ERROR_LOGGED emission via lib.ts emitError()
#
# Every tool CLI that exits non-zero through its error() helper routes through
# emitError(), which appends ERROR_LOGGED to the active workflow's audit.md
# (best-effort, no-op if no workflow exists in cwd, recursion-guarded).
#
# These tests exercise the behavior directly by invoking tool commands with
# invalid arguments and asserting the resulting audit entry has the expected
# shape: Tool, Command, Error fields. Tests use aidlc-state.ts, aidlc-log.ts,
# aidlc-jump.ts, aidlc-bolt.ts — the full set of tools
# that opted into emitError.
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

STATE="$AIDLC_SRC/tools/aidlc-state.ts"
LOG="$AIDLC_SRC/tools/aidlc-log.ts"
JUMP="$AIDLC_SRC/tools/aidlc-jump.ts"
BOLT="$AIDLC_SRC/tools/aidlc-bolt.ts"

plan 11

# --- Test 1: aidlc-state unknown subcommand emits ERROR_LOGGED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$STATE" bogus-cmd --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '^\*\*Event\*\*: ERROR_LOGGED' "aidlc-state bogus-cmd emits ERROR_LOGGED"
cleanup_test_project "$PROJ"

# --- Test 2: ERROR_LOGGED includes Tool field ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$STATE" bogus-cmd --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Tool\*\*: aidlc-state' "ERROR_LOGGED has Tool=aidlc-state"
cleanup_test_project "$PROJ"

# --- Test 3: ERROR_LOGGED includes Command field ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$STATE" bogus-cmd --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Command\*\*: aidlc-state bogus-cmd' "ERROR_LOGGED records Command"
cleanup_test_project "$PROJ"

# --- Test 4: ERROR_LOGGED includes Error field ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$STATE" bogus-cmd --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Error\*\*: Unknown subcommand' "ERROR_LOGGED records Error message"
cleanup_test_project "$PROJ"

# --- Test 5: Tool still exits non-zero ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
set +e
bun "$STATE" bogus-cmd --project-dir "$PROJ" >/dev/null 2>&1
rc=$?
set -e
assert_eq 1 "$rc" "error() exits with code 1"
cleanup_test_project "$PROJ"

# --- Test 6: No-op when no workflow (no state file) ---
PROJ=$(create_test_project)
# Intentionally no seed_state_file — aidlc-docs/ exists but no state file.
# Also intentionally no audit.md.
bun "$STATE" bogus-cmd --project-dir "$PROJ" >/dev/null 2>&1 || true
if [ -f "$PROJ/aidlc-docs/audit.md" ]; then
  not_ok "no-op when no state file" "audit.md was created ($PROJ/aidlc-docs/audit.md)"
else
  ok "no-op when no state file (audit.md not created)"
fi
cleanup_test_project "$PROJ"

# --- Test 7: aidlc-log unknown subcommand emits ERROR_LOGGED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$LOG" bogus --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Tool\*\*: aidlc-log' "aidlc-log error routes through emitError"
cleanup_test_project "$PROJ"

# --- Test 8: aidlc-jump invalid target emits ERROR_LOGGED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$JUMP" preview --to non-existent-slug --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Tool\*\*: aidlc-jump' "aidlc-jump error routes through emitError"
cleanup_test_project "$PROJ"

# --- Test 9: aidlc-bolt invalid command emits ERROR_LOGGED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$BOLT" bogus --project-dir "$PROJ" >/dev/null 2>&1 || true
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Tool\*\*: aidlc-bolt' "aidlc-bolt error routes through emitError"
cleanup_test_project "$PROJ"

# --- Test 11: Multiple errors produce multiple entries (no over-guarding across invocations) ---
# The recursion guard is process-local. Each tool invocation is a fresh process,
# so running two invalid commands should produce two ERROR_LOGGED entries.
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$STATE" bogus-1 --project-dir "$PROJ" >/dev/null 2>&1 || true
bun "$STATE" bogus-2 --project-dir "$PROJ" >/dev/null 2>&1 || true
count=$(grep -c '^\*\*Event\*\*: ERROR_LOGGED' "$PROJ/aidlc-docs/audit.md" || echo 0)
assert_eq 2 "$count" "two invocations produce two ERROR_LOGGED entries"
cleanup_test_project "$PROJ"

# --- Test 12: ERROR_LOGGED is a valid taxonomy member (does not throw as invalid event type) ---
# Regression guard: if someone removes ERROR_LOGGED from VALID_EVENT_TYPES,
# appendAuditEntry would throw "Invalid event type" — we swallow it but the
# audit entry would be missing. This test asserts the entry actually lands.
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
bun "$STATE" bogus --project-dir "$PROJ" >/dev/null 2>&1 || true
count=$(grep -c '^\*\*Event\*\*: ERROR_LOGGED' "$PROJ/aidlc-docs/audit.md" || echo 0)
assert_eq 1 "$count" "ERROR_LOGGED survives taxonomy validation"
cleanup_test_project "$PROJ"

finish
