#!/bin/bash
# t34: Stage protocol structure and cross-reference validation
# Validates stage-protocol.md internal consistency and references to real files/fields
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

PROTOCOL="$AIDLC_SRC/aidlc-common/protocols/stage-protocol.md"
SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"
STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"
AGENTS_DIR="$AIDLC_SRC/agents"
STATE_TEMPLATE="$AIDLC_SRC/knowledge/aidlc-shared/state-template.md"

plan 69

# =============================================================================
# §1 — Required sections exist
# =============================================================================
assert_grep "$PROTOCOL" "^## 1\. Approval Gates" "§1 Approval Gates section exists"
assert_grep "$PROTOCOL" "^## 2\. Completion Messages" "§2 Completion Messages section exists"
assert_grep "$PROTOCOL" "^## 3\. Question Format" "§3 Question Format section exists"
assert_grep "$PROTOCOL" "^## 4\. State Tracking" "§4 State Tracking section exists"
assert_grep "$PROTOCOL" "^## 5\. Agent Persona Loading" "§5 Agent Persona Loading section exists"
assert_grep "$PROTOCOL" "^## 6\. Error Recovery" "§6 Error Recovery section exists"
assert_grep "$PROTOCOL" "^## 8\. Depth Guidance" "§8 Depth Guidance section exists"
assert_grep "$PROTOCOL" "^## 9\. Terminology" "§9 Terminology section exists"
assert_grep "$PROTOCOL" "^## 10\. Content Validation" "§10 Content Validation section exists"
assert_grep "$PROTOCOL" "^## 11\. Subagent Return Summary" "§11 Subagent Return Summary section exists"
assert_grep "$PROTOCOL" "^## 12\. Phase Boundary Verification" "§12 Phase Boundary Verification ref exists"
assert_grep "$PROTOCOL" "^## 13\. Learnings Ritual" "§13 Learnings Ritual section exists"

# =============================================================================
# §1 — Approval gate patterns
# =============================================================================

# Initialization stages (0.1-0.3) are exempt from approval gates
assert_grep "$PROTOCOL" "workspace-scaffold, workspace-detection, state-init" \
  "approval gate exempts all 3 initialization stages"

# 2-option pattern for Construction/Operation
assert_grep "$PROTOCOL" "CONSTRUCTION and OPERATION stages: Strictly 2-option only" \
  "Construction/Operation restricted to 2-option approval"

# 3-option pattern only for IDEATION/INCEPTION
assert_grep "$PROTOCOL" "IDEATION and INCEPTION stages may include a 3rd option" \
  "IDEATION/INCEPTION may have 3rd option"

# Escape hatch after 3 revisions
assert_grep "$PROTOCOL" 'After 3 "Request Changes" cycles' \
  "revision escape hatch triggers after 3 cycles"
assert_grep "$PROTOCOL" "Accept as-is" "escape hatch offers Accept as-is option"

# =============================================================================
# §2 — Completion message 5-part structure
# =============================================================================
assert_grep "$PROTOCOL" "### Part 0: Enter the approval gate" "completion Part 0 (enter approval gate) defined"
assert_grep "$PROTOCOL" "### Part 1: Announcement" "completion Part 1 (announcement) defined"
assert_grep "$PROTOCOL" "### Part 2: Summary" "completion Part 2 (summary) defined"
assert_grep "$PROTOCOL" "### Part 3: Review + Approval" "completion Part 3 (review + approval) defined"
assert_grep "$PROTOCOL" "### Part 4: Progress update" "completion Part 4 (progress update) defined"

# Progress format references correct scope stage counts
for scope in enterprise feature mvp poc bugfix refactor infra security-patch; do
  if grep -qF "| $scope" "$PROTOCOL"; then
    ok "depth table lists scope: $scope"
  else
    not_ok "depth table lists scope: $scope" "scope not found in depth/progress tables"
  fi
done

# =============================================================================
# §3 — Question format
# =============================================================================
# Three interaction modes
assert_grep "$PROTOCOL" "Guide me" "question mode: Guide me"
assert_grep "$PROTOCOL" "I'll edit the file" "question mode: I'll edit the file"
assert_grep "$PROTOCOL" "Chat" "question mode: Chat"
# Contradiction detection is mandatory
assert_grep "$PROTOCOL" "### Contradiction detection (MANDATORY)" "contradiction detection is mandatory"

# =============================================================================
# §4 — State tracking: sed commands reference real state template fields
# =============================================================================

# Extract field names from sed commands in the protocol
SED_FIELDS="Current Stage Lifecycle Phase Status Last Updated Active Agent In Progress Completed"
for field in "Current Stage" "Lifecycle Phase" "Status" "Last Updated" "Active Agent" "In Progress" "Completed"; do
  # The field should exist in both the protocol sed commands and the state template
  if grep -q "\\*\\*${field}\\*\\*" "$PROTOCOL" && grep -q "\\*\\*${field}\\*\\*" "$STATE_TEMPLATE"; then
    ok "sed field '${field}' exists in both protocol and state template"
  else
    not_ok "sed field '${field}' exists in both protocol and state template" \
      "protocol=$(grep -c "\\*\\*${field}\\*\\*" "$PROTOCOL" || true), template=$(grep -c "\\*\\*${field}\\*\\*" "$STATE_TEMPLATE" || true)"
  fi
done

# Checkbox notation matches what fixture files use
assert_grep "$PROTOCOL" '^\- `\[ \]` — Not started' "checkbox notation: [ ] not started"
assert_grep "$PROTOCOL" '^\- `\[-\]` — In progress' "checkbox notation: [-] in progress"
assert_grep "$PROTOCOL" '^\- `\[x\]` — Completed' "checkbox notation: [x] completed"

# =============================================================================
# §5 — Agent persona loading: all 11 agents listed
# =============================================================================
AGENT_LIST=$(grep "^aidlc-product-agent" "$PROTOCOL")
for agent in aidlc-product-agent aidlc-design-agent aidlc-delivery-agent aidlc-architect-agent aidlc-aws-platform-agent \
             aidlc-compliance-agent aidlc-devsecops-agent aidlc-developer-agent aidlc-quality-agent aidlc-pipeline-deploy-agent aidlc-operations-agent; do
  if echo "$AGENT_LIST" | grep -qF "$agent"; then
    ok "protocol agent list includes $agent"
  else
    not_ok "protocol agent list includes $agent" "not found in agent list line"
  fi
done

# Knowledge loading order has 6 steps
KNOWLEDGE_STEPS=$(grep -c "^[0-9]\." <(sed -n '/### Knowledge loading order/,/### For inline/p' "$PROTOCOL"))
if [ "$KNOWLEDGE_STEPS" -ge 6 ]; then
  ok "knowledge loading order has >= 6 steps"
else
  not_ok "knowledge loading order has >= 6 steps" "found $KNOWLEDGE_STEPS steps"
fi

# =============================================================================
# §4 — Audit log formats: all specialized formats present
# =============================================================================
assert_grep "$PROTOCOL" "#### Error log format" "specialized audit format: Error"
assert_grep "$PROTOCOL" "#### Recovery log format" "specialized audit format: Recovery"
assert_grep "$PROTOCOL" "#### Change Request log format" "specialized audit format: Change Request"
assert_grep "$PROTOCOL" "#### Question interaction log format" "specialized audit format: Question interaction"

# --- Depth-aware question generation ---
assert_grep "$PROTOCOL" "Depth-aware question generation" "depth-aware question generation section exists"
assert_grep "$PROTOCOL" '~2-4' "depth guidance includes Minimal range ~2-4"
assert_grep "$PROTOCOL" '~8-12' "depth guidance includes Comprehensive range ~8-12"

# --- Test strategy section ---
assert_grep "$PROTOCOL" "### Test Strategy" "test strategy section exists in §8"
assert_grep "$PROTOCOL" "Nyquist" "test strategy mentions Nyquist model"
assert_grep "$PROTOCOL" '5-8 tests per component' "test strategy defines Standard volume"

# --- Within-Bolt question collection section ---
assert_grep "$PROTOCOL" "### Within-Bolt Question Collection" "within-bolt question collection section exists"
assert_grep "$PROTOCOL" "QUESTION-ONLY mode" "bolt protocol references QUESTION-ONLY mode"
assert_grep "$PROTOCOL" "ARTIFACT-ONLY mode" "bolt protocol references ARTIFACT-ONLY mode"

finish
