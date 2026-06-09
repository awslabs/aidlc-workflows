#!/bin/bash
# t17: Unit tests for aidlc-state.ts CLI tool (83 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-state.ts"

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 83

# --- Test 1: get returns field value ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
OUT=$(bun "$TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$OUT" "intent-capture" "get returns Current Stage value"
cleanup_test_project "$PROJ"

# --- Test 2: get returns Scope ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
OUT=$(bun "$TOOL" get "Scope" --project-dir "$PROJ" 2>&1)
assert_eq "$OUT" "feature" "get returns Scope"
cleanup_test_project "$PROJ"

# --- Test 3: get returns Completed count ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
OUT=$(bun "$TOOL" get "Completed" --project-dir "$PROJ" 2>&1)
assert_eq "$OUT" "3" "get returns Completed count"
cleanup_test_project "$PROJ"

# --- Test 4: get errors on missing field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
OUT=$(bun "$TOOL" get "Nonexistent Field" --project-dir "$PROJ" 2>&1) || true
assert_contains "$OUT" "error" "get errors on missing field"
cleanup_test_project "$PROJ"

# --- Test 5: set updates a single field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
bun "$TOOL" set "Current Stage=market-research" --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(grep "Current Stage" "$PROJ/aidlc-docs/aidlc-state.md" | head -1)
assert_contains "$ACTUAL" "market-research" "set updates single field"
cleanup_test_project "$PROJ"

# --- Test 6: set NOW generates ISO timestamp ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
bun "$TOOL" set "Last Updated=NOW" --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(grep "Last Updated" "$PROJ/aidlc-docs/aidlc-state.md")
assert_match "$ACTUAL" "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z" "set NOW generates ISO timestamp"
cleanup_test_project "$PROJ"

# --- Test 7: set +1 increments numeric field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
bun "$TOOL" set "Completed=+1" --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Completed" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "4" "set +1 increments Completed from 3 to 4"
cleanup_test_project "$PROJ"

# --- Test 8: checkbox marks stage in-progress ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
bun "$TOOL" checkbox "intent-capture=in-progress" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[-\] intent-capture' "checkbox marks in-progress"
cleanup_test_project "$PROJ"

# --- Test 9: checkbox marks stage completed ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" checkbox "feasibility=completed" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[x\] feasibility' "checkbox marks completed"
cleanup_test_project "$PROJ"

# --- Test 10: checkbox marks stage skipped ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-initialization-done.md"
bun "$TOOL" checkbox "intent-capture=skipped" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[S\] intent-capture' "checkbox marks skipped"
cleanup_test_project "$PROJ"

# --- Test 11: count returns correct completed count ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" count completed --project-dir "$PROJ" 2>&1)
assert_eq "$OUT" "5" "count returns 5 completed stages"
cleanup_test_project "$PROJ"

# --- Test 12: advance atomically transitions state ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" advance "feasibility" "scope-definition" --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"completed":"feasibility"' "advance returns completed slug"
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[x\] feasibility' "advance marks completed [x]"
cleanup_test_project "$PROJ"

# --- Test 13: advance updates Current Stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" advance "feasibility" "scope-definition" --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "scope-definition" "advance updates Current Stage"
cleanup_test_project "$PROJ"

# --- Test 14: lookup validate-stage returns valid ---
OUT=$(bun "$TOOL" lookup validate-stage code-generation 2>&1)
assert_contains "$OUT" '"valid":true' "lookup validate-stage code-generation is valid"

# --- Test 15: lookup validate-stage accepts number ---
OUT=$(bun "$TOOL" lookup validate-stage 3.5 2>&1)
assert_contains "$OUT" '"slug":"code-generation"' "lookup validate-stage 3.5 resolves to code-generation"

# --- Test 16: lookup validate-stage rejects invalid ---
OUT=$(bun "$TOOL" lookup validate-stage nonexistent 2>&1)
assert_contains "$OUT" '"valid":false' "lookup validate-stage rejects invalid slug"

# --- Test 17: lookup next-stage returns correct next ---
OUT=$(bun "$TOOL" lookup next-stage intent-capture feature 2>&1)
assert_eq "$OUT" "market-research" "lookup next-stage intent-capture feature = market-research"

# --- Test 18: lookup stages-in-scope bugfix returns JSON ---
OUT=$(bun "$TOOL" lookup stages-in-scope bugfix 2>&1)
assert_contains "$OUT" '"action":"SKIP"' "lookup stages-in-scope bugfix has SKIP stages"

# --- Test 19: checkbox syncs Completed counter ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# feasibility is [-], mark it completed — should update Completed from 5 to 6
bun "$TOOL" checkbox "feasibility=completed" --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Completed" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "6" "checkbox syncs Completed counter (5→6)"
cleanup_test_project "$PROJ"

# --- Test 20: advance uses countCheckboxes (not +1) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# Completed=5 in fixture. advance feasibility→scope-definition marks feasibility [x] → count should be 6
bun "$TOOL" advance "feasibility" "scope-definition" --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Completed" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "6" "advance uses countCheckboxes (count=6 not 5+1)"
cleanup_test_project "$PROJ"

# --- Test 21: finalize marks completed [x] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" finalize "feasibility" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[x\] feasibility' "finalize marks completed [x]"
cleanup_test_project "$PROJ"

# --- Test 22: finalize syncs Completed counter ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" finalize "feasibility" --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Completed" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "6" "finalize syncs Completed counter"
cleanup_test_project "$PROJ"

# --- Test 23: finalize advances Current Stage to next ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" finalize "feasibility" --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "scope-definition" "finalize advances Current Stage to next"
cleanup_test_project "$PROJ"

# --- Test 24: finalize does NOT mark next stage [-] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" finalize "feasibility" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[ \] scope-definition' "finalize does NOT mark next stage [-]"
cleanup_test_project "$PROJ"

# --- Test 25: finalize returns JSON with next_stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" finalize "feasibility" --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"next_stage":"scope-definition"' "finalize returns next_stage in JSON"
cleanup_test_project "$PROJ"

# --- Test 26: advance auto-logs STAGE_COMPLETED + STAGE_STARTED atomically (#50 refactor) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# Ensure audit.md exists but is empty (just header)
echo "# AI-DLC Audit Log" > "$PROJ/aidlc-docs/audit.md"
bun "$TOOL" advance "feasibility" "scope-definition" --project-dir "$PROJ" >/dev/null 2>&1
# State-machine refactor: advance owns emission atomically (tool-driven, not prose)
if grep -q "^\*\*Event\*\*: STAGE_COMPLETED" "$PROJ/aidlc-docs/audit.md" && \
   grep -q "^\*\*Event\*\*: STAGE_STARTED" "$PROJ/aidlc-docs/audit.md"; then
  ok "advance auto-logs STAGE_COMPLETED + STAGE_STARTED atomically"
else
  not_ok "advance auto-logs STAGE_COMPLETED + STAGE_STARTED atomically"
fi

# --- Test 27: complete-workflow sets Status=Completed ---
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" complete-workflow "scope-definition" --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"status":"Completed"' "complete-workflow sets Status=Completed"
cleanup_test_project "$PROJ"

# --- Test 28: advance rejects slug that doesn't match Current Stage (slug validation) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
set +e
OUT=$(bun "$TOOL" advance "code-generation" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "advance wrong slug exits 1"
assert_contains "$OUT" "Cannot advance" "advance wrong slug prints clear error"
cleanup_test_project "$PROJ"

# --- Test 29: advance refuses when Scope field is missing ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
CURRENT=$(bun "$TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
# Nuke the Scope field
sed -i.bak '/^- \*\*Scope\*\*:/d' "$PROJ/aidlc-docs/aidlc-state.md"
rm -f "$PROJ/aidlc-docs/aidlc-state.md.bak"
set +e
OUT=$(bun "$TOOL" advance "$CURRENT" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "advance with missing Scope exits 1"
assert_contains "$OUT" "no Scope field" "advance with missing Scope says so"
cleanup_test_project "$PROJ"

# --- Test 30: advance refuses invalid Scope value ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
CURRENT=$(bun "$TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
bun "$TOOL" set "Scope=bogus" --project-dir "$PROJ" >/dev/null 2>&1
set +e
OUT=$(bun "$TOOL" advance "$CURRENT" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "advance with invalid Scope exits 1"
assert_contains "$OUT" 'invalid Scope' "advance with invalid Scope says so"
cleanup_test_project "$PROJ"

# --- Test 31: advance is idempotent on replay (no duplicate events) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
echo "# Audit" > "$PROJ/aidlc-docs/audit.md"
bun "$TOOL" advance "feasibility" --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" advance "feasibility" --project-dir "$PROJ" >/dev/null 2>&1
STAGE_STARTED_COUNT=$(grep -c "^\*\*Event\*\*: STAGE_STARTED" "$PROJ/aidlc-docs/audit.md")
assert_eq "$STAGE_STARTED_COUNT" "1" "replay of advance does not double-emit STAGE_STARTED"
cleanup_test_project "$PROJ"

# --- Test 32: advance with 2-arg form rejects next slug stamped SKIP in state file ---
PROJ=$(create_test_project)
# Use utility to init a bugfix workflow — state file will have user-stories
# stamped SKIP (bugfix scope excludes it).
bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
# Current Stage is requirements-analysis after init (Greenfield SKIP'd RE)
set +e
# user-stories is SKIP for bugfix in scope-mapping AND in state file suffix
OUT=$(bun "$TOOL" advance "requirements-analysis" "user-stories" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "2-arg advance rejects SKIP-stamped next slug"
assert_contains "$OUT" "SKIP" "2-arg advance error mentions SKIP"
cleanup_test_project "$PROJ"

# --- Test 33: init emits PHASE_COMPLETED+VERIFIED+STARTED for init→next phase ---
PROJ=$(create_test_project)
# Use utility tool to drive init from scratch
bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "^\*\*Event\*\*: PHASE_COMPLETED" "$PROJ/aidlc-docs/audit.md" && \
   grep -q "^\*\*Event\*\*: PHASE_VERIFIED" "$PROJ/aidlc-docs/audit.md" && \
   grep -q "^\*\*Phase\*\*: inception" "$PROJ/aidlc-docs/audit.md"; then
  ok "init emits PHASE_COMPLETED + PHASE_VERIFIED + PHASE_STARTED(inception) for init→inception hand-off"
else
  not_ok "init emits phase hand-off events" "missing one or more of PHASE_COMPLETED / PHASE_VERIFIED / PHASE_STARTED"
fi
cleanup_test_project "$PROJ"

# --- Test 34: single-arg advance on last in-scope stage errors pointing at complete-workflow ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" set "Scope=bugfix" --project-dir "$PROJ" >/dev/null 2>&1
# bugfix's last in-scope stage is build-and-test. Try to advance past it.
set +e
OUT=$(bun "$TOOL" advance "build-and-test" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "advance past last in-scope stage exits 1"
assert_contains "$OUT" "complete-workflow" "error mentions complete-workflow"
cleanup_test_project "$PROJ"

# --- Test 35: single-arg advance respects state-file SKIP (Greenfield override case) ---
PROJ=$(create_test_project)
# Init as bugfix to get the right stage graph; state file will show
# reverse-engineering SKIP for Greenfield.
bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
# After init, Current Stage should be requirements-analysis (RE was SKIP'd for Greenfield)
CURRENT=$(bun "$TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$CURRENT" "requirements-analysis" "Greenfield bugfix lands on requirements-analysis (RE was SKIP)"
cleanup_test_project "$PROJ"

# --- Test 36: resume returns structured JSON snapshot ---
PROJ=$(create_test_project)
bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" resume --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"resumed":true' "resume returns resumed:true"
assert_contains "$OUT" '"current_stage":"requirements-analysis"' "resume returns current_stage"
assert_contains "$OUT" '"gate_state":"in-progress"' "resume returns gate_state"
assert_contains "$OUT" '"compaction_pending":false' "resume returns compaction_pending"
cleanup_test_project "$PROJ"

# --- Test 37: resume detects pending compaction ---
PROJ=$(create_test_project)
bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
# Append SESSION_COMPACTED to audit
cat >> "$PROJ/aidlc-docs/audit.md" <<EOF

## Session Compacted
**Timestamp**: 2026-05-02T12:00:00Z
**Event**: SESSION_COMPACTED
**Current Stage**: requirements-analysis

---
EOF
OUT=$(bun "$TOOL" resume --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"compaction_pending":true' "resume detects pending compaction"
cleanup_test_project "$PROJ"

# --- Test 38: resume compaction_pending=false when stage activity follows ---
PROJ=$(create_test_project)
bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
cat >> "$PROJ/aidlc-docs/audit.md" <<EOF

## Session Compacted
**Timestamp**: 2026-05-02T12:00:00Z
**Event**: SESSION_COMPACTED

---

## Stage Start
**Timestamp**: 2026-05-02T12:01:00Z
**Event**: STAGE_STARTED
**Stage**: requirements-analysis

---
EOF
OUT=$(bun "$TOOL" resume --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"compaction_pending":false' "resume compaction_pending=false after stage activity"
cleanup_test_project "$PROJ"

# --- Test 39: resume reports awaiting-approval gate_state ---
PROJ=$(create_test_project)
bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" gate-start requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" resume --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"gate_state":"awaiting-approval"' "resume reports awaiting-approval gate_state"
cleanup_test_project "$PROJ"

# --- Test 40: gate-start transitions [-] → [?] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[?\] feasibility' "gate-start marks [?]"
cleanup_test_project "$PROJ"

# --- Test 41: gate-start emits STAGE_AWAITING_APPROVAL ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: STAGE_AWAITING_APPROVAL" "gate-start emits STAGE_AWAITING_APPROVAL"
cleanup_test_project "$PROJ"

# --- Test 42: gate-start rejects slug not in [-] state ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# intent-capture is [x] in this fixture, not [-]
set +e
OUT=$(bun "$TOOL" gate-start intent-capture --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "gate-start rejects slug not [-]"
cleanup_test_project "$PROJ"

# --- Test 43: approve transitions [?] → [x] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[x\] feasibility' "approve marks [x]"
cleanup_test_project "$PROJ"

# --- Test 44: approve emits GATE_APPROVED + STAGE_COMPLETED atomically ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "^\*\*Event\*\*: GATE_APPROVED" "$PROJ/aidlc-docs/audit.md" && \
   grep -q "^\*\*Event\*\*: STAGE_COMPLETED" "$PROJ/aidlc-docs/audit.md"; then
  ok "approve emits GATE_APPROVED + STAGE_COMPLETED atomically"
else
  not_ok "approve emits GATE_APPROVED + STAGE_COMPLETED atomically"
fi
cleanup_test_project "$PROJ"

# --- Test 45: approve --user-input records User Input field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --user-input "Looks good, proceed" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*User Input\*\*: Looks good, proceed' "approve --user-input recorded"
cleanup_test_project "$PROJ"

# --- Test 46: approve --test-run flags Test-Run=true ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --test-run --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Test-Run\*\*: true' "approve --test-run tags event"
cleanup_test_project "$PROJ"

# --- Test 47: approve rejects slug not in [?] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# feasibility is [-] in fixture, not [?]
set +e
OUT=$(bun "$TOOL" approve feasibility --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "approve rejects slug not in [?]"
cleanup_test_project "$PROJ"

# --- Test 48: reject transitions [?] → [R] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback "needs more detail" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[R\] feasibility' "reject marks [R]"
cleanup_test_project "$PROJ"

# --- Test 49: reject emits GATE_REJECTED + STAGE_REVISING ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback "x" --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "^\*\*Event\*\*: GATE_REJECTED" "$PROJ/aidlc-docs/audit.md" && \
   grep -q "^\*\*Event\*\*: STAGE_REVISING" "$PROJ/aidlc-docs/audit.md"; then
  ok "reject emits GATE_REJECTED + STAGE_REVISING"
else
  not_ok "reject emits GATE_REJECTED + STAGE_REVISING"
fi
cleanup_test_project "$PROJ"

# --- Test 50: reject increments Revision Count ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback x --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Revision Count" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "1" "reject increments Revision Count 0→1"
cleanup_test_project "$PROJ"

# --- Test 51: reject rejects slug not in [?] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# feasibility is [-] not [?]
set +e
OUT=$(bun "$TOOL" reject feasibility --feedback x --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "reject rejects slug not in [?]"
cleanup_test_project "$PROJ"

# --- Test 52: revise transitions [R] → [?] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback x --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" revise feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[?\] feasibility' "revise returns to [?]"
cleanup_test_project "$PROJ"

# --- Test 53: revise emits STAGE_AWAITING_APPROVAL ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback x --project-dir "$PROJ" >/dev/null 2>&1
# Clear prior STAGE_AWAITING_APPROVAL from gate-start so we can assert a new emission
BEFORE_COUNT=$(grep -c "^\*\*Event\*\*: STAGE_AWAITING_APPROVAL" "$PROJ/aidlc-docs/audit.md")
bun "$TOOL" revise feasibility --project-dir "$PROJ" >/dev/null 2>&1
AFTER_COUNT=$(grep -c "^\*\*Event\*\*: STAGE_AWAITING_APPROVAL" "$PROJ/aidlc-docs/audit.md")
assert_gt "$AFTER_COUNT" "$BEFORE_COUNT" "revise emits fresh STAGE_AWAITING_APPROVAL"
cleanup_test_project "$PROJ"

# --- Test 54: revise rejects slug not in [R] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
set +e
OUT=$(bun "$TOOL" revise feasibility --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "revise rejects slug not in [R]"
cleanup_test_project "$PROJ"

# --- Test 55: skip transitions [ ] → [S] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# scope-definition is [ ] in fixture
bun "$TOOL" skip scope-definition --reason "not needed for this feature" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[S\] scope-definition' "skip marks [S]"
cleanup_test_project "$PROJ"

# --- Test 56: skip emits STAGE_SKIPPED with Reason ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" skip scope-definition --reason "not needed" --project-dir "$PROJ" >/dev/null 2>&1
if grep -q "^\*\*Event\*\*: STAGE_SKIPPED" "$PROJ/aidlc-docs/audit.md" && \
   grep -q '\*\*Reason\*\*: not needed' "$PROJ/aidlc-docs/audit.md"; then
  ok "skip emits STAGE_SKIPPED with Reason"
else
  not_ok "skip emits STAGE_SKIPPED with Reason"
fi
cleanup_test_project "$PROJ"

# --- Test 57: skip from [-] transitions [-] → [S] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# feasibility is [-]
bun "$TOOL" skip feasibility --reason "cut from scope" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[S\] feasibility' "skip accepts [-] → [S]"
cleanup_test_project "$PROJ"

# --- Test 58: skip rejects slug already [x] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# intent-capture is [x]
set +e
OUT=$(bun "$TOOL" skip intent-capture --reason x --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "skip rejects slug already [x]"
cleanup_test_project "$PROJ"

# --- Test 59: Full revision loop [-] → [?] → [R] → [?] → [x] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback "round 1" --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" revise feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[x\] feasibility' "revision loop ends at [x]"
cleanup_test_project "$PROJ"

# --- Test 60: Revision Count reaches 3 after 3 rejections ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback r1 --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" revise feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback r2 --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" revise feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback r3 --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Revision Count" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "3" "Revision Count reaches 3 after 3 rejections"
cleanup_test_project "$PROJ"

# --- Test 61: reuse-artifact emits ARTIFACT_REUSED ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" reuse-artifact feasibility --decision keep --artifacts "feasibility-report.md" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: ARTIFACT_REUSED" "reuse-artifact emits ARTIFACT_REUSED"
cleanup_test_project "$PROJ"

# --- Test 62: reuse-artifact records Decision and Artifacts fields ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" reuse-artifact feasibility --decision modify --artifacts "a.md,b.md" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Decision\*\*: modify' "reuse-artifact records Decision"
cleanup_test_project "$PROJ"

# --- Test 63: reuse-artifact with invalid decision exits 1 ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
set +e
OUT=$(bun "$TOOL" reuse-artifact feasibility --decision bogus --artifacts x --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "reuse-artifact rejects invalid decision"
cleanup_test_project "$PROJ"

# --- Test 64: getFlagValue guards against flag-as-value (adversarial) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
set +e
# --user-input without a value followed by --test-run — should error, not silently use "--test-run" as input
OUT=$(bun "$TOOL" approve feasibility --user-input --test-run --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "approve --user-input with missing value errors cleanly"
cleanup_test_project "$PROJ"

# --- Test 65: approve is audit-first (state unchanged if audit write fails) ---
# If audit append fails, state must stay at [?] — not mutate to [x]. Proves
# the tool emits audit BEFORE writing state (the atomicity guarantee).
# Skipped under root (chmod 0444 is ignored by root, so the mechanism can't
# force an audit failure).
if [ "$(id -u)" -eq 0 ]; then
  skip "audit-first rollback (root ignores chmod 0444)"
else
  PROJ=$(create_test_project)
  seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
  seed_audit_file "$PROJ"
  bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
  # Sabotage audit.md by making it read-only. Unconditional restore via trap
  # in case the test is aborted (Ctrl-C, timeout, or a future caller early-
  # returns). Without this, a read-only file leaks into subsequent tests'
  # cleanup_test_project path and silent-nooperates audit writes.
  AUDIT_FILE="$PROJ/aidlc-docs/audit.md"
  trap 'chmod 0644 "$AUDIT_FILE" 2>/dev/null || true' RETURN EXIT
  chmod 0444 "$AUDIT_FILE"
  set +e
  bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
  APPROVE_RC=$?
  set -e
  chmod 0644 "$AUDIT_FILE"
  trap - RETURN EXIT
  # State should still be [?] — approve must have failed before touching state
  if [ "$APPROVE_RC" -ne 0 ] && grep -q '\[?\] feasibility' "$PROJ/aidlc-docs/aidlc-state.md"; then
    ok "approve is audit-first (state unchanged when audit write fails)"
  else
    not_ok "approve is audit-first" "rc=$APPROVE_RC state-modified-before-audit-rollback"
  fi
  cleanup_test_project "$PROJ"
fi

# --- Test 66: gate-start --artifacts records Artifacts field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" gate-start feasibility --artifacts "feasibility-report.md,risks.md" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Artifacts\*\*: feasibility-report.md,risks.md' \
  "gate-start --artifacts recorded"
cleanup_test_project "$PROJ"

# --- Test 67: approve syncs Completed counter via countCheckboxes ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# Fixture: Completed=5 (counter), feasibility is [-]. Approving it → [x] makes count=6
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Completed" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "6" "approve updates Completed counter via countCheckboxes"
cleanup_test_project "$PROJ"

# --- Test 68: approve updates Last Completed Stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Last Completed Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "feasibility" "approve sets Last Completed Stage"
cleanup_test_project "$PROJ"

# --- Test 69: resume after approve reports the NEW current stage (approve auto-advances) ---
# Approve owns the full post-gate transition: after approve, the old slug is [x]
# and Current Stage has moved to the next in-scope stage (gate_state=in-progress
# for the new current stage, which hasn't been gate-started yet).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" resume --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"current_stage":"scope-definition"' "resume reports advanced current_stage post-approve"
cleanup_test_project "$PROJ"

# --- Test 70: advance after approve is idempotent (no duplicate STAGE_COMPLETED) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
echo "# Audit" > "$PROJ/aidlc-docs/audit.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" advance feasibility --project-dir "$PROJ" >/dev/null 2>&1
# STAGE_COMPLETED should appear exactly once (from approve), not twice
COUNT=$(grep -c "^\*\*Event\*\*: STAGE_COMPLETED" "$PROJ/aidlc-docs/audit.md")
assert_eq "$COUNT" "1" "advance after approve does not double-emit STAGE_COMPLETED"
cleanup_test_project "$PROJ"

# --- Test 71: approve on unknown slug exits 1 ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
set +e
OUT=$(bun "$TOOL" approve nonexistent-slug --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "approve rejects unknown slug"
cleanup_test_project "$PROJ"

# --- Test 72: skip from [R] transitions [R] → [S] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" reject feasibility --feedback x --project-dir "$PROJ" >/dev/null 2>&1
# Now [R] — skip should be allowed
bun "$TOOL" skip feasibility --reason "cut from scope" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[S\] feasibility' "skip accepts [R] → [S]"
cleanup_test_project "$PROJ"

# --- Test 73: advance after approve sets Current Stage to next in-scope stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" advance feasibility --project-dir "$PROJ" >/dev/null 2>&1
ACTUAL=$(bun "$TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$ACTUAL" "scope-definition" "advance after approve moves Current Stage forward"
cleanup_test_project "$PROJ"

# --- Test 74: cross-phase-boundary advance is idempotent (no double PHASE_* events) ---
# Uses a fresh bugfix init and walks through the boundary between init and
# inception to prove replay doesn't double-emit PHASE_COMPLETED / PHASE_VERIFIED
# / PHASE_STARTED (the adversarial finding's stated regression mode).
PROJ=$(create_test_project)
bun "$AIDLC_SRC/tools/aidlc-utility.ts" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
# After init, Current Stage is requirements-analysis (first post-init stage).
# Walk through it, then REPLAY advance and assert no double phase events.
bun "$TOOL" gate-start requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" approve requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
# First advance — legit transition within inception
bun "$TOOL" advance requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
# Snapshot counts
PHASE_COMPLETED_BEFORE=$(grep -c "^\*\*Event\*\*: PHASE_COMPLETED" "$PROJ/aidlc-docs/audit.md")
PHASE_VERIFIED_BEFORE=$(grep -c "^\*\*Event\*\*: PHASE_VERIFIED" "$PROJ/aidlc-docs/audit.md")
PHASE_STARTED_BEFORE=$(grep -c "^\*\*Event\*\*: PHASE_STARTED" "$PROJ/aidlc-docs/audit.md")
# Now replay the SAME advance — should be a no-op
bun "$TOOL" advance requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
PHASE_COMPLETED_AFTER=$(grep -c "^\*\*Event\*\*: PHASE_COMPLETED" "$PROJ/aidlc-docs/audit.md")
PHASE_VERIFIED_AFTER=$(grep -c "^\*\*Event\*\*: PHASE_VERIFIED" "$PROJ/aidlc-docs/audit.md")
PHASE_STARTED_AFTER=$(grep -c "^\*\*Event\*\*: PHASE_STARTED" "$PROJ/aidlc-docs/audit.md")
if [ "$PHASE_COMPLETED_BEFORE" = "$PHASE_COMPLETED_AFTER" ] && \
   [ "$PHASE_VERIFIED_BEFORE" = "$PHASE_VERIFIED_AFTER" ] && \
   [ "$PHASE_STARTED_BEFORE" = "$PHASE_STARTED_AFTER" ]; then
  ok "advance replay does not double-emit PHASE_COMPLETED / PHASE_VERIFIED / PHASE_STARTED"
else
  not_ok "advance replay does not double-emit phase events" \
    "completed=${PHASE_COMPLETED_BEFORE}→${PHASE_COMPLETED_AFTER} verified=${PHASE_VERIFIED_BEFORE}→${PHASE_VERIFIED_AFTER} started=${PHASE_STARTED_BEFORE}→${PHASE_STARTED_AFTER}"
fi
cleanup_test_project "$PROJ"

finish
