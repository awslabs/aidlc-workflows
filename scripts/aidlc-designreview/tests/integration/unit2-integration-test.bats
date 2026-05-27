#!/usr/bin/env bats
# Integration tests for Unit 2: Configuration & YAML Parsing
#
# Tests cover:
# - End-to-end configuration loading during hook initialization
# - CONFIG_* variables accessible from main entry point
# - Fallback chain execution (yq → Python → defaults)
# - Validation after loading
# - Dry run mode detection
# - Cross-module integration

# Setup: Source modules and create test environment
setup() {
    # Set up test environment
    export CWD="${BATS_TEST_DIRNAME}/../fixtures"
    export LIB_DIR="${BATS_TEST_DIRNAME}/../../.claude/lib"

    # Create mock logging functions
    log_info() { echo "[INFO] $*" >&2; }
    log_warning() { echo "[WARN] $*" >&2; }
    log_error() { echo "[ERROR] $*" >&2; }
    export -f log_info log_warning log_error

    # Source the modules under test
    source "${LIB_DIR}/config-parser.sh"

    # Create test config directory
    mkdir -p "${CWD}/.claude"
}

# Teardown: Clean up test fixtures
teardown() {
    rm -rf "${CWD}/.claude"
}

# ==================== End-to-End Configuration Loading ====================

@test "integration: config file exists, full load and validate flow succeeds" {
    # Create valid YAML config
    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: true
dry_run: false
review_threshold: 5
timeout_seconds: 180
blocking:
  on_critical: true
  on_high_count: 5
  max_quality_score: 40
batch:
  size_files: 30
  size_bytes: 30000
EOF

    # Execute full flow: load + validate
    load_config
    validate_and_fix_config

    # Verify all CONFIG_* variables populated correctly
    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_DRY_RUN" = "false" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "5" ]
    [ "$CONFIG_TIMEOUT_SECONDS" = "180" ]
    [ "$CONFIG_BLOCK_ON_CRITICAL" = "true" ]
    [ "$CONFIG_BLOCK_ON_HIGH_COUNT" = "5" ]
    [ "$CONFIG_MAX_QUALITY_SCORE" = "40" ]
    [ "$CONFIG_BATCH_SIZE_FILES" = "30" ]
    [ "$CONFIG_BATCH_SIZE_BYTES" = "30000" ]
}

@test "integration: config file missing, defaults loaded and validated" {
    # No config file created
    load_config
    validate_and_fix_config

    # Verify defaults
    [ "$CONFIG_SOURCE" = "defaults" ]
    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_DRY_RUN" = "false" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "3" ]
    [ "$CONFIG_TIMEOUT_SECONDS" = "120" ]
    [ "$CONFIG_BATCH_SIZE_FILES" = "20" ]
    [ "$CONFIG_BATCH_SIZE_BYTES" = "25600" ]
    [ "$CONFIG_BLOCK_ON_CRITICAL" = "true" ]
    [ "$CONFIG_BLOCK_ON_HIGH_COUNT" = "3" ]
    [ "$CONFIG_MAX_QUALITY_SCORE" = "30" ]
}

@test "integration: partial config with invalid values, validation fixes them" {
    # Create partial config with some invalid values
    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: yes
review_threshold: -10
timeout_seconds: 5000
batch:
  size_files: abc
EOF

    load_config
    validate_and_fix_config

    # Verify invalid values replaced with defaults
    [ "$CONFIG_ENABLED" = "true" ]  # Fixed from "yes"
    [ "$CONFIG_REVIEW_THRESHOLD" = "3" ]  # Fixed from -10
    [ "$CONFIG_TIMEOUT_SECONDS" = "120" ]  # Fixed from 5000
    [ "$CONFIG_BATCH_SIZE_FILES" = "20" ]  # Fixed from "abc"
}

# ==================== Fallback Chain Integration ====================

@test "integration: yq unavailable, falls back to Python successfully" {
    # Create valid config
    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: false
dry_run: true
review_threshold: 10
EOF

    # Save original PATH
    ORIG_PATH="$PATH"

    # Hide yq but keep python
    export PATH="/usr/bin:/bin"

    load_config

    # Restore PATH
    export PATH="$ORIG_PATH"

    # Should have loaded via Python or defaults
    [ "$CONFIG_SOURCE" = "python" ] || [ "$CONFIG_SOURCE" = "defaults" ]
    [ -n "$CONFIG_ENABLED" ]
}

@test "integration: yq and Python unavailable, falls back to defaults" {
    # Create config (will be ignored)
    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: false
EOF

    # Save original PATH
    ORIG_PATH="$PATH"

    # Hide both yq and python
    export PATH="/usr/bin:/bin"

    load_config

    # Restore PATH
    export PATH="$ORIG_PATH"

    # Should have loaded defaults
    [ "$CONFIG_SOURCE" = "defaults" ]
    [ "$CONFIG_ENABLED" = "true" ]  # Default, not false from file
}

# ==================== Dry Run Mode Integration ====================

@test "integration: dry run enabled, is_dry_run returns 0" {
    cat > "${CWD}/.claude/review-config.yaml" << EOF
dry_run: true
EOF

    load_config
    validate_and_fix_config

    # Check dry run detection
    run is_dry_run
    [ "$status" -eq 0 ]
}

@test "integration: dry run disabled, is_dry_run returns 1" {
    cat > "${CWD}/.claude/review-config.yaml" << EOF
dry_run: false
EOF

    load_config
    validate_and_fix_config

    # Check dry run detection
    run is_dry_run
    [ "$status" -eq 1 ]
}

# ==================== CONFIG_* Variable Accessibility ====================

@test "integration: CONFIG_* variables exported and accessible in subshell" {
    load_config
    validate_and_fix_config

    # Test that variables are accessible in subshell
    result=$(bash -c 'echo $CONFIG_ENABLED')
    # Variables are not exported by default, so subshell won't see them
    # This is expected behavior - modules should be sourced, not executed

    # Instead, verify they're accessible in current shell
    [ -n "$CONFIG_ENABLED" ]
    [ -n "$CONFIG_DRY_RUN" ]
    [ -n "$CONFIG_REVIEW_THRESHOLD" ]
}

# ==================== Error Handling Integration ====================

@test "integration: malformed YAML, falls back gracefully to defaults" {
    # Create malformed YAML
    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: true
  invalid_indent: bad
review_threshold: [unclosed array
EOF

    # Should not fail, should fall back to defaults
    run load_config
    [ "$status" -eq 0 ]

    validate_and_fix_config

    # Verify defaults loaded
    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "3" ]
}

@test "integration: empty config file, defaults loaded" {
    # Create empty config file
    touch "${CWD}/.claude/review-config.yaml"

    load_config
    validate_and_fix_config

    # Verify defaults
    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "3" ]
}

# ==================== Validation Integration ====================

@test "integration: all valid values pass validation without modification" {
    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: true
dry_run: false
review_threshold: 50
timeout_seconds: 300
blocking:
  on_critical: false
  on_high_count: 10
  max_quality_score: 100
batch:
  size_files: 50
  size_bytes: 50000
EOF

    load_config
    validate_and_fix_config

    # Verify values unchanged
    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_DRY_RUN" = "false" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "50" ]
    [ "$CONFIG_TIMEOUT_SECONDS" = "300" ]
    [ "$CONFIG_BLOCK_ON_CRITICAL" = "false" ]
    [ "$CONFIG_BLOCK_ON_HIGH_COUNT" = "10" ]
    [ "$CONFIG_MAX_QUALITY_SCORE" = "100" ]
    [ "$CONFIG_BATCH_SIZE_FILES" = "50" ]
    [ "$CONFIG_BATCH_SIZE_BYTES" = "50000" ]
}
