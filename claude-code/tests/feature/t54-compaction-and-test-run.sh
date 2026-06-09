#!/bin/bash
# t54: Structural assertions for the --test-run terminal state (4 tests).
#
# The former tests 1-4 (the compaction-awareness flow in SKILL.md — Session Check
# reading compaction_pending, the Continue/Review/Restart AskUserQuestion, the
# acknowledge-compaction wiring) were RETIRED at the engine cutover. That
# resume/compaction dispatch prose was deleted from SKILL.md; the engine's
# resume branch (`next --resume`) now emits an `ask` directive (covered by the
# t118 differential corpus). NOTE: the engine's resume `ask` does NOT yet
# reproduce the compaction-pending nuance (the three-option Continue/Review/
# Restart sub-flow + acknowledge-compaction) — that is a tracked engine gap to
# wire into the engine's resume directive, NOT prose to re-add to SKILL.md.
#
# Test-run terminal state (aidlc-jump.ts) — unaffected by the cutover:
#   - `--test-run` with a jump target emits WORKFLOW_COMPLETED with
#     Reason=test-run-stopped-at-<target> and sets Status=Completed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

plan 4

JUMP="$AIDLC_SRC/tools/aidlc-jump.ts"

# --- Test-run terminal state (structural on aidlc-jump.ts) ---

# Test 1: --test-run flag recognized in jump tool
if grep -qE 'testRunMode|test-run' "$JUMP"; then
  ok "aidlc-jump.ts recognizes --test-run flag"
else
  not_ok "aidlc-jump.ts recognizes --test-run flag" "no --test-run handling found"
fi

# Test 2: Emits WORKFLOW_COMPLETED with Reason=test-run-stopped-at-<target>
if grep -q 'test-run-stopped-at' "$JUMP"; then
  ok "aidlc-jump.ts emits WORKFLOW_COMPLETED with Reason=test-run-stopped-at-<target>"
else
  not_ok "aidlc-jump.ts emits WORKFLOW_COMPLETED with Reason=test-run-stopped-at-<target>" \
    "pattern not found"
fi

# --- End-to-end --test-run terminal state (runtime) ---

# Test 3: --test-run jump to a target emits WORKFLOW_COMPLETED
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if command -v bun >/dev/null 2>&1; then
  # jump's test-run-terminal behavior triggers when the state file declares
  # Test Run Mode: true (set by `aidlc-utility init --test-run` or
  # `--test-strategy --test-run`). Inject the field so the fixture is in
  # the right mode without running full init.
  printf '\n- **Test Run Mode**: true\n' >> "$PROJ/aidlc-docs/aidlc-state.md"
  bun "$JUMP" execute --target feasibility --direction forward --test-run --project-dir "$PROJ" >/dev/null 2>&1 || true
  if grep -q '^\*\*Event\*\*: WORKFLOW_COMPLETED' "$PROJ/aidlc-docs/audit.md" 2>/dev/null; then
    ok "--test-run jump emits WORKFLOW_COMPLETED terminal event"
  else
    not_ok "--test-run jump emits WORKFLOW_COMPLETED terminal event" \
      "no WORKFLOW_COMPLETED in audit.md"
  fi

  # Test 4: Reason field contains the target slug
  if grep -qE '\*\*Reason\*\*: test-run-stopped-at-feasibility' "$PROJ/aidlc-docs/audit.md" 2>/dev/null; then
    ok "--test-run terminal event Reason=test-run-stopped-at-feasibility"
  else
    not_ok "--test-run terminal event Reason=test-run-stopped-at-feasibility" \
      "Reason field missing or wrong value"
  fi
else
  ok "--test-run jump emits WORKFLOW_COMPLETED (SKIP: bun not installed)"
  ok "--test-run terminal event Reason=test-run-stopped-at-feasibility (SKIP)"
fi
cleanup_test_project "$PROJ"

finish
