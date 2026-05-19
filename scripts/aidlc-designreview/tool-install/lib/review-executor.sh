#!/usr/bin/env bash
# Review Executor for AIDLC Design Review Hook
#
# Purpose: Discover, aggregate, and prepare design artifacts for AI review
#
# Dependencies:
#   - config-parser.sh (CONFIG_BATCH_SIZE_FILES, CONFIG_BATCH_SIZE_BYTES)
#   - Bash 4.0+ (arrays, glob patterns)
#   - Standard POSIX utilities (find, wc, sed)
#
# Usage:
#   source lib/review-executor.sh
#   discover_artifacts "$unit_name"
#   aggregate_artifacts "$unit_name"
#   generate_subagent_instructions "$unit_name" "$aggregated_content"

# Global variables populated by this module
DISCOVERED_ARTIFACTS=()  # Array of artifact file paths
TOTAL_SIZE_BYTES=0       # Total size of all discovered artifacts
AGGREGATED_CONTENT=""    # Aggregated artifact content (or first batch)
BATCH_COUNT=0            # Number of batches (0 or 1 for sequential, >1 for batched)

# Purpose: Discover design artifacts for a given unit
# Inputs: $1 = unit path (e.g., "construction/unit2-config-yaml" or "inception/application-design")
# Outputs: Populates DISCOVERED_ARTIFACTS array
# Returns: 0 (success), 1 (no artifacts found)
discover_artifacts() {
    local unit_path=$1
    local aidlc_docs="${AIDLC_DOCS_DIR:-${CWD}/aidlc-docs}"
    local artifacts_dir="${aidlc_docs}/${unit_path}"

    # Clear previous results
    DISCOVERED_ARTIFACTS=()

    # Check if unit directory exists
    if [ ! -d "$artifacts_dir" ]; then
        log_warning "Artifact directory not found: $artifacts_dir"
        return 1
    fi

    # Discover artifacts using glob pattern
    # Match: aidlc-docs/{phase}/{unit}/**/*.md
    # Exclude: aidlc-docs/{phase}/{unit}/plans/**
    while IFS= read -r -d '' file; do
        # Skip files in plans/ subdirectory
        if [[ "$file" =~ /plans/ ]]; then
            continue
        fi

        DISCOVERED_ARTIFACTS+=("$file")
    done < <(find "$artifacts_dir" -type f -name "*.md" -print0)

    # Check if any artifacts found
    if [ ${#DISCOVERED_ARTIFACTS[@]} -eq 0 ]; then
        log_warning "No artifacts found in: $artifacts_dir"
        return 1
    fi

    log_info "Discovered ${#DISCOVERED_ARTIFACTS[@]} artifacts in: $unit_path"
    return 0
}

# Purpose: Calculate total size of discovered artifacts
# Inputs: None (uses DISCOVERED_ARTIFACTS global)
# Outputs: Populates TOTAL_SIZE_BYTES global
# Returns: 0 (always succeeds)
calculate_total_size() {
    TOTAL_SIZE_BYTES=0

    for file in "${DISCOVERED_ARTIFACTS[@]}"; do
        if [ -f "$file" ]; then
            local file_size
            file_size=$(wc -c < "$file" 2>/dev/null || echo 0)
            TOTAL_SIZE_BYTES=$((TOTAL_SIZE_BYTES + file_size))
        fi
    done

    log_info "Total artifact size: $TOTAL_SIZE_BYTES bytes (${#DISCOVERED_ARTIFACTS[@]} files)"
    return 0
}

# Purpose: Aggregate artifacts (dispatch to sequential or batch based on size)
# Inputs: $1 = unit name
# Outputs: Populates AGGREGATED_CONTENT and BATCH_COUNT globals
# Returns: 0 (success), 1 (no artifacts to aggregate)
aggregate_artifacts() {
    local unit_name=$1

    # Discover artifacts if not already done
    if [ ${#DISCOVERED_ARTIFACTS[@]} -eq 0 ]; then
        if ! discover_artifacts "$unit_name"; then
            return 1
        fi
    fi

    # Calculate total size
    calculate_total_size

    # Dispatch to sequential or batch aggregation
    if [ "$TOTAL_SIZE_BYTES" -le "$CONFIG_BATCH_SIZE_BYTES" ] && [ ${#DISCOVERED_ARTIFACTS[@]} -le "$CONFIG_BATCH_SIZE_FILES" ]; then
        log_info "Using sequential aggregation (under batch thresholds)"
        sequential_aggregation
    else
        log_info "Using batch aggregation (exceeds batch thresholds)"
        batch_aggregation
    fi

    return 0
}

# Purpose: Sequentially aggregate all artifacts into single content block
# Inputs: None (uses DISCOVERED_ARTIFACTS global)
# Outputs: Populates AGGREGATED_CONTENT global
# Returns: 0 (always succeeds)
sequential_aggregation() {
    AGGREGATED_CONTENT=""
    BATCH_COUNT=1

    for file in "${DISCOVERED_ARTIFACTS[@]}"; do
        if [ -f "$file" ]; then
            local relative_path="${file#${CWD}/}"
            AGGREGATED_CONTENT+="--- FILE: $relative_path ---"$'\n'

            # Read file content and sanitize
            local content
            content=$(cat "$file" 2>/dev/null || echo "")
            content=$(sanitize_content "$content")

            AGGREGATED_CONTENT+="$content"$'\n'
            AGGREGATED_CONTENT+="--- END FILE ---"$'\n\n'
        fi
    done

    log_info "Sequential aggregation complete: ${#AGGREGATED_CONTENT} characters"
    return 0
}

# Purpose: Batch aggregate artifacts into multiple batches
# Inputs: None (uses DISCOVERED_ARTIFACTS global, CONFIG_BATCH_SIZE_FILES, CONFIG_BATCH_SIZE_BYTES)
# Outputs: Populates AGGREGATED_CONTENT (first batch only), BATCH_COUNT globals
# Returns: 0 (always succeeds)
batch_aggregation() {
    AGGREGATED_CONTENT=""
    BATCH_COUNT=0

    local batch_content=""
    local batch_files=0
    local batch_size_bytes=0
    local first_batch=true

    for file in "${DISCOVERED_ARTIFACTS[@]}"; do
        if [ ! -f "$file" ]; then
            continue
        fi

        local file_size
        file_size=$(wc -c < "$file" 2>/dev/null || echo 0)

        # Check if adding this file would exceed batch limits
        if [ "$batch_files" -ge "$CONFIG_BATCH_SIZE_FILES" ] || [ "$batch_size_bytes" -ge "$CONFIG_BATCH_SIZE_BYTES" ]; then
            # Finalize current batch
            BATCH_COUNT=$((BATCH_COUNT + 1))

            # Save first batch to AGGREGATED_CONTENT
            if [ "$first_batch" = true ]; then
                AGGREGATED_CONTENT="$batch_content"
                first_batch=false
            fi

            # Reset for next batch
            batch_content=""
            batch_files=0
            batch_size_bytes=0
        fi

        # Add file to current batch
        local relative_path="${file#${CWD}/}"
        batch_content+="--- FILE: $relative_path ---"$'\n'

        local content
        content=$(cat "$file" 2>/dev/null || echo "")
        content=$(sanitize_content "$content")

        batch_content+="$content"$'\n'
        batch_content+="--- END FILE ---"$'\n\n'

        batch_files=$((batch_files + 1))
        batch_size_bytes=$((batch_size_bytes + file_size))
    done

    # Finalize last batch
    if [ -n "$batch_content" ]; then
        BATCH_COUNT=$((BATCH_COUNT + 1))

        # Save first batch if not already saved
        if [ "$first_batch" = true ]; then
            AGGREGATED_CONTENT="$batch_content"
        fi
    fi

    log_info "Batch aggregation complete: $BATCH_COUNT batches"
    log_info "First batch size: ${#AGGREGATED_CONTENT} characters"
    return 0
}

# Purpose: Sanitize content to prevent delimiter collision
# Inputs: $1 = content to sanitize
# Outputs: Sanitized content (stdout)
# Returns: 0 (always succeeds)
sanitize_content() {
    local content=$1

    # Escape "--- FILE:" and "--- END FILE ---" patterns that might appear in content
    # Replace with safe alternatives to prevent delimiter collision
    content="${content//--- FILE:/\-\-\- FILE:}"
    content="${content//--- END FILE ---/\-\-\- END FILE \-\-\-}"

    echo "$content"
}

# Purpose: Load all architectural patterns
# Outputs: Combined patterns content (stdout)
# Returns: 0 (always succeeds)
load_patterns() {
    # HOOK_DIR is .claude/hooks/, so .claude/ is HOOK_DIR/..
    local claude_dir="${HOOK_DIR:-.claude/hooks}/.."
    local patterns_dir="${claude_dir}/patterns"
    local patterns_content=""

    if [ -d "$patterns_dir" ]; then
        for pattern_file in "$patterns_dir"/*.md; do
            if [ -f "$pattern_file" ]; then
                patterns_content+="$(cat "$pattern_file")"$'\n\n'
            fi
        done
    fi

    echo "$patterns_content"
}

# Purpose: Load and prepare a prompt template
# Inputs: $1 = agent name (critique/alternatives/gap), $2 = design content, $3 = severity threshold
# Outputs: Filled prompt (stdout)
# Returns: 0 (success), 1 (template not found)
load_prompt_template() {
    local agent_name=$1
    local design_content=$2
    local severity_threshold=${3:-medium}

    # HOOK_DIR is .claude/hooks/, so .claude/ is HOOK_DIR/..
    local claude_dir="${HOOK_DIR:-.claude/hooks}/.."
    local prompts_dir="${claude_dir}/prompts"
    local template_file="${prompts_dir}/${agent_name}-v1.md"

    if [ ! -f "$template_file" ]; then
        log_error "Prompt template not found: $template_file"
        return 1
    fi

    # Load patterns
    local patterns=$(load_patterns)

    # Read template and perform substitutions
    local prompt=$(cat "$template_file")

    # Replace placeholders
    prompt="${prompt//<!-- INSERT: patterns -->/$patterns}"
    prompt="${prompt//<!-- INSERT: design_document -->/$design_content}"
    prompt="${prompt//<!-- INSERT: severity_threshold -->/$severity_threshold}"
    prompt="${prompt//<!-- INSERT: constraints -->/No specific constraints for this review}"

    echo "$prompt"
}

# Purpose: Call AI agent with prompt and parse JSON response
# Inputs: $1 = agent name, $2 = prompt
# Outputs: Sets global AGENT_RESPONSE with JSON string
# Returns: 0 (success), 1 (API call failed)
call_ai_agent() {
    local agent_name=$1
    local prompt=$2

    AGENT_RESPONSE=""

    if [ "${USE_REAL_AI:-1}" != "1" ] || ! command -v aws &>/dev/null; then
        # Mock response for testing
        case "$agent_name" in
            critique)
                AGENT_RESPONSE='{"findings": []}'
                ;;
            alternatives)
                AGENT_RESPONSE='{"suggestions": [], "recommendation": "Current design is appropriate"}'
                ;;
            gap)
                AGENT_RESPONSE='{"findings": []}'
                ;;
        esac
        return 0
    fi

    # Create temporary files
    local temp_body=$(mktemp)
    local temp_response=$(mktemp)

    # Create request body
    jq -n --arg content "$prompt" '{
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 8192,
        "messages": [{
            "role": "user",
            "content": $content
        }]
    }' > "$temp_body"

    # Call AWS Bedrock with Claude Opus 4.6
    # Timeout: 5 minutes (300 seconds) for large prompts with patterns
    if aws bedrock-runtime invoke-model \
        --model-id us.anthropic.claude-opus-4-6-v1 \
        --body "fileb://$temp_body" \
        --region us-east-1 \
        --cli-read-timeout 300 \
        --cli-connect-timeout 60 \
        "$temp_response" >/dev/null 2>&1; then

        # Extract text from response
        local raw_response=$(jq -r '.content[0].text' "$temp_response" 2>/dev/null)

        # Clean up JSON response (remove markdown code blocks if present)
        # Try multiple extraction methods
        AGENT_RESPONSE=$(echo "$raw_response" | grep -Pzo '(?s)\{.*\}' | tr -d '\0' | head -c 50000)

        # If that didn't work, try simpler extraction
        if [ -z "$AGENT_RESPONSE" ] || ! echo "$AGENT_RESPONSE" | jq empty 2>/dev/null; then
            AGENT_RESPONSE=$(echo "$raw_response" | sed -n '/^{/,/^}$/p')
        fi

        # Validate JSON
        if [ -z "$AGENT_RESPONSE" ]; then
            log_error "Failed to extract JSON from $agent_name response"
            log_error "Raw response (first 500 chars): ${raw_response:0:500}"
            rm -f "$temp_body" "$temp_response"
            return 1
        fi

        if ! echo "$AGENT_RESPONSE" | jq empty 2>/dev/null; then
            log_error "Invalid JSON from $agent_name agent"
            log_error "Response (first 500 chars): ${AGENT_RESPONSE:0:500}"
            rm -f "$temp_body" "$temp_response"
            return 1
        fi
    else
        log_error "AWS Bedrock API call failed for $agent_name"
        rm -f "$temp_body" "$temp_response"
        return 1
    fi

    rm -f "$temp_body" "$temp_response"
    return 0
}
