#!/usr/bin/env bash
# Configuration Parser for AIDLC Design Review Hook
#
# Purpose: Load and validate configuration from .claude/review-config.yaml
# Fallback chain: yq → Python PyYAML → defaults
#
# Dependencies:
#   - config-defaults.sh (default values)
#   - Optional: yq v4+ (mikefarah/yq)
#   - Optional: Python 3.6+ with PyYAML 5.1+
#
# Usage:
#   source lib/config-parser.sh
#   load_config
#   validate_and_fix_config
#   # Now CONFIG_* variables are ready to use

# Global variables populated by this module
CONFIG_ENABLED=""
CONFIG_DRY_RUN=""
CONFIG_INTERACTIVE=""
CONFIG_REVIEW_THRESHOLD=""
CONFIG_TIMEOUT_SECONDS=""
CONFIG_BATCH_SIZE_FILES=""
CONFIG_BATCH_SIZE_BYTES=""
CONFIG_BLOCK_ON_CRITICAL=""
CONFIG_BLOCK_ON_HIGH_COUNT=""
CONFIG_MAX_QUALITY_SCORE=""
CONFIG_SOURCE=""  # Metadata: "yq", "python", or "defaults"

# Purpose: Load configuration from YAML file with three-tier fallback chain
# Inputs: None (reads from ${CWD}/.claude/review-config.yaml)
# Outputs: Populates CONFIG_* global variables
# Returns: 0 (always succeeds, fail-open)
load_config() {
    local config_file="${CWD}/.claude/review-config.yaml"

    # Check if config file exists
    if [ ! -f "$config_file" ]; then
        log_info "Config file not found at $config_file, using defaults"
        load_defaults
        CONFIG_SOURCE="defaults"
        return 0
    fi

    # Tier 1: Try yq parsing
    if parse_with_yq "$config_file"; then
        log_info "Configuration loaded via yq"
        CONFIG_SOURCE="yq"
        return 0
    fi

    # Tier 2: Try Python parsing
    if parse_with_python "$config_file"; then
        log_info "Configuration loaded via Python"
        CONFIG_SOURCE="python"
        return 0
    fi

    # Tier 3: Load defaults (always succeeds)
    log_warning "YAML parsing failed, using defaults"
    load_defaults
    CONFIG_SOURCE="defaults"
    return 0
}

# Purpose: Parse YAML configuration using mikefarah/yq v4+
# Inputs: $1 = path to YAML config file
# Outputs: Populates CONFIG_* global variables
# Returns: 0 (success), 1 (failure)
parse_with_yq() {
    local config_file=$1

    # Check yq availability
    if ! command -v yq &>/dev/null; then
        log_warning "yq not found. Install with: brew install yq (macOS), apt install yq (Ubuntu/Debian), yum install yq (RHEL/CentOS)"
        return 1
    fi

    # Parse flat keys (one yq invocation per key)
    CONFIG_ENABLED=$(yq '.enabled' "$config_file" 2>/dev/null)
    CONFIG_DRY_RUN=$(yq '.dry_run' "$config_file" 2>/dev/null)
    CONFIG_INTERACTIVE=$(yq '.interactive' "$config_file" 2>/dev/null)
    CONFIG_REVIEW_THRESHOLD=$(yq '.review_threshold' "$config_file" 2>/dev/null)
    CONFIG_TIMEOUT_SECONDS=$(yq '.timeout_seconds' "$config_file" 2>/dev/null)

    # Parse nested keys (blocking section)
    CONFIG_BLOCK_ON_CRITICAL=$(yq '.blocking.on_critical' "$config_file" 2>/dev/null)
    CONFIG_BLOCK_ON_HIGH_COUNT=$(yq '.blocking.on_high_count' "$config_file" 2>/dev/null)
    CONFIG_MAX_QUALITY_SCORE=$(yq '.blocking.max_quality_score' "$config_file" 2>/dev/null)

    # Parse nested keys (batch section)
    CONFIG_BATCH_SIZE_FILES=$(yq '.batch.size_files' "$config_file" 2>/dev/null)
    CONFIG_BATCH_SIZE_BYTES=$(yq '.batch.size_bytes' "$config_file" 2>/dev/null)

    # Parse nested keys (review section)
    CONFIG_ENABLE_ALTERNATIVES=$(yq '.review.enable_alternatives' "$config_file" 2>/dev/null)
    CONFIG_ENABLE_GAP_ANALYSIS=$(yq '.review.enable_gap_analysis' "$config_file" 2>/dev/null)

    # Check if parsing succeeded (at least one value present)
    if [ -n "$CONFIG_ENABLED" ] || [ -n "$CONFIG_DRY_RUN" ] || [ -n "$CONFIG_INTERACTIVE" ] || [ -n "$CONFIG_REVIEW_THRESHOLD" ]; then
        return 0
    else
        log_warning "yq parsing failed, trying Python fallback"
        return 1
    fi
}

# Purpose: Parse YAML configuration using Python PyYAML (fallback)
# Inputs: $1 = path to YAML config file
# Outputs: Populates CONFIG_* global variables
# Returns: 0 (success), 1 (failure)
parse_with_python() {
    local config_file=$1

    # Check Python 3 availability
    if ! command -v python3 &>/dev/null; then
        log_warning "Python 3 not found"
        return 1
    fi

    # Check PyYAML availability
    if ! python3 -c "import yaml" 2>/dev/null; then
        log_warning "PyYAML not installed. Using defaults. Install with: pip3 install pyyaml"
        return 1
    fi

    # Parse flat keys (one Python invocation per key)
    CONFIG_ENABLED=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('enabled', ''))" 2>/dev/null)
    CONFIG_DRY_RUN=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('dry_run', ''))" 2>/dev/null)
    CONFIG_INTERACTIVE=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('interactive', ''))" 2>/dev/null)
    CONFIG_REVIEW_THRESHOLD=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('review_threshold', ''))" 2>/dev/null)
    CONFIG_TIMEOUT_SECONDS=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('timeout_seconds', ''))" 2>/dev/null)

    # Parse nested keys (blocking section)
    CONFIG_BLOCK_ON_CRITICAL=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('blocking', {}).get('on_critical', ''))" 2>/dev/null)
    CONFIG_BLOCK_ON_HIGH_COUNT=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('blocking', {}).get('on_high_count', ''))" 2>/dev/null)
    CONFIG_MAX_QUALITY_SCORE=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('blocking', {}).get('max_quality_score', ''))" 2>/dev/null)

    # Parse nested keys (batch section)
    CONFIG_BATCH_SIZE_FILES=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('batch', {}).get('size_files', ''))" 2>/dev/null)
    CONFIG_BATCH_SIZE_BYTES=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('batch', {}).get('size_bytes', ''))" 2>/dev/null)

    # Parse nested keys (review section)
    CONFIG_ENABLE_ALTERNATIVES=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('review', {}).get('enable_alternatives', ''))" 2>/dev/null)
    CONFIG_ENABLE_GAP_ANALYSIS=$(python3 -c "import yaml; print(yaml.safe_load(open('$config_file')).get('review', {}).get('enable_gap_analysis', ''))" 2>/dev/null)

    # Check if parsing succeeded
    if [ -n "$CONFIG_ENABLED" ] || [ -n "$CONFIG_DRY_RUN" ] || [ -n "$CONFIG_REVIEW_THRESHOLD" ]; then
        return 0
    else
        log_warning "Python parsing failed"
        return 1
    fi
}

# Purpose: Load default configuration values
# Inputs: None
# Outputs: Populates CONFIG_* global variables
# Returns: 0 (always succeeds)
load_defaults() {
    # Try to source defaults file
    if [ -f "${LIB_DIR}/config-defaults.sh" ]; then
        # shellcheck source=.claude/lib/config-defaults.sh
        source "${LIB_DIR}/config-defaults.sh"
        return 0
    fi

    # Inline fallback if file missing (ultimate reliability)
    log_error "config-defaults.sh not found, using inline defaults"
    CONFIG_ENABLED=true
    CONFIG_DRY_RUN=false
    CONFIG_INTERACTIVE=false
    CONFIG_REVIEW_THRESHOLD=3
    CONFIG_TIMEOUT_SECONDS=120
    CONFIG_BATCH_SIZE_FILES=20
    CONFIG_BATCH_SIZE_BYTES=25600
    CONFIG_BLOCK_ON_CRITICAL=true
    CONFIG_BLOCK_ON_HIGH_COUNT=3
    CONFIG_MAX_QUALITY_SCORE=30
    CONFIG_ENABLE_ALTERNATIVES=true
    CONFIG_ENABLE_GAP_ANALYSIS=true
    CONFIG_BLOCK_ON_CRITICAL=true
    CONFIG_BLOCK_ON_HIGH_COUNT=3
    CONFIG_MAX_QUALITY_SCORE=30
    return 0
}

# Purpose: Validate configuration values, apply per-key defaults for invalid values
# Inputs: None (validates CONFIG_* globals)
# Outputs: Fixes CONFIG_* globals in-place
# Returns: 0 (always succeeds)
validate_and_fix_config() {
    # Validate enabled (boolean)
    if ! validate_boolean "$CONFIG_ENABLED"; then
        log_warning "Invalid enabled: '$CONFIG_ENABLED' (must be true/false), using default: true"
        CONFIG_ENABLED=true
    fi

    # Validate dry_run (boolean)
    if ! validate_boolean "$CONFIG_DRY_RUN"; then
        log_warning "Invalid dry_run: '$CONFIG_DRY_RUN' (must be true/false), using default: false"
        CONFIG_DRY_RUN=false
    fi

    # Validate interactive (boolean)
    if ! validate_boolean "$CONFIG_INTERACTIVE"; then
        log_warning "Invalid interactive: '$CONFIG_INTERACTIVE' (must be true/false), using default: false"
        CONFIG_INTERACTIVE=false
    fi

    # Validate review_threshold (integer range 1-100)
    if ! validate_integer_range "$CONFIG_REVIEW_THRESHOLD" 1 100; then
        log_warning "Invalid review_threshold: '$CONFIG_REVIEW_THRESHOLD' (must be 1-100), using default: 3"
        CONFIG_REVIEW_THRESHOLD=3
    fi

    # Validate timeout_seconds (integer range 10-3600)
    if ! validate_integer_range "$CONFIG_TIMEOUT_SECONDS" 10 3600; then
        log_warning "Invalid timeout_seconds: '$CONFIG_TIMEOUT_SECONDS' (must be 10-3600), using default: 120"
        CONFIG_TIMEOUT_SECONDS=120
    fi

    # Validate batch_size_files (integer range 1-100)
    if ! validate_integer_range "$CONFIG_BATCH_SIZE_FILES" 1 100; then
        log_warning "Invalid batch_size_files: '$CONFIG_BATCH_SIZE_FILES' (must be 1-100), using default: 20"
        CONFIG_BATCH_SIZE_FILES=20
    fi

    # Validate batch_size_bytes (integer range 1024-10485760)
    if ! validate_integer_range "$CONFIG_BATCH_SIZE_BYTES" 1024 10485760; then
        log_warning "Invalid batch_size_bytes: '$CONFIG_BATCH_SIZE_BYTES' (must be 1024-10485760), using default: 25600"
        CONFIG_BATCH_SIZE_BYTES=25600
    fi

    # Validate block_on_critical (boolean)
    if ! validate_boolean "$CONFIG_BLOCK_ON_CRITICAL"; then
        log_warning "Invalid block_on_critical: '$CONFIG_BLOCK_ON_CRITICAL' (must be true/false), using default: true"
        CONFIG_BLOCK_ON_CRITICAL=true
    fi

    # Validate block_on_high_count (integer range 0-100)
    if ! validate_integer_range "$CONFIG_BLOCK_ON_HIGH_COUNT" 0 100; then
        log_warning "Invalid block_on_high_count: '$CONFIG_BLOCK_ON_HIGH_COUNT' (must be 0-100), using default: 3"
        CONFIG_BLOCK_ON_HIGH_COUNT=3
    fi

    # Validate max_quality_score (integer range 0-1000)
    if ! validate_integer_range "$CONFIG_MAX_QUALITY_SCORE" 0 1000; then
        log_warning "Invalid max_quality_score: '$CONFIG_MAX_QUALITY_SCORE' (must be 0-1000), using default: 30"
        CONFIG_MAX_QUALITY_SCORE=30
    fi

    # Validate enable_alternatives (boolean)
    if ! validate_boolean "$CONFIG_ENABLE_ALTERNATIVES"; then
        log_warning "Invalid enable_alternatives: '$CONFIG_ENABLE_ALTERNATIVES' (must be true/false), using default: true"
        CONFIG_ENABLE_ALTERNATIVES=true
    fi

    # Validate enable_gap_analysis (boolean)
    if ! validate_boolean "$CONFIG_ENABLE_GAP_ANALYSIS"; then
        log_warning "Invalid enable_gap_analysis: '$CONFIG_ENABLE_GAP_ANALYSIS' (must be true/false), using default: true"
        CONFIG_ENABLE_GAP_ANALYSIS=true
    fi

    return 0
}

# Purpose: Validate boolean value
# Inputs: $1 = value to validate
# Returns: 0 (valid), 1 (invalid)
validate_boolean() {
    local value=$1
    [[ "$value" == "true" ]] || [[ "$value" == "false" ]]
}

# Purpose: Validate integer value
# Inputs: $1 = value to validate
# Returns: 0 (valid), 1 (invalid)
validate_integer() {
    local value=$1
    [[ "$value" =~ ^[0-9]+$ ]]
}

# Purpose: Validate integer value within range
# Inputs: $1 = value, $2 = min, $3 = max
# Returns: 0 (valid), 1 (invalid)
validate_integer_range() {
    local value=$1
    local min=$2
    local max=$3

    # Check if integer
    if ! [[ "$value" =~ ^[0-9]+$ ]]; then
        return 1
    fi

    # Check range
    if [ "$value" -ge "$min" ] && [ "$value" -le "$max" ]; then
        return 0
    else
        return 1
    fi
}

# Purpose: Check if dry run mode is enabled
# Inputs: None (checks CONFIG_DRY_RUN global)
# Returns: 0 (dry run enabled), 1 (disabled)
is_dry_run() {
    [ "$CONFIG_DRY_RUN" = "true" ]
}
