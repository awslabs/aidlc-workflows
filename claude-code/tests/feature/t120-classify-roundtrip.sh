#!/bin/bash
# t120 (feature): The walking-skeleton classify round-trip (19 tests). The v0.6.0
# Wave 2 MR 9 close-gate for the ONE knowledge round-trip the engine defers
# rather than decides (vision §6, v06-vision.html:452-454; review Major A).
#
# The first Construction Bolt's gate depends on the walking-skeleton STANCE,
# which an LLM resolves by reading a team's free-form `## Walking Skeleton`
# practices prose — no parser turns free English into a stance. So the engine
# does NOT smuggle an LLM into routing; it honours the boundary with a round-trip:
#   (1) `next` over a Construction-at-Bolt-1 state emits a `run-stage` for the
#       skeleton-gate stage with gate = the sentinel "unresolved";
#   (2) the conductor classifies the prose and hands the typed stance back via
#       `report --skeleton-stance <on|off|scope-dependent>` (recorded in the
#       `Skeleton Stance` state field; NO transition committed);
#   (3) the FOLLOW-UP `next` reads the recorded stance and re-emits the SAME
#       stage with the now-DETERMINED boolean gate.
# The engine still owns the transition — only a typed stance ever crosses back in.
#
# No model in the loop: every step shells out to the engine binary `bun
# aidlc-orchestrate.ts next|report` over a seeded state fixture and diffs the
# emitted directive. It NEVER calls run_claude — the conductor's prose-classify
# step is the model's job (proven in the prose-orchestrator workflow tier);
# this corpus is the deterministic mirror of the ENGINE half of the round-trip.
#
# Per stance (on / off / scope-dependent), the round-trip is asserted end-to-end:
#   - step 1: next → run-stage(skeleton stage) gate:"unresolved" (the sentinel);
#   - step 2: report --skeleton-stance <s> → accepted (print, re-run-next), and
#     the `Skeleton Stance` field is written to state;
#   - step 3: next → run-stage(skeleton stage) with the DETERMINED boolean gate.
# The determined gate is `true` for every stance: per the verified resolution
# prose (pre-cutover SKILL.md:686-720), skeleton-on always-gates Bolt 1, and
# skeleton-off runs Bolt 1 as a regular Bolt whose batch gate is still presented
# (Construction Autonomy Mode is unset → treated as gated until the post-Bolt-1
# ladder). The stance picks the CEREMONY (solo + always-gate + ladder vs regular
# batch gate) — conductor orchestration — not whether a gate is presented; the
# gate axis is on for all Construction work. The round-trip earns its keep by
# DETERMINING the boolean the engine could not compute, not by the boolean
# differing per stance.
#
# Plus one backward-compat assertion — a non-skeleton construction stage still
# emits a BOOLEAN gate (the sentinel never leaks past the skeleton case) — and
# three negative paths (two assertions each: kind + verbatim wording): an invalid
# stance value, a stance reported when the workflow is NOT parked on the
# skeleton-gate stage, and a stance reported with no state file all surface a
# clear `error` rather than scribbling the field at the wrong moment.
#
# Mirrors the tests/feature/t118-engine-differential.sh harness (seed a state
# fixture, shell out to the engine, json_field the directive). Feature tier —
# no LLM, no model. (19 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"
STATE_TOOL="$AIDLC_SRC/tools/aidlc-state.ts"
# state-construction-bolt1.md: a feature workflow parked at the first Construction
# Bolt — inception complete ([x] through delivery-planning), Construction Active,
# Current Stage=functional-design (the first construction EXECUTE stage for
# feature/enterprise/mvp/refactor/workshop = the skeleton-gate stage). The
# walking-skeleton gate has not yet been resolved.
BOLT1_FIXTURE="$FIXTURES_DIR/state-construction-bolt1.md"

# Scope is resolved partly from AWS_AIDLC_DEFAULT_SCOPE — start from a known
# clean env so a developer's exported value can't shadow the seeded fixture.
reset_aidlc_env

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

# Engine guard — the round-trip is meaningful only against the COMPLETE engine
# (next + report). Bail loudly if it's missing rather than pass an empty plan.
if [ ! -f "$TOOL" ]; then
  echo "Bail out! aidlc-orchestrate.ts not found at $TOOL — engine base is wrong"
  exit 1
fi
if [ ! -f "$BOLT1_FIXTURE" ]; then
  echo "Bail out! state-construction-bolt1.md fixture not found at $BOLT1_FIXTURE"
  exit 1
fi

# Extract a scalar field from a directive JSON (booleans as JSON lowercase, so a
# gate assertion diffs against the on-the-wire value byte-for-byte; strings bare).
json_field() {
  python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  v=d.get(sys.argv[1], "<MISSING>")
  print(json.dumps(v) if isinstance(v, bool) else v)
except Exception:
  print("<PARSE-ERR>")' "$2" <<< "$1"
}

# The skeleton-gate stage for the fixture's scope (feature) — the first
# Construction EXECUTE stage. Frozen here; matches firstInScopeStageOfPhase(
# "construction", "feature") and the fixture's own Current Stage.
SKELETON_STAGE="functional-design"

plan 19

# === The round-trip, end-to-end, per stance (3 stances × 4 assertions = 12) ===
# Each iteration seeds a fresh copy of the Bolt-1 fixture (the round-trip mutates
# state), drives next → report --skeleton-stance <s> → next, and pins all three
# steps. The expected DETERMINED gate is `true` for every stance (see header).
for stance in on off scope-dependent; do
  PROJ=$(create_test_project)
  seed_state_file "$PROJ" "$BOLT1_FIXTURE"

  # Step 1 — the engine DEFERS the skeleton gate: next emits a run-stage for the
  # skeleton stage with gate:"unresolved" (the sentinel the conductor recognises).
  N1=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
  assert_eq "$(json_field "$N1" kind)|$(json_field "$N1" stage)|$(json_field "$N1" gate)" \
    "run-stage|$SKELETON_STAGE|unresolved" \
    "[$stance] step 1: next → run-stage($SKELETON_STAGE) gate:\"unresolved\" (engine defers the skeleton gate)"

  # Step 2 — the conductor hands the classified stance back. report
  # --skeleton-stance is accepted (a `print` telling the conductor to re-run
  # next; NOT a done/transition), and the stance is recorded in state.
  R=$(bun "$TOOL" report --skeleton-stance "$stance" --project-dir "$PROJ" 2>&1)
  assert_eq "$(json_field "$R" kind)" "print" \
    "[$stance] step 2: report --skeleton-stance $stance → print (stance accepted, re-run next)"
  assert_grep "$PROJ/aidlc-docs/aidlc-state.md" "\*\*Skeleton Stance\*\*: $stance" \
    "[$stance] step 2: stance recorded in the Skeleton Stance state field"

  # Step 3 — the follow-up next reads the recorded stance and re-emits the SAME
  # stage with the now-DETERMINED boolean gate (no longer the sentinel).
  N2=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
  assert_eq "$(json_field "$N2" kind)|$(json_field "$N2" stage)|$(json_field "$N2" gate)" \
    "run-stage|$SKELETON_STAGE|true" \
    "[$stance] step 3: next → run-stage($SKELETON_STAGE) gate:true (determined from stance)"

  cleanup_test_project "$PROJ"
done

# === Backward-compat: a non-skeleton run-stage keeps its BOOLEAN gate (1) ===
# The sentinel is EXCLUSIVELY the skeleton case. state-construction has Current
# Stage=functional-design ALREADY completed, so next advances to nfr-design — a
# non-first construction stage — which must emit a plain boolean gate:true, never
# "unresolved". Proves the deferral does not leak to every construction stage.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction.md"
NB=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$NB" gate)" "true" \
  "backward-compat: a non-skeleton construction stage emits boolean gate:true, never the sentinel"
cleanup_test_project "$PROJ"

# === Negative path 1: invalid stance value → error (1) ===
# Only on/off/scope-dependent are accepted; anything else is a hard error (clean
# boundary) rather than a silent write.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$BOLT1_FIXTURE"
OUT=$(bun "$TOOL" report --skeleton-stance bogus --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "error" \
  "negative: report --skeleton-stance bogus → error directive (invalid stance rejected)"
# Match the bare message (json_field strips the JSON quoting) so the escaped \"
# in the raw directive doesn't defeat the substring match.
assert_contains "$(json_field "$OUT" message)" 'Unknown --skeleton-stance "bogus"' \
  "negative: invalid-stance error names the rejected value"
cleanup_test_project "$PROJ"

# === Negative path 2: stance reported off the skeleton-gate stage → error (1) ===
# A stance only makes sense parked on the skeleton-gate stage with an unresolved
# gate. With Current Stage advanced to nfr-design (NOT the skeleton stage), the
# conductor mis-fired — the engine surfaces it rather than writing the field at
# the wrong moment.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction.md"
bun "$STATE_TOOL" set "Current Stage=nfr-design" --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" report --skeleton-stance on --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "error" \
  "negative: stance off the skeleton-gate stage (nfr-design) → error directive"
assert_contains "$OUT" "is not the skeleton-gate stage for scope" \
  "negative: off-stage error explains it is not the skeleton-gate stage"
cleanup_test_project "$PROJ"

# === Negative path 3: stance reported with no state file → error (1) ===
# create_test_project makes aidlc-docs/ but NO aidlc-state.md — there is nothing
# to record a stance for.
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" report --skeleton-stance on --project-dir "$PROJ" 2>&1)
assert_eq "$(json_field "$OUT" kind)" "error" \
  "negative: stance with no state file → error directive (nothing to record for)"
assert_contains "$OUT" "No workflow state found" \
  "negative: no-state stance error carries the verbatim no-state wording"
cleanup_test_project "$PROJ"

finish
