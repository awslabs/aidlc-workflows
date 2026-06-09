#!/bin/bash
# t11: Unit tests for aidlc-statusline.ts (62 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

HOOK="$AIDLC_SRC/hooks/aidlc-statusline.ts"
MID_IDEATION="$FIXTURES_DIR/state-mid-ideation.md"

plan 62

# --- Test 1: Shows ready with no state file ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_eq "$OUTPUT" "[AIDLC] ready" "shows ready with no state file"
cleanup_test_project "$PROJ"

# --- Test 2: Shows IDEATION phase ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "IDEATION" "shows IDEATION phase"
cleanup_test_project "$PROJ"

# --- Test 3: Shows display name (not slug) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "Feasibility" "shows display name Feasibility"
cleanup_test_project "$PROJ"

# --- Test 4: Shows agent without -agent suffix ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "Architect" "shows agent display name"
assert_not_contains "$OUTPUT" "aidlc-architect-agent" "strips -agent suffix"
cleanup_test_project "$PROJ"

# --- Test 6: Computes phase progress ---
# IDEATION has 7 non-SKIP stages, 2 are [x] (intent-capture, market-research)
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "2/7" "computes phase progress 2/7"
cleanup_test_project "$PROJ"

# --- Test 7: Output starts with [AIDLC] prefix ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
if echo "$OUTPUT" | grep -q "^\[AIDLC\]"; then
  ok "output starts with [AIDLC] prefix"
else
  not_ok "output starts with [AIDLC] prefix" "got: $OUTPUT"
fi
cleanup_test_project "$PROJ"

# --- Test 8: Shows ready when phase empty ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
# Write fixture with explicit trailing space after Lifecycle Phase colon
printf '%s\n' \
  "# AI-DLC State Tracking" \
  "## Current Status" \
  "- **Lifecycle Phase**: " \
  "- **Current Stage**: feasibility" \
  > "$PROJ/aidlc-docs/aidlc-state.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_eq "$OUTPUT" "[AIDLC] ready" "shows ready when phase empty"
cleanup_test_project "$PROJ"

# --- Test 9: All-SKIP phase shows empty progress ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Stage Progress
### IDEATION PHASE
- [ ] intent-capture — SKIP: not needed
- [ ] market-research — SKIP: not needed
- [ ] feasibility — SKIP: not needed
- [ ] scope-definition — SKIP: not needed
- [ ] team-formation — SKIP: not needed
- [ ] rough-mockups — SKIP: not needed
- [ ] approval-handoff — SKIP: not needed
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
- **Active Agent**: aidlc-product-agent
EOF
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
# awk END block: if total==0 print "" — so no progress fraction should appear
# Output should be like "[AIDLC] IDEATION > Feasibility -- Product Agent" without a n/m fraction
if echo "$OUTPUT" | grep -q "[0-9]/[0-9]"; then
  not_ok "all-SKIP phase shows empty progress" "got progress fraction in: $OUTPUT"
else
  ok "all-SKIP phase shows empty progress"
fi
cleanup_test_project "$PROJ"

# --- Test 10: Empty stdin falls through to env var ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "" | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "IDEATION" "empty stdin falls through to CLAUDE_PROJECT_DIR env var"
cleanup_test_project "$PROJ"

# --- Test 11: Shows CONSTRUCTION phase ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "CONSTRUCTION" "shows CONSTRUCTION phase"
cleanup_test_project "$PROJ"

# --- Test 12: Construction progress count ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
# Construction fixture has 9 non-SKIP checkbox lines (2 units x stages); 2 are [x]
# The statusline counts all checkbox lines under the CONSTRUCTION PHASE heading
assert_match "$OUTPUT" "[0-9]/9" "construction shows progress fraction"
cleanup_test_project "$PROJ"

# --- Test 13: Shows OPERATION phase ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-operation.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "OPERATION" "shows OPERATION phase"
cleanup_test_project "$PROJ"

# --- Test 14: Operation progress count ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-operation.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
# Operation has 7 stages
assert_match "$OUTPUT" "[0-9]/7" "operation shows progress fraction"
cleanup_test_project "$PROJ"

# --- Test 15: Completed fixture shows COMPLETE ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-completed.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "COMPLETE" "completed fixture shows COMPLETE"
cleanup_test_project "$PROJ"

# --- Test 16: Statusline completes within 500ms ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-construction.md"
T_START=$(date +%s%N)
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
T_END=$(date +%s%N)
ELAPSED_MS=$(( (T_END - T_START) / 1000000 ))
assert_lt "$ELAPSED_MS" 500 "statusline completes within 500ms (took ${ELAPSED_MS}ms)"
cleanup_test_project "$PROJ"

# --- Test 17: [S] stages excluded from progress total ---
PROJ=$(create_test_project)
cp "$FIXTURES_DIR/state-jumped.md" "$PROJ/aidlc-docs/aidlc-state.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
# Construction phase: code-generation [-], build-and-test [ ], ci-pipeline [ ] = 3 non-SKIP stages
# [S] stages (functional-design, nfr-requirements, nfr-design, infrastructure-design) should NOT be counted
assert_contains "$OUTPUT" "0/3" "[S] stages excluded from construction progress total"
assert_contains "$OUTPUT" "[░░░░░░░░░░]" "0/3 construction renders empty bar"
cleanup_test_project "$PROJ"

# --- Test 18: [S] in completed ideation phase show correct count ---
PROJ=$(create_test_project)
cp "$FIXTURES_DIR/state-jumped.md" "$PROJ/aidlc-docs/aidlc-state.md"
# Modify only the Lifecycle Phase field to IDEATION (not the CONSTRUCTION PHASE heading)
sed 's/\*\*Lifecycle Phase\*\*: CONSTRUCTION/**Lifecycle Phase**: IDEATION/' "$PROJ/aidlc-docs/aidlc-state.md" > "$PROJ/aidlc-docs/aidlc-state.md.tmp" && mv "$PROJ/aidlc-docs/aidlc-state.md.tmp" "$PROJ/aidlc-docs/aidlc-state.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
# Ideation has 2 [x] and 5 [S] → should show 2/2 (only non-[S] stages counted)
assert_contains "$OUTPUT" "2/2" "[S] stages excluded; shows 2/2 for ideation with skipped stages"
assert_contains "$OUTPUT" "[▓▓▓▓▓▓▓▓▓▓]" "2/2 ideation renders full bar"
cleanup_test_project "$PROJ"

# --- Test 19: Progress bar with filled and empty chars ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
# mid-ideation IDEATION phase: 2 [x] of 7 non-[S] stages → floor(2*10/7)=2 filled, 8 empty
assert_contains "$OUTPUT" "▓" "progress bar contains filled char"
assert_contains "$OUTPUT" "░" "progress bar contains empty char"
cleanup_test_project "$PROJ"

# --- Test 20: Breadcrumb > separator present ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" " > " "breadcrumb > separator present"
cleanup_test_project "$PROJ"

# --- Test 21: Agent -- separator present ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" " -- " "agent -- separator present"
cleanup_test_project "$PROJ"

# --- Test 22: Init-phase statusline shows INITIALIZATION ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Execution Plan Summary
- **Total Stages**: 3
- **Completed**: 1
## Stage Progress
### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [-] workspace-detection — EXECUTE
- [ ] state-init — EXECUTE
## Current Status
- **Lifecycle Phase**: INITIALIZATION
- **Current Stage**: workspace-detection
- **Active Agent**: aidlc-developer-agent
- **Status**: Running
EOF
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "INITIALIZATION" "init-phase statusline shows INITIALIZATION"

# --- Test 23: Init-phase statusline shows display name ---
assert_contains "$OUTPUT" "Workspace Detection" "init-phase statusline shows Workspace Detection"

# --- Test 24: Init-phase statusline has progress bar ---
assert_contains "$OUTPUT" "▓" "init-phase statusline has filled progress bar char"
cleanup_test_project "$PROJ"

# --- Test 26: Model name appears in output (Bedrock) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"},"model":{"id":"us.anthropic.claude-opus-4-6-v1"},"context_window":{"used_percentage":45.2}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "BR:opus-4-6" "model name appears abbreviated in output"
cleanup_test_project "$PROJ"

# --- Test 27: Context percentage appears in output ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"},"model":{"id":"us.anthropic.claude-opus-4-6-v1"},"context_window":{"used_percentage":45.2}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "ctx:45%" "context percentage appears in output"
cleanup_test_project "$PROJ"

# --- Test 28: Model and context appear after agent ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"},"model":{"id":"us.anthropic.claude-opus-4-6-v1"},"context_window":{"used_percentage":45.2}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
assert_match "$OUTPUT" "Agent.*BR:.*ctx:" "model and context appear after agent"
cleanup_test_project "$PROJ"

# --- Test 29: Bedrock prefix detection ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"},"model":{"id":"us.anthropic.claude-sonnet-4-20250514"},"context_window":{"used_percentage":30}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "BR:sonnet-4" "Bedrock prefix detected and model abbreviated"
cleanup_test_project "$PROJ"

# --- Test 30: Non-Bedrock model (no BR: prefix) ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"},"model":{"id":"claude-sonnet-4-20250514"},"context_window":{"used_percentage":30}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "sonnet-4" "non-Bedrock model name appears"
assert_not_contains "$OUTPUT" "BR:" "no BR: prefix for non-Bedrock model"
cleanup_test_project "$PROJ"

# --- Test 31: Context color green for low usage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"},"model":{"id":"claude-sonnet-4-20250514"},"context_window":{"used_percentage":30}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
ESC=$'\033'
assert_contains "$OUTPUT" "${ESC}[32m" "context green color for usage < 50%"
cleanup_test_project "$PROJ"

# --- Test 32: Context color red for high usage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"},"model":{"id":"claude-sonnet-4-20250514"},"context_window":{"used_percentage":85}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
ESC=$'\033'
assert_contains "$OUTPUT" "${ESC}[31m" "context red color for usage >= 75%"
cleanup_test_project "$PROJ"

# --- Test 33: No model/context in JSON means no suffix ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
assert_not_contains "$OUTPUT" "BR:" "no BR: when model absent from JSON"
assert_not_contains "$OUTPUT" "ctx:" "no ctx: when context absent from JSON"
cleanup_test_project "$PROJ"

# --- Test 34: Shipped Bedrock Opus 4-7 ID abbreviates correctly ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$MID_IDEATION"
JSON='{"workspace":{"project_dir":"'"$PROJ"'"},"model":{"id":"us.anthropic.claude-opus-4-7"},"context_window":{"used_percentage":40}}'
OUTPUT=$(echo "$JSON" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "BR:opus-4-7" "shipped Opus 4.7 Bedrock ID abbreviates to BR:opus-4-7"
cleanup_test_project "$PROJ"

# --- Test 42: 1-stage phase math (poc-style scope) ---
# Scopes like poc/security-patch/infra produce phases with exactly 1 EXECUTE stage.
# 0/1 → floor(0*10/1)=0 filled; 1/1 → floor(10*10/10)=10 filled. No intermediate.
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Stage Progress
### INCEPTION PHASE
- [S] reverse-engineering — SKIP
- [S] requirements-analysis — SKIP
- [S] user-stories — SKIP
- [S] refined-mockups — SKIP
- [S] application-design — SKIP
- [S] units-generation — SKIP
- [S] delivery-planning — SKIP
### CONSTRUCTION PHASE
- [S] functional-design — SKIP
- [S] nfr-requirements — SKIP
- [S] nfr-design — SKIP
- [S] infrastructure-design — SKIP
- [-] code-generation — EXECUTE
- [S] build-and-test — SKIP
- [S] ci-pipeline — SKIP
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Active Agent**: aidlc-developer-agent
- **Status**: Running
EOF
OUT_EMPTY=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_EMPTY" "0/1" "1-stage phase at 0/1 shows ratio"
assert_contains "$OUT_EMPTY" "[░░░░░░░░░░]" "1-stage phase at 0/1 renders empty bar"

sed -i.bak 's/- \[-\] code-generation/- [x] code-generation/' "$PROJ/aidlc-docs/aidlc-state.md"
OUT_FULL=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_FULL" "1/1" "1-stage phase at 1/1 shows ratio"
assert_contains "$OUT_FULL" "[▓▓▓▓▓▓▓▓▓▓]" "1-stage phase at 1/1 renders full bar"
cleanup_test_project "$PROJ"

# --- Test 43: OPERATION phase mid-progression bar ---
# Existing Test 14 only asserts a ratio via regex. Lock down the bar math for operation too.
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Stage Progress
### OPERATION PHASE
- [x] deployment-pipeline — EXECUTE
- [x] environment-provisioning — EXECUTE
- [x] deployment-execution — EXECUTE
- [-] observability-setup — EXECUTE
- [ ] incident-response — EXECUTE
- [ ] performance-validation — EXECUTE
- [ ] feedback-optimization — EXECUTE
## Current Status
- **Lifecycle Phase**: OPERATION
- **Current Stage**: observability-setup
- **Active Agent**: aidlc-operations-agent
- **Status**: Running
EOF
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
# floor(3*10/7) = 4 filled, 6 empty
assert_contains "$OUTPUT" "3/7" "3/7 operation ratio"
assert_contains "$OUTPUT" "[▓▓▓▓░░░░░░]" "3/7 operation renders 4 filled chars"
cleanup_test_project "$PROJ"

# --- Test 44: CONSTRUCTION → OPERATION phase-boundary reset ---
# Same file, only Lifecycle Phase pointer changes. Bar resets full → empty.
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Stage Progress
### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [x] code-generation — EXECUTE
- [x] build-and-test — EXECUTE
- [x] ci-pipeline — EXECUTE

### OPERATION PHASE
- [ ] deployment-pipeline — EXECUTE
- [ ] environment-provisioning — EXECUTE
- [ ] deployment-execution — EXECUTE
- [ ] observability-setup — EXECUTE
- [ ] incident-response — EXECUTE
- [ ] performance-validation — EXECUTE
- [ ] feedback-optimization — EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ci-pipeline
- **Active Agent**: aidlc-pipeline-deploy-agent
- **Status**: Running
EOF
OUT_END=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_END" "[▓▓▓▓▓▓▓▓▓▓]" "end of CONSTRUCTION renders full bar"
sed -i.bak 's/\*\*Lifecycle Phase\*\*: CONSTRUCTION/**Lifecycle Phase**: OPERATION/' "$PROJ/aidlc-docs/aidlc-state.md"
OUT_START=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_START" "[░░░░░░░░░░]" "start of OPERATION renders empty bar"
cleanup_test_project "$PROJ"

# --- Test 45: IDEATION → INCEPTION phase-boundary reset ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Stage Progress
### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [x] market-research — EXECUTE
- [x] feasibility — EXECUTE
- [x] scope-definition — EXECUTE
- [x] team-formation — EXECUTE
- [x] rough-mockups — EXECUTE
- [x] approval-handoff — EXECUTE

### INCEPTION PHASE
- [ ] reverse-engineering — EXECUTE
- [ ] practices-discovery — EXECUTE
- [ ] requirements-analysis — EXECUTE
- [ ] user-stories — EXECUTE
- [ ] refined-mockups — EXECUTE
- [ ] application-design — EXECUTE
- [ ] units-generation — EXECUTE
- [ ] delivery-planning — EXECUTE
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: approval-handoff
- **Active Agent**: aidlc-product-agent
- **Status**: Running
EOF
OUT_END=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_END" "[▓▓▓▓▓▓▓▓▓▓]" "end of IDEATION renders full bar"
sed -i.bak 's/\*\*Lifecycle Phase\*\*: IDEATION/**Lifecycle Phase**: INCEPTION/' "$PROJ/aidlc-docs/aidlc-state.md"
OUT_START=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_START" "[░░░░░░░░░░]" "start of INCEPTION renders empty bar"
cleanup_test_project "$PROJ"

# --- Test 46: Realistic full-state-file regression for the #37 scenario ---
# Full aidlc-state.md layout (all 5 phase headings, Current Status, Session Resume)
# with INCEPTION at the exact 5/7 state the user reported.
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking

## Project Information
- **Project**: Regression case for #37
- **Project Type**: Greenfield
- **Scope**: feature
- **Start Date**: 2026-05-02T10:00:00Z
- **Active Agent**: aidlc-architect-agent

## Scope Configuration
- **Stages to Execute**: 0.1, 0.2, 0.3, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
- **Stages to Skip**: none
- **Depth**: Standard

## Execution Plan Summary
- **Total Stages**: 32
- **Completed**: 16
- **In Progress**: units-generation

## Stage Progress

### INITIALIZATION PHASE
- [x] workspace-scaffold — EXECUTE
- [x] workspace-detection — EXECUTE
- [x] state-init — EXECUTE

### IDEATION PHASE
- [x] intent-capture — EXECUTE
- [x] market-research — EXECUTE
- [x] feasibility — EXECUTE
- [x] scope-definition — EXECUTE
- [x] team-formation — EXECUTE
- [x] rough-mockups — EXECUTE
- [x] approval-handoff — EXECUTE

### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [x] practices-discovery — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [x] application-design — EXECUTE
- [-] units-generation — EXECUTE
- [ ] delivery-planning — EXECUTE

### CONSTRUCTION PHASE
- [ ] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — EXECUTE

### OPERATION PHASE
- [ ] deployment-pipeline — EXECUTE
- [ ] environment-provisioning — EXECUTE
- [ ] deployment-execution — EXECUTE
- [ ] observability-setup — EXECUTE
- [ ] incident-response — EXECUTE
- [ ] performance-validation — EXECUTE
- [ ] feedback-optimization — EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: units-generation
- **Next Stage**: delivery-planning
- **Status**: Running
- **Last Updated**: 2026-05-02T11:30:00Z

## Session Resume Point
- **Last Completed Stage**: application-design
- **Next Action**: Execute units-generation
EOF
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
# The user reported "inception 5/7" with a static bar (pre-MR-8); after practices-discovery
# at slot 2.2, the inception block has 8 stages and 6 are completed. floor(6*10/8)=7 filled.
assert_contains "$OUTPUT" "6/8" "inception 6/8 ratio rendered"
assert_contains "$OUTPUT" "[▓▓▓▓▓▓▓░░░]" "inception 6/8 renders 7 filled chars (not static)"
cleanup_test_project "$PROJ"

# --- Test 47: Lifecycle Phase with trailing text still matches heading (M2) ---
# Any drift in Lifecycle Phase value (e.g., "INCEPTION (finalizing)", lowercase)
# must not silently drop the bar — the hook normalises to the first token.
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [-] requirements-analysis — EXECUTE
- [ ] user-stories — EXECUTE
## Current Status
- **Lifecycle Phase**: INCEPTION (finalizing)
- **Current Stage**: requirements-analysis
- **Status**: Running
EOF
OUT_TRAIL=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_TRAIL" "1/3" "Lifecycle Phase with trailing text still shows ratio"
assert_contains "$OUT_TRAIL" "▓" "Lifecycle Phase with trailing text still shows bar"
cleanup_test_project "$PROJ"

# --- Test 48: Prose decoy containing "Lifecycle Phase:" does not hijack display ---
# extractField is anchored to the Markdown field pattern so quoted discussion
# or comments that happen to contain the label don't get picked up first.
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking

## Notes
> Discussion: The Lifecycle Phase: OPERATION refactor landed in v2.

## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [-] requirements-analysis — EXECUTE
- [ ] user-stories — EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: requirements-analysis
- **Active Agent**: aidlc-architect-agent
- **Status**: Running
EOF
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "INCEPTION" "prose decoy doesn't hijack phase name"
assert_not_contains "$OUTPUT" "OPERATION" "prose decoy doesn't bleed into output"
assert_contains "$OUTPUT" "1/3" "anchored field read still finds the real phase"
cleanup_test_project "$PROJ"

# --- Test 49: COMPLETE status with unresolved Lifecycle Phase still renders full bar ---
# Defensive guard for any future caller that sets a sentinel like "COMPLETE" in
# the Lifecycle Phase field, or leaves the field stale on workflow end.
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Stage Progress
### OPERATION PHASE
- [x] deployment-pipeline — EXECUTE
## Current Status
- **Lifecycle Phase**: COMPLETE
- **Current Stage**: none
- **Status**: Completed
EOF
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "[▓▓▓▓▓▓▓▓▓▓]" "COMPLETE with unresolved phase renders full bar"
assert_contains "$OUTPUT" "COMPLETE" "COMPLETE label rendered"
cleanup_test_project "$PROJ"

# --- Test 37: Bar advances when a stage completes within the current phase (#37 regression) ---
# Seed INCEPTION at 4 [x] of 7 non-[S] stages → floor(4*10/7)=5 filled.
# Then bump to 5 [x] of 7 → floor(5*10/7)=7 filled. Bar must differ.
PROJ_A=$(create_test_project)
cat > "$PROJ_A/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Execution Plan Summary
- **Total Stages**: 31
- **Completed**: 13
## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [-] application-design — EXECUTE
- [ ] units-generation — EXECUTE
- [ ] delivery-planning — EXECUTE
## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: application-design
- **Active Agent**: aidlc-architect-agent
- **Status**: Running
EOF
OUTPUT_A=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ_A\"}}" | bun "$HOOK" 2>/dev/null)

PROJ_B=$(create_test_project)
cat > "$PROJ_B/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Execution Plan Summary
- **Total Stages**: 31
- **Completed**: 14
## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [x] application-design — EXECUTE
- [-] units-generation — EXECUTE
- [ ] delivery-planning — EXECUTE
## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: units-generation
- **Active Agent**: aidlc-architect-agent
- **Status**: Running
EOF
OUTPUT_B=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ_B\"}}" | bun "$HOOK" 2>/dev/null)

BAR_A=$(echo "$OUTPUT_A" | grep -oE '\[▓*░*\]' | head -1)
BAR_B=$(echo "$OUTPUT_B" | grep -oE '\[▓*░*\]' | head -1)
assert_eq "$BAR_A" "[▓▓▓▓▓░░░░░]" "4/7 inception renders 5 filled chars"
assert_eq "$BAR_B" "[▓▓▓▓▓▓▓░░░]" "5/7 inception renders 7 filled chars"
cleanup_test_project "$PROJ_A"
cleanup_test_project "$PROJ_B"

# --- Test 38: Phase-boundary reset — last stage of phase N full, first stage of phase N+1 empty ---
# Same checkbox state, different Lifecycle Phase pointer. Bar should reset full → empty.
PROJ=$(create_test_project)
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'EOF'
# AI-DLC State Tracking
## Execution Plan Summary
- **Total Stages**: 14
- **Completed**: 7
## Stage Progress
### INCEPTION PHASE
- [x] reverse-engineering — EXECUTE
- [x] requirements-analysis — EXECUTE
- [x] user-stories — EXECUTE
- [x] refined-mockups — EXECUTE
- [x] application-design — EXECUTE
- [x] units-generation — EXECUTE
- [x] delivery-planning — EXECUTE

### CONSTRUCTION PHASE
- [ ] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
- [ ] ci-pipeline — EXECUTE
## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: delivery-planning
- **Active Agent**: aidlc-architect-agent
- **Status**: Running
EOF
OUT_END=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_END" "[▓▓▓▓▓▓▓▓▓▓]" "end of INCEPTION renders full bar"

sed -i.bak 's/\*\*Lifecycle Phase\*\*: INCEPTION/**Lifecycle Phase**: CONSTRUCTION/' "$PROJ/aidlc-docs/aidlc-state.md"
OUT_START=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUT_START" "[░░░░░░░░░░]" "start of CONSTRUCTION renders empty bar"
cleanup_test_project "$PROJ"

# --- Test 40: COMPLETE status renders full bar from phase-local checkbox state ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-completed.md"
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>/dev/null)
assert_contains "$OUTPUT" "[▓▓▓▓▓▓▓▓▓▓]" "completed workflow renders full bar"

finish
