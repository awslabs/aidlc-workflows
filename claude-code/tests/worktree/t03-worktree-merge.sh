#!/bin/bash
# t03: aidlc-worktree merge — squash, conflict, and pre-audit guards.
# v0.4.0 MR 7. Covers happy-path squash, defensive HEAD check, conflict
# envelope shape, and rebase-without-remote rejection.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/worktree-helpers.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
# Force a non-interactive editor so any unexpected `git commit` without
# `--no-edit` fails loudly instead of hanging.
export EDITOR=false

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 13

TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"

FIX1=""; FIX2=""; FIX3=""; FIX4=""
trap '
  for f in "$FIX1" "$FIX2" "$FIX3" "$FIX4"; do
    [ -n "$f" ] && cleanup_worktree_fixture "$f" || true
  done
' EXIT

# --- Test 1-3: squash merge happy path ---
FIX1=$(setup_worktree_fixture)
mkdir -p "$FIX1/aidlc-docs"
(cd "$FIX1" && bun "$TOOL" create --slug demo --base main --project-dir "$FIX1" >/dev/null 2>&1)

# Make a commit in the worktree so the squash has something to merge.
WT="$FIX1/.aidlc/worktrees/bolt-demo"
echo "feature" > "$WT/feature.txt"
git -C "$WT" add feature.txt
git -C "$WT" -c user.email=t@x -c user.name=t commit -qm "add feature"

OUT=$(cd "$FIX1" && bun "$TOOL" merge --slug demo --target main --strategy squash --message "Bolt demo" --project-dir "$FIX1" 2>&1)
RC=$?
assert_eq "$RC" "0" "squash merge exits 0"
assert_contains "$OUT" '"emitted":"WORKTREE_MERGED"' "merge stdout records emitted=WORKTREE_MERGED"
# Worktree directory should be gone after successful merge.
if [ ! -d "$WT" ]; then
  ok "worktree removed after successful squash merge"
else
  not_ok "worktree removed after successful squash merge" "still at $WT"
fi

# --- Test 4-5: defensive HEAD check fails when cwd is on a different branch ---
FIX2=$(setup_worktree_fixture)
mkdir -p "$FIX2/aidlc-docs"
(cd "$FIX2" && bun "$TOOL" create --slug demo --base main --project-dir "$FIX2" >/dev/null 2>&1)
git -C "$FIX2" -c user.email=t@x -c user.name=t checkout -qb other-branch
set +e
OUT=$(cd "$FIX2" && bun "$TOOL" merge --slug demo --target main --strategy squash --project-dir "$FIX2" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "merge with wrong cwd HEAD exits non-zero"
assert_contains "$OUT" "expected branch main, found other-branch" "merge error names the actual branch"

# --- Test 6-9: conflict envelope shape on conflicting changes ---
FIX3=$(setup_worktree_fixture)
mkdir -p "$FIX3/aidlc-docs"
# Seed main with content the bolt will conflict against.
echo "main version" > "$FIX3/conflict.txt"
git -C "$FIX3" add conflict.txt
git -C "$FIX3" -c user.email=t@x -c user.name=t commit -qm "main writes conflict.txt"

(cd "$FIX3" && bun "$TOOL" create --slug demo --base main --project-dir "$FIX3" >/dev/null 2>&1)

WT3="$FIX3/.aidlc/worktrees/bolt-demo"
echo "bolt version" > "$WT3/conflict.txt"
git -C "$WT3" add conflict.txt
git -C "$WT3" -c user.email=t@x -c user.name=t commit -qm "bolt writes conflict.txt"

# Now mutate main again so squash produces a conflict.
echo "main version 2" > "$FIX3/conflict.txt"
git -C "$FIX3" add conflict.txt
git -C "$FIX3" -c user.email=t@x -c user.name=t commit -qm "main writes conflict.txt v2"

set +e
OUT=$(cd "$FIX3" && bun "$TOOL" merge --slug demo --target main --strategy squash --project-dir "$FIX3" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "conflicted merge exits non-zero"
assert_contains "$OUT" '"status":"conflict"' "conflict envelope status field present"
assert_contains "$OUT" '"detail":"Merge produced conflicts' "conflict envelope detail field present"
# conflict_files must be non-empty AND contain the actual conflicting path.
# Pin both so a regression that swapped to an empty array OR returned a
# wrong path (e.g. parsing artefact like `feature.` from rename/rename
# stderr) trips this assertion. listConflictFiles() uses
# `git diff --name-only --diff-filter=U` so the answer is deterministic.
assert_match "$OUT" '"conflict_files":\["conflict\.txt"\]' \
  "conflict envelope conflict_files lists conflict.txt"
# Worktree must be preserved on conflict so the user can resolve in place.
if [ -d "$WT3" ]; then
  ok "worktree preserved on conflict (not removed)"
else
  not_ok "worktree preserved on conflict" "$WT3 was removed"
fi

# --- Test 10-12: rebase strategy errors when no remote configured ---
FIX4=$(setup_worktree_fixture)
mkdir -p "$FIX4/aidlc-docs"
(cd "$FIX4" && bun "$TOOL" create --slug demo --base main --project-dir "$FIX4" >/dev/null 2>&1)

set +e
OUT=$(cd "$FIX4" && bun "$TOOL" merge --slug demo --target main --strategy rebase --project-dir "$FIX4" 2>&1)
RC=$?
set -e
assert_not_eq "$RC" "0" "rebase merge without remote exits non-zero"
assert_contains "$OUT" "rebase strategy requires a remote" "rebase error message names the missing remote"
# Worktree must still exist — rebase failed pre-audit so it never started.
if [ -d "$FIX4/.aidlc/worktrees/bolt-demo" ]; then
  ok "worktree preserved after pre-audit rebase rejection"
else
  not_ok "worktree preserved after pre-audit rebase rejection" "directory missing"
fi

finish
