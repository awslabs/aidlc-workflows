#!/bin/bash
# Worktree test helpers: per-test git-repo fixtures + assertions
# Usage: source this file alongside lib/tap.sh, then use
#   path=$(setup_worktree_fixture)
#   assert_worktree_at "$path" "$path/wt"
#   cleanup_worktree_fixture "$path"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# All fixtures live under this prefix. cleanup_worktree_fixture refuses to
# rm -rf any path that doesn't start with the prefix — defence in depth so
# a caller passing a typo'd "$" or empty value can't nuke /, $HOME, /tmp,
# or other system paths.
WORKTREE_FIXTURE_PREFIX_NAME="aidlc-worktree-"

# Create a fresh git repo in a tempdir with one initial commit on `main`.
# Echoes the path on stdout. Caller captures via $(setup_worktree_fixture).
# Returns non-zero (and emits no path) if any setup step fails — including
# git init, the seed commit, or path canonicalisation.
setup_worktree_fixture() {
  local proj
  proj=$(mktemp -d "${TMPDIR:-/tmp}/${WORKTREE_FIXTURE_PREFIX_NAME}XXXXXX") || return 1
  # macOS symlinks /var → /private/var; git worktree list --porcelain returns
  # canonical paths, so callers comparing to the fixture path need the
  # canonical form too. Resolve via `cd && pwd -P`.
  proj=$(cd "$proj" && pwd -P) || { rm -rf "$proj"; return 1; }
  # On Windows (Git Bash / MSYS), mktemp returns POSIX paths like /tmp/foo,
  # but native Windows Bun cannot resolve those. Use cygpath -m (mixed mode)
  # to produce absolute Windows paths with forward slashes — these are
  # understood by both Git Bash utilities and native Windows Bun, and round-
  # trip safely through JSON. Mirrors tests/lib/fixtures.sh:29-31.
  if command -v cygpath >/dev/null 2>&1; then
    proj=$(cygpath -m "$proj")
  fi
  # Use init + symbolic-ref instead of `git init -b main`. The -b flag
  # requires git ≥ 2.28 (March 2020); older CI runners (Ubuntu 18.04,
  # Debian buster, Amazon Linux 2) ship 2.17–2.20. The symbolic-ref form
  # works on every git version that has worktrees at all (≥ 2.5).
  if ! (
    cd "$proj" &&
    git init -q &&
    git symbolic-ref HEAD refs/heads/main &&
    echo "seed" > README.md &&
    git add README.md &&
    git -c user.email=t@x -c user.name=t commit -qm "init"
  ); then
    rm -rf "$proj"
    return 1
  fi
  echo "$proj"
}

# Assert that <path> is registered as a worktree of the git repo at <repo>.
# Uses TAP ok/not_ok from tap.sh (caller must source tap.sh first).
assert_worktree_at() {
  local repo="$1"
  local path="$2"
  if git -C "$repo" worktree list --porcelain 2>/dev/null | grep -qF "worktree $path"; then
    ok "worktree registered at $path"
  else
    not_ok "worktree registered at $path" "git worktree list does not include $path"
  fi
}

# Inverse of assert_worktree_at — fails if the worktree IS registered.
assert_worktree_absent() {
  local repo="$1"
  local path="$2"
  if git -C "$repo" worktree list --porcelain 2>/dev/null | grep -qF "worktree $path"; then
    not_ok "worktree absent at $path" "git worktree list still includes $path"
  else
    ok "worktree absent at $path"
  fi
}

# Idempotent cleanup: remove all child worktrees (errors swallowed) then
# rm -rf the parent. Refuses to act on paths outside the fixture prefix.
# Safe to call multiple times on the same path or on a missing path.
cleanup_worktree_fixture() {
  local path="$1"
  # Reject empty, whitespace-only, or unset.
  [ -n "${path// /}" ] || return 0
  # Defence in depth: only act on paths whose basename starts with the
  # fixture prefix. Refuses /, /tmp, /home, $HOME, etc. even if a caller
  # somehow constructs a colliding string.
  case "$(basename -- "$path")" in
    "${WORKTREE_FIXTURE_PREFIX_NAME}"*) ;;
    *) return 0 ;;
  esac
  if [ -d "$path" ]; then
    # Iterate worktrees and remove all non-main entries. The first `worktree`
    # line in --porcelain output is the main checkout; subsequent ones are
    # children. Errors swallowed so a partially-set-up fixture still cleans.
    local main_listed=false
    local wt
    while IFS= read -r line; do
      case "$line" in
        worktree\ *)
          wt="${line#worktree }"
          if [ "$main_listed" = false ]; then
            main_listed=true
          else
            git -C "$path" worktree remove --force "$wt" 2>/dev/null || true
          fi
          ;;
      esac
    done < <(git -C "$path" worktree list --porcelain 2>/dev/null || true)
    rm -rf "$path"
  fi
}
