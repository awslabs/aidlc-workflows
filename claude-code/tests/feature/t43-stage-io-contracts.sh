#!/bin/bash
# t43: Stage I/O contract chain — verify inputs/outputs chain between stages (19 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

plan 19

STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"
LIB="$AIDLC_SRC/tools/aidlc-lib.ts"

# Helper: find stage file by slug
find_stage_file() {
  local slug="$1"
  for phase_dir in "$STAGES_DIR"/*/; do
    local f="$phase_dir${slug}.md"
    if [ -f "$f" ]; then
      echo "$f"
      return 0
    fi
  done
  return 1
}

# Helper: extract Inputs scalar from YAML frontmatter
get_inputs() {
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$1', 'utf8'));
    console.log(typeof obj.inputs === 'string' ? obj.inputs : '');
  " 2>/dev/null
}

# Helper: extract Outputs scalar from YAML frontmatter
get_outputs() {
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$1', 'utf8'));
    console.log(typeof obj.outputs === 'string' ? obj.outputs : '');
  " 2>/dev/null
}

# Stage execution order (lifecycle sequence)
STAGE_ORDER=(
  workspace-scaffold workspace-detection state-init
  intent-capture market-research feasibility scope-definition team-formation rough-mockups approval-handoff
  reverse-engineering requirements-analysis user-stories refined-mockups application-design units-generation delivery-planning
  functional-design nfr-requirements nfr-design infrastructure-design code-generation build-and-test ci-pipeline
  deployment-pipeline environment-provisioning deployment-execution observability-setup incident-response performance-validation feedback-optimization
)

# --- Test 1: Every stage file has an Inputs line ---
MISSING_INPUTS=0
for slug in "${STAGE_ORDER[@]}"; do
  f=$(find_stage_file "$slug") || continue
  inputs=$(get_inputs "$f")
  [ -z "$inputs" ] && MISSING_INPUTS=$((MISSING_INPUTS + 1))
done
assert_eq "$MISSING_INPUTS" "0" "all stage files have an Inputs line"

# --- Test 2: Every stage file has an Outputs line ---
MISSING_OUTPUTS=0
for slug in "${STAGE_ORDER[@]}"; do
  f=$(find_stage_file "$slug") || continue
  outputs=$(get_outputs "$f")
  [ -z "$outputs" ] && MISSING_OUTPUTS=$((MISSING_OUTPUTS + 1))
done
assert_eq "$MISSING_OUTPUTS" "0" "all stage files have an Outputs line"

# --- Test 3: Every non-init stage references stage-protocol ---
MISSING_PROTOCOL=0
NON_INIT_STAGES=("${STAGE_ORDER[@]:3}")  # skip first 3 init stages
for slug in "${NON_INIT_STAGES[@]}"; do
  f=$(find_stage_file "$slug") || continue
  if ! grep -qi "stage-protocol" "$f" 2>/dev/null; then
    MISSING_PROTOCOL=$((MISSING_PROTOCOL + 1))
  fi
done
assert_eq "$MISSING_PROTOCOL" "0" "all non-init stages reference stage-protocol"

# --- Test 4: reverse-engineering has CONDITIONAL + brownfield ---
RE_FILE=$(find_stage_file "reverse-engineering")
if [ -f "$RE_FILE" ]; then
  if grep -qi "CONDITIONAL" "$RE_FILE" && grep -qi "brownfield" "$RE_FILE"; then
    ok "reverse-engineering has CONDITIONAL execution with brownfield check"
  else
    not_ok "reverse-engineering has CONDITIONAL execution with brownfield check" "missing CONDITIONAL or brownfield"
  fi
else
  not_ok "reverse-engineering has CONDITIONAL execution with brownfield check" "file not found"
fi

# --- Tests 5-8: Ideation output directories use aidlc-docs/ideation/ ---
for slug in intent-capture market-research feasibility scope-definition; do
  f=$(find_stage_file "$slug") || { not_ok "ideation output dir: $slug" "file not found"; continue; }
  outputs=$(get_outputs "$f")
  if echo "$outputs" | grep -q "aidlc-docs/ideation/"; then
    ok "$slug outputs to aidlc-docs/ideation/"
  else
    not_ok "$slug outputs to aidlc-docs/ideation/" "outputs: $outputs"
  fi
done

# --- Tests 9-11: Inception output directories use aidlc-docs/inception/ ---
for slug in reverse-engineering requirements-analysis application-design; do
  f=$(find_stage_file "$slug") || { not_ok "inception output dir: $slug" "file not found"; continue; }
  outputs=$(get_outputs "$f")
  if echo "$outputs" | grep -q "aidlc-docs/inception/"; then
    ok "$slug outputs to aidlc-docs/inception/"
  else
    not_ok "$slug outputs to aidlc-docs/inception/" "outputs: $outputs"
  fi
done

# --- Test 12: Construction per-unit stages reference {unit-name} in outputs ---
UNIT_STAGES=(functional-design nfr-requirements nfr-design infrastructure-design code-generation)
UNIT_REF_COUNT=0
for slug in "${UNIT_STAGES[@]}"; do
  f=$(find_stage_file "$slug") || continue
  outputs=$(get_outputs "$f")
  if echo "$outputs" | grep -q "{unit-name}"; then
    UNIT_REF_COUNT=$((UNIT_REF_COUNT + 1))
  fi
done
assert_gt "$UNIT_REF_COUNT" 3 "most per-unit construction stages reference {unit-name}"

# --- Test 13: intent-capture outputs feed into market-research inputs ---
IC_FILE=$(find_stage_file "intent-capture")
MR_FILE=$(find_stage_file "market-research")
if [ -f "$IC_FILE" ] && [ -f "$MR_FILE" ]; then
  ic_outputs=$(get_outputs "$IC_FILE")
  mr_inputs=$(get_inputs "$MR_FILE")
  # intent-capture produces intent-statement.md, market-research reads intent statement
  if echo "$ic_outputs" | grep -qi "intent-statement" && echo "$mr_inputs" | grep -qi "intent"; then
    ok "intent-capture outputs → market-research inputs (intent statement)"
  else
    not_ok "intent-capture outputs → market-research inputs (intent statement)" "outputs: $ic_outputs | inputs: $mr_inputs"
  fi
else
  not_ok "intent-capture outputs → market-research inputs (intent statement)" "files not found"
fi

# --- Test 14: reverse-engineering outputs feed into requirements-analysis inputs ---
RE_FILE=$(find_stage_file "reverse-engineering")
RA_FILE=$(find_stage_file "requirements-analysis")
if [ -f "$RE_FILE" ] && [ -f "$RA_FILE" ]; then
  re_outputs=$(get_outputs "$RE_FILE")
  ra_inputs=$(get_inputs "$RA_FILE")
  # RE outputs artifacts, requirements-analysis reads RE artifacts
  if echo "$re_outputs" | grep -qi "reverse-engineering" && echo "$ra_inputs" | grep -qi "RE\|reverse"; then
    ok "reverse-engineering outputs → requirements-analysis inputs"
  else
    not_ok "reverse-engineering outputs → requirements-analysis inputs" "outputs: $re_outputs | inputs: $ra_inputs"
  fi
else
  not_ok "reverse-engineering outputs → requirements-analysis inputs" "files not found"
fi

# --- Test 15: requirements-analysis outputs feed into user-stories inputs ---
RA_FILE=$(find_stage_file "requirements-analysis")
US_FILE=$(find_stage_file "user-stories")
if [ -f "$RA_FILE" ] && [ -f "$US_FILE" ]; then
  ra_outputs=$(get_outputs "$RA_FILE")
  us_inputs=$(get_inputs "$US_FILE")
  if echo "$ra_outputs" | grep -qi "requirements" && echo "$us_inputs" | grep -qi "requirements"; then
    ok "requirements-analysis outputs → user-stories inputs"
  else
    not_ok "requirements-analysis outputs → user-stories inputs" "outputs: $ra_outputs | inputs: $us_inputs"
  fi
else
  not_ok "requirements-analysis outputs → user-stories inputs" "files not found"
fi

# --- Test 16: scope-definition outputs feed into team-formation inputs ---
SD_FILE=$(find_stage_file "scope-definition")
TF_FILE=$(find_stage_file "team-formation")
if [ -f "$SD_FILE" ] && [ -f "$TF_FILE" ]; then
  sd_outputs=$(get_outputs "$SD_FILE")
  tf_inputs=$(get_inputs "$TF_FILE")
  if echo "$sd_outputs" | grep -qi "scope" && echo "$tf_inputs" | grep -qi "scope\|intent"; then
    ok "scope-definition outputs → team-formation inputs"
  else
    not_ok "scope-definition outputs → team-formation inputs" "outputs: $sd_outputs | inputs: $tf_inputs"
  fi
else
  not_ok "scope-definition outputs → team-formation inputs" "files not found"
fi

# --- Test 17: application-design outputs feed into units-generation inputs ---
AD_FILE=$(find_stage_file "application-design")
UG_FILE=$(find_stage_file "units-generation")
if [ -f "$AD_FILE" ] && [ -f "$UG_FILE" ]; then
  ad_outputs=$(get_outputs "$AD_FILE")
  ug_inputs=$(get_inputs "$UG_FILE")
  if echo "$ad_outputs" | grep -qi "application-design" && echo "$ug_inputs" | grep -qi "application-design\|design"; then
    ok "application-design outputs → units-generation inputs"
  else
    not_ok "application-design outputs → units-generation inputs" "outputs: $ad_outputs | inputs: $ug_inputs"
  fi
else
  not_ok "application-design outputs → units-generation inputs" "files not found"
fi

# --- Test 18: Operation phase outputs use aidlc-docs/operation/ ---
OP_STAGES=(deployment-pipeline environment-provisioning deployment-execution observability-setup)
OP_DIR_COUNT=0
for slug in "${OP_STAGES[@]}"; do
  f=$(find_stage_file "$slug") || continue
  outputs=$(get_outputs "$f")
  if echo "$outputs" | grep -q "aidlc-docs/operation/"; then
    OP_DIR_COUNT=$((OP_DIR_COUNT + 1))
  fi
done
assert_eq "$OP_DIR_COUNT" "4" "all checked operation stages output to aidlc-docs/operation/"

# --- Test 19: state-init inputs reference workspace-detection output ---
SI_FILE=$(find_stage_file "state-init")
if [ -f "$SI_FILE" ]; then
  si_inputs=$(get_inputs "$SI_FILE")
  if echo "$si_inputs" | grep -qi "workspace\|classification"; then
    ok "state-init inputs reference workspace classification"
  else
    not_ok "state-init inputs reference workspace classification" "inputs: $si_inputs"
  fi
else
  not_ok "state-init inputs reference workspace classification" "file not found"
fi

finish
