#!/bin/bash
# t09: halt-and-ask preserves the worktree on simulated Bolt failure.
# v0.4.0 MR 12. Pins the load-bearing invariant from ROADMAP.md:137 —
# aborted/skipped Bolts' worktrees stay on disk for inspection unless the
# user explicitly discards. (8 tests)
#
# Flow: create a worktree → simulate Bolt failure (run aidlc-bolt fail with
# --slug to emit BOLT_FAILED) → assert worktree still on disk + BOLT_FAILED
# in audit + zero WORKTREE_DISCARDED events.
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

plan 8

WT_TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"
BOLT_TOOL="$AIDLC_SRC/tools/aidlc-bolt.ts"

FIX=""
trap '[ -n "$FIX" ] && cleanup_worktree_fixture "$FIX" || true' EXIT

# --- Setup: fixture project + create a worktree for slug bolt-x ---
FIX=$(setup_worktree_fixture)
mkdir -p "$FIX/aidlc-docs"
(cd "$FIX" && bun "$WT_TOOL" create --slug x --base main --project-dir "$FIX" >/dev/null 2>&1)
assert_dir_exists "$FIX/.aidlc/worktrees/bolt-x" "worktree created on disk"
assert_grep "$FIX/aidlc-docs/audit.md" "Event.*WORKTREE_CREATED" "WORKTREE_CREATED in audit"

# --- Simulate Bolt failure: run aidlc-bolt fail --slug x ---
(cd "$FIX" && bun "$BOLT_TOOL" fail --name "Test Bolt" --slug x --error "fixture failure" --project-dir "$FIX" >/dev/null 2>&1)
assert_grep "$FIX/aidlc-docs/audit.md" "Event.*BOLT_FAILED" "BOLT_FAILED emitted"
assert_grep "$FIX/aidlc-docs/audit.md" "Bolt slug.*x$" "BOLT_FAILED includes Bolt slug field"

# --- Pin the preservation invariant: worktree still on disk, no discard event ---
assert_dir_exists "$FIX/.aidlc/worktrees/bolt-x" "worktree preserved after BOLT_FAILED (no auto-discard)"
assert_worktree_at "$FIX" "$FIX/.aidlc/worktrees/bolt-x"

# --- Negative: zero WORKTREE_DISCARDED entries means halt-and-ask did NOT
#     auto-discard. The orchestrator's prose preserves Skip and Abort symmetrically.
set +e
DISCARD_COUNT=$(grep -c "Event.*WORKTREE_DISCARDED" "$FIX/aidlc-docs/audit.md" 2>/dev/null)
set -e
[ -z "$DISCARD_COUNT" ] && DISCARD_COUNT=0
assert_eq "$DISCARD_COUNT" "0" "zero WORKTREE_DISCARDED events after BOLT_FAILED"

# --- info subcommand returns the live path even after the failure ---
INFO_OUT=$(cd "$FIX" && bun "$WT_TOOL" info --slug x --project-dir "$FIX" 2>&1)
assert_contains "$INFO_OUT" '"path":' "info still resolves path after BOLT_FAILED (worktree-state visibility)"

finish
