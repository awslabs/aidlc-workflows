#!/bin/bash
# t72: aidlc-worktree info — deterministic worktree path/branch lookup from
# audit.md for halt-and-ask correlation. v0.4.0 MR 12.
#
# Pins: hit returns expected JSON; multiple WORKTREE_CREATED for same slug
# returns most-recent (timestamp-ordered, end-to-start scan); missing slug
# exits non-zero with stderr message; malformed block (missing field) exits
# non-zero with stderr message. (10 tests)
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

plan 10

TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"

# Each test runs in a fresh temp project so audit fixtures don't bleed across.
FIX1=""; FIX2=""; FIX3=""; FIX4=""
trap '
  for f in "$FIX1" "$FIX2" "$FIX3" "$FIX4"; do
    [ -n "$f" ] && rm -rf "$f" || true
  done
' EXIT

write_audit() {
  local dir="$1" content="$2"
  mkdir -p "$dir/aidlc-docs"
  printf '%s\n' "$content" > "$dir/aidlc-docs/audit.md"
}

# --- Tests 1-4: hit returns expected JSON shape and field values ---
FIX1=$(mktemp -d)
write_audit "$FIX1" '# AI-DLC Audit Log

## Worktree Created
**Timestamp**: 2026-05-18T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-onboarding
**Worktree path**: /tmp/proj/.aidlc/worktrees/bolt-onboarding
**Branch name**: bolt-onboarding
**Base branch**: main

---'

set +e
OUT=$(cd "$FIX1" && bun "$TOOL" info --slug bolt-onboarding --project-dir "$FIX1" 2>&1)
RC=$?
set -e
assert_eq "$RC" "0" "info exits 0 on hit"
assert_contains "$OUT" '"slug":"bolt-onboarding"' "info JSON includes slug"
assert_contains "$OUT" '"path":"/tmp/proj/.aidlc/worktrees/bolt-onboarding"' "info JSON includes path"
assert_contains "$OUT" '"branch_name":"bolt-onboarding"' "info JSON includes branch_name"

# --- Tests 5-6: multiple WORKTREE_CREATED for same slug returns most-recent ---
FIX2=$(mktemp -d)
write_audit "$FIX2" '# AI-DLC Audit Log

## Worktree Created
**Timestamp**: 2026-05-18T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-x
**Worktree path**: /tmp/old-path
**Branch name**: bolt-x
**Base branch**: main

---

## Worktree Created
**Timestamp**: 2026-05-18T11:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-x
**Worktree path**: /tmp/new-path
**Branch name**: bolt-x
**Base branch**: main

---'

set +e
OUT=$(cd "$FIX2" && bun "$TOOL" info --slug bolt-x --project-dir "$FIX2" 2>&1)
RC=$?
set -e
assert_eq "$RC" "0" "info exits 0 with multiple matching blocks"
assert_contains "$OUT" '"path":"/tmp/new-path"' "info returns most-recent path (end-to-start scan)"

# --- Tests 7-8: missing slug exits non-zero with stderr message ---
FIX3=$(mktemp -d)
write_audit "$FIX3" '# AI-DLC Audit Log

## Worktree Created
**Timestamp**: 2026-05-18T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-other
**Worktree path**: /tmp/other
**Branch name**: bolt-other
**Base branch**: main

---'

set +e
OUT=$(cd "$FIX3" && bun "$TOOL" info --slug bolt-missing --project-dir "$FIX3" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "info exits non-zero on missing slug"
assert_contains "$OUT" "no WORKTREE_CREATED audit entry for slug bolt-missing" "info stderr names the missing slug"

# --- Tests 9-10: malformed block (missing Worktree path field) exits non-zero ---
FIX4=$(mktemp -d)
write_audit "$FIX4" '# AI-DLC Audit Log

## Worktree Created
**Timestamp**: 2026-05-18T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-broken
**Branch name**: bolt-broken
**Base branch**: main

---'

set +e
OUT=$(cd "$FIX4" && bun "$TOOL" info --slug bolt-broken --project-dir "$FIX4" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "info exits non-zero on malformed block (missing Worktree path)"
assert_contains "$OUT" "malformed WORKTREE_CREATED block" "info stderr flags malformed block"

finish
