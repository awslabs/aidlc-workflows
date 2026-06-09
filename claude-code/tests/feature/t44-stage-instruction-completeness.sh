#!/bin/bash
# t44: Stage instruction completeness — verify steps describe how to produce declared outputs (41 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

plan 41

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

# Helper: extract specific output filenames from YAML frontmatter `outputs`
# Extracts words ending in .md from the outputs scalar value
get_output_filenames() {
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$1', 'utf8'));
    const s = typeof obj.outputs === 'string' ? obj.outputs : '';
    const matches = s.match(/[a-z][a-z0-9-]*\.md/g) || [];
    for (const m of matches) console.log(m);
  " 2>/dev/null
}

# Helper: check if stage has CONDITIONAL execution (YAML frontmatter)
is_conditional() {
  local exec_val
  exec_val=$(bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$1', 'utf8'));
    console.log(typeof obj.execution === 'string' ? obj.execution : '');
  " 2>/dev/null)
  [ "$exec_val" = "CONDITIONAL" ]
}

# Helper: check if stage has question file in outputs
has_question_output() {
  get_output_filenames "$1" | grep -q "questions"
}

# All stage slugs in lifecycle order
ALL_STAGES=(
  workspace-scaffold workspace-detection state-init
  intent-capture market-research feasibility scope-definition team-formation rough-mockups approval-handoff
  reverse-engineering practices-discovery requirements-analysis user-stories refined-mockups application-design units-generation delivery-planning
  functional-design nfr-requirements nfr-design infrastructure-design code-generation build-and-test ci-pipeline
  deployment-pipeline environment-provisioning deployment-execution observability-setup incident-response performance-validation feedback-optimization
)

# --- Tests 1-10: Key output filenames appear in stage steps ---

# Test 1: intent-capture mentions intent-statement.md in steps
f=$(find_stage_file "intent-capture")
assert_grep "$f" "intent-statement.md" "intent-capture steps mention intent-statement.md"

# Test 2: intent-capture mentions stakeholder-map.md in steps
assert_grep "$f" "stakeholder-map.md" "intent-capture steps mention stakeholder-map.md"

# Test 3: requirements-analysis mentions requirements.md in steps
f=$(find_stage_file "requirements-analysis")
assert_grep "$f" "requirements\.md" "requirements-analysis steps mention requirements.md"

# Test 4: scope-definition mentions scope-document.md in steps
f=$(find_stage_file "scope-definition")
assert_grep "$f" "scope-document.md" "scope-definition steps mention scope-document.md"

# Test 5: application-design mentions components.md in steps
f=$(find_stage_file "application-design")
assert_grep "$f" "components.md" "application-design steps mention components.md"

# Test 6: units-generation mentions unit-of-work.md in steps
f=$(find_stage_file "units-generation")
assert_grep "$f" "unit-of-work.md" "units-generation steps mention unit-of-work.md"

# Test 7: delivery-planning mentions bolt-plan.md in steps
f=$(find_stage_file "delivery-planning")
assert_grep "$f" "bolt-plan.md" "delivery-planning steps mention bolt-plan.md"

# Test 7a: delivery-planning mentions risk-and-sequencing-rationale.md in steps
assert_grep "$f" "risk-and-sequencing-rationale.md" "delivery-planning steps mention risk-and-sequencing-rationale.md"

# Test 7b: delivery-planning mentions external-dependency-map.md in steps
assert_grep "$f" "external-dependency-map.md" "delivery-planning steps mention external-dependency-map.md"

# Test 8: feasibility mentions feasibility-assessment.md in steps
f=$(find_stage_file "feasibility")
assert_grep "$f" "feasibility-assessment.md" "feasibility steps mention feasibility-assessment.md"

# --- Tests 11-17: Stages with question outputs mention [Answer]: format or delegate to stage-protocol ---

QUESTION_STAGES=(intent-capture market-research feasibility scope-definition requirements-analysis approval-handoff delivery-planning)
for slug in "${QUESTION_STAGES[@]}"; do
  f=$(find_stage_file "$slug") || { not_ok "$slug mentions question format" "file not found"; continue; }
  if has_question_output "$f"; then
    if grep -qi '\[Answer\]\|question.*format\|stage-protocol.*question' "$f" 2>/dev/null; then
      ok "$slug mentions question format ([Answer]: or via stage-protocol)"
    else
      not_ok "$slug mentions question format ([Answer]: or via stage-protocol)" "has question output but no format reference"
    fi
  else
    ok "$slug has no question output (skip question format check)"
  fi
done

# --- Tests 18-23: Stages with state updates mention aidlc-state.md ---

STATE_UPDATE_STAGES=(workspace-scaffold workspace-detection state-init intent-capture requirements-analysis reverse-engineering)
for slug in "${STATE_UPDATE_STAGES[@]}"; do
  f=$(find_stage_file "$slug") || { not_ok "$slug mentions state update" "file not found"; continue; }
  if grep -qi "aidlc-state\|Update State" "$f" 2>/dev/null; then
    ok "$slug steps mention state update"
  else
    not_ok "$slug steps mention state update" "no aidlc-state.md or Update State reference found"
  fi
done

# --- Tests 24-29: CONDITIONAL stages document skip condition ---

CONDITIONAL_STAGES=(reverse-engineering practices-discovery feasibility market-research team-formation rough-mockups ci-pipeline)
for slug in "${CONDITIONAL_STAGES[@]}"; do
  f=$(find_stage_file "$slug") || { not_ok "$slug documents skip condition" "file not found"; continue; }
  if is_conditional "$f"; then
    if grep -qi "[Ss]kip" "$f" 2>/dev/null; then
      ok "$slug (CONDITIONAL) documents skip condition"
    else
      not_ok "$slug (CONDITIONAL) documents skip condition" "CONDITIONAL but no skip reference"
    fi
  else
    ok "$slug is not CONDITIONAL (skip check not needed)"
  fi
done

# --- Tests 29-32: Construction stages mention their output directory pattern ---

for slug in functional-design nfr-requirements nfr-design code-generation; do
  f=$(find_stage_file "$slug") || { not_ok "$slug mentions construction output dir" "file not found"; continue; }
  if grep -qi "aidlc-docs/construction" "$f" 2>/dev/null; then
    ok "$slug mentions aidlc-docs/construction/ in content"
  else
    not_ok "$slug mentions aidlc-docs/construction/ in content" "no construction dir reference"
  fi
done

# --- Tests 34-36: Operation stages mention their output directory ---

for slug in deployment-pipeline observability-setup incident-response; do
  f=$(find_stage_file "$slug") || { not_ok "$slug mentions operation output dir" "file not found"; continue; }
  if grep -qi "aidlc-docs/operation" "$f" 2>/dev/null; then
    ok "$slug mentions aidlc-docs/operation/ in content"
  else
    not_ok "$slug mentions aidlc-docs/operation/ in content" "no operation dir reference"
  fi
done

# --- Test 36: All stages with approval gates mention AskUserQuestion or approval ---
APPROVAL_STAGES=(intent-capture requirements-analysis reverse-engineering application-design delivery-planning approval-handoff)
APPROVAL_COUNT=0
for slug in "${APPROVAL_STAGES[@]}"; do
  f=$(find_stage_file "$slug") || continue
  if grep -qi "AskUserQuestion\|[Aa]pproval\|[Aa]pprove" "$f" 2>/dev/null; then
    APPROVAL_COUNT=$((APPROVAL_COUNT + 1))
  fi
done
assert_gt "$APPROVAL_COUNT" 4 "most approval-gate stages mention approval mechanism"

# --- Test 36: build-and-test mentions test in steps ---
f=$(find_stage_file "build-and-test")
if grep -qi "test" "$f" 2>/dev/null; then
  ok "build-and-test stage mentions testing in steps"
else
  not_ok "build-and-test stage mentions testing in steps" "no test reference"
fi

# --- Test 39: reverse-engineering steps mention a key output artifact ---
f=$(find_stage_file "reverse-engineering")
assert_grep "$f" "architecture.md" "reverse-engineering steps mention architecture.md"

# --- Test 40: code-generation steps mention code-summary.md ---
f=$(find_stage_file "code-generation")
assert_grep "$f" "code-summary.md" "code-generation steps mention code-summary.md"

finish
