#!/bin/bash
# t118 (unit): The differential corpus — per-scope jump-commit diffs + no-state trio (38 tests). The
# WAVE CLOSE GATE for the v0.6.0 Wave 1 engine (aidlc-orchestrate.ts next/report,
# MR 3-6), extended in Wave 2 MR 9 with the classified-stance anchor. This is the
# keystone regression guard that makes the Wave 2 cutover safe: it asserts the
# deterministic engine emits, FOR EACH OF THE 9 SCOPES, the same scope-shaped
# directive the prose orchestrator (skills/aidlc/SKILL.md) produces today — WITH
# NO MODEL IN THE LOOP (vision §5: "you can assert the directive sequence for a
# scope with a fixture and no model").
#
# How it runs with no model: it shells out to `bun aidlc-orchestrate.ts next`
# (the engine binary) over a seeded state fixture whose Scope field is swapped to
# each scope, and DIFFS the emitted directive's fields against a FROZEN golden.
# It NEVER calls run_claude — the prose-orchestrator workflow tests (t50-t59)
# already drive the model; this corpus is the deterministic mirror of their
# observed behaviour. Re-wiring run_claude here would defeat the entire point.
#
# The golden per-scope FINGERPRINT — the first EXECUTE stage after the three
# bootstrap initialization stages — was derived once from the scope membership in
# data/scope-mapping.json (via `aidlc-state.ts lookup stages-in-scope <scope>`)
# and cross-validated against the prose orchestrator's observed behaviour: e.g.
# t56-workflow-forward-jump drives `--stage reverse-engineering --scope bugfix`
# and lands the workflow in INCEPTION, matching the bugfix fingerprint below.
# Frozen here as a static table; a scope-membership change that moved a
# fingerprint would (correctly) red this corpus.
#
# Two diffs per scope:
#   (A) the fingerprint stage is IN scope → the engine's explicit-jump path
#       (`next --stage <fingerprint>`) emits a `run-stage` naming that exact
#       stage + phase + GATE value. GATE IS ASSERTED, not just kind/stage: the
#       gate axis is the human-judgement boundary (every EXECUTE stage gates
#       except the bootstrap initialization stages), and a corpus that ignored
#       gate would let a gate regression through silently.
#   (B) a representative OUT-OF-scope (SKIP) stage → the engine emits an `error`
#       carrying the verbatim `Stage "..." is skipped for scope "<scope>".`
#       wording (relayed from aidlc-jump.ts resolve). This is the negative half
#       of the scope fingerprint — it proves the scope shape is real, not that
#       every stage happens to run.
#
# Plus the gate-axis anchor that MR 3 lacked a pin for: an initialization stage
# emits gate:false (bootstrap auto-proceed), proving gate tracks the
# human-judgement boundary and not the conditional-inclusion axis.
#
# Plus the classified-stance anchor (v0.6.0 Wave 2 MR 9): the FIRST Construction
# Bolt's gate emits the sentinel gate:"unresolved" — the third gate value, the
# practices-derived case the engine defers to the conductor's classify round-trip
# (vision §6:452-454). The full round-trip is the feature-tier WALK C.
#
# Plus a no-state workflow-birth trio — `next <known-scope>` / `next <freeform>` /
# bare `next` against a project with NO state file — closing the close-gate
# coverage hole the engine's no-state defects (Wave-1 audit findings 2 & 3)
# slipped through (every other diff seeds state then jumps).
#
# Table-driven, mirrors t19-tool-jump.sh + t114-orchestrate-next.sh. Unit tier —
# no LLM, no model in the loop. (38 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"
JUMP_TOOL="$AIDLC_SRC/tools/aidlc-jump.ts"  # diff A commits the resolved jump

# Scope is resolved partly from AWS_AIDLC_DEFAULT_SCOPE — start from a known
# clean env so a developer's exported value can't shadow the seeded fixtures.
reset_aidlc_env

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

# Engine guard — the corpus only means something against the COMPLETE engine
# (next + report). If aidlc-orchestrate.ts is missing, bail loudly rather than
# silently pass an empty plan.
if [ ! -f "$TOOL" ]; then
  echo "Bail out! aidlc-orchestrate.ts not found at $TOOL — engine base is wrong"
  exit 1
fi

# --- Golden fixture corpus + harness helpers ---

# Drive the engine's explicit-jump path for one scope + stage against the
# init-done fixture (Scope swapped), returning the emitted directive JSON.
# Uses the explicit-jump branch (next --stage <slug>), which delegates the
# in-scope SKIP check to aidlc-jump.ts resolve. Diff B uses this for the SKIP
# negative half: a SKIP stage still yields the verbatim skip error (unchanged at
# the cutover). For an IN-scope stage the engine now emits a `print` naming
# `aidlc-jump.ts execute` (the jump is a mutation) rather than a run-stage — diff
# A drives the full commit loop instead (see emit_scope_fingerprint_runstage).
emit_scope_stage() {
  local scope="$1" stage="$2" proj out
  proj=$(create_test_project)
  seed_state_file "$proj" "$FIXTURES_DIR/state-initialization-done.md"
  # Swap ONLY the Scope field; the init-done checkboxes are scope-agnostic for
  # the jump path (resolve validates SKIP against scope-mapping.json, not the
  # checkbox suffixes), so a single fixture serves all 9 scopes.
  sed_i "s/^- \*\*Scope\*\*: .*/- **Scope**: $scope/" "$proj/aidlc-docs/aidlc-state.md"
  out=$(bun "$TOOL" next --stage "$stage" --project-dir "$proj" 2>&1)
  cleanup_test_project "$proj"
  echo "$out"
}

# Drive the FULL post-cutover jump-commit loop for one scope's fingerprint and
# return the run-stage directive the engine emits AFTER the commit. Re-anchors
# diff A end-to-end: (1) `next --stage <fp>` must emit a print naming `execute
# --target <fp> --direction forward` (Current Stage is pivoted to the last init
# stage state-init so every post-init fingerprint resolves forward); (2) the
# conductor runs that execute (mutating state: [S]/pivot Current Stage); (3) the
# next bare `next` reads the pivoted state and emits the run-stage for the
# fingerprint. The returned JSON is that final run-stage — so the existing
# stage/phase/GATE golden diff still holds, now proving the engine LANDS the
# scope on its fingerprint with the right gate through the print→execute→run-stage
# loop. Echoes the STEP-1 print on the first line (tag PRINT|) then the final
# run-stage on the second (tag RUNSTAGE|) so the caller can assert both halves.
emit_scope_fingerprint_runstage() {
  local scope="$1" fp="$2" proj print_out exec_rc runstage_out
  proj=$(create_test_project)
  seed_state_file "$proj" "$FIXTURES_DIR/state-initialization-done.md"
  sed_i "s/^- \*\*Scope\*\*: .*/- **Scope**: $scope/" "$proj/aidlc-docs/aidlc-state.md"
  # Pivot Current Stage to the last init stage so the fingerprint is forward (not
  # redo — intent-capture is the fixture's own Current Stage for 4 scopes).
  sed_i "s/^- \*\*Current Stage\*\*:.*/- **Current Stage**: state-init/" "$proj/aidlc-docs/aidlc-state.md"
  print_out=$(bun "$TOOL" next --stage "$fp" --project-dir "$proj" 2>&1)
  # Commit the jump the print named (mutating state) then re-run next.
  bun "$JUMP_TOOL" execute --target "$fp" --direction forward --scope "$scope" --project-dir "$proj" >/dev/null 2>&1
  runstage_out=$(bun "$TOOL" next --project-dir "$proj" 2>&1)
  cleanup_test_project "$proj"
  printf 'PRINT|%s\nRUNSTAGE|%s\n' "$print_out" "$runstage_out"
}

# Extract a scalar field from a directive JSON (no jq in the test env). Prints
# the field's value, or "<MISSING>" if absent/unparseable. Booleans are rendered
# as JSON lowercase (true/false) — NOT Python's True/False — so a gate assertion
# diffs against the on-the-wire directive value byte-for-byte; strings print bare.
json_field() {
  python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  v=d.get(sys.argv[1], "<MISSING>")
  print(json.dumps(v) if isinstance(v, bool) else v)
except Exception:
  print("<PARSE-ERR>")' "$2" <<< "$1"
}

# --- The FROZEN golden table (derived once, cross-validated, now static) ---
#
# Bash 3.2 (macOS) has no associative arrays — parallel arrays keyed by index.
# Each row: scope | fingerprint stage (first non-init EXECUTE) | its phase |
# its gate (always true; no scope's fingerprint is an init stage) | a
# representative SKIP-for-scope stage ("-" when the scope SKIPs nothing, i.e.
# enterprise / feature run every stage).
GOLDEN_SCOPES=(
  "enterprise"      "feature"          "mvp"             "poc"
  "bugfix"          "refactor"         "infra"           "security-patch"
  "workshop"
)
GOLDEN_FINGERPRINT=(
  "intent-capture"     "intent-capture"     "intent-capture"     "intent-capture"
  "reverse-engineering" "reverse-engineering" "practices-discovery" "reverse-engineering"
  "reverse-engineering"
)
GOLDEN_PHASE=(
  "ideation"   "ideation"   "ideation"   "ideation"
  "inception"  "inception"  "inception"  "inception"
  "inception"
)
# A stage that is SKIP for the scope (negative-half fingerprint). enterprise and
# feature SKIP nothing, so their negative half is the gate-axis init anchor below
# rather than a skip-error row; their slot here is "-".
GOLDEN_SKIP_STAGE=(
  "-"                  "-"                  "approval-handoff"   "feasibility"
  "intent-capture"     "market-research"    "reverse-engineering" "requirements-analysis"
  "intent-capture"
)

plan 38

# --- Per-scope diff A: fingerprint stage IS in scope → jump commits, lands there ---
# TWO assertions per scope (18). At the engine cutover a WITH-STATE jump became a
# MUTATION the conductor commits (mark intervening [S], emit STAGE_JUMPED, pivot
# Current Stage) — so `next --stage <fp>` emits a `print` naming `aidlc-jump.ts
# execute`, NOT a run-stage. This diff re-anchors the differential END-TO-END
# through the post-cutover loop (see emit_scope_fingerprint_runstage):
#   (A1) STEP 1 — `next --stage <fp>` emits a print naming `execute --target <fp>
#        --direction forward --scope <scope>` (Current Stage pivoted to state-init
#        so the fingerprint resolves forward for every scope).
#   (A2) After the conductor runs that execute and re-runs `next`, the engine
#        emits the run-stage for the fingerprint — the exact stage + phase + GATE
#        of the frozen golden. A drift in any field reds the scope's row. (Gate is
#        true for every fingerprint: no scope's first post-init EXECUTE stage is
#        an initialization stage; this is the per-fingerprint gate pin diff A has
#        always carried, preserved through the new mechanism.)
for i in "${!GOLDEN_SCOPES[@]}"; do
  scope="${GOLDEN_SCOPES[$i]}"
  fp="${GOLDEN_FINGERPRINT[$i]}"
  ph="${GOLDEN_PHASE[$i]}"
  LOOP_OUT=$(emit_scope_fingerprint_runstage "$scope" "$fp")
  PRINT_OUT=$(printf '%s\n' "$LOOP_OUT" | sed -n 's/^PRINT|//p')
  RUNSTAGE_OUT=$(printf '%s\n' "$LOOP_OUT" | sed -n 's/^RUNSTAGE|//p')
  # A1: the jump is named as an execute print (the commit move), forward direction.
  assert_contains "$PRINT_OUT" "execute --target $fp --direction forward --scope $scope" \
    "scope '$scope' fingerprint → print names execute $fp (forward) [golden diff, step 1]"
  # A2: after committing + re-running next, the engine lands on the fingerprint
  # run-stage with the golden stage|phase|gate.
  KIND=$(json_field "$RUNSTAGE_OUT" kind)
  STG=$(json_field "$RUNSTAGE_OUT" stage)
  PHA=$(json_field "$RUNSTAGE_OUT" phase)
  GATE=$(json_field "$RUNSTAGE_OUT" gate)
  ACTUAL="$KIND|$STG|$PHA|$GATE"
  EXPECTED="run-stage|$fp|$ph|true"
  assert_eq "$ACTUAL" "$EXPECTED" \
    "scope '$scope' fingerprint → run-stage $fp ($ph) gate:true after commit [golden diff, step 2]"
done

# --- Per-scope diff B: a SKIP-for-scope stage → verbatim skip error ---
# The negative half of the fingerprint. 7 scopes SKIP at least one stage; for
# each, jumping to a SKIP stage must emit an error carrying the verbatim
# `Stage "..." is skipped for scope "<scope>".` wording (relayed from
# aidlc-jump.ts resolve). enterprise + feature SKIP nothing — their negative
# coverage is the gate-axis init anchor below. (7 assertions × 2 = 14: kind +
# verbatim wording per scope.)
for i in "${!GOLDEN_SCOPES[@]}"; do
  scope="${GOLDEN_SCOPES[$i]}"
  skip="${GOLDEN_SKIP_STAGE[$i]}"
  [ "$skip" = "-" ] && continue
  OUT=$(emit_scope_stage "$scope" "$skip")
  KIND=$(json_field "$OUT" kind)
  MSG=$(json_field "$OUT" message)
  assert_eq "$KIND" "error" "scope '$scope' SKIP stage '$skip' → error directive"
  assert_contains "$MSG" "is skipped for scope \"$scope\"" \
    "scope '$scope' SKIP error carries the verbatim resolve wording for '$skip'"
done

# --- Gate-axis anchor: an INITIALIZATION stage emits gate:false ---
# Diff A proves every scope's fingerprint gates (gate:true). This is the other
# end of the gate axis: the bootstrap initialization stages auto-proceed with NO
# governance boundary, so their run-stage carries gate:false. The happy path on
# state-pre-workspace-detection (Current Stage=workspace-detection, an init
# stage, in-flight) emits a run-stage for it with gate:false — the human-judgement
# boundary is OFF for bootstrap. A rule that derived gate from the
# conditional-inclusion axis (execution ALWAYS/CONDITIONAL) would get this wrong.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-pre-workspace-detection.md"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
GATE=$(json_field "$OUT" gate)
STG=$(json_field "$OUT" stage)
assert_eq "$GATE|$STG" "false|workspace-detection" \
  "initialization stage (workspace-detection) → run-stage gate:false (bootstrap auto-proceed) [gate-axis anchor]"
cleanup_test_project "$PROJ"

# --- Classified-stance anchor: the skeleton gate emits gate:"unresolved" ---
# The third gate value, alongside the per-fingerprint gate:true (diff A) and the
# init gate:false (anchor above): the FIRST Construction Bolt's gate depends on a
# practices-derived STANCE the engine cannot compute, so it emits the sentinel
# gate:"unresolved" (v0.6.0 Wave 2 MR 9, vision §6:452-454). state-construction-
# bolt1 is a feature workflow parked at Current Stage=functional-design (the first
# construction EXECUTE stage = the skeleton gate) with no stance recorded yet, so
# bare `next` emits the run-stage for it carrying gate:"unresolved" — NOT a
# boolean. The full classify round-trip (report --skeleton-stance → determined
# gate) is the feature-tier WALK C; this single-directive anchor pins the engine's
# emit of the sentinel itself. The feature half also pins the non-skeleton
# backward-compat (a later construction stage keeps its boolean gate).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction-bolt1.md"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
GATE=$(json_field "$OUT" gate)
STG=$(json_field "$OUT" stage)
assert_eq "$GATE|$STG" "unresolved|functional-design" \
  "skeleton-gate stage (functional-design, Bolt 1, no stance) → run-stage gate:\"unresolved\" (classify-round-trip sentinel) [stance anchor]"
cleanup_test_project "$PROJ"

# --- No-state workflow-birth trio (3) — the close-gate coverage hole ---
# Every diff above seeds state then jumps. These three drive a NO-STATE
# invocation (create_test_project makes aidlc-docs/ but NO aidlc-state.md), the
# workflow-birth paths the Wave 2 cutover leans on. They sat outside the gate,
# which is how the engine's known-scope / SKIP-on-no-state defects (Wave-1 audit
# findings 2 & 3) slipped it. Each pins the resolved scope / directive kind the
# engine emits for a fresh workspace.

# (1) Bare KNOWN-SCOPE positional, no state: `next bugfix` — the literal scope
# name is NOT freeform intent. The engine recognises it as the scope (finding 2)
# and relays the SAME no-state error `next --scope bugfix` emits (there is
# nothing to run until init scaffolds the workspace). Pre-fix this emitted an
# `ask` defaulting to "feature" — the WRONG scope, read as prose.
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next bugfix --project-dir "$PROJ" 2>&1)
KIND=$(json_field "$OUT" kind)
MSG=$(json_field "$OUT" message)
assert_eq "$KIND" "error" "no-state bare known-scope 'bugfix' → error (recognised as scope, not freeform) [finding 2]"
assert_contains "$MSG" "No workflow state found" \
  "no-state bare known-scope 'bugfix' relays the verbatim no-state error (mirrors next --scope bugfix)"
cleanup_test_project "$PROJ"

# (2) Freeform (<=5-word) intent, no state: `next add dark mode toggle` — genuine
# prose, NOT a scope name. The engine emits an `ask` (scope confirmation), the
# read-only stand-in for the conductor's detect-scope + confirm. This is the
# control proving the finding-2 fix narrows ONLY known-scope positionals — real
# freeform still defers to the human via ask.
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next add dark mode toggle --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "ask" \
  "no-state freeform intent → ask (scope confirmation; engine never calls AskUserQuestion)"
cleanup_test_project "$PROJ"

# (3) Bare `next`, no state and no target: the engine cannot read a position to
# advance from and creating one is init's (mutating) job, so it emits the
# no-state error rather than guessing.
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "error" "no-state bare next → error directive (no position to advance from)"
cleanup_test_project "$PROJ"

finish
