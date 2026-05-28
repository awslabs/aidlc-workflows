#!/usr/bin/env bash
# Audit Logger for AIDLC Design Review Hook
#
# Purpose: Log review events to audit trail and detect bypass attempts
#
# Dependencies:
#   - Bash 4.0+
#   - POSIX utilities (date, cat)
#
# Usage:
#   source lib/audit-logger.sh
#   log_audit_entry "Review Started" "User initiated design review for unit2-config-yaml"
#   detect_bypass

# Purpose: Log audit entry to aidlc-docs/audit.md
# Inputs: $1 = event name, $2 = event description
# Outputs: Appends entry to aidlc-docs/audit.md
# Returns: 0 (success), 1 (failure)
log_audit_entry() {
    local event_name=$1
    local event_description=$2

    local aidlc_docs="${AIDLC_DOCS_DIR:-${CWD}/aidlc-docs}"
    local audit_file="${aidlc_docs}/audit.md"

    # Create aidlc-docs directory if missing
    mkdir -p "${aidlc_docs}" || {
        log_error "Failed to create aidlc-docs directory"
        return 1
    }

    # Create audit file if missing (with header)
    if [ ! -f "$audit_file" ]; then
        cat > "$audit_file" <<EOF
# AIDLC Design Review Audit Trail

This file contains a chronological log of all design review events.

---

EOF
    fi

    # Format and append audit entry
    local entry
    entry=$(format_audit_entry "$event_name" "$event_description")

    echo "$entry" >> "$audit_file" || {
        log_error "Failed to write to audit file: $audit_file"
        return 1
    }

    return 0
}

# Purpose: Format audit entry as markdown
# Inputs: $1 = event name, $2 = event description
# Outputs: Formatted markdown entry (stdout)
# Returns: 0 (always succeeds)
format_audit_entry() {
    local event_name=$1
    local event_description=$2

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    cat <<EOF
## $event_name

**Timestamp**: $timestamp
**Event**: $event_name
**Description**: $event_description

---

EOF
}

# Purpose: Detect bypass attempts (marker file deletion or review skip)
# Inputs: None (checks for marker files in ${CWD}/.claude/)
# Outputs: User prompt if bypass detected
# Returns: 0 (no bypass or user confirmed), 1 (bypass detected and user denied)
detect_bypass() {
    local marker_file="${CWD}/.claude/.review-in-progress"

    # Check if marker file exists
    if [ ! -f "$marker_file" ]; then
        # No marker file means either:
        # 1. First review (normal)
        # 2. Marker was deleted (bypass attempt)
        # We can't distinguish these cases, so we only warn if aidlc-docs exists
        local aidlc_docs="${AIDLC_DOCS_DIR:-${CWD}/aidlc-docs}"
        if [ -d "${aidlc_docs}/construction" ]; then
            # Project has design artifacts but no marker - possible bypass
            log_warning "Review marker file not found. If you deleted it to bypass review, this is logged in audit trail."

            # Prompt user for confirmation
            echo "⚠️  Review marker file missing. Continue without review? (y/N)" >&2
            read -r -t 30 response || response="N"

            case "${response,,}" in
                y|yes)
                    log_audit_entry "Bypass Detected" "User confirmed bypass of review process (marker file deleted)"
                    return 0
                    ;;
                *)
                    log_audit_entry "Bypass Denied" "User denied bypass attempt, requiring review"
                    return 1
                    ;;
            esac
        fi
    fi

    # Marker file exists or no artifacts - normal flow
    return 0
}

# Purpose: Create marker file to track review in progress
# Inputs: $1 = unit name
# Outputs: Creates marker file at ${CWD}/.claude/.review-in-progress
# Returns: 0 (always succeeds)
create_review_marker() {
    local unit_name=$1

    local marker_file="${CWD}/.claude/.review-in-progress"
    mkdir -p "${CWD}/.claude"

    cat > "$marker_file" <<EOF
# Review In Progress
Unit: $unit_name
Started: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
EOF

    return 0
}

# Purpose: Remove marker file after review completes
# Inputs: None
# Outputs: Removes marker file
# Returns: 0 (always succeeds)
remove_review_marker() {
    local marker_file="${CWD}/.claude/.review-in-progress"

    if [ -f "$marker_file" ]; then
        rm -f "$marker_file"
    fi

    return 0
}
