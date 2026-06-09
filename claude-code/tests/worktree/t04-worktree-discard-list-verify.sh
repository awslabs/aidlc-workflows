#!/bin/bash
# t04: aidlc-worktree discard / list / verify.
# v0.4.0 MR 7.
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

plan 12

TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"

FIX1=""; FIX2=""; FIX3=""
trap '
  for f in "$FIX1" "$FIX2" "$FIX3"; do
    [ -n "$f" ] && cleanup_worktree_fixture "$f" || true
  done
' EXIT

# --- Test 1-3: discard removes worktree + branch + emits event ---
FIX1=$(setup_worktree_fixture)
mkdir -p "$FIX1/aidlc-docs"
(cd "$FIX1" && bun "$TOOL" create --slug demo --base main --project-dir "$FIX1" >/dev/null 2>&1)
OUT=$(cd "$FIX1" && bun "$TOOL" discard --slug demo --project-dir "$FIX1" 2>&1)
RC=$?
assert_eq "$RC" "0" "discard exits 0"
assert_contains "$OUT" '"emitted":"WORKTREE_DISCARDED"' "discard stdout records emitted=WORKTREE_DISCARDED"
if [ ! -d "$FIX1/.aidlc/worktrees/bolt-demo" ]; then
  ok "discard removed the worktree directory"
else
  not_ok "discard removed the worktree directory" "still present"
fi

# --- Test 4: idempotent — second discard succeeds silently ---
OUT2=$(cd "$FIX1" && bun "$TOOL" discard --slug demo --project-dir "$FIX1" 2>&1)
RC2=$?
assert_eq "$RC2" "0" "second discard on already-gone slug exits 0 (idempotent)"

# --- Test 5-7: list returns only bolt-* worktrees ---
FIX2=$(setup_worktree_fixture)
mkdir -p "$FIX2/aidlc-docs"
# Add a non-bolt worktree to confirm the filter excludes it.
git -C "$FIX2" worktree add -q "$FIX2/non-bolt-wt" -b unrelated >/dev/null 2>&1
(cd "$FIX2" && bun "$TOOL" create --slug listed --base main --project-dir "$FIX2" >/dev/null 2>&1)

OUT=$(cd "$FIX2" && bun "$TOOL" list --project-dir "$FIX2" 2>&1)
RC=$?
assert_eq "$RC" "0" "list exits 0"
assert_contains "$OUT" '"slug":"listed"' "list includes the bolt-listed worktree"
assert_not_contains "$OUT" "non-bolt-wt" "list excludes non-bolt worktrees"

# --- Test 8-9: verify finds the most recent matching event within window ---
FIX3=$(setup_worktree_fixture)
mkdir -p "$FIX3/aidlc-docs"
(cd "$FIX3" && bun "$TOOL" create --slug ver --base main --project-dir "$FIX3" >/dev/null 2>&1)
OUT=$(cd "$FIX3" && bun "$TOOL" verify --event WORKTREE_CREATED --slug ver --project-dir "$FIX3" 2>&1)
RC=$?
assert_eq "$RC" "0" "verify (present) exits 0"
assert_contains "$OUT" '"verified":true' "verify (present) stdout reports verified=true"

# --- Test 10-11: verify (absent slug) exits non-zero with absent reason ---
set +e
OUT=$(cd "$FIX3" && bun "$TOOL" verify --event WORKTREE_CREATED --slug other --project-dir "$FIX3" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "verify (absent slug) exits non-zero"
assert_contains "$OUT" '"reason":"absent"' "verify (absent slug) reports reason=absent"

# --- Test 12: verify (stale) — set max-age to 0 so even fresh entries fail ---
set +e
OUT=$(cd "$FIX3" && bun "$TOOL" verify --event WORKTREE_CREATED --slug ver --max-age-seconds 0 --project-dir "$FIX3" 2>&1)
RC=$?
set -e
# RC should be non-zero, and reason should be "stale (last seen ...)"
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q '"reason":"stale'; then
  ok "verify with max-age=0 reports stale (deterministic backstop respects window)"
else
  not_ok "verify with max-age=0 reports stale" "rc=$RC out=$OUT"
fi

finish
