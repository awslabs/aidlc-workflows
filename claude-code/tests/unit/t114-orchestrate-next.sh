#!/bin/bash
# t114: Unit tests for aidlc-orchestrate.ts `next` — the read-only orchestration
# engine handler (27 tests)
#
# `next` reads workflow state + the compiled stage graph and emits EXACTLY ONE
# validated directive (JSON) to stdout, mutating nothing. These tests drive it
# over the existing state fixtures and assert (state + args) → directive kind +
# key fields, the flag-precedence ladder (state > flag > env > default),
# read-only dispatch (--status/--version → print), the mutually-exclusive
# --stage+--phase guard, and scope resolution from a known scope. Table-driven,
# mirrors t19-tool-jump.sh. Unit tier — no LLM, no model in the loop.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"

# Tests resolve scope partly from AWS_AIDLC_DEFAULT_SCOPE — start from a known
# clean env so a developer's exported value can't shadow the fixtures.
reset_aidlc_env

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 27

# --- Test 1: happy path — in-flight current stage → run-stage for it ---
# state-mid-ideation: scope=feature, Current Stage=feasibility ([-] active).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"run-stage"' "in-flight current stage → run-stage directive"
cleanup_test_project "$PROJ"

# --- Test 2: run-stage carries the routing fields read off the graph node ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"stage":"feasibility"' "run-stage names the current stage (feasibility)"
cleanup_test_project "$PROJ"

# --- Test 3: run-stage carries lead_agent + gate off the node ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"lead_agent":"aidlc-architect-agent"' "run-stage carries lead_agent from the graph node"
cleanup_test_project "$PROJ"

# --- Test 4: brownfield bugfix fixture → run-stage for the active stage ---
# state-brownfield-init-done: scope=bugfix, Current Stage=reverse-engineering ([-]).
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-brownfield-init-done.md"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"stage":"reverse-engineering"' "brownfield bugfix active stage → run-stage reverse-engineering"
cleanup_test_project "$PROJ"

# --- Test 5: an INVALID --scope flag errors unconditionally, even when state
# supplies a valid scope ---
# state-mid-inception has a valid Scope (bugfix). An explicit `--scope bogusscope`
# is validated regardless of the state scope (Wave-1 audit finding 4): the prose
# orchestrator errors unconditionally on a bad --scope (SKILL.md:110 step 1), so
# the engine mirrors that with the verbatim `Unknown scope "..."` wording rather
# than silently running the current stage. (A VALID --scope that differs is a
# legitimate scope-change → print, covered by the feature-tier differential
# corpus special path 6; a valid same-as-state --scope is a no-op that falls
# through to the happy path.)
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-inception.md"
OUT=$(bun "$TOOL" next --scope bogusscope --project-dir "$PROJ" 2>&1)
# $OUT is the raw directive JSON, so the message's quotes are backslash-escaped
# (`Unknown scope \"bogusscope\"`). Match a quote-free substring + the kind so
# the assertion is robust to JSON escaping.
assert_contains "$OUT" '"kind":"error"' "invalid --scope errors unconditionally over valid state (not swallowed) [finding 4]"
assert_contains "$OUT" 'Unknown scope' "invalid --scope error carries the verbatim Unknown scope wording"
cleanup_test_project "$PROJ"

# --- Test 6: precedence — explicit --scope flag BEATS env (no state file) ---
# No state file. Invalid env scope would error IF env won; a valid --scope flag
# must take precedence, yielding a run-stage with no error.
PROJ=$(create_test_project)
OUT=$(AWS_AIDLC_DEFAULT_SCOPE=bogusscope bun "$TOOL" next --scope bugfix --stage requirements-analysis --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"run-stage"' "--scope flag beats AWS_AIDLC_DEFAULT_SCOPE env"
cleanup_test_project "$PROJ"

# --- Test 7: precedence — env BEATS default (no state, no flag) ---
# Valid env scope (poc) resolves; --stage surfaces a run-stage directive. The
# default (feature) is never reached because env supplied a valid scope.
PROJ=$(create_test_project)
OUT=$(AWS_AIDLC_DEFAULT_SCOPE=poc bun "$TOOL" next --stage intent-capture --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"stage":"intent-capture"' "env scope beats default (poc resolved, run-stage emitted)"
cleanup_test_project "$PROJ"

# --- Test 8: invalid env scope (last resort) → error carrying the canonical
# AWS_AIDLC_DEFAULT_SCOPE message. The env path validates by composing
# `aidlc-utility.ts resolve-env-scope`, which owns the verbatim
# `Invalid AWS_AIDLC_DEFAULT_SCOPE "...". Valid scopes: ...` wording (SKILL.md:101).
# (The generic `Unknown scope` wording is reserved for the --scope flag / freeform
# path; the env source carries its own canonical message.) ---
PROJ=$(create_test_project)
OUT=$(AWS_AIDLC_DEFAULT_SCOPE=frobnicate bun "$TOOL" next --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'Invalid AWS_AIDLC_DEFAULT_SCOPE' "invalid env scope → error directive (verbatim AWS_AIDLC_DEFAULT_SCOPE message)"
cleanup_test_project "$PROJ"

# --- Test 9: read-only dispatch — --status → print directive ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --status --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"print"' "--status → print directive (read-only dispatch)"
cleanup_test_project "$PROJ"

# --- Test 10: read-only dispatch — --version → print directive ---
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --version --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"print"' "--version → print directive (terminal read-only)"
cleanup_test_project "$PROJ"

# --- Test 11: mutually-exclusive --stage + --phase → error directive ---
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --stage feasibility --phase ideation --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'Cannot use --stage and --phase together' "mutually-exclusive --stage+--phase → error directive"
cleanup_test_project "$PROJ"

# --- Test 12: WITH-STATE jump commits via an `execute` print directive ---
# state-mid-ideation is feature scope, Current Stage=feasibility; `--phase
# construction` resolves forward to functional-design. A jump against an existing
# workflow is a MUTATION (mark intervening [S], emit STAGE_JUMPED, pivot Current
# Stage), and `next` is read-only — so, exactly like scope-change/config-change,
# the engine emits a `print` naming `aidlc-jump.ts execute` for the conductor to
# run, NOT a run-stage. The tool-resolved target (functional-design) + direction
# (forward) are carried in the command; the next `next` after the conductor runs
# it sees the pivoted state and emits the run-stage. (Pre-cutover this branch
# emitted run-stage directly, which produced ZERO state change — the
# release-gate regression t24/t25/t26/t56/t57 caught. This test re-anchors the
# unit-tier proof at the new home: the execute print directive.)
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" next --phase construction --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"print"' "WITH-STATE --phase jump → print directive (commit is a mutation, next stays read-only)"
assert_contains "$OUT" 'aidlc-jump.ts execute --target functional-design --direction forward' "jump print names execute with the tool-resolved target + direction"
cleanup_test_project "$PROJ"

# --- Test 13: gate axis is the human-judgement boundary, NOT conditional-inclusion ---
# Regression guard for the gate-derivation fix. intent-capture is execution:ALWAYS
# (the conditional-inclusion axis) yet presents a standard approval gate. A rule that
# read gate from `execution !== ALWAYS` would emit gate:false here — wrong. Every
# EXECUTE stage gates except bootstrap initialization stages, so intent-capture (an
# ideation stage) MUST carry gate:true.
PROJ=$(create_test_project)
OUT=$(AWS_AIDLC_DEFAULT_SCOPE=poc bun "$TOOL" next --stage intent-capture --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"gate":true' "ALWAYS-execution gated stage (intent-capture) → gate:true (not derived from execution axis)"
cleanup_test_project "$PROJ"

# --- Test 14: the cutover invocation is engine-compatible (no dropped-arg wrapper) ---
# Regression guard for the cutover. SKILL.md's forwarding loop invokes the engine
# as `next $ARGUMENTS` (argv word-split straight into the parser). A wrapper like
# `next --args "$ARGUMENTS"` would silently drop every flag-bearing invocation —
# `--args` is an unknown `--` token the parser ignores, and the quoted blob after
# it never reaches a flag branch — so `--stage`/`--scope`/`--phase` jumps would
# all no-op to "run current stage". The parser (parseNextFlags) has no `--args`
# flag and never has. Pin BOTH halves: (a) SKILL.md must NOT document a `--args`
# wrapper; (b) a flag-bearing jump must reach the parser, not fall through to a
# bare next. This couples the shipped prose to the engine's actual CLI — the
# coupling whose absence let the wrapper ship green.
SKILL_MD="$AIDLC_SRC/skills/aidlc/SKILL.md"
if grep -q -- 'next --args' "$SKILL_MD"; then
  not_ok "SKILL.md forwarding loop must not wrap \$ARGUMENTS in a --args flag the engine drops" "found 'next --args' in SKILL.md"
else
  ok "SKILL.md forwarding loop must not wrap \$ARGUMENTS in a --args flag the engine drops"
fi
# Prove the engine has no --args swallow: a flag-bearing jump reaches the parser
# (unknown-stage error), it does NOT fall through to a bare next.
PROJ=$(create_test_project)
OUT=$(AWS_AIDLC_DEFAULT_SCOPE=poc bun "$TOOL" next --stage nonexistent-stage --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'Unknown stage' "flag-bearing argv reaches the parser (no --args swallow): --stage <bad> → unknown-stage error, not bare-next fallthrough"
cleanup_test_project "$PROJ"

# --- Test 15: --init threads --test-run into the scaffold command ---
# Regression guard for the MR8 engine-init cutover. Workflow-birth init-command
# emission moved from SKILL.md prose into the engine's --init branch; the cmd[]
# builder threaded --scope/--depth/--force but DROPPED --test-run. Birth scaffolds
# state via `aidlc-utility.ts init`, and init writes the `Test Run Mode: true`
# state field (aidlc-utility.ts) ONLY when it receives --test-run. jump.ts reads
# that field on resume to detect test-run mode — so a dropped --test-run at birth
# silently strips test-run persistence (5/8 workflow tests failed `Test Run Mode:
# true` deterministically). Pin BOTH halves at the engine boundary: (a) `--init
# --test-run` emits a print whose command carries --test-run; (b) the control
# without --test-run does NOT. No workspace state required — the no-state --init
# branch names the move (print) before any mutation.
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --init --scope bugfix --test-run --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '--test-run' "--init --test-run threads --test-run into the scaffold command (birth test-run persistence)"
cleanup_test_project "$PROJ"

PROJ=$(create_test_project)
OUT=$(bun "$TOOL" next --init --scope bugfix --project-dir "$PROJ" 2>&1)
assert_not_contains "$OUT" '--test-run' "--init without --test-run does NOT thread --test-run (control)"
cleanup_test_project "$PROJ"

# --- Test 16: --test-run RESUME over a stamp-less workflow → enable-test-run print ---
# Regression guard for the MR8 resume-layer fix (sibling to test 15's birth leg).
# t55 is two-session: `/aidlc --init` (no --test-run) then `/aidlc bugfix
# --test-run` over the EXISTING post-init state. Phase 2 is a RESUME — `next
# bugfix --test-run` over existing state would normally run-stage directly, so
# the birth-time `Test Run Mode: true` stamp never fires. The field is
# load-bearing: aidlc-jump.ts:229 READS `getField(content, "Test Run Mode")`,
# NOT the CLI flag, for forward-jump termination (t56/t57 fail indirectly
# through it). The MR8 cutover deleted the old re-stamp instruction with no
# replacement. The engine now NAMES the move (a run-then-continue print) when
# `--test-run` re-enters state lacking the field — mirroring how Branch 5
# (scope/config-change) and the jump execute (Branch 7) name a mutation for the
# conductor; `next` stays read-only. state-brownfield-init-done is bugfix scope,
# Current Stage=reverse-engineering (in-flight), has a Revision Count line (the
# enable-test-run insert anchor), and NO Test Run Mode field — the exact t55
# resume shape.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-brownfield-init-done.md"
OUT=$(bun "$TOOL" next bugfix --test-run --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"kind":"print"' "--test-run over stamp-less state → print directive (resume test-run persistence)"
assert_contains "$OUT" 'enable-test-run' "the print names aidlc-utility.ts enable-test-run for the conductor to run"
cleanup_test_project "$PROJ"

# --- Test 17: control — field ALREADY present → does NOT re-emit enable-test-run ---
# Once enable-test-run has stamped `Test Run Mode: true`, a subsequent `next
# <scope> --test-run` must NOT re-emit the print (else the loop never advances).
# The branch fires only when getField(stateContent, "Test Run Mode") === null,
# so the field's presence falls through to the happy-path run-stage. Stamp the
# field via the real tool (which also proves it inserts after Revision Count),
# then re-run `next`.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-brownfield-init-done.md"
bun "$AIDLC_SRC/tools/aidlc-utility.ts" enable-test-run --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" next bugfix --test-run --project-dir "$PROJ" 2>&1)
assert_not_contains "$OUT" 'enable-test-run' "--test-run with the field already present does NOT re-emit enable-test-run (loop advances)"
assert_contains "$OUT" '"kind":"run-stage"' "field present + --test-run → run-stage (the resume persist branch no-ops)"
cleanup_test_project "$PROJ"

# --- Test 18: control — stamp-less state, NO --test-run → never emits enable-test-run ---
# The branch is gated on flags.testRun; a plain resume over the same stamp-less
# state must take the normal run-stage path, never the test-run-persist print.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-brownfield-init-done.md"
OUT=$(bun "$TOOL" next bugfix --project-dir "$PROJ" 2>&1)
assert_not_contains "$OUT" 'enable-test-run' "no --test-run → never emits enable-test-run (normal run-stage)"
assert_contains "$OUT" '"kind":"run-stage"' "stamp-less state without --test-run → run-stage"
cleanup_test_project "$PROJ"

# --- Test 19: branch order — --scope X --test-run against a DIFFERING scope routes
# to scope-change FIRST, NOT test-run-persist (no shadow). The test-run persist
# branch sits AFTER Branch 5 (scope-change), so the bigger move (scope-change)
# wins; test-run persistence rides the next loop iteration once scope-change has
# re-stamped state. state-brownfield-init-done is bugfix scope; `--scope feature`
# is a valid differing scope. Pins the branch_order_check guarantee.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-brownfield-init-done.md"
OUT=$(bun "$TOOL" next --scope feature --test-run --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" 'scope-change --scope feature' "--scope X --test-run over a differing scope routes to scope-change first (test-run persist does not shadow it)"
assert_not_contains "$OUT" 'enable-test-run' "the scope-change combo does NOT emit enable-test-run (test-run persist rides the next loop iteration)"
cleanup_test_project "$PROJ"

finish
