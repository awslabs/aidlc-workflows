#!/bin/bash
# t35: Stage protocol recovery and change handling validation
# Validates stage-protocol-recovery.md structure, phase coverage, and cross-references
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

RECOVERY="$AIDLC_SRC/aidlc-common/protocols/stage-protocol-recovery.md"
PROTOCOL="$AIDLC_SRC/aidlc-common/protocols/stage-protocol.md"

plan 30

# =============================================================================
# Top-level structure
# =============================================================================
assert_grep "$RECOVERY" "^## 6\. Error Recovery" "§6 Error Recovery section exists"
assert_grep "$RECOVERY" "^## 7\. Change Handling" "§7 Change Handling section exists"
assert_grep "$RECOVERY" "supplement to .stage-protocol.md" "references main protocol as parent"

# =============================================================================
# §6 — Error Recovery: Session resume
# =============================================================================
assert_grep "$RECOVERY" "### Session resume$" "session resume subsection exists"
assert_grep "$RECOVERY" "### Session resume context loading" "session resume context loading subsection exists"

# All 5 phases have resume context loading guidance
assert_grep "$RECOVERY" "INITIALIZATION stages" "resume context: INITIALIZATION"
assert_grep "$RECOVERY" "IDEATION stages" "resume context: IDEATION"
assert_grep "$RECOVERY" "INCEPTION" "resume context: INCEPTION"
assert_grep "$RECOVERY" "CONSTRUCTION" "resume context: CONSTRUCTION"
assert_grep "$RECOVERY" "OPERATION stages" "resume context: OPERATION"

# Resume context references real artifact directories
assert_grep "$RECOVERY" "aidlc-docs/ideation/" "resume references ideation artifacts dir"
assert_grep "$RECOVERY" "aidlc-docs/inception/" "resume references inception artifacts dir"
assert_grep "$RECOVERY" "aidlc-docs/operation/" "resume references operation artifacts dir"

# =============================================================================
# §6 — Error Recovery: Corrupted state file recovery
# =============================================================================
assert_grep "$RECOVERY" "### Corrupted state file recovery" "corrupted state recovery subsection exists"
assert_grep "$RECOVERY" "aidlc-state.md.bak" "creates backup before state recovery"
assert_grep "$RECOVERY" "Rebuild.*from artifact evidence" "rebuilds state from artifacts"

# =============================================================================
# §6 — Error Recovery: Missing artifact recovery
# =============================================================================
assert_grep "$RECOVERY" "### Missing artifact recovery" "missing artifact recovery subsection exists"

# =============================================================================
# §6 — Error severity table
# =============================================================================
assert_grep "$RECOVERY" "### Error Severity Levels" "error severity levels subsection exists"
assert_grep "$RECOVERY" "Critical" "severity level: Critical"
assert_grep "$RECOVERY" "\\*\\*High\\*\\*" "severity level: High"
assert_grep "$RECOVERY" "\\*\\*Medium\\*\\*" "severity level: Medium"
assert_grep "$RECOVERY" "\\*\\*Low\\*\\*" "severity level: Low"

# Escalation guidelines defined
assert_grep "$RECOVERY" "Escalation guidelines" "escalation guidelines defined"

# =============================================================================
# §6 — Context compaction
# =============================================================================
assert_grep "$RECOVERY" "### Context compaction" "context compaction subsection exists"
assert_grep "$RECOVERY" "PreCompact hook" "references PreCompact hook"
assert_grep "$RECOVERY" ".aidlc-recovery.md" "references recovery breadcrumb file"

# =============================================================================
# §7 — Change handling categories
# =============================================================================
assert_grep "$RECOVERY" "### Minor changes" "change handling: minor changes"
assert_grep "$RECOVERY" "### Major changes" "change handling: major changes"
assert_grep "$RECOVERY" "### Scope changes" "change handling: scope changes"
assert_grep "$RECOVERY" "### Archive before change" "change handling: archive before change"

finish
