#!/bin/bash
# t10: explicit aidlc-worktree discard --slug cleans up + emits
# WORKTREE_DISCARDED with Reason: agent-discard. v0.4.0 MR 12. Pins the
# user-cleanup half of the symmetric preservation invariant from t09.
# (8 tests)
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

# --- Setup: simulate the t09 end-state (worktree on disk after BOLT_FAILED) ---
FIX=$(setup_worktree_fixture)
mkdir -p "$FIX/aidlc-docs"
(cd "$FIX" && bun "$WT_TOOL" create --slug y --base main --project-dir "$FIX" >/dev/null 2>&1)
(cd "$FIX" && bun "$BOLT_TOOL" fail --name "Test Bolt" --slug y --error "fixture failure" --project-dir "$FIX" >/dev/null 2>&1)
assert_dir_exists "$FIX/.aidlc/worktrees/bolt-y" "worktree on disk before discard"

# --- Discard cleans up: directory gone, branch removed, audit event emitted ---
(cd "$FIX" && bun "$WT_TOOL" discard --slug y --project-dir "$FIX" >/dev/null 2>&1)
assert_file_not_exists "$FIX/.aidlc/worktrees/bolt-y" "worktree directory removed after discard"
assert_worktree_absent "$FIX" "$FIX/.aidlc/worktrees/bolt-y"
assert_grep "$FIX/aidlc-docs/audit.md" "Event.*WORKTREE_DISCARDED" "WORKTREE_DISCARDED emitted"
assert_grep "$FIX/aidlc-docs/audit.md" "Reason.*agent-discard" "discard records Reason: agent-discard"
assert_grep "$FIX/aidlc-docs/audit.md" "Bolt slug.*y$" "discard records the Bolt slug"

# --- Idempotent: second discard succeeds silently per MR 7 contract ---
set +e
OUT=$(cd "$FIX" && bun "$WT_TOOL" discard --slug y --project-dir "$FIX" 2>&1)
RC=$?
set -e
assert_eq "$RC" "0" "second discard exits 0 (idempotent per MR 7 contract)"

# --- info now reflects the post-discard state: WORKTREE_CREATED still exists
#     in audit (most-recent), so info still hits — but the path on disk is gone.
#     The orchestrator's halt-and-ask flow uses info BEFORE choosing abort/skip,
#     so this is the natural shape — info reads audit, not the live filesystem.
INFO_OUT=$(cd "$FIX" && bun "$WT_TOOL" info --slug y --project-dir "$FIX" 2>&1)
assert_contains "$INFO_OUT" '"path":' "info still resolves from audit after discard (audit-of-intent semantics)"

finish
