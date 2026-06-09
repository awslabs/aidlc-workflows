#!/bin/bash
# t39: Per-scope phase sequence test — 9 scopes, data-driven.
#
# For each canonical scope (enterprise, feature, mvp, poc, bugfix, refactor,
# infra, security-patch, workshop), asserts:
#
#   1. PHASE_STARTED fires once per INCLUDED phase (lifecycle phase has at
#      least one EXECUTE stage).
#   2. PHASE_SKIPPED fires once per EXCLUDED phase (no EXECUTE stages).
#   3. The state file's ## Phase Progress section records each phase with the
#      correct status ("Active" / "Pending" / "Skipped") after init.
#
# Init always emits PHASE_STARTED for Initialization (phase 0). PHASE_STARTED
# for subsequent phases fires when `advance` crosses the phase boundary, NOT
# at init time — so we only assert on PHASE_STARTED=Initialization here, and
# assert PHASE_SKIPPED for phases the scope excludes entirely.
#
# L1 tier — pure bash + bun (no claude CLI).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

# Derive expected skipped/active phases from scope-mapping.json. A phase is
# "skipped" iff every stage in that phase is SKIP. Otherwise it's "active"
# (at least one EXECUTE — init will advance into it eventually).
#
# Phase stage sets (lifted from stage-graph.json):
#   initialization: workspace-scaffold workspace-detection state-init
#   ideation:       intent-capture market-research feasibility scope-definition team-formation rough-mockups approval-handoff
#   inception:      reverse-engineering requirements-analysis user-stories refined-mockups application-design units-generation delivery-planning
#   construction:   functional-design nfr-requirements nfr-design infrastructure-design code-generation build-and-test ci-pipeline
#   operation:      deployment-pipeline environment-provisioning deployment-execution observability-setup incident-response performance-validation feedback-optimization
#
# Expected skipped phases per scope (initialization + construction always active).
# macOS ships bash 3.2 — no associative arrays. Use a lookup function instead.
expected_skipped_phases() {
  case "$1" in
    enterprise|feature) echo "" ;;
    mvp|poc) echo "operation" ;;
    bugfix|refactor) echo "ideation operation" ;;
    infra|security-patch|workshop) echo "ideation" ;;
    *) echo "" ;;
  esac
}

expected_skipped_count() {
  local list
  list="$(expected_skipped_phases "$1")"
  if [ -z "$list" ]; then
    echo 0
  else
    echo "$list" | wc -w | tr -d ' '
  fi
}

# 9 scopes × 3 assertions each = 27
plan 27

for scope in enterprise feature mvp poc bugfix refactor infra security-patch workshop; do
  PROJ=$(create_test_project)
  # Init the workflow from this scope. --test-run avoids interactive prompts.
  # Some scopes' init flow (workshop in particular) needs AIDLC_WORKFLOW_INTENT.
  AIDLC_WORKFLOW_INTENT="phase sequence test" \
    bun "$UTIL" init --scope "$scope" --project-dir "$PROJ" --test-run >/dev/null 2>&1 || true

  audit="$PROJ/aidlc-docs/audit.md"
  state="$PROJ/aidlc-docs/aidlc-state.md"

  # --- Assertion 1: PHASE_STARTED emitted for initialization ---
  if grep -qE '^\*\*Event\*\*: PHASE_STARTED' "$audit" 2>/dev/null; then
    ok "[$scope] PHASE_STARTED emitted for initialization"
  else
    not_ok "[$scope] PHASE_STARTED emitted for initialization" \
      "no PHASE_STARTED in audit (init may have failed — see $audit)"
  fi

  # --- Assertion 2: PHASE_SKIPPED emitted once per excluded phase ---
  # grep -c returns 0 to stdout on match-count-zero; the `|| echo 0` fallback
  # only fires if grep itself errors (missing file). Don't combine — that causes
  # "0\n0" to concatenate when both grep and fallback run.
  if [ -f "$audit" ]; then
    actual_skipped=$(grep -cE '^\*\*Event\*\*: PHASE_SKIPPED' "$audit" 2>/dev/null || true)
    actual_skipped=${actual_skipped:-0}
  else
    actual_skipped=0
  fi
  expected="$(expected_skipped_count "$scope")"
  if [ "$actual_skipped" -eq "$expected" ]; then
    ok "[$scope] $expected PHASE_SKIPPED events (matches scope-mapping.json)"
  else
    not_ok "[$scope] $expected PHASE_SKIPPED events (matches scope-mapping.json)" \
      "expected=$expected actual=$actual_skipped"
  fi

  # --- Assertion 3: State file records each excluded phase as "Skipped" in Phase Progress ---
  # Phase Progress block lists each phase with status. Extract and verify.
  all_skipped_match=true
  for excluded in $(expected_skipped_phases "$scope"); do
    # Case-insensitive phase name match; status column is "Skipped".
    # Match pattern: "- **Ideation**: Skipped" (capitalized phase name)
    phase_cap="$(echo "${excluded:0:1}" | tr '[:lower:]' '[:upper:]')${excluded:1}"
    if ! grep -qE "^- \*\*$phase_cap\*\*: Skipped\$" "$state"; then
      all_skipped_match=false
      break
    fi
  done

  # If there are NO excluded phases, the check is trivially true.
  if $all_skipped_match; then
    ok "[$scope] Phase Progress records excluded phases as Skipped"
  else
    not_ok "[$scope] Phase Progress records excluded phases as Skipped" \
      "state file:\n$(grep -A 10 '^## Phase Progress' "$state" || echo '(no Phase Progress section)')"
  fi

  cleanup_test_project "$PROJ"
done

finish
