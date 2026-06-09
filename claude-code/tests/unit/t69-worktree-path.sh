#!/bin/bash
# t69: worktreePath() helper composes Construction-Bolt worktree paths from
# projectDir + boltSlug. v0.4.0 MR 2 introduces this primitive; MR 7's
# aidlc-worktree.ts will consume it. Pure path construction — no I/O, no
# validation. Companion to stateFilePath() and auditFilePath() in lib.ts.
#
# Test design note: assert behavioural contracts independent of the
# implementation, NOT path.join(...) parity. A test that compares the
# helper to its own implementation only catches deletion. The four
# assertions below catch real regressions:
#   1. .gitignore has the anchored /.aidlc/ entry (static)
#   2. Output is absolute when projectDir is absolute (path shape)
#   3. Output ends with /bolt-<slug> (prefix contract — catches dropping
#      the bolt- literal or the slug)
#   4. Slug containing '/' passes through verbatim (pins the "no
#      validation in MR 2" decision; MR 7 validates at create-time)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 4

# --- Test 1: anchored /.aidlc/ entry in repo .gitignore ---
# Anchored (leading /) so .aidlc/ inside node_modules or nested packages
# isn't silently swallowed. The framework only ever writes .aidlc/ at the
# repo root, alongside .claude/.
assert_grep "$REPO_ROOT/.gitignore" '^/\.aidlc/$' \
  ".gitignore contains anchored /.aidlc/ entry"

# --- Shared bun probe used by tests 2-4 ---
# One bun invocation produces three lines of probe output, parsed below.
# Reduces wall time vs. spawning bun per assertion.
LIB="$AIDLC_SRC/tools/aidlc-lib.ts"
PROJ=$(setup_integration_project --no-aidlc-docs)
PROBE=$(bun -e "
  import { worktreePath } from '$LIB';
  import { isAbsolute } from 'path';
  const projectDir = '$PROJ';
  const normalSlug = 'demo';
  const traversalSlug = 'a/b';
  console.log('ABSOLUTE=' + isAbsolute(worktreePath(projectDir, normalSlug)));
  console.log('NORMAL=' + worktreePath(projectDir, normalSlug));
  console.log('TRAVERSAL=' + worktreePath(projectDir, traversalSlug));
" 2>&1)

# --- Test 2: output is absolute when projectDir is absolute ---
# Catches an implementation that returned a relative path or accidentally
# lost the projectDir prefix. The fixture's projectDir is always absolute.
ABSOLUTE=$(echo "$PROBE" | grep '^ABSOLUTE=' | cut -d= -f2)
assert_eq "$ABSOLUTE" "true" \
  "worktreePath() returns an absolute path when projectDir is absolute"

# --- Test 3: output ends with bolt-<slug> ---
# Prefix contract. Catches dropping the literal "bolt-", dropping the
# slug, or appending an extra path component. Compared to path.join
# parity testing, this asserts a property the consumer actually relies
# on (MR 7's `git worktree add <path>` invocation expects the leaf to
# be bolt-<slug>).
NORMAL=$(echo "$PROBE" | grep '^NORMAL=' | cut -d= -f2-)
assert_match "$NORMAL" '/bolt-demo$' \
  "worktreePath(projectDir, 'demo') ends with /bolt-demo"

# --- Test 4: slug containing '/' passes through verbatim ---
# Pins the "no validation in MR 2" decision (see Decision 1 in
# tmp/v04-mr2-decisions.html — validation deferred to MR 7's
# aidlc-worktree.ts at create-time). If a future change adds slug
# sanitisation here without going through the MR 7 design, this test
# fails and forces a conscious decision.
TRAVERSAL=$(echo "$PROBE" | grep '^TRAVERSAL=' | cut -d= -f2-)
assert_match "$TRAVERSAL" '/bolt-a/b$' \
  "worktreePath() does not validate or sanitise the slug (MR 2 contract)"

cleanup_test_project "$PROJ"

finish
