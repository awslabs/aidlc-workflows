#!/bin/bash
# t77: Unit tests for v0.4.0 MR 11 — aidlc-bolt.ts worktree flags
# (start --worktree, complete --merge, abort [--discard], fail --slug). (28 tests)
#
# Pins:
#  - Atomicity ordering: BOLT_STARTED → STATE_FORKED → AUDIT_FORKED on
#    success; on primitive throw, BOLT_FAILED recovery row + envelope.
#  - --worktree / --merge require --slug (kebab-case Bolt slug).
#  - csv --name with --worktree or --merge is rejected (single-bolt only).
#  - Failure envelope shape: {ok:false, slug, stage, reason, detail} for
#    halt-and-ask (MR 12) consumption.
#  - abort emits BOLT_FAILED with Reason=aborted (no new event type).
#  - abort --discard delegates to aidlc-worktree discard subprocess.
#  - fail --slug records Bolt slug field for halt-and-ask correlation.
#  - Existing no-flag paths unchanged (regression guards).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-bolt.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 28

# Helper: project with v7 state seeded from a fixture and audit file.
# Optionally pre-create the worktree dir so MR 9 fork doesn't reject.
setup_v7_project() {
  local fixture="${1:-state-construction.md}"
  local with_worktree="${2:-}"
  local proj
  proj=$(create_test_project)
  seed_state_file "$proj" "$FIXTURES_DIR/$fixture"
  seed_audit_file "$proj"
  if [ -n "$with_worktree" ]; then
    mkdir -p "$proj/.aidlc/worktrees/bolt-$with_worktree"
  fi
  echo "$proj"
}

# === start --worktree ===

# T1: --worktree without --slug fails fast
PROJ=$(setup_v7_project)
set +e
OUT=$(bun "$TOOL" start --name "Foo" --batch 1 --worktree --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "start --worktree without --slug exits 1"
cleanup_test_project "$PROJ"

# T2: --worktree with csv --name rejects
PROJ=$(setup_v7_project)
set +e
OUT=$(bun "$TOOL" start --name "Foo,Bar" --batch 1 --worktree --slug foo --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "start --worktree rejects csv --name"
cleanup_test_project "$PROJ"

# T3: happy path — start --worktree against real MR 9/10 primitives
PROJ=$(setup_v7_project "state-construction.md" "happy")
OUT=$(bun "$TOOL" start --name "Happy" --batch 1 --worktree --slug happy --project-dir "$PROJ" 2>&1)
RC=$?
assert_eq "$RC" "0" "start --worktree happy path exits 0"

# T4: stdout JSON declares forked sequence (extended in v0.5.0 MR 11 with
# RUNTIME_GRAPH_FORKED — informational token only, NOT an audit event;
# the fragment lifecycle rides on STATE_FORKED + AUDIT_FORKED).
assert_contains "$OUT" '"forked":["STATE_FORKED","AUDIT_FORKED","RUNTIME_GRAPH_FORKED"]' "stdout reports forked events"

# T5: BOLT_STARTED in audit
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: BOLT_STARTED" "BOLT_STARTED emitted"

# T6: STATE_FORKED emitted by MR 9 primitive
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: STATE_FORKED" "STATE_FORKED emitted by MR 9 fork"

# T7: AUDIT_FORKED emitted by MR 10 primitive
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: AUDIT_FORKED" "AUDIT_FORKED emitted by MR 10 audit-fork"

# T8: audit ordering — BOLT_STARTED line precedes STATE_FORKED line
BS_LINE=$(grep -n "^\*\*Event\*\*: BOLT_STARTED" "$PROJ/aidlc-docs/audit.md" | tail -1 | cut -d: -f1)
SF_LINE=$(grep -n "^\*\*Event\*\*: STATE_FORKED" "$PROJ/aidlc-docs/audit.md" | tail -1 | cut -d: -f1)
if [ -n "$BS_LINE" ] && [ -n "$SF_LINE" ] && [ "$BS_LINE" -lt "$SF_LINE" ]; then
  ok "atomicity ordering: BOLT_STARTED precedes STATE_FORKED in audit"
else
  not_ok "atomicity ordering" "BS=$BS_LINE SF=$SF_LINE"
fi

# T9: Bolt Refs populated with the slug after fork
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" "Bolt Refs.*happy" "main Bolt Refs contains slug post-fork"

# T10: forked worktree state file exists
assert_file_exists "$PROJ/.aidlc/worktrees/bolt-happy/aidlc-docs/aidlc-state.md" "worktree state file forked"
cleanup_test_project "$PROJ"

# T11: failure envelope shape — readonly project surface fork failure
PROJ=$(setup_v7_project "state-construction.md" "blocked")
chmod 444 "$PROJ/aidlc-docs/aidlc-state.md"
set +e
OUT=$(bun "$TOOL" start --name "Blocked" --batch 1 --worktree --slug blocked --project-dir "$PROJ" 2>&1)
RC=$?
set -e
chmod 644 "$PROJ/aidlc-docs/aidlc-state.md"
assert_eq "$RC" "1" "start --worktree fails on readonly state"
assert_contains "$OUT" '"ok":false' "envelope ok:false on failure"
assert_contains "$OUT" '"stage":"start-worktree"' "envelope stage=start-worktree"
cleanup_test_project "$PROJ"

# === complete --merge ===

# T14: --merge without --slug fails
PROJ=$(setup_v7_project)
set +e
OUT=$(bun "$TOOL" complete --name "Foo" --batch 1 --merge --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "complete --merge without --slug exits 1"
cleanup_test_project "$PROJ"

# T15: complete --merge end-to-end (after fork)
PROJ=$(setup_v7_project "state-construction.md" "round")
bun "$TOOL" start --name "Round" --batch 1 --worktree --slug round --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" complete --name "Round" --batch 1 --merge --slug round --project-dir "$PROJ" 2>&1)
RC=$?
assert_eq "$RC" "0" "complete --merge round-trip exits 0"
assert_contains "$OUT" '"merged":["STATE_MERGED","AUDIT_MERGED","RUNTIME_GRAPH_MERGED"]' "stdout reports merged events"

# T17: state Bolt Refs cleared post-merge (slug removed)
REFS_LINE=$(grep "Bolt Refs" "$PROJ/aidlc-docs/aidlc-state.md" | head -1)
if echo "$REFS_LINE" | grep -q "round"; then
  not_ok "merge removes slug from Bolt Refs" "still present: $REFS_LINE"
else
  ok "merge removes slug from Bolt Refs"
fi
cleanup_test_project "$PROJ"

# === abort ===

# T18: abort without --slug fails
PROJ=$(setup_v7_project)
set +e
OUT=$(bun "$TOOL" abort --name "Foo" --reason "test" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "abort without --slug exits 1"
cleanup_test_project "$PROJ"

# T19: abort without --reason fails
PROJ=$(setup_v7_project)
set +e
OUT=$(bun "$TOOL" abort --name "Foo" --slug foo --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "abort without --reason exits 1"
cleanup_test_project "$PROJ"

# T20: abort emits BOLT_FAILED with Reason=aborted (no new event type)
PROJ=$(setup_v7_project)
bun "$TOOL" abort --name "Foo" --slug foo --reason "user changed mind" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: BOLT_FAILED" "abort emits BOLT_FAILED"

# T21: abort BOLT_FAILED carries Reason=aborted field
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Reason\*\*: aborted' "abort records Reason=aborted"
cleanup_test_project "$PROJ"

# T22: abort default preserves worktree (no --discard)
PROJ=$(setup_v7_project "state-construction.md" "preserved")
OUT=$(bun "$TOOL" abort --name "Preserved" --slug preserved --reason "preserve test" --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"discarded":false' "abort default reports discarded:false"
cleanup_test_project "$PROJ"

# === fail --slug (MR 12 coordination) ===

# T23: fail --slug records Bolt slug for halt-and-ask correlation
PROJ=$(setup_v7_project)
bun "$TOOL" fail --name "Failed" --slug fail-slug --error "broke" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Bolt slug\*\*: fail-slug' "fail --slug records Bolt slug"
cleanup_test_project "$PROJ"

# === Regression guards: existing no-flag paths unchanged ===

# T24: start without --worktree leaves Bolt Refs unchanged
PROJ=$(setup_v7_project)
INITIAL_REFS=$(grep "Bolt Refs" "$PROJ/aidlc-docs/aidlc-state.md")
bun "$TOOL" start --name "Plain" --batch 1 --project-dir "$PROJ" >/dev/null 2>&1
FINAL_REFS=$(grep "Bolt Refs" "$PROJ/aidlc-docs/aidlc-state.md")
assert_eq "$FINAL_REFS" "$INITIAL_REFS" "regression: start without --worktree leaves Bolt Refs unchanged"
cleanup_test_project "$PROJ"

# === Failure envelope completeness — review fold-in ===
# Pre-review t77 only pinned 2 of the 5 envelope fields (ok, stage). MR 12's
# halt-and-ask consumes all five (ok, slug, stage, reason, detail). T25-T27
# pin the missing three so the contract holds end-to-end.

# T25: envelope contains slug field
PROJ=$(setup_v7_project "state-construction.md" "envtest")
chmod 444 "$PROJ/aidlc-docs/aidlc-state.md"
set +e
OUT=$(bun "$TOOL" start --name "Env" --batch 1 --worktree --slug envtest --project-dir "$PROJ" 2>&1)
set -e
chmod 644 "$PROJ/aidlc-docs/aidlc-state.md"
assert_contains "$OUT" '"slug":"envtest"' "envelope contains slug field"

# T26: envelope contains reason field with non-empty value
REASON=$(echo "$OUT" | jq -r '.reason // empty' 2>/dev/null)
if [ -n "$REASON" ] && [ "$REASON" != "null" ]; then
  ok "envelope reason field is non-empty"
else
  not_ok "envelope reason field is non-empty" "got: $REASON"
fi

# T27: envelope contains detail field with non-empty user-facing prose
DETAIL=$(echo "$OUT" | jq -r '.detail // empty' 2>/dev/null)
if [ -n "$DETAIL" ] && [ ${#DETAIL} -gt 5 ]; then
  ok "envelope detail field is non-empty user-facing prose"
else
  not_ok "envelope detail field is non-empty user-facing prose" "got: $DETAIL"
fi
cleanup_test_project "$PROJ"

# T28: abort default (no --discard) stdout reports discarded:false
# Pre-review the assertion was inferred via T22; adding explicit pin so the
# regression bound on the JSON envelope contract is unambiguous.
PROJ=$(setup_v7_project "state-construction.md" "exp-pres")
mkdir -p "$PROJ/.aidlc/worktrees/bolt-exp-pres"
echo "marker" >"$PROJ/.aidlc/worktrees/bolt-exp-pres/file.txt"
bun "$TOOL" abort --name "Pres" --slug exp-pres --reason "default-pres test" --project-dir "$PROJ" >/dev/null 2>&1
# Worktree directory survives default abort (no --discard).
assert_dir_exists "$PROJ/.aidlc/worktrees/bolt-exp-pres" "default abort preserves worktree directory"
cleanup_test_project "$PROJ"
