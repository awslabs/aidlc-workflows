#!/usr/bin/env bash
# User Interaction Module for AIDLC Design Review Hook
#
# Purpose: Handle user prompts and responses during review workflow
#
# Dependencies:
#   - config-parser.sh (CONFIG_TIMEOUT_SECONDS)
#   - Bash 4.0+ (read with timeout)
#
# Usage:
#   source lib/user-interaction.sh
#   prompt_initial_review
#   prompt_post_review "$findings_summary"

# ==================== Unit 3: Initial Review Prompt ====================

# Purpose: Prompt user before starting design review
# Inputs: None (uses CONFIG_TIMEOUT_SECONDS)
# Outputs: User decision (stdout: "Y" or "N")
# Returns: 0 (user says Y), 1 (user says N)
prompt_initial_review() {
    local timeout=$CONFIG_TIMEOUT_SECONDS
    local retry_count=0
    local max_retries=3
    local response

    while [ $retry_count -lt $max_retries ]; do
        echo "🔍 Design artifacts detected. Review design now? (Y/n, timeout ${timeout}s)" >&2

        # Read with timeout
        if read -t "$timeout" -r response; then
            # User provided input
            response=$(normalize_response "$response")

            if [ "$response" = "Y" ]; then
                echo "Y"
                return 0
            elif [ "$response" = "N" ]; then
                echo "N"
                return 1
            else
                # Invalid input
                retry_count=$((retry_count + 1))
                if [ $retry_count -lt $max_retries ]; then
                    echo "❌ Invalid input. Please enter Y (yes) or N (no). Retry $retry_count/$max_retries" >&2
                fi
            fi
        else
            # Timeout - default to Y
            log_info "User prompt timed out after ${timeout}s, defaulting to: Y"
            echo "Y"
            return 0
        fi
    done

    # Max retries exceeded - default to Y
    log_warning "Max retries ($max_retries) exceeded for initial review prompt, defaulting to: Y"
    echo "Y"
    return 0
}

# Purpose: Normalize user response to Y or N
# Inputs: $1 = raw user input
# Outputs: Normalized response (stdout: "Y", "N", or "INVALID")
# Returns: 0 (valid), 1 (invalid)
normalize_response() {
    local input=$1

    # Trim whitespace and convert to lowercase
    input=$(echo "$input" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

    # Normalize to Y or N
    case "$input" in
        y|yes)
            echo "Y"
            return 0
            ;;
        n|no)
            echo "N"
            return 0
            ;;
        "")
            # Empty input - treat as default Y
            echo "Y"
            return 0
            ;;
        *)
            echo "INVALID"
            return 1
            ;;
    esac
}

# ==================== Unit 4: Post-Review Prompt ====================

# Purpose: Display findings summary to user
# Inputs: $1 = findings summary text
# Outputs: Formatted findings (stderr)
# Returns: 0 (always succeeds)
display_findings() {
    local findings_summary=$1

    # Display findings header
    echo "" >&2
    echo "═════════════════════════════════════════════════════════" >&2
    echo "📋 DESIGN REVIEW FINDINGS" >&2
    echo "═════════════════════════════════════════════════════════" >&2
    echo "" >&2

    # Display findings content
    echo "$findings_summary" >&2

    echo "" >&2
    echo "═════════════════════════════════════════════════════════" >&2
    echo "" >&2

    return 0
}

# Purpose: Prompt user after review with findings summary
# Inputs: $1 = findings summary text
# Outputs: User decision (stdout: "S" for stop, "C" for continue)
# Returns: 0 (continue), 1 (stop)
prompt_post_review() {
    local findings_summary=$1
    local timeout=$CONFIG_POST_REVIEW_TIMEOUT_SECONDS
    local response

    # Display findings
    display_findings "$findings_summary"

    # Prompt user (unlimited retries until valid input or timeout)
    while true; do
        echo "⚠️  Stop code generation or continue? (S/c, timeout ${timeout}s)" >&2
        echo "   S = Stop (block code generation)" >&2
        echo "   C = Continue (proceed with code generation)" >&2

        # Read with timeout
        if read -t "$timeout" -r response; then
            # User provided input - normalize
            response=$(echo "$response" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')

            case "$response" in
                s|stop)
                    echo "S"
                    return 1
                    ;;
                c|continue|"")
                    # Empty input defaults to continue
                    echo "C"
                    return 0
                    ;;
                *)
                    # Invalid input - retry (unlimited)
                    echo "❌ Invalid input. Please enter S (stop) or C (continue)." >&2
                    continue
                    ;;
            esac
        else
            # Timeout - default to continue (fail-open)
            log_info "Post-review prompt timed out after ${timeout}s, defaulting to: C (continue)"
            echo "C"
            return 0
        fi
    done
}
