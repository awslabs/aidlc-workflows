#!/bin/bash
# t36: Stage protocol governance and phase boundary validation
# Validates stage-protocol-governance.md structure, guardrail references, phase boundaries
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

GOVERNANCE="$AIDLC_SRC/aidlc-common/protocols/stage-protocol-governance.md"
STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"
KNOWLEDGE_DIR="$AIDLC_SRC/knowledge/aidlc-shared"

plan 19

# =============================================================================
# Top-level structure
# =============================================================================
assert_grep "$GOVERNANCE" "^## 13\. Phase Boundary Verification" "§13 Phase Boundary Verification exists"
assert_grep "$GOVERNANCE" "supplement to .stage-protocol.md" "references main protocol as parent"

# =============================================================================
# Dead guardrail-learning model is gone (superseded by §13 Learnings Ritual in
# stage-protocol.md — see v0.5.0 MR 15). The governance file covers only
# phase-boundary verification now.
# =============================================================================
assert_not_grep "$GOVERNANCE" "Guardrail Learning Protocol" "no dead §12 Guardrail Learning Protocol"
assert_not_grep "$GOVERNANCE" "NEVER/ALWAYS" "no dead NEVER/ALWAYS guardrail format"
assert_not_grep "$GOVERNANCE" "GUARDRAIL_LEARNED" "no dead GUARDRAIL_LEARNED emission"

# =============================================================================
# §13 — Phase boundary verification
# =============================================================================
assert_grep "$GOVERNANCE" "### When to verify" "when to verify subsection exists"
assert_grep "$GOVERNANCE" "### Verification process" "verification process subsection exists"
assert_grep "$GOVERNANCE" "### Phase boundary checks" "phase boundary checks subsection exists"

# Phase boundaries reference valid stage transitions
assert_grep "$GOVERNANCE" "approval-handoff.*reverse-engineering" \
  "Ideation→Inception boundary: approval-handoff→reverse-engineering"
assert_grep "$GOVERNANCE" "delivery-planning.*functional-design" \
  "Inception→Construction boundary: delivery-planning→functional-design"
assert_grep "$GOVERNANCE" "ci-pipeline.*deployment-pipeline" \
  "Construction→Operation boundary: ci-pipeline→deployment-pipeline"

# All boundary stages exist as files
for slug in approval-handoff reverse-engineering delivery-planning functional-design ci-pipeline deployment-pipeline; do
  found=false
  for phase_dir in "$STAGES_DIR"/*/; do
    if [ -f "$phase_dir${slug}.md" ]; then
      found=true
      break
    fi
  done
  if [ "$found" = true ]; then
    ok "boundary stage '$slug' exists as file"
  else
    not_ok "boundary stage '$slug' exists as file" "file not found"
  fi
done

# Verification references verification.md knowledge file
assert_grep "$GOVERNANCE" "verification.md" "references verification.md knowledge file"
assert_file_exists "$KNOWLEDGE_DIR/verification.md" "verification.md exists on disk"

finish
