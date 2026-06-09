#!/bin/bash
# t82: Unit tests for v0.4.0 MR 13 post-merge fold-in — HOLD-MERGE invariant
# tooling on aidlc-bolt.ts (hold-merge / release-merge subcommands +
# complete --merge refusal when held). (10 tests)
#
# Pins:
#  - hold-merge --slug <slug> sets Merge-Held: true in the per-Bolt forked
#    state file at <wt>/aidlc-docs/aidlc-state.md.
#  - release-merge --slug <slug> sets Merge-Held: false.
#  - complete --merge --slug <slug> refuses with non-zero exit and a
#    {ok:false, reason:"merge-held", ...} envelope when held; succeeds after
#    release-merge clears the marker.
#  - hold-merge / release-merge are idempotent (second call same outcome).
#  - hold-merge errors if the Bolt has no per-Bolt forked state file (i.e.
#    `aidlc-bolt start --worktree` was not run for the slug).

set -euo pipefail
T_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$T_DIR/../lib/tap.sh"
source "$T_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-bolt.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 10

# Helper: project with a forked Bolt at slug $1 ready for hold-merge tests.
setup_forked_project() {
  local slug="$1"
  local proj
  proj=$(create_test_project)
  seed_state_file "$proj" "$FIXTURES_DIR/state-construction.md"
  seed_audit_file "$proj"
  mkdir -p "$proj/.aidlc/worktrees/bolt-$slug"
  bun "$TOOL" start --name "Bolt$slug" --batch 1 --worktree --slug "$slug" \
    --project-dir "$proj" >/dev/null 2>&1
  echo "$proj"
}

# === hold-merge / release-merge basics ===

# T1: hold-merge --slug sets Merge-Held: true in the forked state file
PROJ=$(setup_forked_project hm1)
bun "$TOOL" hold-merge --slug hm1 --project-dir "$PROJ" >/dev/null 2>&1
WT_STATE="$PROJ/.aidlc/worktrees/bolt-hm1/aidlc-docs/aidlc-state.md"
if grep -q "^- \*\*Merge-Held\*\*: true" "$WT_STATE"; then
  ok "hold-merge sets Merge-Held: true in forked state"
else
  not_ok "hold-merge sets Merge-Held: true in forked state" "field missing or wrong value"
fi
cleanup_test_project "$PROJ"

# T2: release-merge --slug clears Merge-Held to false
PROJ=$(setup_forked_project hm2)
bun "$TOOL" hold-merge --slug hm2 --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" release-merge --slug hm2 --project-dir "$PROJ" >/dev/null 2>&1
WT_STATE="$PROJ/.aidlc/worktrees/bolt-hm2/aidlc-docs/aidlc-state.md"
if grep -q "^- \*\*Merge-Held\*\*: false" "$WT_STATE"; then
  ok "release-merge sets Merge-Held: false in forked state"
else
  not_ok "release-merge sets Merge-Held: false in forked state" "field missing or wrong value"
fi
cleanup_test_project "$PROJ"

# T3: hold-merge stdout JSON envelope shape
PROJ=$(setup_forked_project hm3)
OUT=$(bun "$TOOL" hold-merge --slug hm3 --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"slug":"hm3"' "hold-merge stdout includes slug"
cleanup_test_project "$PROJ"

# T4: release-merge stdout JSON envelope shape
PROJ=$(setup_forked_project hm4)
OUT=$(bun "$TOOL" release-merge --slug hm4 --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"merge_held":false' "release-merge stdout reports merge_held:false"
cleanup_test_project "$PROJ"

# === complete --merge refusal ===

# T5: complete --merge refuses while Merge-Held is true
PROJ=$(setup_forked_project hm5)
bun "$TOOL" hold-merge --slug hm5 --project-dir "$PROJ" >/dev/null 2>&1
set +e
OUT=$(bun "$TOOL" complete --name "Hm5" --batch 1 --merge --slug hm5 --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "complete --merge refuses with non-zero exit when held"

# T6: refusal envelope reason is merge-held
assert_contains "$OUT" '"reason":"merge-held"' "complete --merge refusal envelope reports reason=merge-held"

# T7: refusal envelope detail names the release-merge subcommand
assert_contains "$OUT" "release-merge" "complete --merge refusal detail names release-merge"

# T8: BOLT_COMPLETED was NOT emitted under refusal
if grep -q "^\*\*Event\*\*: BOLT_COMPLETED" "$PROJ/aidlc-docs/audit.md"; then
  not_ok "complete --merge refusal does not emit BOLT_COMPLETED" "BOLT_COMPLETED present in audit"
else
  ok "complete --merge refusal does not emit BOLT_COMPLETED"
fi
cleanup_test_project "$PROJ"

# T9: complete --merge proceeds after release-merge clears the hold
PROJ=$(setup_forked_project hm9)
bun "$TOOL" hold-merge --slug hm9 --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" release-merge --slug hm9 --project-dir "$PROJ" >/dev/null 2>&1
set +e
OUT=$(bun "$TOOL" complete --name "Hm9" --batch 1 --merge --slug hm9 --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "0" "complete --merge proceeds after release-merge"
cleanup_test_project "$PROJ"

# T10: hold-merge errors when no forked state file exists for the slug
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction.md"
seed_audit_file "$PROJ"
set +e
OUT=$(bun "$TOOL" hold-merge --slug nonexistent --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "hold-merge errors when forked state absent"
cleanup_test_project "$PROJ"

finish
