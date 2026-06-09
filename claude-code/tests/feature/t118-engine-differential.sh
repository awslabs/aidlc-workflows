#!/bin/bash
# t118 (feature): The differential corpus — cross-component special-path (27 tests).
# sequences. The feature-tier half of the v0.6.0 Wave 1 WAVE CLOSE GATE (the
# unit half, tests/unit/t118-engine-differential.sh, covers the 9 per-scope
# single-directive diffs). Where the unit half pins one directive per scope, this
# half walks MULTI-STEP next/report sequences across the engine's components
# (next decision rule + report dispatcher) for each SPECIAL PATH the prose
# orchestrator handles today — with NO MODEL IN THE LOOP.
#
# No model: every step shells out to the engine binary `bun aidlc-orchestrate.ts
# next|report` over a seeded fixture and diffs the emitted directive against a
# FROZEN golden. It NEVER calls run_claude. The prose-orchestrator workflow tests
# (t50-t59) drive the model and capture the same behaviour; this corpus is their
# deterministic mirror and grows the no-LLM tier (vision §5).
#
# The 7 special paths (the gate's coverage requirement — not a subset):
#   1. jump forward   — next --stage <later>  → print naming execute(target,
#                       forward) (a WITH-STATE jump is a mutation the conductor
#                       commits — re-anchored at the engine cutover from run-stage);
#                       direction cross-checked against aidlc-jump.ts resolve.
#   2. jump backward  — next --stage <earlier> → print naming execute(target,
#                       backward); resolve says backward.
#   3. jump redo      — next --stage <current> → print naming execute(target, redo);
#                       resolve says redo (the redo golden has NO t50-t59 source —
#                       derived from the tool, proven in t19-tool-jump: resolve →
#                       "redo").
#   4. resume         — next --resume → ask (the engine never calls
#                       AskUserQuestion; it emits `ask` and stops).
#   5. init           — clean workspace → print naming the scaffold command, with
#                       NO state created by next; state-exists guard → error
#                       carrying the verbatim guard message.
#   6. scope-change   — next --scope <other> over an active workflow → print
#                       naming the scope-change command (no t50-t59 golden;
#                       derived from the engine's scope-change branch).
#   7. test-run       — full next → report --test-run → next round-trip: the
#                       report dispatcher rides --test-run through to
#                       aidlc-state.ts approve, stamping `Test-Run: true` on the
#                       GATE_APPROVED audit row (absent without --test-run), and
#                       the follow-up next reflects the advanced stage.
#
# Plus three TRUE cross-component WALKS (next → report → next) proving the report
# dispatcher round-trips deterministically and the next-after reflects fresh
# state: a non-gated advance walk, a gated approve walk, and the v0.6.0 Wave 2
# MR 9 CLASSIFY round-trip — next emits the skeleton gate UNRESOLVED, `report
# --skeleton-stance <s>` records the conductor's typed stance (no transition
# committed; the test supplies the stance — no model), and the follow-up next
# re-emits the same stage with the now-DETERMINED gate.
#
# Table-driven, mirrors t19-tool-jump.sh. Feature tier — no LLM, no model. (27 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"
JUMP_TOOL="$AIDLC_SRC/tools/aidlc-jump.ts"
STATE_TOOL="$AIDLC_SRC/tools/aidlc-state.ts"

reset_aidlc_env

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

# Engine guard — the corpus is meaningful only against the COMPLETE engine
# (next + report). Bail loudly if it's missing rather than pass an empty plan.
if [ ! -f "$TOOL" ]; then
  echo "Bail out! aidlc-orchestrate.ts not found at $TOOL — engine base is wrong"
  exit 1
fi

# Extract a scalar field from a directive JSON (booleans as JSON lowercase).
json_field() {
  python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  v=d.get(sys.argv[1], "<MISSING>")
  print(json.dumps(v) if isinstance(v, bool) else v)
except Exception:
  print("<PARSE-ERR>")' "$2" <<< "$1"
}

# count_event <proj> <EVENT> — count audit rows of one event type.
count_event() {
  grep -c "\*\*Event\*\*: $2\$" "$1/aidlc-docs/audit.md" 2>/dev/null || true
}

plan 27

# === Special path 1: JUMP FORWARD ===
# state-mid-ideation (feature, Current Stage=feasibility); --stage code-generation
# is later → forward. A WITH-STATE jump is a MUTATION the conductor commits, so at
# the engine cutover the directive became a `print` naming `aidlc-jump.ts execute
# --target code-generation --direction forward` (NOT a run-stage; re-anchored).
# The engine DELEGATES direction to the tool (does not re-derive it) and embeds
# resolve's own direction in the command, so the corpus still pins engine-vs-tool
# agreement: the print's direction must equal resolve's.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --stage code-generation --project-dir "$PROJ" 2>&1)
DIR=$(bun "$JUMP_TOOL" resolve --stage code-generation --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'execute --target code-generation --direction forward' \
  "jump forward → print naming execute(code-generation, forward)"
assert_contains "$DIR" '"direction":"forward"' "jump forward direction matches aidlc-jump.ts resolve"
cleanup_test_project "$PROJ"

# === Special path 2: JUMP BACKWARD ===
# state-jumped (feature, Current Stage=code-generation); --stage feasibility is
# earlier → backward. WITH-STATE jump → print naming execute (see path 1).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" next --stage feasibility --project-dir "$PROJ" 2>&1)
DIR=$(bun "$JUMP_TOOL" resolve --stage feasibility --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'execute --target feasibility --direction backward' \
  "jump backward → print naming execute(feasibility, backward)"
assert_contains "$DIR" '"direction":"backward"' "jump backward direction matches aidlc-jump.ts resolve"
cleanup_test_project "$PROJ"

# === Special path 3: JUMP REDO ===
# state-jumped (Current Stage=code-generation); --stage code-generation == current
# → redo. WITH-STATE jump → print naming execute (see path 1). (No t50-t59 golden
# for redo — this golden is derived from the tool, proven in t19-tool-jump.)
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" next --stage code-generation --project-dir "$PROJ" 2>&1)
DIR=$(bun "$JUMP_TOOL" resolve --stage code-generation --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'execute --target code-generation --direction redo' \
  "jump redo → print naming execute(code-generation, redo)"
assert_contains "$DIR" '"direction":"redo"' "jump redo direction matches aidlc-jump.ts resolve"
cleanup_test_project "$PROJ"

# === Special path 4: RESUME ===
# next --resume over an existing workflow → ask (the engine emits the resume-choice
# question and stops; it never calls AskUserQuestion).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" next --resume --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "ask" "resume → ask directive (engine never calls AskUserQuestion)"
assert_contains "$OUT" "existing workflow was found" "resume ask carries the resume-choice question"
cleanup_test_project "$PROJ"

# === Special path 5: INIT ===
# (a) clean workspace → print naming the scaffold command, and next creates NO
#     state (the mutation stays conductor-side; next is read-only).
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --init --scope poc --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "print" "init (clean) → print directive (read-only; names the move)"
if [ ! -f "$PROJ/aidlc-docs/aidlc-state.md" ]; then
  ok "init (clean) → next creates no state (mutation stays conductor-side)"
else
  not_ok "init (clean) → next creates no state" "state file was created by next"
fi
cleanup_test_project "$PROJ"
# (b) state-exists guard → error carrying the verbatim guard message.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --init --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "error" "init (state exists, no --force) → error directive"
assert_contains "$OUT" "Use --force to reinitialize" "init guard error carries the verbatim guard message"
cleanup_test_project "$PROJ"

# === Special path 6: SCOPE-CHANGE ===
# next --scope mvp over a feature workflow (no --stage/--phase) → print naming the
# scope-change command (changing scope is a mutation; next names the move). No
# t50-t59 golden — derived from the engine's scope-change branch.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --scope mvp --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "print" "scope-change → print directive (names the move)"
assert_contains "$OUT" "scope-change --scope mvp" "scope-change print names the scope-change command"
cleanup_test_project "$PROJ"

# === Special path 7: TEST-RUN (full round-trip) ===
# A gated stage (feasibility) with the gate open: report --result approved
# --test-run rides --test-run through the report dispatcher to aidlc-state.ts
# approve, which stamps `Test-Run: true` on the GATE_APPROVED audit row. The
# follow-up next reflects the advanced stage (scope-definition). Then a control
# run WITHOUT --test-run proves the stamp is absent — the test-run path is
# observable, not a no-op.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$STATE_TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
REPORT_OUT=$(bun "$TOOL" report --result approved --test-run --user-input "auto" --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$REPORT_OUT" kind)" "done" "test-run report → done directive"
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Test-Run\*\*: true' "report --test-run stamps Test-Run:true on the GATE_APPROVED row"
NEXT_AFTER=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$NEXT_AFTER" stage)" "scope-definition" "next after test-run report reflects the advanced stage"
cleanup_test_project "$PROJ"
# Control: WITHOUT --test-run, no Test-Run stamp.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$STATE_TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" report --result approved --user-input "human ok" --project-dir "$PROJ" >/dev/null 2>&1
assert_not_grep "$PROJ/aidlc-docs/audit.md" '\*\*Test-Run\*\*: true' "report WITHOUT --test-run leaves no Test-Run stamp (path is observable)"
cleanup_test_project "$PROJ"

# === Cross-component WALK A: non-gated advance (next → report → next) ===
# state-pre-workspace-detection: Current Stage=workspace-detection, a bootstrap
# init stage (gate:false). The engine's report dispatcher picks `advance` (non-
# gated, non-final) and the follow-up next advances to state-init. A true multi-
# step sequence across the next decision rule and the report dispatcher.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-pre-workspace-detection.md"
N1=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$N1" stage)|$(json_field "$N1" gate)" "workspace-detection|false" \
  "walk(non-gated) step 1: next → run-stage(workspace-detection) gate:false"
R=$(bun "$TOOL" report --result completed --project-dir "$PROJ" 2>&1)
assert_contains "$R" "Committed advance for" "walk(non-gated) step 2: report dispatches advance (not approve)"
N2=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$N2" stage)" "state-init" "walk(non-gated) step 3: next-after reflects the advanced stage (state-init)"
cleanup_test_project "$PROJ"

# === Cross-component WALK B: gated approve (next → report → next) ===
# state-mid-ideation: Current Stage=feasibility, a gated ideation stage
# (gate:true). The report dispatcher picks `approve` (gated), which owns the full
# transition (GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED, exactly one
# STAGE_STARTED — no double-advance), and the follow-up next reflects the advanced
# stage (scope-definition).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
N1=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$N1" stage)|$(json_field "$N1" gate)" "feasibility|true" \
  "walk(gated) step 1: next → run-stage(feasibility) gate:true"
bun "$STATE_TOOL" gate-start feasibility --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" report --result approved --user-input "ok" --project-dir "$PROJ" >/dev/null 2>&1
assert_eq "$(count_event "$PROJ" "STAGE_STARTED")" "1" \
  "walk(gated) step 2: approve emits exactly one STAGE_STARTED (no double-advance)"
N2=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$N2" stage)" "scope-definition" "walk(gated) step 3: next-after reflects the advanced stage (scope-definition)"
cleanup_test_project "$PROJ"

# === Cross-component WALK C: the classify round-trip (next → report --skeleton-stance → next) ===
# The classified-stance fixture (v0.6.0 Wave 2 MR 9, vision §6:452-454). The first
# Construction Bolt's gate depends on the walking-skeleton STANCE — knowledge the
# engine cannot compute — so the engine emits the gate UNRESOLVED, the conductor
# classifies the prose and hands the typed stance back via `report
# --skeleton-stance` (the test SUPPLIES the stance — no model), and the follow-up
# next re-emits the same stage with the now-DETERMINED gate. This is the third
# component walk: it exercises the report dispatcher's stance branch (which records
# state without committing a transition) AND the next decision rule's gate
# computation reading that recorded stance. The golden carries the resolved gate
# (true — skeleton-on always-gates Bolt 1, and skeleton-off's regular Bolt still
# gates while autonomy is unset/gated; the stance picks the ceremony, not whether
# Bolt 1 gates). state-construction-bolt1: feature, Construction Active, Current
# Stage=functional-design (the first construction EXECUTE stage = the skeleton gate).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction-bolt1.md"
N1=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$N1" stage)|$(json_field "$N1" gate)" "functional-design|unresolved" \
  "walk(classify) step 1: next → run-stage(functional-design) gate:\"unresolved\" (engine defers the skeleton gate)"
R=$(bun "$TOOL" report --skeleton-stance on --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$R" kind)" "print" \
  "walk(classify) step 2: report --skeleton-stance on → print (stance recorded, no transition committed)"
N2=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$N2" stage)|$(json_field "$N2" gate)" "functional-design|true" \
  "walk(classify) step 3: next-after reads the recorded stance → run-stage(functional-design) gate:true (determined)"
cleanup_test_project "$PROJ"

finish
