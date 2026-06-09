#!/bin/bash
# t134 (worktree): aidlc-swarm.ts — the stateless convergence REFEREE (13 tests).
#
# The swarm fires only under human-granted Construction autonomy in a live
# Claude Code session; the conductor (that session) owns the fan-out + retry
# loop, and the tool is the deterministic referee it consults. There is no
# headless `claude -p` worker any more, so there is no binary to swap: the
# HARNESS plays the conductor, driving the referee subcommands directly over
# real git worktrees and staging each worktree's on-disk state the way a worker
# would (or wouldn't) have. Determinism comes from the staged state + the real
# check command's exit code — never a worker's self-claim.
#
# The three subcommands under test:
#   prepare  --batch --units [--base] [--concurrency] [--degraded-from]
#   check    <unit> --check-cmd [--test-file]   (stateless; emits no audit)
#   finalize --batch --units --claimed --check-cmd [--test-file] [--reasons u=reason,...]
#
# Assertions (13):
#   1. prepare: forks a worktree per unit + emits SWARM_STARTED
#   2. check: a GENUINELY converged unit (impl present, check exits 0) → exit 0,
#      converged:true
#   3. check is STATELESS: the same converged unit returns the same verdict on a
#      second call (no counter, no state drift)
#   4. check: a not-yet-converged unit → exit non-zero, converged:false
#   5. anti-tamper: editing the protected --test-file → check reports tampered:true
#      and refuses convergence (exit non-zero) — baseline re-derived from git
#   6. finalize: a genuinely converged claimed unit merges back + emits
#      SWARM_UNIT_CONVERGED, envelope converged:1, exit 0
#   7. LYING-CONDUCTOR GUARD: finalize re-verifies a unit FALSELY claimed
#      converged (red on disk) → refuses the merge, unit lands in the failure
#      envelope, SWARM_UNIT_FAILED + SWARM_BATON_RETURNED emitted, exit 2
#   8. finalize anti-tamper: a claimed unit whose protected file was edited is
#      re-verify-rejected (not merged), even though its check command "passes"
#   9. finalize: a mixed batch (one genuine, one falsely-claimed) tallies
#      converged:1 + failed:1, emits SWARM_COMPLETED, exits 2 (baton returns)
#  10. loud-degrade: prepare --degraded-from ultracode emits the SWARM_DEGRADED row
#  11. path-confinement: a --test-file that escapes the worktree (../) is a typed
#      error on check, not a silently-disabled guard
#  12. conductor attribution: a DECLINED unit with --reasons u=unsatisfiable lands
#      the typed reason `unsatisfiable` (not the cap-exhausted default) in both the
#      envelope and the SWARM_UNIT_FAILED audit row (the spec's named acceptance case)
#  13. --reasons cannot override the lying-conductor guard: a CLAIMED-but-red unit
#      stays reason `error` even when --reasons names it unsatisfiable (the tool's
#      own re-verify verdict wins for a claimed unit)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/worktree-helpers.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

SWARM_TOOL="$AIDLC_SRC/tools/aidlc-swarm.ts"
FIXTURES_DIR="$REPO_ROOT/tests/fixtures"

if [ ! -f "$SWARM_TOOL" ]; then
  echo "Bail out! aidlc-swarm.ts not found at $SWARM_TOOL"
  exit 1
fi

plan 13

FIXTURES=()
trap '
	for f in "${FIXTURES[@]:-}"; do
		if [ -n "$f" ] && [ -d "$f" ]; then
			chmod -R u+w "$f" 2>/dev/null || true
			cleanup_worktree_fixture "$f" || true
		fi
	done
' EXIT INT TERM

# A git-repo fixture in Construction phase with the framework gitignore set,
# so worktree-create does not byte-copy audit.md/runtime-graph.json into the
# child worktree.
make_swarm_fixture() {
  local fix
  fix=$(setup_worktree_fixture)
  FIXTURES+=("$fix")
  mkdir -p "$fix/aidlc-docs"
  cp "$FIXTURES_DIR/state-construction.md" "$fix/aidlc-docs/aidlc-state.md"
  printf "# AI-DLC Audit Log\n" >"$fix/aidlc-docs/audit.md"
  cat >"$fix/.gitignore" <<'EOF'
aidlc-docs/audit.md
aidlc-docs/runtime-graph.json
aidlc-docs/.aidlc-recovery.md
aidlc-docs/.aidlc-hooks-health/
EOF
  (cd "$fix" && git add -A && git -c user.email=t@t -c user.name=t commit -q --amend --no-edit) >/dev/null 2>&1 || true
  echo "$fix"
}

# The per-unit worktree path the tool derives deterministically from the slug
# (mirrors aidlc-lib worktreePath: <proj>/.aidlc/worktrees/bolt-<slug>).
wt_path() { echo "$1/.aidlc/worktrees/bolt-$2"; }

# Run a referee subcommand. $1=proj, rest=args. Captures stdout/rc without
# letting `set -e` abort on the tool's intended non-zero exits.
run_ref() {
  local proj="$1"
  shift
  bun "$SWARM_TOOL" --project-dir "$proj" "$@" \
    >/tmp/t134-out.$$ 2>/tmp/t134-err.$$ && REF_RC=0 || REF_RC=$?
  REF_OUT="$(cat /tmp/t134-out.$$ 2>/dev/null || true)"
  REF_ERR="$(cat /tmp/t134-err.$$ 2>/dev/null || true)"
  rm -f /tmp/t134-out.$$ /tmp/t134-err.$$
  return 0
}

# ============================================================================
# Cases 1-4 + 6: prepare + check (stateless) + finalize on a converged unit.
# ============================================================================
PROJ=$(make_swarm_fixture)
run_ref "$PROJ" prepare --batch 1 --units alpha --base main

if echo "$REF_OUT" | grep -q '"ok": true' &&
  grep -q "SWARM_STARTED" "$PROJ/aidlc-docs/audit.md" &&
  [ -d "$(wt_path "$PROJ" alpha)" ]; then
  ok "1 prepare: forked a worktree for the unit + emitted SWARM_STARTED"
else
  not_ok "prepare forks + SWARM_STARTED" "rc=$REF_RC out=$REF_OUT audit=$(cat "$PROJ/aidlc-docs/audit.md")"
fi

# The conductor's worker would have written impl.txt; the harness stages it so
# the real check command (exit 0 = green) passes.
echo "done" >"$(wt_path "$PROJ" alpha)/impl.txt"

run_ref "$PROJ" check alpha --check-cmd "test -f impl.txt"
if [ "$REF_RC" = "0" ] && echo "$REF_OUT" | grep -q '"converged":true'; then
  ok "2 check: genuinely converged unit → exit 0, converged:true"
else
  not_ok "check converged" "rc=$REF_RC out=$REF_OUT"
fi

# Stateless: a second identical call returns the same verdict (no counter).
run_ref "$PROJ" check alpha --check-cmd "test -f impl.txt"
if [ "$REF_RC" = "0" ] && echo "$REF_OUT" | grep -q '"converged":true'; then
  ok "3 check is stateless: same verdict on a repeat call (no counter)"
else
  not_ok "check stateless" "rc=$REF_RC out=$REF_OUT"
fi

# A not-yet-converged unit: prepare beta, do NOT write its impl, check → red.
run_ref "$PROJ" prepare --batch 1 --units beta --base main
run_ref "$PROJ" check beta --check-cmd "test -f impl.txt"
if [ "$REF_RC" != "0" ] && echo "$REF_OUT" | grep -q '"converged":false'; then
  ok "4 check: not-yet-converged unit → exit non-zero, converged:false"
else
  not_ok "check not-converged" "rc=$REF_RC out=$REF_OUT"
fi

# finalize the genuinely converged alpha (claimed) — merges back + emits.
run_ref "$PROJ" finalize --batch 1 --units alpha --claimed alpha --check-cmd "test -f impl.txt"
if echo "$REF_OUT" | grep -q '"converged": 1' &&
  echo "$REF_OUT" | grep -q '"merge_failures": \[\]' &&
  grep -q "SWARM_UNIT_CONVERGED" "$PROJ/aidlc-docs/audit.md" &&
  [ "$REF_RC" = "0" ]; then
  ok "6 finalize: genuine claimed unit merges back + SWARM_UNIT_CONVERGED, exit 0"
else
  not_ok "finalize converged" "rc=$REF_RC out=$REF_OUT audit_conv=$(grep -c SWARM_UNIT_CONVERGED "$PROJ/aidlc-docs/audit.md")"
fi

# ============================================================================
# Case 5: anti-tamper on check — editing the protected --test-file is rejected,
# baseline re-derived from the worktree's own git fork (no stored hash).
# ============================================================================
PROJ=$(make_swarm_fixture)
# Seed a tracked protected file so the worktree fork carries it at HEAD.
mkdir -p "$PROJ/spec"
printf 'EXPECTED\n' >"$PROJ/spec/unit.test"
(cd "$PROJ" && git add -A && git -c user.email=t@t -c user.name=t commit -q -m "seed test") >/dev/null 2>&1
run_ref "$PROJ" prepare --batch 1 --units gamma --base main
# The "worker" cheats: it makes the check pass by editing the protected file.
echo "TAMPERED" >"$(wt_path "$PROJ" gamma)/spec/unit.test"
run_ref "$PROJ" check gamma --check-cmd "grep -q TAMPERED spec/unit.test" --test-file "spec/unit.test"
if [ "$REF_RC" != "0" ] && echo "$REF_OUT" | grep -q '"tampered":true'; then
  ok "5 anti-tamper: edited protected --test-file → tampered:true, convergence refused"
else
  not_ok "anti-tamper check" "rc=$REF_RC out=$REF_OUT"
fi

# ============================================================================
# Cases 7 + 9: the LYING-CONDUCTOR GUARD + mixed batch. A conductor claims two
# units converged; only one actually is.
# ============================================================================
PROJ=$(make_swarm_fixture)
run_ref "$PROJ" prepare --batch 2 --units win,lie --base main
# `win` genuinely converges; `lie` does NOT (no impl written) but the conductor
# falsely claims it converged.
echo "done" >"$(wt_path "$PROJ" win)/win.txt"
run_ref "$PROJ" finalize --batch 2 --units win,lie --claimed win,lie \
  --check-cmd "test -f win.txt"

# Test 7: the lying-conductor guard — `lie` is re-verified red, refused the
# merge, lands in the failure envelope; SWARM_UNIT_FAILED + SWARM_BATON_RETURNED.
if echo "$REF_OUT" | grep -q '"unit": "lie"' &&
  echo "$REF_OUT" | grep -A2 '"unit": "lie"' | grep -q '"status": "failed"' &&
  grep -q "SWARM_UNIT_FAILED" "$PROJ/aidlc-docs/audit.md" &&
  grep -q "SWARM_BATON_RETURNED" "$PROJ/aidlc-docs/audit.md"; then
  ok "7 lying-conductor: a falsely-claimed-converged unit is re-verify-refused"
else
  not_ok "lying-conductor guard" "out=$REF_OUT failed=$(grep -c SWARM_UNIT_FAILED "$PROJ/aidlc-docs/audit.md")"
fi

# Test 9: the mixed batch tallies 1 converged + 1 failed, emits SWARM_COMPLETED,
# and exits 2 (baton returns).
if echo "$REF_OUT" | grep -q '"converged": 1' &&
  echo "$REF_OUT" | grep -q '"failed": 1' &&
  grep -q "SWARM_COMPLETED" "$PROJ/aidlc-docs/audit.md" &&
  [ "$REF_RC" = "2" ]; then
  ok "9 finalize mixed batch: 1 converged + 1 failed tallied; SWARM_COMPLETED; exit 2"
else
  not_ok "finalize mixed batch" "rc=$REF_RC out=$REF_OUT"
fi

# ============================================================================
# Case 8: finalize anti-tamper — a claimed unit whose protected file was edited
# is re-verify-rejected even though the check command keys off that file.
# ============================================================================
PROJ=$(make_swarm_fixture)
mkdir -p "$PROJ/spec"
printf 'EXPECTED\n' >"$PROJ/spec/unit.test"
(cd "$PROJ" && git add -A && git -c user.email=t@t -c user.name=t commit -q -m "seed test") >/dev/null 2>&1
run_ref "$PROJ" prepare --batch 1 --units delta --base main
echo "TAMPERED" >"$(wt_path "$PROJ" delta)/spec/unit.test"
run_ref "$PROJ" finalize --batch 1 --units delta --claimed delta \
  --check-cmd "grep -q TAMPERED spec/unit.test" --test-file "spec/unit.test"
if [ "$REF_RC" = "2" ] &&
  echo "$REF_OUT" | grep -q '"converged": 0' &&
  echo "$REF_OUT" | grep -q '"tampered": true'; then
  ok "8 finalize anti-tamper: a tampered claimed unit is re-verify-rejected (not merged)"
else
  not_ok "finalize anti-tamper" "rc=$REF_RC out=$REF_OUT"
fi

# ============================================================================
# Case 10: loud-degrade — prepare --degraded-from ultracode emits SWARM_DEGRADED.
# ============================================================================
PROJ=$(make_swarm_fixture)
run_ref "$PROJ" prepare --batch 1 --units epsilon --base main --degraded-from ultracode
if grep -q "SWARM_DEGRADED" "$PROJ/aidlc-docs/audit.md" &&
  grep -q "ultracode" "$PROJ/aidlc-docs/audit.md"; then
  ok "10 loud-degrade: prepare --degraded-from ultracode emits SWARM_DEGRADED"
else
  not_ok "SWARM_DEGRADED emitted" "audit: $(grep -A4 SWARM_DEGRADED "$PROJ/aidlc-docs/audit.md" 2>/dev/null)"
fi

# ============================================================================
# Case 11: path-confinement — a --test-file escaping the worktree (../) is a
# typed error on check, not a silently-disabled anti-tamper guard.
# ============================================================================
PROJ=$(make_swarm_fixture)
run_ref "$PROJ" prepare --batch 1 --units zeta --base main
echo "done" >"$(wt_path "$PROJ" zeta)/impl.txt"
run_ref "$PROJ" check zeta --check-cmd "test -f impl.txt" --test-file "../escape.test"
# `check` prints compact JSON ("reason":"error"); `finalize` pretty-prints. Match
# the substance — the typed error reason + the confinement message — not spacing.
if [ "$REF_RC" != "0" ] &&
  echo "$REF_OUT" | grep -q '"reason":"error"' &&
  echo "$REF_OUT" | grep -q 'resolves outside the unit worktree'; then
  ok "11 path-confinement: a ../ --test-file is a typed error, not a disabled guard"
else
  not_ok "path-confinement" "rc=$REF_RC out=$REF_OUT"
fi

# ============================================================================
# Case 12: conductor attribution — a DECLINED unit (not claimed converged) for
# which the conductor judged the unit unsatisfiable. --reasons carries that typed
# attribution; the tool records it faithfully (knowledge->conductor decides,
# determinism->tool records) instead of the cap-exhausted default. This is the
# spec's named acceptance case (wave-4.md: "unsatisfiable, not a hedge").
# ============================================================================
PROJ=$(make_swarm_fixture)
run_ref "$PROJ" prepare --batch 1 --units stuck --base main
# `stuck` gets no impl and is NOT claimed; the conductor attributes unsatisfiable.
run_ref "$PROJ" finalize --batch 1 --units stuck --claimed "" \
  --check-cmd "test -f impl.txt" --reasons stuck=unsatisfiable
if [ "$REF_RC" = "2" ] &&
  echo "$REF_OUT" | grep -q '"reason": "unsatisfiable"' &&
  grep -A4 "SWARM_UNIT_FAILED" "$PROJ/aidlc-docs/audit.md" | grep -qi "unsatisfiable"; then
  ok "12 conductor attribution: --reasons unsatisfiable lands the typed reason (envelope + audit)"
else
  not_ok "conductor attribution unsatisfiable" "rc=$REF_RC out=$REF_OUT audit=$(grep -A4 SWARM_UNIT_FAILED "$PROJ/aidlc-docs/audit.md" 2>/dev/null)"
fi

# ============================================================================
# Case 13: --reasons cannot override the lying-conductor guard. A unit CLAIMED
# converged but red on disk must stay reason `error` (the tool's own re-verify
# verdict) even when --reasons names it unsatisfiable — a conductor attribution
# applies only to DECLINED units, never to launder a claimed-but-red one.
# ============================================================================
PROJ=$(make_swarm_fixture)
run_ref "$PROJ" prepare --batch 1 --units sneaky --base main
# sneaky is CLAIMED converged but no impl exists; conductor also tries to dress
# the failure as unsatisfiable via --reasons. The tool must ignore that and
# report error (claimed-but-red).
run_ref "$PROJ" finalize --batch 1 --units sneaky --claimed sneaky \
  --check-cmd "test -f impl.txt" --reasons sneaky=unsatisfiable
if [ "$REF_RC" = "2" ] &&
  echo "$REF_OUT" | grep -q '"reason": "error"' &&
  ! echo "$REF_OUT" | grep -q '"reason": "unsatisfiable"'; then
  ok "13 --reasons cannot override the lying-conductor guard: claimed-but-red stays error"
else
  not_ok "reasons cannot override guard" "rc=$REF_RC out=$REF_OUT"
fi

finish
