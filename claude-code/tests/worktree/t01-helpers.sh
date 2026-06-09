#!/bin/bash
# t01-helpers: exercise tests/lib/worktree-helpers.sh against a fresh fixture.
# v0.4.0 Wave 1 MR 3 — confirms setup/assert/cleanup primitives work before
# downstream worktree-related MRs (7, 9, 10, 11) consume them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/worktree-helpers.sh"

plan 7

# Trap so an early-assertion failure still removes the tempdir. The trap
# fires under -e on any non-zero exit (assertion failure, command error,
# strict-mode trip). Without this, a broken fixture leaks into /tmp.
fixture=""
trap '[ -n "$fixture" ] && cleanup_worktree_fixture "$fixture" || true' EXIT

# 1. setup_worktree_fixture creates a directory.
fixture=$(setup_worktree_fixture)
if [ -d "$fixture" ]; then
  ok "setup_worktree_fixture creates a directory at $fixture"
else
  not_ok "setup_worktree_fixture creates a directory" "got: $fixture"
fi

# 2. The path is a git repo.
if git -C "$fixture" rev-parse --git-dir >/dev/null 2>&1; then
  ok "fixture is a git repo"
else
  not_ok "fixture is a git repo" "git -C $fixture rev-parse --git-dir failed"
fi

# 3. The repo has exactly one commit. Direct comparison — no failure mask
# so any git error propagates as a real diagnostic instead of being hidden
# behind a misleading "got: 0".
commit_count=$(git -C "$fixture" rev-list --count HEAD)
if [ "$commit_count" = "1" ]; then
  ok "fixture has exactly one commit"
else
  not_ok "fixture has exactly one commit" "rev-list count: $commit_count"
fi

# 4. assert_worktree_at correctly reports presence (the main checkout itself).
#    The fixture's only worktree on creation is the main checkout. Confirming
#    `assert_worktree_at $fixture $fixture` succeeds proves the porcelain
#    parsing is correct.
assert_worktree_at "$fixture" "$fixture"

# 5. Adding a child worktree, assert_worktree_at finds it.
child_wt="$fixture/wt"
git -C "$fixture" worktree add -q "$child_wt" -b foo-branch >/dev/null 2>&1
assert_worktree_at "$fixture" "$child_wt"

# 6. cleanup_worktree_fixture refuses to act on paths outside the fixture
# prefix. Defence-in-depth probe: a non-fixture path under /tmp must be
# left untouched. Create a sentinel directory whose basename does NOT start
# with `aidlc-worktree-`, call cleanup on it, confirm it still exists, then
# remove it manually.
sentinel=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-NOT-A-FIXTURE-XXXXXX")
sentinel=$(cd "$sentinel" && pwd -P)
cleanup_worktree_fixture "$sentinel"
if [ -d "$sentinel" ]; then
  ok "cleanup refuses to act on paths outside fixture prefix"
  rm -rf "$sentinel"
else
  not_ok "cleanup refuses to act on paths outside fixture prefix" \
    "sentinel was deleted"
fi

# 7. cleanup_worktree_fixture is idempotent for fixture paths.
cleanup_worktree_fixture "$fixture"
cleanup_worktree_fixture "$fixture"  # second call must be a no-op
if [ ! -d "$fixture" ]; then
  ok "cleanup_worktree_fixture is idempotent (path removed; second call no-op)"
  fixture=""  # disarm the trap; nothing left to clean
else
  not_ok "cleanup_worktree_fixture is idempotent" "path still exists: $fixture"
fi

finish
