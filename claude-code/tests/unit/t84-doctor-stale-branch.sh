#!/bin/bash
# t84: Unit tests for v0.4.0 MR 15 doctor stale-branch detection (5 tests).
#
# Covers Check 2 of MR 15's doctor extensions (ROADMAP.md:143). Walks
# `git branch --list 'bolt-*'`; flags any `bolt-<slug>` branch whose
# worktree directory is gone but no terminal WORKTREE_DISCARDED or
# WORKTREE_MERGED audit row landed for that slug.
#
# Tests:
#   1. Not a git repo — skips silently with informational pass
#   2. Clean git repo with zero `bolt-*` branches — passes
#   3. Stale: bolt-foo branch + no worktree + no terminal audit row → ✗
#   4. Live: bolt-foo branch + worktree dir present → ✓
#   5. Terminated: bolt-foo branch + no worktree + WORKTREE_MERGED row → ✓
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 5

# Helper: init a fresh git repo with one commit on `main`.
init_git_repo() {
  local proj="$1"
  git -C "$proj" init -b main >/dev/null 2>&1 || git -C "$proj" init >/dev/null 2>&1
  git -C "$proj" config user.email "test@example.com"
  git -C "$proj" config user.name "Test"
  git -C "$proj" config commit.gpgsign false
  echo "init" > "$proj/README.md"
  git -C "$proj" add README.md >/dev/null
  git -C "$proj" commit -m "init" >/dev/null 2>&1
  # Some git versions create master; rename if so.
  current=$(git -C "$proj" symbolic-ref --short HEAD)
  if [ "$current" != "main" ]; then
    git -C "$proj" branch -m main >/dev/null 2>&1 || true
  fi
}

# Helper: append an audit block.
append_audit() {
  local proj="$1"
  shift
  local body="$*"
  cat >> "$proj/aidlc-docs/audit.md" <<EOF

$body

---
EOF
}

# --- Test 1: Not a git repo — skip silently ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Stale branches: 0 observed (not a git repo)"; then
  ok "Stale-branch check skips silently when not a git repo"
else
  not_ok "Stale-branch check skips silently when not a git repo" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 2: Clean git repo, zero bolt-* branches ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
init_git_repo "$PROJ"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Stale branches: 0 \(0 bolt-\* observed\)"; then
  ok "Stale-branch check passes on clean git repo with zero bolt-* branches"
else
  not_ok "Stale-branch check passes on clean git repo with zero bolt-* branches" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 3: Stale (branch + no worktree + no terminal audit row) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
init_git_repo "$PROJ"
git -C "$PROJ" branch bolt-stalefoo >/dev/null
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Stale branches: 1 drift" && echo "$out" | grep -q "stalefoo"; then
  ok "Stale branch flagged when worktree dir absent and no terminal audit row"
else
  not_ok "Stale branch flagged when worktree dir absent and no terminal audit row" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Live (branch + worktree dir present) — not flagged ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
init_git_repo "$PROJ"
git -C "$PROJ" branch bolt-livefoo >/dev/null
mkdir -p "$PROJ/.aidlc/worktrees/bolt-livefoo"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Stale branches: 0 \(1 bolt-\* observed\)"; then
  ok "Live branch (worktree dir present) is not flagged as stale"
else
  not_ok "Live branch (worktree dir present) is not flagged as stale" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 5: Terminated (branch + no worktree + WORKTREE_MERGED) — not flagged ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
init_git_repo "$PROJ"
git -C "$PROJ" branch bolt-mergedfoo >/dev/null
append_audit "$PROJ" "## Worktree Merged
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: WORKTREE_MERGED
**Bolt slug**: mergedfoo
**Worktree path**: /tmp/bolt-mergedfoo
**Target branch**: main
**Strategy**: squash"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Stale branches: 0 \(1 bolt-\* observed\)"; then
  ok "Terminated branch (WORKTREE_MERGED row present) is not flagged as stale"
else
  not_ok "Terminated branch (WORKTREE_MERGED row present) is not flagged as stale" "got:\n$out"
fi
cleanup_test_project "$PROJ"

finish
