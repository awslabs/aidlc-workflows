#!/bin/bash
# t127: the `--single` stage-runner invariant (v0.6.0 Wave 3 MR 14). A
# stage-runner drives ONE stage in isolation via the engine's `--single` mode and
# the load-bearing rule is the POINTER INVARIANT: a `--single` run NEVER touches
# the main workflow's `Current Stage`. Exercises both halves of the engine
# contract over a seeded ACTIVE workflow:
#   next  --stage <slug> --single  -> ONE run-stage directive for <slug>, gate
#                                     computed, conductor persona on the first
#                                     directive; the main pointer is unchanged.
#   report --single --stage <slug> --result completed
#                                  -> a synthetic-id STAGE_STARTED/STAGE_COMPLETED
#                                     pair in audit.md; the main pointer is STILL
#                                     unchanged; `done` directive.
# Plus the tool-enforced refusal: `report --single` with NO --stage (the "advance
# the main workflow" attempt) -> `error`; an init-stage `--single` -> `error`; a
# SKIP-for-scope stage `--single` -> `error`. (16 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"
STATE_TOOL="$AIDLC_SRC/tools/aidlc-state.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 16

# count_event <proj> <EVENT> — count audit rows of one event type. grep -c on an
# existing file prints exactly one number and (mirroring t115) `|| true` swallows
# the exit-1-with-0 of a no-match without a second echo. Callers seed audit.md so
# the file always exists.
count_event() {
  grep -c "\*\*Event\*\*: $2\$" "$1/aidlc-docs/audit.md" 2>/dev/null || true
}

# --- Tests 1-7: pointer invariant across next --single + report --single ---
# Seed an ACTIVE feature workflow parked at `feasibility` (Current Stage), then
# run a DIFFERENT stage (code-generation) via --single. Neither the next nor the
# report leg may move the main pointer off `feasibility`.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"

BEFORE=$(bun "$STATE_TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$BEFORE" "feasibility" "main workflow starts parked at feasibility"

NEXT_OUT=$(bun "$TOOL" next --stage code-generation --single --project-dir "$PROJ" 2>&1)
assert_contains "$NEXT_OUT" '"kind":"run-stage"' "next --single emits a run-stage directive"
assert_contains "$NEXT_OUT" '"stage":"code-generation"' "next --single targets the requested stage, not Current Stage"
assert_contains "$NEXT_OUT" '"conductor_persona"' "next --single delivers the conductor persona on the first directive (D-E)"

AFTER_NEXT=$(bun "$STATE_TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$AFTER_NEXT" "feasibility" "next --single leaves the main Current Stage untouched"

REPORT_OUT=$(bun "$TOOL" report --single --stage code-generation --result completed --project-dir "$PROJ" 2>&1)
assert_contains "$REPORT_OUT" '"kind":"done"' "report --single emits a done directive"

AFTER_REPORT=$(bun "$STATE_TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
assert_eq "$AFTER_REPORT" "feasibility" "report --single leaves the main Current Stage untouched"
cleanup_test_project "$PROJ"

# --- Tests 8-10: the synthetic-id audit pair lands, tagged, audit-only ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" report --single --stage code-generation --result completed --project-dir "$PROJ" >/dev/null 2>&1
assert_eq "$(count_event "$PROJ" "STAGE_STARTED")" "1" "report --single commits exactly one STAGE_STARTED"
assert_eq "$(count_event "$PROJ" "STAGE_COMPLETED")" "1" "report --single commits exactly one STAGE_COMPLETED"
if grep -q '\*\*Workflow\*\*: single-stage:code-generation' "$PROJ/aidlc-docs/audit.md"; then
  ok "the synthetic pair is tagged with the single-stage workflow id"
else
  not_ok "the synthetic pair is tagged with the single-stage workflow id" \
    "audit: $(tail -20 "$PROJ/aidlc-docs/audit.md")"
fi
cleanup_test_project "$PROJ"

# --- Tests 11-12: report --single with NO --stage is an attempt to advance the
# main workflow -> error (tool-enforced refusal). And it does not commit anything.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
NOSTAGE=$(bun "$TOOL" report --single --result completed --project-dir "$PROJ" 2>&1)
assert_contains "$NOSTAGE" '"kind":"error"' "report --single with no --stage errors (refuses to advance the main workflow)"
assert_eq "$(count_event "$PROJ" "STAGE_COMPLETED")" "0" "the refused report --single commits no STAGE_COMPLETED"
cleanup_test_project "$PROJ"

# --- Test 13: next --single requires --stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
NOSTG=$(bun "$TOOL" next --single --project-dir "$PROJ" 2>&1)
assert_contains "$NOSTG" '"kind":"error"' "next --single with no --stage errors"
cleanup_test_project "$PROJ"

# --- Test 14: an initialization stage cannot run via --single ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
INIT=$(bun "$TOOL" next --stage workspace-detection --single --project-dir "$PROJ" 2>&1)
assert_contains "$INIT" 'initialization stage with --single' "next --single rejects an initialization stage (bootstrap, use --init)"
cleanup_test_project "$PROJ"

# --- Test 15: a SKIP-for-scope stage cannot run via --single ---
# `user-stories` is SKIP for bugfix; --single relays the verbatim skip wording.
# Use a no-state project so the explicit `--scope bugfix` resolves (an active
# workflow's state Scope would win the precedence ladder over the flag).
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
# The verbatim wording is `Stage "..." is skipped for scope "bugfix".`; in JSON
# stdout the quotes are backslash-escaped, so match the quote-free substring.
SKIP=$(bun "$TOOL" next --stage user-stories --single --scope bugfix --project-dir "$PROJ" 2>&1)
assert_contains "$SKIP" 'is skipped for scope' "next --single rejects a SKIP-for-scope stage with the verbatim skip wording"
cleanup_test_project "$PROJ"

# --- Test 16: --single + --phase is mutually exclusive ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
PH=$(bun "$TOOL" next --single --phase inception --project-dir "$PROJ" 2>&1)
assert_contains "$PH" 'Cannot use --single with --phase' "next --single --phase errors (one stage, not a range)"
cleanup_test_project "$PROJ"

finish
