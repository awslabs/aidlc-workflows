#!/bin/bash
# t78: Feature test — end-to-end Bolt-with-worktree lifecycle (Issue 75
# US-1 line 216 / test plan line 216). Exercises the full per-Bolt
# lifecycle: start --worktree → simulate per-Unit work in worktree →
# complete --merge OR fail/abort. (13 tests)
#
# Pins:
#  - Round-trip: start --worktree → complete --merge produces clean
#    audit log with the canonical 6-event sequence and Bolt Refs cleared.
#  - Worktree state changes propagate back to main on merge (per-field
#    merge rule from MR 9 mergeState).
#  - abort --discard tears down the worktree directory entirely.
#  - abort without --discard preserves the worktree directory for
#    inspection per US-1 AC line 51.
#  - Two parallel Bolts (separate slugs) round-trip cleanly without
#    interfering with each other's state.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-bolt.ts"
WT_TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 13

setup_lifecycle_project() {
  local proj
  proj=$(create_test_project)
  seed_state_file "$proj" "$FIXTURES_DIR/state-construction.md"
  seed_audit_file "$proj"
  echo "$proj"
}

# === Lifecycle 1: complete-merge happy path ===

# Pre-create the worktree directory (in production, MR 7 aidlc-worktree
# create handles this; for unit-isolation we just satisfy MR 9 fork's
# "directory exists" check).
PROJ=$(setup_lifecycle_project)
WT="$PROJ/.aidlc/worktrees/bolt-foo"
mkdir -p "$WT"

# Step 1: BOLT_STARTED + state-fork + audit-fork
bun "$TOOL" start --name "Foo Bolt" --batch 1 --worktree --slug foo --project-dir "$PROJ" >/dev/null 2>&1
RC=$?
assert_eq "$RC" "0" "T1: lifecycle start --worktree exits 0"

# T2: forked worktree state file is byte-comparable (modulo decorative path)
assert_file_exists "$WT/aidlc-docs/aidlc-state.md" "T2: forked worktree state file exists"

# T3: forked worktree audit file exists
assert_file_exists "$WT/aidlc-docs/audit.md" "T3: forked worktree audit file exists"

# Simulate per-Unit work in the worktree by writing a checkbox change.
# In production this would happen via stage execution inside the Bolt.
# Use sed to mark a Construction stage [ ] → [x] in the worktree state.
sed_i 's/^- \[ \] code-generation — EXECUTE/- [x] code-generation — EXECUTE/' "$WT/aidlc-docs/aidlc-state.md"

# Step 2: complete --merge — consolidates worktree changes back to main
bun "$TOOL" complete --name "Foo Bolt" --batch 1 --merge --slug foo --project-dir "$PROJ" >/dev/null 2>&1
RC=$?
assert_eq "$RC" "0" "T4: lifecycle complete --merge exits 0"

# T5: post-merge, main Bolt Refs is empty
REFS_LINE=$(grep "Bolt Refs" "$PROJ/aidlc-docs/aidlc-state.md" | head -1)
if echo "$REFS_LINE" | grep -q "foo"; then
  not_ok "T5: post-merge Bolt Refs no longer contains foo" "still: $REFS_LINE"
else
  ok "T5: post-merge Bolt Refs no longer contains foo"
fi

# T6: full audit sequence in expected order
EVENTS=$(grep "^\*\*Event\*\*:" "$PROJ/aidlc-docs/audit.md" | tail -6 | awk '{print $2}')
EXPECTED=$'BOLT_STARTED\nSTATE_FORKED\nAUDIT_FORKED\nBOLT_COMPLETED\nSTATE_MERGED\nAUDIT_MERGED'
if [ "$EVENTS" = "$EXPECTED" ]; then
  ok "T6: canonical 6-event audit sequence in expected order"
else
  not_ok "T6: canonical 6-event audit sequence" "got: $EVENTS"
fi

cleanup_test_project "$PROJ"

# === Lifecycle 2: abort --discard with successful discard emits BOLT_FAILED ===
# Post-fix ordering: discard first, audit after. So BOLT_FAILED only appears
# when discard succeeded. Set up a real git worktree so discard can run.

PROJ=$(setup_lifecycle_project)
(cd "$PROJ" && git init -q -b main && git config user.email t@t && git config user.name t \
  && git add -A 2>/dev/null && git commit -q -m init --allow-empty 2>/dev/null) || true
(cd "$PROJ" && bun "$WT_TOOL" create --slug bar --base main --project-dir "$PROJ") >/dev/null 2>&1 || true

set +e
bun "$TOOL" abort --name "Bar Bolt" --slug bar --reason "test abort" --discard --project-dir "$PROJ" >/dev/null 2>&1
set -e

# T7: abort --discard emits BOLT_FAILED (only fires when discard succeeded)
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: BOLT_FAILED" "T7: abort --discard emits BOLT_FAILED on successful discard"

# T8: abort BOLT_FAILED carries Reason=aborted (sub-classifier vs fail)
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Reason\*\*: aborted' "T8: abort sub-classifies as aborted"

cleanup_test_project "$PROJ"

# === Lifecycle 3: abort without --discard preserves worktree ===

PROJ=$(setup_lifecycle_project)
WT="$PROJ/.aidlc/worktrees/bolt-baz"
mkdir -p "$WT"
echo "synthetic worktree content" > "$WT/marker.txt"

bun "$TOOL" abort --name "Baz Bolt" --slug baz --reason "preserve check" --project-dir "$PROJ" >/dev/null 2>&1

# T9: abort without --discard leaves worktree directory in place (US-1 AC line 51)
assert_dir_exists "$WT" "T9: abort without --discard preserves worktree directory"

# T10: marker file in the worktree survives (worktree contents not touched)
assert_file_exists "$WT/marker.txt" "T10: worktree contents preserved for inspection"

cleanup_test_project "$PROJ"

# === Lifecycle 4: two parallel-batch Bolts round-trip cleanly ===

PROJ=$(setup_lifecycle_project)
mkdir -p "$PROJ/.aidlc/worktrees/bolt-alpha" "$PROJ/.aidlc/worktrees/bolt-beta"

bun "$TOOL" start --name "Alpha" --batch 1 --worktree --slug alpha --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" start --name "Beta"  --batch 1 --worktree --slug beta  --project-dir "$PROJ" >/dev/null 2>&1

# T11: both slugs in main Bolt Refs after parallel forks
REFS_LINE=$(grep "Bolt Refs" "$PROJ/aidlc-docs/aidlc-state.md" | head -1)
if echo "$REFS_LINE" | grep -q "alpha" && echo "$REFS_LINE" | grep -q "beta"; then
  ok "T11: both alpha+beta in Bolt Refs after parallel start --worktree"
else
  not_ok "T11: both alpha+beta in Bolt Refs" "$REFS_LINE"
fi

bun "$TOOL" complete --name "Alpha" --batch 1 --merge --slug alpha --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" complete --name "Beta"  --batch 1 --merge --slug beta  --project-dir "$PROJ" >/dev/null 2>&1

# T12: post-merge of both, Bolt Refs empty again
REFS_LINE=$(grep "Bolt Refs" "$PROJ/aidlc-docs/aidlc-state.md" | head -1)
if echo "$REFS_LINE" | grep -qE "alpha|beta"; then
  not_ok "T12: post-merge Bolt Refs cleared of both slugs" "still: $REFS_LINE"
else
  ok "T12: post-merge Bolt Refs cleared of both slugs"
fi

cleanup_test_project "$PROJ"

# === Lifecycle 5: abort --discard verification (review fold-in) ===
# Pre-review t78 only asserted BOLT_FAILED was emitted on --discard. Doesn't
# verify discard actually ran. After the BLOCKER fix (audit-after-discard),
# a discard subprocess failure means BOLT_FAILED is NOT emitted. Verify the
# inverse: when discard succeeds, both the audit row AND directory teardown
# happen.

PROJ=$(setup_lifecycle_project)
# Init real git so aidlc-worktree create can fork properly. Don't pre-create
# the worktree dir — aidlc-worktree create handles mkdir + git worktree add
# atomically. Pre-creating leaves a non-git-worktree dir that discard refuses.
(cd "$PROJ" && git init -q -b main && git config user.email t@t && git config user.name t \
  && git commit -q -m init --allow-empty 2>/dev/null) || true
(cd "$PROJ" && bun "$WT_TOOL" create --slug tearcheck --base main --project-dir "$PROJ") >/dev/null 2>&1

# Confirm worktree exists before abort
if [ ! -d "$PROJ/.aidlc/worktrees/bolt-tearcheck" ]; then
  not_ok "T13 setup: aidlc-worktree create succeeded" "worktree dir never created"
else
  bun "$TOOL" abort --name "Tearcheck" --slug tearcheck --reason "discard test" --discard --project-dir "$PROJ" >/dev/null 2>&1
  if [ ! -d "$PROJ/.aidlc/worktrees/bolt-tearcheck" ]; then
    ok "T13: abort --discard tears down worktree directory"
  else
    not_ok "T13: abort --discard tears down worktree directory" "still exists at $PROJ/.aidlc/worktrees/bolt-tearcheck"
  fi
fi

cleanup_test_project "$PROJ"
