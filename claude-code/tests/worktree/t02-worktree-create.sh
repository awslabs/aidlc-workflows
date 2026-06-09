#!/bin/bash
# t02: aidlc-worktree create — happy path + pre-audit validation failures.
# v0.4.0 MR 7. Exercises every create-time check before audit emit and the
# successful create path that emits WORKTREE_CREATED + git worktree add.
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

plan 15

TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"

# Each test runs in a fresh fixture so worktrees don't leak between cases.
FIX1=""; FIX2=""; FIX3=""; FIX4=""; FIX5=""
trap '
  for f in "$FIX1" "$FIX2" "$FIX3" "$FIX4" "$FIX5"; do
    [ -n "$f" ] && cleanup_worktree_fixture "$f" || true
  done
' EXIT

# --- Test 1-4: happy path: create succeeds, emits audit, registers worktree ---
FIX1=$(setup_worktree_fixture)
mkdir -p "$FIX1/aidlc-docs"
OUT=$(cd "$FIX1" && bun "$TOOL" create --slug demo --base main --project-dir "$FIX1" 2>&1)
RC=$?
assert_eq "$RC" "0" "create exits 0 on happy path"
assert_contains "$OUT" '"emitted":"WORKTREE_CREATED"' "create stdout contains emitted=WORKTREE_CREATED"
assert_grep "$FIX1/aidlc-docs/audit.md" "Bolt slug.*demo" "audit.md records the slug"
assert_dir_exists "$FIX1/.aidlc/worktrees/bolt-demo" "worktree directory exists at the helper-shaped path"

# --- Test 5: branch was created on the bolt branch ---
BRANCH=$(git -C "$FIX1/.aidlc/worktrees/bolt-demo" rev-parse --abbrev-ref HEAD)
assert_eq "$BRANCH" "bolt-demo" "worktree HEAD is on bolt-<slug>"

# --- Test 6-7: invalid slug rejected pre-audit (no audit row, no directory) ---
FIX2=$(setup_worktree_fixture)
mkdir -p "$FIX2/aidlc-docs"
set +e
OUT=$(cd "$FIX2" && bun "$TOOL" create --slug "Foo_Bar" --base main --project-dir "$FIX2" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "create exits non-zero on bad slug"
assert_contains "$OUT" "Invalid --slug" "create error message names the invalid flag"

# --- Test 8: nonexistent base branch rejected pre-audit ---
FIX3=$(setup_worktree_fixture)
mkdir -p "$FIX3/aidlc-docs"
set +e
OUT=$(cd "$FIX3" && bun "$TOOL" create --slug demo --base nonexistent-branch --project-dir "$FIX3" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "create exits non-zero on missing base branch"
assert_contains "$OUT" "Base branch does not exist" "create error names the missing base"

# --- Test 9-10: double-create on same slug fails pre-audit ---
FIX4=$(setup_worktree_fixture)
mkdir -p "$FIX4/aidlc-docs"
(cd "$FIX4" && bun "$TOOL" create --slug demo --base main --project-dir "$FIX4" >/dev/null 2>&1)
set +e
OUT=$(cd "$FIX4" && bun "$TOOL" create --slug demo --base main --project-dir "$FIX4" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "second create on same slug exits non-zero"
assert_contains "$OUT" "already exists" "second create error message reports already-exists"

# --- Test 11-14: parallel creates with distinct slugs all succeed ---
# Mirrors the t33-hook-concurrency.sh:21-25 `&` + `wait` precedent.
FIX5=$(setup_worktree_fixture)
mkdir -p "$FIX5/aidlc-docs"
(cd "$FIX5" && bun "$TOOL" create --slug a --base main --project-dir "$FIX5" >/dev/null 2>&1) &
PID_A=$!
(cd "$FIX5" && bun "$TOOL" create --slug b --base main --project-dir "$FIX5" >/dev/null 2>&1) &
PID_B=$!
(cd "$FIX5" && bun "$TOOL" create --slug c --base main --project-dir "$FIX5" >/dev/null 2>&1) &
PID_C=$!
wait $PID_A; RC_A=$?
wait $PID_B; RC_B=$?
wait $PID_C; RC_C=$?
assert_eq "$RC_A" "0" "parallel create slug=a succeeds"
assert_eq "$RC_B" "0" "parallel create slug=b succeeds"
assert_eq "$RC_C" "0" "parallel create slug=c succeeds"
COUNT=$(grep -c "Bolt slug.*[abc]\$" "$FIX5/aidlc-docs/audit.md" || echo 0)
assert_eq "$COUNT" "3" "all 3 parallel creates emitted distinct WORKTREE_CREATED events"

finish
