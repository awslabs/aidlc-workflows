#!/bin/bash
# t117: Unit tests for aidlc-orchestrate.ts `next` — the non-happy-path branches
# (jump / resume / init / scope-change / env-scope) (24 tests)
#
# These branches port the remaining SKILL.md handlers into the read-only engine
# as typed directives. `next` still mutates NOTHING: jumps + env-scope shell out
# to PURE-READ subcommands (aidlc-jump.ts resolve, aidlc-utility.ts
# resolve-env-scope); the init guard shells out only on the already-state-exists
# path (where the tool dies at its guard before writing); scope/config-change
# emit a `print` naming the conductor's move rather than performing it. The
# engine NEVER calls AskUserQuestion — resume + scope-confirm come out as `ask`.
#
# Each test drives (state + args) → expected directive kind + key fields. Jump
# directions are cross-checked against `aidlc-jump.ts resolve` (the engine
# delegates direction to that tool rather than re-deriving it). Table-driven,
# mirrors t19-tool-jump.sh + t114-orchestrate-next.sh. Unit tier — no LLM.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"
JUMP_TOOL="$AIDLC_SRC/tools/aidlc-jump.ts"

# Tests resolve scope partly from AWS_AIDLC_DEFAULT_SCOPE — start from a known
# clean env so a developer's exported value can't shadow the fixtures.
reset_aidlc_env

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 24

# --- Test 1: forward jump → print naming execute; direction matches resolve ---
# state-mid-ideation: Current Stage=feasibility. --stage code-generation is later
# in the graph → resolve says forward. A WITH-STATE jump is a MUTATION (mark
# intervening [S], emit STAGE_JUMPED, pivot Current Stage) and `next` is
# read-only, so — exactly like scope-change (Test 11) / config-change (Test 12) —
# the engine emits a `print` naming `aidlc-jump.ts execute` carrying the
# tool-resolved target + direction, NOT a run-stage. (Re-anchored at the engine
# cutover: pre-cutover this emitted run-stage directly, producing ZERO state
# change — the release-gate regression t24/t25/t26/t56/t57 caught.)
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --stage code-generation --project-dir "$PROJ" 2>&1)
DIR=$(bun "$JUMP_TOOL" resolve --stage code-generation --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'execute --target code-generation --direction forward' "forward jump → print naming execute for the resolved target (code-generation, forward)"
assert_contains "$DIR" '"direction":"forward"' "forward jump direction matches aidlc-jump.ts resolve"
cleanup_test_project "$PROJ"

# --- Test 2: backward jump → print naming execute; direction matches resolve ---
# state-jumped: Current Stage=code-generation. --stage feasibility is earlier →
# resolve says backward. WITH-STATE jump → print naming execute (see Test 1).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" next --stage feasibility --project-dir "$PROJ" 2>&1)
DIR=$(bun "$JUMP_TOOL" resolve --stage feasibility --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'execute --target feasibility --direction backward' "backward jump → print naming execute for the resolved target (feasibility, backward)"
assert_contains "$DIR" '"direction":"backward"' "backward jump direction matches aidlc-jump.ts resolve"
cleanup_test_project "$PROJ"

# --- Test 3: redo jump → print naming execute; direction matches resolve ---
# state-jumped: Current Stage=code-generation. --stage code-generation == current
# → resolve says redo. WITH-STATE jump → print naming execute (see Test 1).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" next --stage code-generation --project-dir "$PROJ" 2>&1)
DIR=$(bun "$JUMP_TOOL" resolve --stage code-generation --scope feature --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'execute --target code-generation --direction redo' "redo jump → print naming execute for the resolved target (code-generation, redo)"
assert_contains "$DIR" '"direction":"redo"' "redo jump direction matches aidlc-jump.ts resolve"
cleanup_test_project "$PROJ"

# --- Test 4: jump to a SKIP-for-scope stage → error (verbatim resolve wording) ---
# state-mid-inception is bugfix scope; intent-capture is SKIP for bugfix. The
# engine relays the resolve tool's verbatim skip message rather than emitting a
# run-stage for a stage the scope excludes.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-inception.md"
OUT=$(bun "$TOOL" next --stage intent-capture --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"error"' "jump to a SKIP-for-scope stage → error directive"
assert_contains "$OUT" 'is skipped for scope' "SKIP-stage error carries the verbatim resolve wording"
cleanup_test_project "$PROJ"

# --- Test 5: resume with existing state → ask directive ---
# /aidlc --resume over an existing workflow surfaces the resume-choice question;
# the engine emits `ask` and stops (it never calls AskUserQuestion).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" next --resume --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"ask"' "resume with existing state → ask directive"
cleanup_test_project "$PROJ"

# --- Test 6: resume over a mid-phase fixture → ask directive ---
# A second resume fixture (mid-ideation, an in-flight [-] stage) proves the
# branch is keyed on --resume + state presence, not on a single fixture.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --resume --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"ask"' "resume over a mid-phase workflow → ask directive"
cleanup_test_project "$PROJ"

# --- Test 7: init guard — state exists, no --force → error (verbatim) ---
# The init tool dies at its own guard (before any scaffold write) when state
# exists and --force is absent; the engine relays that verbatim message.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --init --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"error"' "init guard (state exists, no --force) → error directive"
assert_contains "$OUT" 'Use --force to reinitialize' "init-guard error carries the verbatim guard message"
cleanup_test_project "$PROJ"

# --- Test 8: init on a clean workspace → print (names the move, no mutation) ---
# No state file: init WOULD mutate, so `next` does not spawn it — it emits a
# print naming the command. The state file must NOT be created by `next`.
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --init --scope poc --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"print"' "init on a clean workspace → print directive (read-only)"
if [ ! -f "$PROJ/aidlc-docs/aidlc-state.md" ]; then
  ok "next --init does not create state (mutation stays conductor-side)"
else
  not_ok "next --init does not create state" "state file was created by next"
fi
cleanup_test_project "$PROJ"

# --- Test 9: mutually-exclusive --stage + --phase → error (verbatim SKILL.md) ---
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --stage feasibility --phase ideation --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'Cannot use --stage and --phase together' "mutually-exclusive --stage+--phase → error directive (verbatim)"
cleanup_test_project "$PROJ"

# --- Test 10: env-scope-invalid → error carrying the verbatim substring ---
# AWS_AIDLC_DEFAULT_SCOPE=bogus, no state, no flag → scope source is env; the
# engine shells out to resolve-env-scope and relays its verbatim message.
PROJ=$(create_test_project)
OUT=$(AWS_AIDLC_DEFAULT_SCOPE=bogus bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"error"' "env-scope-invalid → error directive"
assert_contains "$OUT" 'Invalid AWS_AIDLC_DEFAULT_SCOPE' "env-scope error carries the verbatim Invalid AWS_AIDLC_DEFAULT_SCOPE substring"
cleanup_test_project "$PROJ"

# --- Test 11: scope-change against existing state → print (names the move) ---
# state-mid-ideation is feature scope; --scope mvp with no --stage/--phase is a
# scope change. Changing scope is a mutation, so `next` emits a print naming the
# scope-change command rather than performing it.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --scope mvp --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'scope-change --scope mvp' "scope-change against existing state → print naming the scope-change command"
cleanup_test_project "$PROJ"

# --- Test 12: config-change (depth) against existing state → print ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --depth comprehensive --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'config-change --depth comprehensive' "config-change (depth) against existing state → print naming the config-change command"
cleanup_test_project "$PROJ"

# --- Test 13: phase jump → print naming execute for the first in-scope stage ---
# state-mid-ideation is feature scope, Current Stage=feasibility; --phase
# construction resolves (via the resolve tool) to the first EXECUTE stage of
# construction (functional-design), forward of feasibility. A WITH-STATE phase
# jump is a MUTATION, so the engine emits a `print` naming execute with the
# tool-resolved target + direction, NOT a run-stage (re-anchored at the engine
# cutover; see Test 1).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --phase construction --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'execute --target functional-design --direction forward' "phase jump (construction, feature) → print naming execute functional-design (forward)"
cleanup_test_project "$PROJ"

# --- Test 14: freeform intent with no workflow → ask (scope confirmation) ---
# `/aidlc <freeform text>` with no state and no explicit scope surfaces the
# scope-confirmation question as `ask`; the engine never auto-dispatches.
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next "add a login form to the app" --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"ask"' "freeform intent with no workflow → ask directive (scope confirmation)"
cleanup_test_project "$PROJ"

# --- Test 15: init-stage jump guard (SKILL.md step 5) — --stage <init>, state present ---
# Jumping to an initialization stage is rejected (init stages have bootstrap
# behavior that doesn't fit the jump model). aidlc-jump.ts resolve treats them as
# valid targets, so the engine enforces the guard itself with the verbatim prose.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" next --stage state-init --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'Cannot jump to initialization stages' "jump to init stage (state present) → error, not run-stage"
cleanup_test_project "$PROJ"

# --- Test 16: init-stage jump guard — --phase initialization ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-jumped.md"
OUT=$(bun "$TOOL" next --phase initialization --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'Cannot jump to initialization stages' "--phase initialization → error (init guard)"
cleanup_test_project "$PROJ"

# --- Test 17: init-stage jump guard holds on the no-state path too ---
# next --stage <init> with no state file must still reject (the no-state stage
# fallback applies the same guard before naming the target).
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --stage workspace-scaffold --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'Cannot jump to initialization stages' "jump to init stage (no state) → error (guard holds)"
cleanup_test_project "$PROJ"

finish
