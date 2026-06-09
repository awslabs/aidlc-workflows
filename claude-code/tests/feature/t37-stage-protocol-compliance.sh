#!/bin/bash
# t37: Cross-file protocol compliance — every stage references protocol,
#      state template fields match sed commands, knowledge dirs match agents,
#      state fixture conforms to template structure
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

PROTOCOL="$AIDLC_SRC/aidlc-common/protocols/stage-protocol.md"
STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"
AGENTS_DIR="$AIDLC_SRC/agents"
KNOWLEDGE_DIR="$AIDLC_SRC/knowledge"
STATE_TEMPLATE="$AIDLC_SRC/knowledge/aidlc-shared/state-template.md"
SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"

# Count assertions for plan
# 32 stages: protocol reference check (29 non-init + 3 init that may not ref)
# 11 agents: knowledge dir check
# 7 state template section checks
# 5 fixture vs template section checks
# 3 protocol loading checks from SKILL.md routing
# 5 sed command pattern checks
# 3 init stage exemption checks
# 3 checkbox pattern checks on fixture
TOTAL_STAGES=0
for phase_dir in "$STAGES_DIR"/*/; do
  for f in "$phase_dir"*.md; do
    [ -f "$f" ] && TOTAL_STAGES=$((TOTAL_STAGES + 1))
  done
done

plan 71

# =============================================================================
# Every non-initialization stage file references stage-protocol.md
# =============================================================================
INIT_STAGES="workspace-scaffold workspace-detection state-init"
PROTO_REF_PASS=0
PROTO_REF_FAIL=0
for phase_dir in "$STAGES_DIR"/*/; do
  for f in "$phase_dir"*.md; do
    [ -f "$f" ] || continue
    slug=$(basename "$f" .md)
    # Check for "stage-protocol" or "stage-protocol.md" reference
    if grep -qi "stage-protocol" "$f"; then
      ok "stage '$slug' references stage-protocol"
    else
      # Initialization stages may not reference it explicitly (orchestrator handles it)
      is_init=false
      for init in $INIT_STAGES; do
        [ "$slug" = "$init" ] && is_init=true
      done
      if [ "$is_init" = true ]; then
        ok "stage '$slug' (initialization) — protocol reference optional"
      else
        not_ok "stage '$slug' references stage-protocol" "no stage-protocol reference found"
      fi
    fi
  done
done

# =============================================================================
# Every agent has a knowledge directory
# =============================================================================
for agent_file in "$AGENTS_DIR"/*.md; do
  [ -f "$agent_file" ] || continue
  agent=$(basename "$agent_file" .md)
  assert_dir_exists "$KNOWLEDGE_DIR/$agent" "knowledge dir exists for $agent"
done

# =============================================================================
# State template has all required sections (matches fixture structure)
# =============================================================================
TEMPLATE_SECTIONS=(
  "## Project Information"
  "## Scope Configuration"
  "## Workspace State"
  "## Execution Plan Summary"
  "## Runtime State"
  "## Stage Progress"
  "## Current Status"
)
for section in "${TEMPLATE_SECTIONS[@]}"; do
  assert_grep "$STATE_TEMPLATE" "$section" "state template has section: $section"
done

# =============================================================================
# Fixture state files conform to template section structure
# =============================================================================
FIXTURE="$FIXTURES_DIR/state-mid-ideation.md"
for section in "## Project Information" "## Scope Configuration" "## Stage Progress" \
               "## Current Status" "## Session Resume Point"; do
  assert_grep "$FIXTURE" "$section" "fixture has section: $section"
done

# =============================================================================
# SKILL.md routing section mandates all 3 protocol files
# =============================================================================
ROUTING_SECTION=$(sed -n '/^## Routing/,/^## /p' "$SKILL")
assert_contains "$ROUTING_SECTION" "stage-protocol.md" "routing mandates stage-protocol.md"
assert_contains "$ROUTING_SECTION" "stage-protocol-recovery.md" "routing mandates stage-protocol-recovery.md"
assert_contains "$ROUTING_SECTION" "stage-protocol-governance.md" "routing mandates stage-protocol-governance.md"

# =============================================================================
# Protocol sed commands use correct patterns for state template fields
# =============================================================================
# Extract sed patterns from protocol and verify they'd match template format
# Template uses: - **Field Name**: value
SED_SECTION=$(sed -n '/^### Silent bookkeeping writes/,/^---$/p' "$PROTOCOL")

# Tool field references use correct markdown bold syntax
assert_contains "$SED_SECTION" '**Current Stage**' "bookkeeping section references Current Stage field"
assert_contains "$SED_SECTION" '**Lifecycle Phase**' "bookkeeping section references Lifecycle Phase field"
assert_contains "$SED_SECTION" '**Active Agent**' "bookkeeping section references Active Agent field"
assert_contains "$SED_SECTION" '**In Progress**' "bookkeeping section references In Progress field"
assert_contains "$SED_SECTION" '**Completed**' "bookkeeping section references Completed field"

# =============================================================================
# Initialization stages exempt from approval gates
# =============================================================================
APPROVAL_SECTION=$(sed -n '/^## 1\. Approval Gates/,/^---$/p' "$PROTOCOL")
for init_stage in workspace-scaffold workspace-detection state-init; do
  assert_contains "$APPROVAL_SECTION" "$init_stage" \
    "approval exemption lists initialization stage: $init_stage"
done

# =============================================================================
# State fixture checkbox patterns match protocol notation
# =============================================================================
# Protocol defines: [ ] not started, [-] in progress, [x] completed
# Fixture should use these exact patterns
assert_grep "$FIXTURE" '^\- \[x\]' "fixture uses [x] completed notation"
assert_grep "$FIXTURE" '^\- \[-\]' "fixture uses [-] in-progress notation"
assert_grep "$FIXTURE" '^\- \[ \]' "fixture uses [ ] not-started notation"

# =============================================================================
# [S] skipped-via-jump notation
# =============================================================================
# [S] is documented in protocol as valid checkbox state
assert_grep "$PROTOCOL" '\[S\]' "protocol documents [S] skipped-via-jump notation"

# Jumped fixture uses [S] notation
JUMPED="$FIXTURES_DIR/state-jumped.md"
assert_grep "$JUMPED" '^\- \[S\]' "jumped fixture uses [S] skipped notation"

finish
