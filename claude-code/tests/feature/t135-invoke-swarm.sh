#!/bin/bash
# t135 (feature): invoke-swarm — the engine emits it under an autonomy grant,
# and the swarm referee emits the three batch-level events (8 tests).
#
# DETERMINISTIC, no live model. Two surfaces:
#   (1-2,7) The ENGINE (aidlc-orchestrate next): a Construction-phase project at
#       the code-generation stage (in-flight) with a runtime-graph.json carrying
#       a bolt_dag batch. With Construction Autonomy Mode: autonomous the engine
#       emits {"kind":"invoke-swarm","units":[...]} naming the batch; with the
#       grant absent (gated/unset) it falls back to a run-stage for
#       code-generation — invoke-swarm is gated on the autonomy grant. (7) the
#       structural skeleton guard: under a scope where code-generation IS the
#       walking-skeleton gate stage (bugfix/poc), the swarm NEVER fires even
#       with autonomy granted — Bolt 1 is always human-gated.
#   (3-6) The REFEREE (aidlc-swarm prepare/finalize) over a real worktree
#       fixture, with the HARNESS playing the conductor (no claude -p worker,
#       no AIDLC_SWARM_CLAUDE_BIN): `prepare` a 2-unit batch, stage only `win`'s
#       impl on disk, then `finalize` claiming BOTH — `lose` is re-verified red
#       (the lying-conductor guard) and fails. Assert the three batch-level
#       audit events SWARM_STARTED (prepare) / SWARM_COMPLETED / SWARM_BATON_RETURNED
#       (finalize) all land in audit.md. The full referee surface is t134's job.
#
# Why feature tier, not workflow/integration: this gates the 0.6.0 minor, so it
# must always run — the integration tier is claude-gated and would SKIP on a
# CLI-less box. Both surfaces here are deterministic (engine read + harness-driven
# referee), so there is no model to gate on.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"
source "$SCRIPT_DIR/../lib/worktree-helpers.sh"

reset_aidlc_env

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"
SWARM_TOOL="$AIDLC_SRC/tools/aidlc-swarm.ts"
for f in "$TOOL" "$SWARM_TOOL"; do
  if [ ! -f "$f" ]; then
    echo "Bail out! tool not found at $f"
    exit 1
  fi
done

plan 8

# Extract a scalar field from a directive JSON (no jq in the env).
json_field() {
  python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  v=d.get(sys.argv[1], "<MISSING>")
  print(json.dumps(v) if isinstance(v,(bool,list,dict)) else v)
except Exception:
  print("<PARSE-ERR>")' "$2" <<< "$1"
}

# Seed a Construction-phase project parked at code-generation (in-flight) with a
# bolt_dag batch on runtime-graph.json. $2 = the autonomy line to inject (or "").
seed_codegen_project() {
  local proj="$1" autonomy="$2"
  seed_state_file "$proj" "$FIXTURES_DIR/state-construction.md"
  # Pivot Current Stage to code-generation (the per-unit build stage). Its
  # checkbox under widget-checkout is [ ] (pending) → in-flight, so the engine
  # runs THAT stage next.
  sed_i "s/^- \*\*Current Stage\*\*:.*/- **Current Stage**: code-generation/" \
    "$proj/aidlc-docs/aidlc-state.md"
  if [ -n "$autonomy" ]; then
    # Add the autonomy field right after the Scope line.
    sed_i "s/^- \*\*Scope\*\*: \(.*\)$/- **Scope**: \1\n- **Construction Autonomy Mode**: $autonomy/" \
      "$proj/aidlc-docs/aidlc-state.md"
  fi
  # The compiled batch DAG (MR 15 shape): one topological level of units a,b.
  cat >"$proj/aidlc-docs/runtime-graph.json" <<'EOF'
{
  "bolt_dag": {
    "units": [
      { "name": "a", "depends_on": [] },
      { "name": "b", "depends_on": [] }
    ],
    "batches": [["a", "b"]]
  }
}
EOF
}

# ============================================================================
# (1) Autonomy granted → engine emits invoke-swarm naming the batch
# ============================================================================
PROJ=$(create_test_project)
seed_codegen_project "$PROJ" "autonomous"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
KIND=$(json_field "$OUT" kind)
UNITS=$(json_field "$OUT" units)
assert_eq "$KIND" "invoke-swarm" \
  "(1) autonomy granted + eligible batch → engine emits invoke-swarm"
# units is the first batch (a,b) — JSON array, order-preserved from the DAG.
assert_eq "$UNITS" '["a", "b"]' \
  "(1) invoke-swarm names the batch units off the compiled bolt_dag"
cleanup_test_project "$PROJ"

# ============================================================================
# (2) Autonomy NOT granted (gated) → engine emits run-stage, NOT invoke-swarm
# ============================================================================
PROJ=$(create_test_project)
seed_codegen_project "$PROJ" "gated"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
KIND=$(json_field "$OUT" kind)
STG=$(json_field "$OUT" stage)
assert_eq "$KIND|$STG" "run-stage|code-generation" \
  "(2) gated autonomy → engine falls back to run-stage for code-generation (no swarm)"
cleanup_test_project "$PROJ"

# ============================================================================
# (7) Structural skeleton guard: under bugfix scope, code-generation IS the
# walking-skeleton gate stage (first Construction EXECUTE). Even WITH autonomy
# granted, the engine must NOT swarm it — Bolt 1 is always human-gated. This
# pins the defense-in-depth that does not rest on conductor ordering.
# ============================================================================
PROJ=$(create_test_project)
seed_codegen_project "$PROJ" "autonomous"
# Flip the fixture scope to bugfix, where code-generation is the skeleton gate.
sed_i "s/^- \*\*Scope\*\*: .*/- **Scope**: bugfix/" "$PROJ/aidlc-docs/aidlc-state.md"
OUT=$(bun "$TOOL" next --project-dir "$PROJ" 2>&1)
KIND=$(json_field "$OUT" kind)
assert_eq "$KIND" "run-stage" \
  "(7) skeleton-gate stage is never swarmed even under autonomy (structural guard)"
cleanup_test_project "$PROJ"

# ============================================================================
# (3-6) Referee: the harness plays the conductor. `prepare` a 2-unit batch,
# stage only `win`'s impl on disk, then `finalize` claiming BOTH — `lose` is
# re-verified red (lying-conductor guard) and fails. Assert the three
# batch-level events SWARM_STARTED (prepare) / SWARM_COMPLETED / SWARM_BATON_RETURNED.
# ============================================================================
WT_FIXTURES=()
cleanup_wt() {
  for f in "${WT_FIXTURES[@]:-}"; do
    if [ -n "$f" ] && [ -d "$f" ]; then
      chmod -R u+w "$f" 2>/dev/null || true
      cleanup_worktree_fixture "$f" 2>/dev/null || true
    fi
  done
}
trap cleanup_wt EXIT INT TERM

WTPROJ=$(setup_worktree_fixture)
WT_FIXTURES+=("$WTPROJ")
mkdir -p "$WTPROJ/aidlc-docs"
cp "$FIXTURES_DIR/state-construction.md" "$WTPROJ/aidlc-docs/aidlc-state.md"
printf "# AI-DLC Audit Log\n" >"$WTPROJ/aidlc-docs/audit.md"
cat >"$WTPROJ/.gitignore" <<'EOF'
aidlc-docs/audit.md
aidlc-docs/runtime-graph.json
aidlc-docs/.aidlc-recovery.md
aidlc-docs/.aidlc-hooks-health/
EOF
(cd "$WTPROJ" && git add -A && git -c user.email=t@t -c user.name=t commit -q --amend --no-edit) >/dev/null 2>&1 || true

# Conductor step 1: prepare forks a worktree per unit + emits SWARM_STARTED.
bun "$SWARM_TOOL" --project-dir "$WTPROJ" prepare \
  --batch 1 --units win,lose --base main >/dev/null 2>&1 || true
# Conductor step 2: the worker for `win` converged (writes win.txt); `lose` did
# not. The harness stages win's impl directly — no model.
echo done >"$WTPROJ/.aidlc/worktrees/bolt-win/win.txt"
# Conductor step 3: finalize claiming BOTH (the conductor wrongly claims lose).
# finalize re-verifies, refuses lose, returns the baton.
SWARM_RC=0
bun "$SWARM_TOOL" --project-dir "$WTPROJ" finalize \
  --batch 1 --units win,lose --claimed win,lose --check-cmd "test -f win.txt" \
  >/tmp/t135-out.$$ 2>/tmp/t135-err.$$ && SWARM_RC=0 || SWARM_RC=$?
SWARM_OUT="$(cat /tmp/t135-out.$$ 2>/dev/null || true)"
rm -f /tmp/t135-out.$$ /tmp/t135-err.$$
AUDIT="$WTPROJ/aidlc-docs/audit.md"

# (3) SWARM_STARTED — fan-out at batch start (emitted by prepare).
if grep -q "SWARM_STARTED" "$AUDIT"; then
  ok "(3) SWARM_STARTED emitted at batch start (prepare)"
else
  not_ok "(3) SWARM_STARTED emitted" "audit: $(cat "$AUDIT")"
fi

# (4) SWARM_COMPLETED — once at the end, with the converged/failed tally.
if grep -q "SWARM_COMPLETED" "$AUDIT" &&
  grep -q "Converged count" "$AUDIT" &&
  grep -q "Failed count" "$AUDIT"; then
  ok "(4) SWARM_COMPLETED emitted with converged/failed tally"
else
  not_ok "(4) SWARM_COMPLETED emitted" "audit: $(grep -A5 SWARM_COMPLETED "$AUDIT" 2>/dev/null)"
fi

# (5) SWARM_BATON_RETURNED — one per failed unit (lose), naming the unit + reason.
if grep -q "SWARM_BATON_RETURNED" "$AUDIT" &&
  grep -A4 "SWARM_BATON_RETURNED" "$AUDIT" | grep -q "lose"; then
  ok "(5) SWARM_BATON_RETURNED emitted for the failed unit (lose)"
else
  not_ok "(5) SWARM_BATON_RETURNED emitted" "audit: $(grep -A4 SWARM_BATON_RETURNED "$AUDIT" 2>/dev/null)"
fi

# (6) The mixed batch returns the baton (exit 2): win converged, lose refused.
if [ "$SWARM_RC" = "2" ] &&
  echo "$SWARM_OUT" | grep -q '"converged": 1' &&
  echo "$SWARM_OUT" | grep -q '"failed": 1'; then
  ok "(6) mixed batch exits 2 (baton returns) with 1 converged + 1 failed"
else
  not_ok "(6) mixed batch baton return" "rc=$SWARM_RC out=$SWARM_OUT"
fi

finish
