#!/usr/bin/env bash
# Report Generator for AIDLC Design Review Hook
#
# Purpose: Generate markdown reports from AI review responses
#
# Dependencies:
#   - Bash 4.0+ (arrays, parameter expansion, associative arrays)
#   - POSIX utilities (grep, date, sed)
#
# Usage:
#   source lib/report-generator.sh
#   parse_response "$ai_response"
#   generate_report "$unit_name" "$ai_response"

# Global variables populated by parse_response()
FINDINGS_CRITICAL=()
FINDINGS_HIGH=()
FINDINGS_MEDIUM=()
FINDINGS_LOW=()
declare -gA FINDING_DETAILS  # Associative array for finding details (indexed by finding_N)
declare -gA FINDING_INDEX  # Maps finding title to index (title -> N)
QUALITY_SCORE=0
RAW_AI_RESPONSE=""  # Store raw response for extracting details later

# Global variables for alternatives and gap analysis
ALTERNATIVES=()  # Array of alternative titles
declare -gA ALTERNATIVE_DETAILS  # Associative array for alternative details
declare -gA ALTERNATIVE_INDEX  # Maps alternative title to index
ALTERNATIVES_RECOMMENDATION=""

GAPS_CRITICAL=()
GAPS_HIGH=()
GAPS_MEDIUM=()
GAPS_LOW=()
declare -gA GAP_DETAILS  # Associative array for gap details
declare -gA GAP_INDEX  # Maps gap title to index

# Purpose: Parse JSON AI review response from multi-agent system
# Inputs: $1 = Combined JSON response from critique, alternatives, and gap agents
# Outputs: Populates FINDINGS_* globals, FINDING_DETAILS, ALTERNATIVES, GAPS, and QUALITY_SCORE
# Returns: 0 (success), 1 (parse error)
parse_response() {
    local response=$1
    RAW_AI_RESPONSE="$response"

    # Clear previous results
    FINDINGS_CRITICAL=()
    FINDINGS_HIGH=()
    FINDINGS_MEDIUM=()
    FINDINGS_LOW=()
    declare -gA FINDING_DETAILS
    declare -gA FINDING_INDEX
    QUALITY_SCORE=0

    ALTERNATIVES=()
    declare -gA ALTERNATIVE_DETAILS
    declare -gA ALTERNATIVE_INDEX
    ALTERNATIVES_RECOMMENDATION=""

    GAPS_CRITICAL=()
    GAPS_HIGH=()
    GAPS_MEDIUM=()
    GAPS_LOW=()
    declare -gA GAP_DETAILS
    declare -gA GAP_INDEX

    # Parse critique findings
    local critique_findings_count=$(echo "$response" | jq -r '.critique.findings | length' 2>/dev/null || echo "0")

    for ((i=0; i<critique_findings_count; i++)); do
        local finding=$(echo "$response" | jq -r ".critique.findings[$i]" 2>/dev/null)
        local title=$(echo "$finding" | jq -r '.title' 2>/dev/null)
        local severity=$(echo "$finding" | jq -r '.severity' 2>/dev/null)
        local description=$(echo "$finding" | jq -r '.description' 2>/dev/null)
        local location=$(echo "$finding" | jq -r '.location' 2>/dev/null)
        local recommendation=$(echo "$finding" | jq -r '.recommendation' 2>/dev/null)

        # Store index mapping
        FINDING_INDEX["$title"]=$i

        # Add to appropriate severity array
        case "${severity,,}" in
            critical)
                FINDINGS_CRITICAL+=("$title")
                ;;
            high)
                FINDINGS_HIGH+=("$title")
                ;;
            medium)
                FINDINGS_MEDIUM+=("$title")
                ;;
            low)
                FINDINGS_LOW+=("$title")
                ;;
        esac

        # Store details
        local key="finding_${i}"
        FINDING_DETAILS["${key}_title"]="$title"
        FINDING_DETAILS["${key}_severity"]="$severity"
        FINDING_DETAILS["${key}_desc"]="$description"
        FINDING_DETAILS["${key}_loc"]="$location"
        FINDING_DETAILS["${key}_rec"]="$recommendation"
    done

    # Parse alternatives if present
    local alternatives_count=$(echo "$response" | jq -r '.alternatives.suggestions | length' 2>/dev/null || echo "0")

    for ((i=0; i<alternatives_count; i++)); do
        local alt=$(echo "$response" | jq -r ".alternatives.suggestions[$i]" 2>/dev/null)
        local title=$(echo "$alt" | jq -r '.title' 2>/dev/null)

        # Store index mapping
        ALTERNATIVE_INDEX["$title"]=$i

        ALTERNATIVES+=("$title")

        local key="alt_${i}"
        ALTERNATIVE_DETAILS["${key}_title"]="$title"
        ALTERNATIVE_DETAILS["${key}_overview"]=$(echo "$alt" | jq -r '.overview' 2>/dev/null)
        ALTERNATIVE_DETAILS["${key}_changes"]=$(echo "$alt" | jq -r '.what_changes' 2>/dev/null)
        ALTERNATIVE_DETAILS["${key}_complexity"]=$(echo "$alt" | jq -r '.implementation_complexity' 2>/dev/null)

        # Parse advantages array
        local adv_count=$(echo "$alt" | jq -r '.advantages | length' 2>/dev/null || echo "0")
        local advantages=""
        for ((j=0; j<adv_count; j++)); do
            local adv=$(echo "$alt" | jq -r ".advantages[$j]" 2>/dev/null)
            advantages+="- $adv"$'\n'
        done
        ALTERNATIVE_DETAILS["${key}_advantages"]="$advantages"

        # Parse disadvantages array
        local dis_count=$(echo "$alt" | jq -r '.disadvantages | length' 2>/dev/null || echo "0")
        local disadvantages=""
        for ((j=0; j<dis_count; j++)); do
            local dis=$(echo "$alt" | jq -r ".disadvantages[$j]" 2>/dev/null)
            disadvantages+="- $dis"$'\n'
        done
        ALTERNATIVE_DETAILS["${key}_disadvantages"]="$disadvantages"
    done

    ALTERNATIVES_RECOMMENDATION=$(echo "$response" | jq -r '.alternatives.recommendation' 2>/dev/null || echo "")

    # Parse gap analysis findings
    local gap_findings_count=$(echo "$response" | jq -r '.gap.findings | length' 2>/dev/null || echo "0")

    for ((i=0; i<gap_findings_count; i++)); do
        local gap=$(echo "$response" | jq -r ".gap.findings[$i]" 2>/dev/null)
        local title=$(echo "$gap" | jq -r '.title' 2>/dev/null)
        local priority=$(echo "$gap" | jq -r '.priority' 2>/dev/null)
        local category=$(echo "$gap" | jq -r '.category' 2>/dev/null)
        local description=$(echo "$gap" | jq -r '.description' 2>/dev/null)
        local impact=$(echo "$gap" | jq -r '.impact' 2>/dev/null)
        local suggestion=$(echo "$gap" | jq -r '.suggestion' 2>/dev/null)

        # Store index mapping
        GAP_INDEX["$title"]=$i

        # Map priority to severity and add to appropriate array
        local severity="medium"
        case "${priority,,}" in
            high)
                severity="high"
                GAPS_HIGH+=("$title")
                ;;
            medium)
                GAPS_MEDIUM+=("$title")
                ;;
            low)
                severity="low"
                GAPS_LOW+=("$title")
                ;;
        esac

        # Store details
        local key="gap_${i}"
        GAP_DETAILS["${key}_title"]="$title"
        GAP_DETAILS["${key}_severity"]="$severity"
        GAP_DETAILS["${key}_category"]="$category"
        GAP_DETAILS["${key}_desc"]="$description"
        GAP_DETAILS["${key}_impact"]="$impact"
        GAP_DETAILS["${key}_suggestion"]="$suggestion"
    done

    # Calculate quality score: (critical × 4) + (high × 3) + (medium × 2) + (low × 1)
    QUALITY_SCORE=$(( (${#FINDINGS_CRITICAL[@]} * 4) + (${#FINDINGS_HIGH[@]} * 3) + (${#FINDINGS_MEDIUM[@]} * 2) + (${#FINDINGS_LOW[@]} * 1) ))

    log_info "Parsed findings: ${#FINDINGS_CRITICAL[@]} critical, ${#FINDINGS_HIGH[@]} high, ${#FINDINGS_MEDIUM[@]} medium, ${#FINDINGS_LOW[@]} low"
    if [ ${#ALTERNATIVES[@]} -gt 0 ]; then
        log_info "Parsed alternatives: ${#ALTERNATIVES[@]}"
    fi
    local total_gaps=$((${#GAPS_CRITICAL[@]} + ${#GAPS_HIGH[@]} + ${#GAPS_MEDIUM[@]} + ${#GAPS_LOW[@]}))
    if [ $total_gaps -gt 0 ]; then
        log_info "Parsed gaps: $total_gaps (${#GAPS_CRITICAL[@]} critical, ${#GAPS_HIGH[@]} high, ${#GAPS_MEDIUM[@]} medium, ${#GAPS_LOW[@]} low)"
    fi

    return 0
}

# Purpose: Extract detailed fields for each finding
# Inputs: $1 = AI response text
# Outputs: Populates FINDING_DETAILS associative array
extract_finding_details() {
    local response=$1

    # Pattern: After "SEVERITY: Title", look for "Description:", "Location:", "Recommendation:" on subsequent lines
    local current_finding=""
    local in_finding=false

    while IFS= read -r line; do
        # Check if line starts a new finding
        if [[ "$line" =~ ^(CRITICAL|HIGH|MEDIUM|LOW):\  ]]; then
            current_finding="$line"
            in_finding=true
        elif [ "$in_finding" = true ]; then
            # Extract detail fields
            if [[ "$line" =~ ^Description:\s*(.+)$ ]]; then
                FINDING_DETAILS["${current_finding}_desc"]="${BASH_REMATCH[1]}"
            elif [[ "$line" =~ ^Location:\s*(.+)$ ]]; then
                FINDING_DETAILS["${current_finding}_loc"]="${BASH_REMATCH[1]}"
            elif [[ "$line" =~ ^Recommendation:\s*(.+)$ ]]; then
                FINDING_DETAILS["${current_finding}_rec"]="${BASH_REMATCH[1]}"
            # Stop at next finding or quality score
            elif [[ "$line" =~ ^(CRITICAL|HIGH|MEDIUM|LOW):\  ]] || [[ "$line" =~ ^Quality\ Score: ]]; then
                in_finding=false
                current_finding="$line"
                if [[ "$line" =~ ^(CRITICAL|HIGH|MEDIUM|LOW):\  ]]; then
                    in_finding=true
                fi
            fi
        fi
    done <<< "$response"
}

# Purpose: Extract alternative approaches from AI response
# Inputs: $1 = AI response text
# Outputs: Populates ALTERNATIVES array and ALTERNATIVE_DETAILS associative array
extract_alternatives() {
    local response=$1

    # Clear previous results
    ALTERNATIVES=()
    declare -gA ALTERNATIVE_DETAILS
    ALTERNATIVES_RECOMMENDATION=""

    # Check if alternatives section exists
    if ! echo "$response" | grep -q "=== ALTERNATIVES AGENT ==="; then
        return 0
    fi

    # Extract alternatives section
    local in_alternatives=false
    local current_alt=""
    local current_field=""

    while IFS= read -r line; do
        # Start of alternatives section
        if [[ "$line" =~ ^===\ ALTERNATIVES\ AGENT\ ===$ ]]; then
            in_alternatives=true
            continue
        fi

        # End of alternatives section
        if [[ "$line" =~ ^===\ GAP\ ANALYSIS\ AGENT\ ===$ ]] || [[ "$line" =~ ^Quality\ Score: ]]; then
            in_alternatives=false
            break
        fi

        if [ "$in_alternatives" = true ]; then
            # Match ALTERNATIVE N: Title
            if [[ "$line" =~ ^ALTERNATIVE\ [0-9]+:\ (.+)$ ]]; then
                current_alt="${BASH_REMATCH[1]}"
                ALTERNATIVES+=("$current_alt")
                current_field=""
            # Match Recommended Alternative line
            elif [[ "$line" =~ ^Recommended\ Alternative:\ (.+)$ ]]; then
                ALTERNATIVES_RECOMMENDATION="${BASH_REMATCH[1]}"
            # Match detail fields
            elif [[ "$line" =~ ^Overview:\ (.+)$ ]]; then
                ALTERNATIVE_DETAILS["${current_alt}_overview"]="${BASH_REMATCH[1]}"
                current_field="overview"
            elif [[ "$line" =~ ^Complexity:\ (.+)$ ]]; then
                ALTERNATIVE_DETAILS["${current_alt}_complexity"]="${BASH_REMATCH[1]}"
                current_field=""
            elif [[ "$line" =~ ^Advantages:$ ]]; then
                ALTERNATIVE_DETAILS["${current_alt}_advantages"]=""
                current_field="advantages"
            elif [[ "$line" =~ ^Disadvantages:$ ]]; then
                ALTERNATIVE_DETAILS["${current_alt}_disadvantages"]=""
                current_field="disadvantages"
            # Handle list items under Advantages/Disadvantages
            elif [[ "$line" =~ ^-\  ]]; then
                if [ "$current_field" = "advantages" ]; then
                    ALTERNATIVE_DETAILS["${current_alt}_advantages"]+="$line"$'\n'
                elif [ "$current_field" = "disadvantages" ]; then
                    ALTERNATIVE_DETAILS["${current_alt}_disadvantages"]+="$line"$'\n'
                fi
            # Multi-line continuation for overview
            elif [ -n "$current_alt" ] && [ "$current_field" = "overview" ] && [ -n "$line" ]; then
                ALTERNATIVE_DETAILS["${current_alt}_overview"]+=" $line"
            fi
        fi
    done <<< "$response"
}

# Purpose: Extract gap analysis findings from AI response
# Inputs: $1 = AI response text
# Outputs: Populates GAPS_* arrays and GAP_DETAILS associative array
extract_gaps() {
    local response=$1

    # Clear previous results
    GAPS_CRITICAL=()
    GAPS_HIGH=()
    GAPS_MEDIUM=()
    GAPS_LOW=()
    declare -gA GAP_DETAILS

    # Check if gap section exists
    if ! echo "$response" | grep -q "=== GAP ANALYSIS AGENT ==="; then
        return 0
    fi

    # Extract gap analysis section
    local in_gaps=false
    local current_severity=""
    local current_title=""

    while IFS= read -r line; do
        # Start of gap analysis section
        if [[ "$line" =~ ^===\ GAP\ ANALYSIS\ AGENT\ ===$ ]]; then
            in_gaps=true
            continue
        fi

        # End of gap analysis section
        if [[ "$line" =~ ^Quality\ Score: ]]; then
            in_gaps=false
            break
        fi

        if [ "$in_gaps" = true ]; then
            # Match severity markers
            if [[ "$line" =~ ^CRITICAL:\ (.+)$ ]]; then
                current_severity="CRITICAL"
                current_title="${BASH_REMATCH[1]}"
                GAPS_CRITICAL+=("$current_title")
            elif [[ "$line" =~ ^HIGH:\ (.+)$ ]]; then
                current_severity="HIGH"
                current_title="${BASH_REMATCH[1]}"
                GAPS_HIGH+=("$current_title")
            elif [[ "$line" =~ ^MEDIUM:\ (.+)$ ]]; then
                current_severity="MEDIUM"
                current_title="${BASH_REMATCH[1]}"
                GAPS_MEDIUM+=("$current_title")
            elif [[ "$line" =~ ^LOW:\ (.+)$ ]]; then
                current_severity="LOW"
                current_title="${BASH_REMATCH[1]}"
                GAPS_LOW+=("$current_title")
            # Extract detail fields
            elif [[ "$line" =~ ^Category:\ (.+)$ ]]; then
                local gap_key="${current_severity}: ${current_title}"
                GAP_DETAILS["${gap_key}_category"]="${BASH_REMATCH[1]}"
            elif [[ "$line" =~ ^Description:\ (.+)$ ]]; then
                local gap_key="${current_severity}: ${current_title}"
                GAP_DETAILS["${gap_key}_desc"]="${BASH_REMATCH[1]}"
            elif [[ "$line" =~ ^Recommendation:\ (.+)$ ]]; then
                local gap_key="${current_severity}: ${current_title}"
                GAP_DETAILS["${gap_key}_rec"]="${BASH_REMATCH[1]}"
            fi
        fi
    done <<< "$response"
}

# Purpose: Format findings with full details for display
# Inputs: None (uses FINDINGS_* globals and FINDING_DETAILS)
# Outputs: Formatted findings text (stdout)
# Returns: 0 (always succeeds)
format_findings() {
    local output=""

    # Critical findings
    if [ ${#FINDINGS_CRITICAL[@]} -gt 0 ]; then
        output+="### Critical Findings (${#FINDINGS_CRITICAL[@]})"$'\n\n'

        local count=0
        for finding_title in "${FINDINGS_CRITICAL[@]}"; do
            count=$((count + 1))
            local idx="${FINDING_INDEX[$finding_title]:-}"
            local finding_key="finding_${idx}"

            output+="#### ${count}. $finding_title"$'\n\n'
            output+="- **Severity**: Critical"$'\n'

            if [ -n "${FINDING_DETAILS["${finding_key}_loc"]:-}" ]; then
                output+="- **Location**: ${FINDING_DETAILS["${finding_key}_loc"]:-}"$'\n'
            fi

            if [ -n "${FINDING_DETAILS["${finding_key}_desc"]:-}" ]; then
                output+="- **Description**: ${FINDING_DETAILS["${finding_key}_desc"]:-}"$'\n'
            fi

            if [ -n "${FINDING_DETAILS["${finding_key}_rec"]:-}" ]; then
                output+="- **Recommendation**: ${FINDING_DETAILS["${finding_key}_rec"]:-}"$'\n'
            fi

            output+=$'\n'
        done
    fi

    # High findings
    if [ ${#FINDINGS_HIGH[@]} -gt 0 ]; then
        output+="### High Findings (${#FINDINGS_HIGH[@]})"$'\n\n'

        local count=0
        for finding_title in "${FINDINGS_HIGH[@]}"; do
            count=$((count + 1))
            local idx="${FINDING_INDEX[$finding_title]:-}"
            local finding_key="finding_${idx}"

            output+="#### ${count}. $finding_title"$'\n\n'
            output+="- **Severity**: High"$'\n'

            if [ -n "${FINDING_DETAILS["${finding_key}_loc"]:-}" ]; then
                output+="- **Location**: ${FINDING_DETAILS["${finding_key}_loc"]:-}"$'\n'
            fi

            if [ -n "${FINDING_DETAILS["${finding_key}_desc"]:-}" ]; then
                output+="- **Description**: ${FINDING_DETAILS["${finding_key}_desc"]:-}"$'\n'
            fi

            if [ -n "${FINDING_DETAILS["${finding_key}_rec"]:-}" ]; then
                output+="- **Recommendation**: ${FINDING_DETAILS["${finding_key}_rec"]:-}"$'\n'
            fi

            output+=$'\n'
        done
    fi

    # Medium findings
    if [ ${#FINDINGS_MEDIUM[@]} -gt 0 ]; then
        output+="### Medium Findings (${#FINDINGS_MEDIUM[@]})"$'\n\n'

        local count=0
        for finding_title in "${FINDINGS_MEDIUM[@]}"; do
            count=$((count + 1))
            local idx="${FINDING_INDEX[$finding_title]:-}"
            local finding_key="finding_${idx}"

            output+="#### ${count}. $finding_title"$'\n\n'
            output+="- **Severity**: Medium"$'\n'

            if [ -n "${FINDING_DETAILS["${finding_key}_loc"]:-}" ]; then
                output+="- **Location**: ${FINDING_DETAILS["${finding_key}_loc"]:-}"$'\n'
            fi

            if [ -n "${FINDING_DETAILS["${finding_key}_desc"]:-}" ]; then
                output+="- **Description**: ${FINDING_DETAILS["${finding_key}_desc"]:-}"$'\n'
            fi

            if [ -n "${FINDING_DETAILS["${finding_key}_rec"]:-}" ]; then
                output+="- **Recommendation**: ${FINDING_DETAILS["${finding_key}_rec"]:-}"$'\n'
            fi

            output+=$'\n'
        done
    fi

    # Low findings
    if [ ${#FINDINGS_LOW[@]} -gt 0 ]; then
        output+="### Low Findings (${#FINDINGS_LOW[@]})"$'\n\n'

        local count=0
        for finding_title in "${FINDINGS_LOW[@]}"; do
            count=$((count + 1))
            local idx="${FINDING_INDEX[$finding_title]:-}"
            local finding_key="finding_${idx}"

            output+="#### ${count}. $finding_title"$'\n\n'
            output+="- **Severity**: Low"$'\n'

            if [ -n "${FINDING_DETAILS["${finding_key}_loc"]:-}" ]; then
                output+="- **Location**: ${FINDING_DETAILS["${finding_key}_loc"]:-}"$'\n'
            fi

            if [ -n "${FINDING_DETAILS["${finding_key}_desc"]:-}" ]; then
                output+="- **Description**: ${FINDING_DETAILS["${finding_key}_desc"]:-}"$'\n'
            fi

            if [ -n "${FINDING_DETAILS["${finding_key}_rec"]:-}" ]; then
                output+="- **Recommendation**: ${FINDING_DETAILS["${finding_key}_rec"]:-}"$'\n'
            fi

            output+=$'\n'
        done
    fi

    # No findings
    if [ ${#FINDINGS_CRITICAL[@]} -eq 0 ] && [ ${#FINDINGS_HIGH[@]} -eq 0 ] && [ ${#FINDINGS_MEDIUM[@]} -eq 0 ] && [ ${#FINDINGS_LOW[@]} -eq 0 ]; then
        output+="*No findings detected.*"$'\n'
    fi

    echo "$output"
}

# Purpose: Format top findings for executive summary
# Inputs: None (uses FINDINGS_* globals and FINDING_DETAILS)
# Outputs: Formatted top findings text (stdout)
# Returns: 0 (always succeeds)
format_top_findings() {
    local output=""
    local count=0
    local max_top=5

    # Add critical findings first
    for finding_title in "${FINDINGS_CRITICAL[@]}"; do
        if [ $count -ge $max_top ]; then break; fi
        count=$((count + 1))
        local finding_key="CRITICAL: $finding_title"

        output+="${count}. **[CRITICAL]** $finding_title"$'\n'
        if [ -n "${FINDING_DETAILS["${finding_key}_desc"]:-}" ]; then
            output+="   - ${FINDING_DETAILS["${finding_key}_desc"]:-}"$'\n'
        fi
        output+="   - Source: critique"$'\n'
    done

    # Add high findings
    for finding_title in "${FINDINGS_HIGH[@]}"; do
        if [ $count -ge $max_top ]; then break; fi
        count=$((count + 1))
        local finding_key="HIGH: $finding_title"

        output+="${count}. **[HIGH]** $finding_title"$'\n'
        if [ -n "${FINDING_DETAILS["${finding_key}_desc"]:-}" ]; then
            output+="   - ${FINDING_DETAILS["${finding_key}_desc"]:-}"$'\n'
        fi
        output+="   - Source: critique"$'\n'
    done

    # Add medium findings if we haven't hit max
    for finding_title in "${FINDINGS_MEDIUM[@]}"; do
        if [ $count -ge $max_top ]; then break; fi
        count=$((count + 1))
        local finding_key="MEDIUM: $finding_title"

        output+="${count}. **[MEDIUM]** $finding_title"$'\n'
        if [ -n "${FINDING_DETAILS["${finding_key}_desc"]:-}" ]; then
            output+="   - ${FINDING_DETAILS["${finding_key}_desc"]:-}"$'\n'
        fi
        output+="   - Source: critique"$'\n'
    done

    if [ $count -eq 0 ]; then
        output+="No significant findings identified."$'\n'
    fi

    echo "$output"
}

# Purpose: Format alternative approaches for display
# Inputs: None (uses ALTERNATIVES array and ALTERNATIVE_DETAILS)
# Outputs: Formatted alternatives text (stdout)
# Returns: 0 (always succeeds)
format_alternatives() {
    local output=""

    if [ ${#ALTERNATIVES[@]} -eq 0 ]; then
        output="No alternative approaches suggested."$'\n'
        echo "$output"
        return 0
    fi

    local count=0
    for alt_title in "${ALTERNATIVES[@]}"; do
        count=$((count + 1))
        local idx="${ALTERNATIVE_INDEX[$alt_title]:-}"
        local alt_key="alt_${idx}"

        output+="### Alternative ${count}: $alt_title"$'\n\n'

        if [ -n "${ALTERNATIVE_DETAILS["${alt_key}_overview"]:-}" ]; then
            output+="**Overview**: ${ALTERNATIVE_DETAILS["${alt_key}_overview"]:-}"$'\n\n'
        fi

        if [ -n "${ALTERNATIVE_DETAILS["${alt_key}_changes"]:-}" ]; then
            output+="**What Changes**: ${ALTERNATIVE_DETAILS["${alt_key}_changes"]:-}"$'\n\n'
        fi

        if [ -n "${ALTERNATIVE_DETAILS["${alt_key}_complexity"]:-}" ]; then
            output+="**Implementation Complexity**: ${ALTERNATIVE_DETAILS["${alt_key}_complexity"]:-}"$'\n\n'
        fi

        if [ -n "${ALTERNATIVE_DETAILS["${alt_key}_advantages"]:-}" ]; then
            output+="**Advantages**:"$'\n'
            output+="${ALTERNATIVE_DETAILS["${alt_key}_advantages"]:-}"$'\n'
        fi

        if [ -n "${ALTERNATIVE_DETAILS["${alt_key}_disadvantages"]:-}" ]; then
            output+="**Disadvantages**:"$'\n'
            output+="${ALTERNATIVE_DETAILS["${alt_key}_disadvantages"]:-}"$'\n'
        fi

        output+="---"$'\n\n'
    done

    echo "$output"
}

# Purpose: Format gap analysis findings for display
# Inputs: None (uses GAPS_* arrays and GAP_DETAILS)
# Outputs: Formatted gaps text (stdout)
# Returns: 0 (always succeeds)
format_gaps() {
    local output=""

    # Critical gaps
    if [ ${#GAPS_CRITICAL[@]} -gt 0 ]; then
        output+="### Critical Gaps (${#GAPS_CRITICAL[@]})"$'\n\n'

        local count=0
        for gap_title in "${GAPS_CRITICAL[@]}"; do
            count=$((count + 1))
            local idx="${GAP_INDEX[$gap_title]:-}"
            local gap_key="gap_${idx}"

            output+="#### ${count}. $gap_title"$'\n\n'
            output+="- **Severity**: Critical"$'\n'

            if [ -n "${GAP_DETAILS["${gap_key}_category"]:-}" ]; then
                output+="- **Category**: ${GAP_DETAILS["${gap_key}_category"]:-}"$'\n'
            fi

            if [ -n "${GAP_DETAILS["${gap_key}_desc"]:-}" ]; then
                output+="- **Description**: ${GAP_DETAILS["${gap_key}_desc"]:-}"$'\n'
            fi

            if [ -n "${GAP_DETAILS["${gap_key}_suggestion"]:-}" ]; then
                output+="- **Recommendation**: ${GAP_DETAILS["${gap_key}_suggestion"]:-}"$'\n'
            fi

            output+=$'\n'
        done
    fi

    # High gaps
    if [ ${#GAPS_HIGH[@]} -gt 0 ]; then
        output+="### High Gaps (${#GAPS_HIGH[@]})"$'\n\n'

        local count=0
        for gap_title in "${GAPS_HIGH[@]}"; do
            count=$((count + 1))
            local idx="${GAP_INDEX[$gap_title]:-}"
            local gap_key="gap_${idx}"

            output+="#### ${count}. $gap_title"$'\n\n'
            output+="- **Severity**: High"$'\n'

            if [ -n "${GAP_DETAILS["${gap_key}_category"]:-}" ]; then
                output+="- **Category**: ${GAP_DETAILS["${gap_key}_category"]:-}"$'\n'
            fi

            if [ -n "${GAP_DETAILS["${gap_key}_desc"]:-}" ]; then
                output+="- **Description**: ${GAP_DETAILS["${gap_key}_desc"]:-}"$'\n'
            fi

            if [ -n "${GAP_DETAILS["${gap_key}_suggestion"]:-}" ]; then
                output+="- **Recommendation**: ${GAP_DETAILS["${gap_key}_suggestion"]:-}"$'\n'
            fi

            output+=$'\n'
        done
    fi

    # Medium gaps
    if [ ${#GAPS_MEDIUM[@]} -gt 0 ]; then
        output+="### Medium Gaps (${#GAPS_MEDIUM[@]})"$'\n\n'

        local count=0
        for gap_title in "${GAPS_MEDIUM[@]}"; do
            count=$((count + 1))
            local idx="${GAP_INDEX[$gap_title]:-}"
            local gap_key="gap_${idx}"

            output+="#### ${count}. $gap_title"$'\n\n'
            output+="- **Severity**: Medium"$'\n'

            if [ -n "${GAP_DETAILS["${gap_key}_category"]:-}" ]; then
                output+="- **Category**: ${GAP_DETAILS["${gap_key}_category"]:-}"$'\n'
            fi

            if [ -n "${GAP_DETAILS["${gap_key}_desc"]:-}" ]; then
                output+="- **Description**: ${GAP_DETAILS["${gap_key}_desc"]:-}"$'\n'
            fi

            if [ -n "${GAP_DETAILS["${gap_key}_suggestion"]:-}" ]; then
                output+="- **Recommendation**: ${GAP_DETAILS["${gap_key}_suggestion"]:-}"$'\n'
            fi

            output+=$'\n'
        done
    fi

    # Low gaps
    if [ ${#GAPS_LOW[@]} -gt 0 ]; then
        output+="### Low Gaps (${#GAPS_LOW[@]})"$'\n\n'

        local count=0
        for gap_title in "${GAPS_LOW[@]}"; do
            count=$((count + 1))
            local idx="${GAP_INDEX[$gap_title]:-}"
            local gap_key="gap_${idx}"

            output+="#### ${count}. $gap_title"$'\n\n'
            output+="- **Severity**: Low"$'\n'

            if [ -n "${GAP_DETAILS["${gap_key}_category"]:-}" ]; then
                output+="- **Category**: ${GAP_DETAILS["${gap_key}_category"]:-}"$'\n'
            fi

            if [ -n "${GAP_DETAILS["${gap_key}_desc"]:-}" ]; then
                output+="- **Description**: ${GAP_DETAILS["${gap_key}_desc"]:-}"$'\n'
            fi

            if [ -n "${GAP_DETAILS["${gap_key}_suggestion"]:-}" ]; then
                output+="- **Recommendation**: ${GAP_DETAILS["${gap_key}_suggestion"]:-}"$'\n'
            fi

            output+=$'\n'
        done
    fi

    # No gaps
    if [ ${#GAPS_CRITICAL[@]} -eq 0 ] && [ ${#GAPS_HIGH[@]} -eq 0 ] && [ ${#GAPS_MEDIUM[@]} -eq 0 ] && [ ${#GAPS_LOW[@]} -eq 0 ]; then
        output+="*No gaps identified.*"$'\n'
    fi

    echo "$output"
}

# Purpose: Calculate quality label from quality score
# Inputs: $1 = quality score
# Outputs: Quality label (stdout)
# Returns: 0 (always succeeds)
calculate_quality_label() {
    local score=$1

    if [ "$score" -le 20 ]; then
        echo "Excellent"
    elif [ "$score" -le 50 ]; then
        echo "Good"
    elif [ "$score" -le 80 ]; then
        echo "Needs Improvement"
    else
        echo "Poor"
    fi
}

# Purpose: Generate markdown report from AI review response
# Inputs: $1 = unit name, $2 = AI review response
# Outputs: Report file at reports/design_review/{timestamp}-designreview.md
# Returns: 0 (success), 1 (failure)
generate_report() {
    local unit_name=$1
    local response=$2

    # Parse response
    parse_response "$response"

    # Calculate quality label and recommendation
    local quality_label
    quality_label=$(calculate_quality_label "$QUALITY_SCORE")

    local recommendation
    if [ ${#FINDINGS_CRITICAL[@]} -gt 0 ]; then
        recommendation="Request Changes — Address critical findings before proceeding"
    elif [ "$QUALITY_SCORE" -gt 80 ]; then
        recommendation="Request Changes — Quality score indicates significant issues"
    elif [ "$QUALITY_SCORE" -gt 50 ]; then
        recommendation="Explore Alternatives — Consider alternative approaches to improve the design"
    else
        recommendation="Approve — Quality meets acceptable standards"
    fi

    # Format findings content
    local findings_content
    findings_content=$(format_findings)

    # Format top findings for executive summary
    local top_findings_content
    top_findings_content=$(format_top_findings)

    # Format alternatives content
    local alternatives_content
    alternatives_content=$(format_alternatives)

    # Format gaps content
    local gaps_content
    gaps_content=$(format_gaps)

    # Calculate agent status
    local alternatives_status="Completed"
    local alternatives_count=${#ALTERNATIVES[@]}
    local gaps_total=$((${#GAPS_CRITICAL[@]} + ${#GAPS_HIGH[@]} + ${#GAPS_MEDIUM[@]} + ${#GAPS_LOW[@]}))
    local gaps_status="Completed"

    if [ "$CONFIG_ENABLE_ALTERNATIVES" != "true" ]; then
        alternatives_status="Skipped (disabled in config)"
        alternatives_count=0
    fi

    if [ "$CONFIG_ENABLE_GAP_ANALYSIS" != "true" ]; then
        gaps_status="Skipped (disabled in config)"
        gaps_total=0
    fi

    # Generate recommended actions based on quality
    local recommended_actions=""
    if [ ${#FINDINGS_CRITICAL[@]} -gt 0 ] || [ "$QUALITY_SCORE" -gt 80 ]; then
        recommended_actions+="- Approve: The design meets quality standards with minor or no issues."$'\n'
        recommended_actions+="- **>>> Request Changes** (Recommended): Significant issues found that should be addressed before proceeding."$'\n'
        recommended_actions+="- Explore Alternatives: Consider alternative approaches to improve the design."$'\n'
    elif [ "$QUALITY_SCORE" -gt 50 ]; then
        recommended_actions+="- Approve: The design meets quality standards with minor or no issues."$'\n'
        recommended_actions+="- Request Changes: Significant issues found that should be addressed before proceeding."$'\n'
        recommended_actions+="- **>>> Explore Alternatives** (Recommended): Consider alternative approaches to improve the design."$'\n'
    else
        recommended_actions+="- **>>> Approve** (Recommended): The design meets quality standards with minor or no issues."$'\n'
        recommended_actions+="- Request Changes: Significant issues found that should be addressed before proceeding."$'\n'
        recommended_actions+="- Explore Alternatives: Consider alternative approaches to improve the design."$'\n'
    fi

    # Create report directory
    local report_dir="${CWD}/reports/design_review"
    mkdir -p "$report_dir" || {
        log_error "Failed to create report directory: $report_dir"
        return 1
    }

    # Generate filename
    local timestamp
    timestamp=$(date +%s)
    local report_file="${report_dir}/${timestamp}-designreview.md"

    # Load template
    local template_file="${LIB_DIR}/../templates/design-review-report.md"
    if [ ! -f "$template_file" ]; then
        log_error "Report template not found: $template_file"
        return 1
    fi

    local template
    template=$(cat "$template_file")

    # Calculate total findings
    local total_findings=$((${#FINDINGS_CRITICAL[@]} + ${#FINDINGS_HIGH[@]} + ${#FINDINGS_MEDIUM[@]} + ${#FINDINGS_LOW[@]}))

    # Determine model name based on USE_REAL_AI
    local model_name
    if [ "${USE_REAL_AI:-1}" = "1" ]; then
        model_name="Claude Opus 4.6 (AWS Bedrock: us.anthropic.claude-opus-4-6-v1)"
    else
        model_name="Mock (USE_REAL_AI=0)"
    fi

    # Substitute variables
    template="${template//\{\{UNIT_NAME\}\}/$unit_name}"
    template="${template//\{\{TIMESTAMP\}\}/$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
    template="${template//\{\{MODEL_NAME\}\}/$model_name}"
    template="${template//\{\{QUALITY_SCORE\}\}/$QUALITY_SCORE}"
    template="${template//\{\{QUALITY_LABEL\}\}/$quality_label}"
    template="${template//\{\{RECOMMENDATION\}\}/$recommendation}"
    template="${template//\{\{FINDINGS_CRITICAL\}\}/${#FINDINGS_CRITICAL[@]}}"
    template="${template//\{\{FINDINGS_HIGH\}\}/${#FINDINGS_HIGH[@]}}"
    template="${template//\{\{FINDINGS_MEDIUM\}\}/${#FINDINGS_MEDIUM[@]}}"
    template="${template//\{\{FINDINGS_LOW\}\}/${#FINDINGS_LOW[@]}}"
    template="${template//\{\{FINDINGS_TOTAL\}\}/$total_findings}"
    template="${template//\{\{FINDINGS_CONTENT\}\}/$findings_content}"
    template="${template//\{\{TOP_FINDINGS_CONTENT\}\}/$top_findings_content}"
    template="${template//\{\{RECOMMENDED_ACTIONS\}\}/$recommended_actions}"
    template="${template//\{\{ALTERNATIVES_CONTENT\}\}/$alternatives_content}"
    template="${template//\{\{ALTERNATIVES_RECOMMENDATION\}\}/$ALTERNATIVES_RECOMMENDATION}"
    template="${template//\{\{GAPS_CONTENT\}\}/$gaps_content}"
    template="${template//\{\{ALTERNATIVES_STATUS\}\}/$alternatives_status}"
    template="${template//\{\{ALTERNATIVES_COUNT\}\}/$alternatives_count}"
    template="${template//\{\{GAPS_STATUS\}\}/$gaps_status}"
    template="${template//\{\{GAPS_TOTAL\}\}/$gaps_total}"

    # Write report
    echo "$template" > "$report_file" || {
        log_error "Failed to write report: $report_file"
        return 1
    }

    log_info "Report generated: $report_file"
    return 0
}

# Purpose: Generate consolidated report combining all units
# Inputs: Uses global variables set by hook:
#   UNIT_NAMES - array of unit names
#   TOTAL_CRITICAL, TOTAL_HIGH, TOTAL_MEDIUM, TOTAL_LOW - totals
#   COMBINED_FINDINGS, COMBINED_ALTERNATIVES, COMBINED_GAPS - formatted content
# Outputs: Single consolidated report file
# Returns: 0 (success), 1 (failure)
generate_consolidated_report() {
    log_debug "Generating consolidated report..."

    # Create report directory
    local report_dir="${CWD}/reports/design_review"
    mkdir -p "$report_dir" || {
        log_error "Failed to create report directory: $report_dir"
        return 1
    }

    # Generate filename
    local timestamp
    timestamp=$(date +%s)
    local report_file="${report_dir}/${timestamp}-consolidated-designreview.md"

    # Calculate total findings and quality score
    local total_findings=$((TOTAL_CRITICAL + TOTAL_HIGH + TOTAL_MEDIUM + TOTAL_LOW))
    local quality_score=$(( (TOTAL_CRITICAL * 4) + (TOTAL_HIGH * 3) + (TOTAL_MEDIUM * 2) + (TOTAL_LOW * 1) ))

    # Calculate quality label
    local quality_label
    if [ $quality_score -le 20 ]; then
        quality_label="Excellent"
    elif [ $quality_score -le 50 ]; then
        quality_label="Good"
    elif [ $quality_score -le 80 ]; then
        quality_label="Needs Improvement"
    else
        quality_label="Poor"
    fi

    # Determine recommendation
    local recommendation
    if [ $TOTAL_CRITICAL -gt 0 ]; then
        recommendation="Request Changes — Address critical findings before proceeding"
    elif [ $quality_score -gt 80 ]; then
        recommendation="Request Changes — Quality score indicates significant issues"
    elif [ $quality_score -gt 50 ]; then
        recommendation="Review Carefully — Consider addressing medium/high findings"
    else
        recommendation="Approve — Quality meets acceptable standards"
    fi

    # Generate recommended actions
    local recommended_actions=""
    if [ $TOTAL_CRITICAL -gt 0 ] || [ $quality_score -gt 80 ]; then
        recommended_actions+="- Approve: The design meets quality standards with minor or no issues."$'\n'
        recommended_actions+="- **>>> Request Changes** (Recommended): Significant issues found that should be addressed before proceeding."$'\n'
        recommended_actions+="- Explore Alternatives: Consider alternative approaches to improve the design."$'\n'
    elif [ $quality_score -gt 50 ]; then
        recommended_actions+="- Approve: The design meets quality standards with minor or no issues."$'\n'
        recommended_actions+="- Request Changes: Significant issues found that should be addressed before proceeding."$'\n'
        recommended_actions+="- **>>> Explore Alternatives** (Recommended): Consider alternative approaches to improve the design."$'\n'
    else
        recommended_actions+="- **>>> Approve** (Recommended): The design meets quality standards with minor or no issues."$'\n'
        recommended_actions+="- Request Changes: Significant issues found that should be addressed before proceeding."$'\n'
        recommended_actions+="- Explore Alternatives: Consider alternative approaches to improve the design."$'\n'
    fi

    # Determine model name
    local model_name
    if [ "${USE_REAL_AI:-1}" = "1" ]; then
        model_name="Claude Opus 4.6 (AWS Bedrock: us.anthropic.claude-opus-4-6-v1)"
    else
        model_name="Mock (USE_REAL_AI=0)"
    fi

    # Build unit list
    local unit_list=""
    for unit in "${UNIT_NAMES[@]}"; do
        unit_list+="- $unit"$'\n'
    done

    # Generate the consolidated report
    cat > "$report_file" << EOF_REPORT
# Design Review Report - Consolidated

## Table of Contents

- [Executive Summary](#executive-summary)
- [Design Critique](#design-critique)
- [Alternative Approaches](#alternative-approaches)
- [Gap Analysis](#gap-analysis)
- [Appendix](#appendix)

---

## Executive Summary

**Overall Quality: $quality_label** (Score: $quality_score)

Consolidated design review for **${#UNIT_NAMES[@]} units** completed with **$total_findings** total findings.

### Units Reviewed

$unit_list

### Overall Findings Summary

| Severity | Count |
|----------|-------|
| Critical | $TOTAL_CRITICAL |
| High | $TOTAL_HIGH |
| Medium | $TOTAL_MEDIUM |
| Low | $TOTAL_LOW |

### Quality Assessment

**Quality Score**: $quality_score

**Calculation**: (critical × 4) + (high × 3) + (medium × 2) + (low × 1) = $quality_score

**Quality Label**: $quality_label

**Quality Thresholds**:
- Excellent: 0-20
- Good: 21-50
- Needs Improvement: 51-80
- Poor: 81+

### Recommended Actions

$recommended_actions

### Recommendation

**$recommendation**

---

## Design Critique

$COMBINED_FINDINGS

---

## Alternative Approaches

$COMBINED_ALTERNATIVES

---

## Gap Analysis

$COMBINED_GAPS

---

## Appendix

### Metadata

| Field | Value |
|-------|-------|
| **Timestamp** | $(date -u +"%Y-%m-%dT%H:%M:%SZ") |
| **Tool Version** | 1.0 (Bash Hook) |
| **Units Reviewed** | ${#UNIT_NAMES[@]} |
| **Model** | $model_name |
| **Review Tool** | AIDLC Design Review Hook v1.0 |

### Report Metadata

- **Units**: ${#UNIT_NAMES[@]}
- **Review Date**: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
- **Total Findings**: $total_findings
- **Quality Score**: $quality_score
- **Quality Label**: $quality_label
- **Recommendation**: $recommendation

---

## Legal Disclaimer

**IMPORTANT**: This report is generated by an AI-powered automated design review tool and is provided for **advisory purposes only**. The recommendations, findings, and assessments contained herein:

- ✅ **Are advisory only** - Not binding recommendations or requirements
- ✅ **Require human review** - Must be reviewed and validated by qualified professionals before implementation
- ✅ **May contain errors** - AI-generated content may include inaccuracies or incomplete analysis
- ✅ **Not a substitute for professional judgment** - Does not replace expert architectural or security review
- ✅ **Context-dependent** - May not consider organization-specific constraints or requirements

**Limitations**:
- AI models may produce biased, incomplete, or incorrect recommendations
- Analysis is limited to information provided in design documents
- Does not guarantee compliance with security, regulatory, or industry standards
- Tool and models are continuously updated; results may vary over time

**No Warranties**: This report is provided "AS IS" without warranties of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement. The authors and providers assume no liability for any errors, omissions, or damages arising from the use of this report.

**User Responsibility**: Users are solely responsible for:
- Validating all recommendations before implementation
- Verifying compliance with applicable standards and regulations
- Conducting thorough security and architectural reviews
- Making final design and implementation decisions

---

*Report generated by AIDLC Design Reviewer v1.0 (Bash Hook)*

**Copyright (c) 2026 AIDLC Design Reviewer Contributors**
Licensed under the MIT License
EOF_REPORT

    if [ $? -ne 0 ]; then
        log_error "Failed to write consolidated report: $report_file"
        return 1
    fi

    log_info "Consolidated report generated: $report_file"
    return 0
}
