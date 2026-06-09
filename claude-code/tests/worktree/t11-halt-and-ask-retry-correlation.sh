#!/bin/bash
# t11: retry-then-fail correlation — info returns the SAME path across
# multiple BOLT_FAILED emissions for the same slug. v0.4.0 MR 12. Pins
# the round-4 final-pass-critic concern that retry must not mutate the
# rendered worktree path. (6 tests)
#
# Flow: create worktree → fail → retry (no new WORKTREE_CREATED) → fail
# again → assert info returns the same path both times + only ONE
# WORKTREE_CREATED in audit (Retry re-runs in place per SKILL.md per-Bolt
# loop semantics).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/worktree-helpers.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 6

WT_TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"
BOLT_TOOL="$AIDLC_SRC/tools/aidlc-bolt.ts"

FIX=""
trap '[ -n "$FIX" ] && cleanup_worktree_fixture "$FIX" || true' EXIT

# --- Setup ---
FIX=$(setup_worktree_fixture)
mkdir -p "$FIX/aidlc-docs"
(cd "$FIX" && bun "$WT_TOOL" create --slug r --base main --project-dir "$FIX" >/dev/null 2>&1)

# --- Failure 1 ---
(cd "$FIX" && bun "$BOLT_TOOL" fail --name "Retry Bolt" --slug r --error "first failure" --project-dir "$FIX" >/dev/null 2>&1)
INFO1=$(cd "$FIX" && bun "$WT_TOOL" info --slug r --project-dir "$FIX" 2>&1)
PATH1=$(echo "$INFO1" | sed -nE 's/.*"path":"([^"]+)".*/\1/p')
assert_contains "$INFO1" '"path":' "first info hit returns a path"

# --- Retry semantics: re-run inside the existing worktree.
#     The orchestrator does NOT call aidlc-worktree create again on retry;
#     SKILL.md's per-Bolt loop says "Retry: re-run the failed Bolt only
#     inside the existing worktree." So no new WORKTREE_CREATED emits.
# --- Failure 2: same slug, same worktree ---
(cd "$FIX" && bun "$BOLT_TOOL" fail --name "Retry Bolt" --slug r --error "second failure" --project-dir "$FIX" >/dev/null 2>&1)
INFO2=$(cd "$FIX" && bun "$WT_TOOL" info --slug r --project-dir "$FIX" 2>&1)
PATH2=$(echo "$INFO2" | sed -nE 's/.*"path":"([^"]+)".*/\1/p')
assert_eq "$PATH1" "$PATH2" "info returns the SAME path across retry attempts"

# --- Audit invariants ---
CREATED_COUNT=$(grep -c "Event.*WORKTREE_CREATED" "$FIX/aidlc-docs/audit.md" 2>/dev/null || echo 0)
[ -z "$CREATED_COUNT" ] && CREATED_COUNT=0
assert_eq "$CREATED_COUNT" "1" "exactly one WORKTREE_CREATED event (retry does not re-create worktree)"

set +e
FAILED_COUNT=$(grep -c "Event.*BOLT_FAILED" "$FIX/aidlc-docs/audit.md" 2>/dev/null)
set -e
[ -z "$FAILED_COUNT" ] && FAILED_COUNT=0
assert_eq "$FAILED_COUNT" "2" "two BOLT_FAILED events (one per retry attempt)"

# --- Worktree still on disk after multiple failures (preservation invariant) ---
assert_dir_exists "$FIX/.aidlc/worktrees/bolt-r" "worktree preserved across multiple failures"

# --- Both BOLT_FAILED entries carry the slug field for halt-and-ask correlation ---
SLUG_COUNT=$(grep -c "Bolt slug.*r$" "$FIX/aidlc-docs/audit.md" 2>/dev/null || echo 0)
[ -z "$SLUG_COUNT" ] && SLUG_COUNT=0
# Every BOLT_FAILED + the WORKTREE_CREATED carry "Bolt slug: r" — 3 total.
assert_eq "$SLUG_COUNT" "3" "Bolt slug field on every emit (1 WORKTREE_CREATED + 2 BOLT_FAILED)"

finish
