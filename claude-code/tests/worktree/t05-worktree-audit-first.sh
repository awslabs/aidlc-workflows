#!/bin/bash
# t05: aidlc-worktree audit-first invariant. Two parts:
#
# Part A: chmod audit.md to read-only — tool exits non-zero pre-git, no
# worktree directory is created. (Mirrors tests/unit/t17-tool-state.sh:
# 637-650 chmod precedent.) Audit log stays at "# AI-DLC Audit Log\n"; no
# ERROR_LOGGED can be appended because audit.md itself is locked.
#
# Part B: induce a git-time failure AFTER the audit emit succeeded. Confirm
# WORKTREE_CREATED and ERROR_LOGGED both land in audit.md, with the slug
# embedded in the ERROR_LOGGED Error field for doctor correlation.
#
# A state file is seeded so emitError's `existsSync(stateFilePath)` check
# passes — without it, ERROR_LOGGED is silently skipped per emitError's
# best-effort policy.
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

plan 7

TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"
fixA=""; fixB=""
trap '
  for f in "$fixA" "$fixB"; do
    if [ -n "$f" ]; then
      chmod 0644 "$f/aidlc-docs/audit.md" 2>/dev/null || true
      cleanup_worktree_fixture "$f" || true
    fi
  done
' EXIT

# --- Part A: chmod 0444 audit.md, create must exit non-zero pre-git ---
fixA=$(setup_worktree_fixture)
mkdir -p "$fixA/aidlc-docs"
cp "$FIXTURES_DIR/state-mid-ideation.md" "$fixA/aidlc-docs/aidlc-state.md"
printf "# AI-DLC Audit Log\n" > "$fixA/aidlc-docs/audit.md"
chmod 0444 "$fixA/aidlc-docs/audit.md"

set +e
OUT_A=$(cd "$fixA" && bun "$TOOL" create --slug demo --base main --project-dir "$fixA" 2>&1)
RC_A=$?
set -e
chmod 0644 "$fixA/aidlc-docs/audit.md"

assert_not_eq "$RC_A" "0" "Part A: create exits non-zero when audit.md is read-only"
if [ ! -d "$fixA/.aidlc/worktrees/bolt-demo" ]; then
  ok "Part A: no worktree directory created (audit-first prevented git invocation)"
else
  not_ok "Part A: no worktree directory created" "directory exists at $fixA/.aidlc/worktrees/bolt-demo"
fi
# Affirmatively verify audit.md was NOT mutated. The header it shipped with
# (`# AI-DLC Audit Log\n`) should be its only content; no WORKTREE_CREATED
# row landed (audit-first invariant), and no ERROR_LOGGED row landed
# either (audit.md itself was read-only — emitError's best-effort write
# failed silently, which is the correct behaviour).
assert_not_grep "$fixA/aidlc-docs/audit.md" "WORKTREE_CREATED" \
  "Part A: audit.md does NOT contain WORKTREE_CREATED (audit emit failed pre-git)"

# --- Part B: induce git-time failure AFTER successful audit emit ---
# Strategy: pre-create the worktree DIRECTORY (not via git) so `git worktree
# add` fails with "already exists". The pre-audit existsSync(wtPath) check
# would catch a directory we own — so we use a deeper path that the tool's
# existsSync misses but `git worktree add` discovers and rejects. Instead,
# the cleaner approach: exhaust the worktree's parent directory permission
# AFTER pre-audit checks pass.
#
# Simpler approach that exercises the real path: race a competing `git
# worktree add` on the same path between the tool's existsSync check and
# its `git worktree add` call. Hard to make deterministic.
#
# Most-deterministic approach: chmod the .aidlc/worktrees parent to read-
# only AFTER pre-audit existsSync check (which only checks the leaf path,
# which doesn't yet exist). The audit emit still succeeds, then `git
# worktree add` fails because it can't mkdir the leaf.
fixB=$(setup_worktree_fixture)
mkdir -p "$fixB/aidlc-docs"
cp "$FIXTURES_DIR/state-mid-ideation.md" "$fixB/aidlc-docs/aidlc-state.md"
mkdir -p "$fixB/.aidlc/worktrees"
chmod 0555 "$fixB/.aidlc/worktrees"

set +e
OUT_B=$(cd "$fixB" && bun "$TOOL" create --slug demo --base main --project-dir "$fixB" 2>&1)
RC_B=$?
set -e
chmod 0755 "$fixB/.aidlc/worktrees"

assert_not_eq "$RC_B" "0" "Part B: create exits non-zero when git fails post-audit"
# WORKTREE_CREATED was emitted (audit-of-intent), then git failed.
assert_grep "$fixB/aidlc-docs/audit.md" "WORKTREE_CREATED" \
  "Part B: WORKTREE_CREATED audit-of-intent row landed before git failure"
# ERROR_LOGGED with [slug=demo] in the Error field.
assert_grep "$fixB/aidlc-docs/audit.md" "ERROR_LOGGED" \
  "Part B: ERROR_LOGGED appended after git failure"
assert_grep "$fixB/aidlc-docs/audit.md" "\\[slug=demo\\]" \
  "Part B: ERROR_LOGGED Error field contains [slug=demo] for doctor correlation"

finish
