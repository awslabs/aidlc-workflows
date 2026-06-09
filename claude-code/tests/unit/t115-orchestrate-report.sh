#!/bin/bash
# t115: Unit tests for `aidlc-orchestrate.ts report` — the commit-the-transition
# half of the orchestration engine (Wave 1). report is a THIN DISPATCHER: it
# shells out to EXACTLY ONE of aidlc-state.ts approve / advance /
# complete-workflow per the acted stage's gate status (then finality), so the
# next `next` reads fresh state. Round-trip: next -> act -> report -> next
# reflects the advanced stage. Asserts audit rows land in taxonomy order, no
# double-advance after approve, no orphan lock dir, and the tool-level replay
# guard report relies on emits zero new events (not an error). (22 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"
STATE_TOOL="$AIDLC_SRC/tools/aidlc-state.ts"

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 22

# audit_events <proj> — print the audit event types in file order, space-joined.
audit_events() {
  grep '\*\*Event\*\*:' "$1/aidlc-docs/audit.md" 2>/dev/null | sed 's/.*: //' | tr '\n' ' '
}

# count_event <proj> <EVENT> — count audit rows of one event type. grep -c
# exits 1 (and prints 0) when there are no matches; `|| true` swallows the
# non-zero exit without a second `echo 0` that would print "0\n0".
count_event() {
  grep -c "\*\*Event\*\*: $2\$" "$1/aidlc-docs/audit.md" 2>/dev/null || true
}

# lock_dir <proj> — the per-project audit lock dir (mirrors aidlc-lib.ts
# auditLockDir: $TMPDIR/.aidlc-audit-<md5(projectDir)[:8]>.lock). md5 parity
# between shell and bun's createHash is verified; report must leave none behind.
lock_dir() {
  local hash
  if command -v md5 >/dev/null 2>&1; then
    hash=$(printf '%s' "$1" | md5 | cut -c1-8)
  else
    hash=$(printf '%s' "$1" | md5sum | cut -c1-8)
  fi
  echo "${TMPDIR:-/tmp}/.aidlc-audit-${hash}.lock"
}

# --- Test 1: report requires --result ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" report --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"error"' "report with no --result emits an error directive"
cleanup_test_project "$PROJ"

# --- Test 2: report rejects an unknown --result outcome ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" report --result rejected --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'commits forward transitions only' "report rejects an unknown --result outcome"
cleanup_test_project "$PROJ"

# --- Test 3: report with no state file is a clean error, not a crash ---
PROJ=$(create_test_project)
# create_test_project scaffolds aidlc-docs but no state file
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
OUT=$(bun "$TOOL" report --result approved --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"error"' "report with no state file emits an error directive"
cleanup_test_project "$PROJ"

# --- Tests 4-9: GATED APPROVE round-trip (mid-ideation, feasibility) ---
# next emits run-stage(feasibility, gate:true); the conductor "acts"; the gate
# opens (gate-start); report --result approved commits via approve, which owns
# the full transition (GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED), no
# separate advance. The follow-up next reflects the advanced stage.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
NEXT_BEFORE=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_contains "$NEXT_BEFORE" '"stage":"feasibility"' "next before report points at the active gated stage"
bun "$STATE_TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
REPORT_OUT=$(bun "$TOOL" report --result approved --user-input "looks good" --project-dir "$PROJ" 2>&1)
assert_contains "$REPORT_OUT" '"kind":"done"' "report on a gated stage emits a done directive"
EVENTS=$(audit_events "$PROJ")
assert_contains "$EVENTS" "GATE_APPROVED STAGE_COMPLETED STAGE_STARTED" \
  "gated approve emits GATE_APPROVED then STAGE_COMPLETED then STAGE_STARTED in order"
STARTED_COUNT=$(count_event "$PROJ" "STAGE_STARTED")
assert_eq "$STARTED_COUNT" "1" "gated approve emits exactly one STAGE_STARTED (no double-advance)"
NEXT_AFTER=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_contains "$NEXT_AFTER" '"stage":"scope-definition"' "next after report reflects the advanced stage"
LOCK=$(lock_dir "$PROJ")
if [ ! -d "$LOCK" ]; then
  ok "no orphan audit lock dir after report (gated path)"
else
  not_ok "no orphan audit lock dir after report (gated path)" "lock dir still present: $LOCK"
fi
cleanup_test_project "$PROJ"

# --- Tests 10-11: NON-GATED ADVANCE (init stage, no phase boundary) ---
# workspace-detection is a bootstrap initialization stage — non-gated. report
# --result completed commits via advance (NOT approve), emitting STAGE_COMPLETED
# then STAGE_STARTED, with no GATE_APPROVED.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-pre-workspace-detection.md"
REPORT_OUT=$(bun "$TOOL" report --result completed --project-dir "$PROJ" 2>&1)
# The done reason names the dispatched subcommand; quotes are JSON-escaped in
# stdout, so match the quote-free substring "Committed advance for".
assert_contains "$REPORT_OUT" 'Committed advance for' \
  "report on a non-gated stage dispatches advance (not approve)"
EVENTS=$(audit_events "$PROJ")
assert_contains "$EVENTS" "STAGE_COMPLETED STAGE_STARTED" \
  "non-gated advance emits STAGE_COMPLETED then STAGE_STARTED"
cleanup_test_project "$PROJ"

# --- Tests 12-15: NON-GATED PHASE BOUNDARY (state-init -> ideation) ---
# state-init is the last initialization stage; advancing it crosses the
# init -> ideation boundary, so advance emits the full boundary quartet
# PHASE_COMPLETED + PHASE_VERIFIED + PHASE_STARTED around the stage events.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-init-active.md"
bun "$TOOL" report --result completed --project-dir "$PROJ" >/dev/null 2>&1
assert_eq "$(count_event "$PROJ" "PHASE_COMPLETED")" "1" "phase-boundary advance emits PHASE_COMPLETED"
assert_eq "$(count_event "$PROJ" "PHASE_VERIFIED")" "1" "phase-boundary advance emits PHASE_VERIFIED"
assert_eq "$(count_event "$PROJ" "PHASE_STARTED")" "1" "phase-boundary advance emits PHASE_STARTED"
EVENTS=$(audit_events "$PROJ")
assert_contains "$EVENTS" "STAGE_COMPLETED PHASE_COMPLETED PHASE_VERIFIED PHASE_STARTED STAGE_STARTED" \
  "phase-boundary advance emits the events in taxonomy order"
cleanup_test_project "$PROJ"

# --- Tests 16-18: FINAL COMPLETE-WORKFLOW (gated final stage) ---
# feedback-optimization is the final in-scope stage. Its gate approval routes
# approve -> complete-workflow in-process (finality), emitting STAGE_COMPLETED +
# PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED and setting
# Status=Completed. No STAGE_STARTED — there is no next stage.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-final-stage.md"
bun "$STATE_TOOL" gate-start feedback-optimization --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" report --result approved --project-dir "$PROJ" >/dev/null 2>&1
assert_eq "$(count_event "$PROJ" "WORKFLOW_COMPLETED")" "1" "final gated approve emits WORKFLOW_COMPLETED"
EVENTS=$(audit_events "$PROJ")
assert_contains "$EVENTS" "STAGE_COMPLETED PHASE_COMPLETED PHASE_VERIFIED WORKFLOW_COMPLETED" \
  "final completion emits STAGE_COMPLETED + PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED"
STATUS=$(bun "$STATE_TOOL" get "Status" --project-dir "$PROJ" 2>&1)
assert_eq "$STATUS" "Completed" "final completion sets Status=Completed"
cleanup_test_project "$PROJ"

# --- Tests 19-21: DOUBLE-COMMIT REPLAY GUARD ---
# report shells out to `aidlc-state.ts advance <slug>`, whose replay guard
# (:364-378) short-circuits a re-commit of the same completed slug: it emits
# ZERO new audit events and returns "replay":true rather than erroring. Exercise
# that guard at the exact subcommand report dispatches.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-pre-workspace-detection.md"
bun "$STATE_TOOL" advance workspace-detection --project-dir "$PROJ" >/dev/null 2>&1
EV_BEFORE=$(grep -c '\*\*Event\*\*:' "$PROJ/aidlc-docs/audit.md")
REPLAY_OUT=$(bun "$STATE_TOOL" advance workspace-detection --project-dir "$PROJ" 2>&1)
assert_contains "$REPLAY_OUT" '"replay":true' "advance replay guard returns replay:true on a double-commit"
EV_AFTER=$(grep -c '\*\*Event\*\*:' "$PROJ/aidlc-docs/audit.md")
assert_eq "$EV_AFTER" "$EV_BEFORE" "advance replay guard emits zero new audit events"
assert_eq "$(count_event "$PROJ" "ERROR_LOGGED")" "0" "a replayed commit is not an error (no ERROR_LOGGED)"
cleanup_test_project "$PROJ"

# --- Test 22: re-report through the engine on a completed workflow is a clean error ---
# Once the workflow is Completed, the active stage is [x]; a stray second report
# dispatches approve on an already-completed stage, which aidlc-state.ts rejects.
# The engine surfaces a clean error directive (clean boundaries) — no crash,
# no half-emitted directive on stdout.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-final-stage.md"
bun "$STATE_TOOL" gate-start feedback-optimization --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" report --result approved --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" report --result approved --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"error"' "re-report on a completed workflow emits an error directive, not a crash"
cleanup_test_project "$PROJ"

finish
