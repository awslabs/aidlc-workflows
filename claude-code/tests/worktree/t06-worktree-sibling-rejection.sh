#!/bin/bash
# t71: aidlc-worktree refuses to run from inside a sibling worktree.
#
# Construction's bolt-* worktrees are siblings of the main checkout, not
# nested. Running aidlc-worktree from inside a sibling can corrupt git's
# worktree registry; the tool's pre-audit check rejects the call with a
# helpful message.
#
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

plan 3

TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"
fixture=""
trap '
  [ -n "$fixture" ] && cleanup_worktree_fixture "$fixture" || true
' EXIT

# Setup: create a fixture and a sibling worktree (mimics .claude/worktrees/<dev-slug>/).
fixture=$(setup_worktree_fixture)
mkdir -p "$fixture/aidlc-docs"
SIBLING="$fixture/.claude/worktrees/dev-slug"
git -C "$fixture" worktree add -q "$SIBLING" -b dev-branch >/dev/null 2>&1
mkdir -p "$SIBLING/aidlc-docs"

# Run aidlc-worktree from inside the sibling. The tool should reject pre-audit.
set +e
OUT=$(cd "$SIBLING" && bun "$TOOL" create --slug demo --base main --project-dir "$SIBLING" 2>&1)
RC=$?
set -e

assert_not_eq "$RC" "0" "create from sibling worktree exits non-zero"
assert_contains "$OUT" "must run from the main repo checkout" \
  "error message names the main-checkout requirement"
assert_contains "$OUT" "siblings of the main checkout, not nested" \
  "error message explains the siblings-vs-nested distinction"

finish
