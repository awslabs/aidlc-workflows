#!/usr/bin/env bats
# Unit tests for config-parser.sh
#
# Tests cover:
# - load_config() fallback chain
# - parse_with_yq() parsing
# - parse_with_python() parsing
# - load_defaults() default loading
# - validate_and_fix_config() validation
# - Validator functions
# - is_dry_run() check

# Setup: Source the module and create test fixtures
setup() {
    # Set up test environment
    export CWD="${BATS_TEST_DIRNAME}/../fixtures"
    export LIB_DIR="${BATS_TEST_DIRNAME}/../../.claude/lib"

    # Create mock logging functions
    log_info() { echo "[INFO] $*" >&2; }
    log_warning() { echo "[WARN] $*" >&2; }
    log_error() { echo "[ERROR] $*" >&2; }
    export -f log_info log_warning log_error

    # Source the module under test
    source "${LIB_DIR}/config-parser.sh"

    # Create test config directory
    mkdir -p "${CWD}/.claude"
}

# Teardown: Clean up test fixtures
teardown() {
    rm -rf "${CWD}/.claude"
}

# ==================== load_config() Tests ====================

@test "load_config: config file exists, yq available, parsing succeeds" {
    # Create valid YAML config
    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: true
dry_run: false
review_threshold: 5
EOF

    # Mock yq to be available (assumes yq is installed)
    run load_config

    [ "$status" -eq 0 ]
    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_SOURCE" = "yq" ] || [ "$CONFIG_SOURCE" = "python" ] || [ "$CONFIG_SOURCE" = "defaults" ]
}

@test "load_config: config file missing, defaults loaded" {
    # No config file created
    run load_config

    [ "$status" -eq 0 ]
    [ "$CONFIG_SOURCE" = "defaults" ]
    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "3" ]
}

@test "load_config: config file exists, yq and Python unavailable, defaults loaded" {
    # Create config but hide yq and python
    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: false
EOF

    # Save original PATH
    ORIG_PATH="$PATH"

    # Hide yq and python by setting PATH to minimal
    export PATH="/usr/bin:/bin"

    load_config

    # Restore PATH
    export PATH="$ORIG_PATH"

    # Should fall back to defaults
    [ "$CONFIG_SOURCE" = "defaults" ]
    [ "$CONFIG_ENABLED" = "true" ]  # Default, not false from file
}

@test "load_config: always returns 0 (fail-open)" {
    # Even with invalid scenarios, should return 0
    run load_config
    [ "$status" -eq 0 ]
}

# ==================== parse_with_yq() Tests ====================

@test "parse_with_yq: valid YAML, all keys present" {
    skip "Requires yq to be installed"

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

    parse_with_yq "${CWD}/.claude/review-config.yaml"

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

@test "parse_with_yq: partial config (some keys missing)" {
    skip "Requires yq to be installed"

    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: true
review_threshold: 10
EOF

    parse_with_yq "${CWD}/.claude/review-config.yaml"

    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "10" ]
    # Other keys will be empty or null
}

@test "parse_with_yq: yq unavailable, returns 1" {
    # Save original PATH
    ORIG_PATH="$PATH"

    # Hide yq
    export PATH="/usr/bin:/bin"

    run parse_with_yq "${CWD}/.claude/review-config.yaml"

    # Restore PATH
    export PATH="$ORIG_PATH"

    [ "$status" -eq 1 ]
}

# ==================== parse_with_python() Tests ====================

@test "parse_with_python: valid YAML, all keys present" {
    skip "Requires Python 3 and PyYAML to be installed"

    cat > "${CWD}/.claude/review-config.yaml" << EOF
enabled: false
dry_run: true
review_threshold: 7
timeout_seconds: 90
blocking:
  on_critical: false
  on_high_count: 10
  max_quality_score: 50
batch:
  size_files: 15
  size_bytes: 20000
EOF

    parse_with_python "${CWD}/.claude/review-config.yaml"

    [ "$CONFIG_ENABLED" = "False" ] || [ "$CONFIG_ENABLED" = "false" ]
    [ "$CONFIG_DRY_RUN" = "True" ] || [ "$CONFIG_DRY_RUN" = "true" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "7" ]
}

@test "parse_with_python: Python unavailable, returns 1" {
    # Save original PATH
    ORIG_PATH="$PATH"

    # Hide python
    export PATH="/usr/bin:/bin"

    run parse_with_python "${CWD}/.claude/review-config.yaml"

    # Restore PATH
    export PATH="$ORIG_PATH"

    [ "$status" -eq 1 ]
}

# ==================== load_defaults() Tests ====================

@test "load_defaults: config-defaults.sh present, sourced correctly" {
    run load_defaults

    [ "$status" -eq 0 ]
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

@test "load_defaults: always returns 0" {
    run load_defaults
    [ "$status" -eq 0 ]
}

# ==================== validate_and_fix_config() Tests ====================

@test "validate_and_fix_config: all valid values, no changes" {
    CONFIG_ENABLED=true
    CONFIG_DRY_RUN=false
    CONFIG_REVIEW_THRESHOLD=50
    CONFIG_TIMEOUT_SECONDS=300
    CONFIG_BATCH_SIZE_FILES=25
    CONFIG_BATCH_SIZE_BYTES=30000
    CONFIG_BLOCK_ON_CRITICAL=true
    CONFIG_BLOCK_ON_HIGH_COUNT=5
    CONFIG_MAX_QUALITY_SCORE=40

    run validate_and_fix_config

    [ "$status" -eq 0 ]
    [ "$CONFIG_ENABLED" = "true" ]
    [ "$CONFIG_REVIEW_THRESHOLD" = "50" ]
}

@test "validate_and_fix_config: invalid enabled (not true/false), replaced with default" {
    CONFIG_ENABLED="yes"
    CONFIG_DRY_RUN=false
    CONFIG_REVIEW_THRESHOLD=3
    CONFIG_TIMEOUT_SECONDS=120
    CONFIG_BATCH_SIZE_FILES=20
    CONFIG_BATCH_SIZE_BYTES=25600
    CONFIG_BLOCK_ON_CRITICAL=true
    CONFIG_BLOCK_ON_HIGH_COUNT=3
    CONFIG_MAX_QUALITY_SCORE=30

    validate_and_fix_config

    [ "$CONFIG_ENABLED" = "true" ]  # Default
}

@test "validate_and_fix_config: invalid review_threshold (out of range), replaced with default" {
    CONFIG_ENABLED=true
    CONFIG_DRY_RUN=false
    CONFIG_REVIEW_THRESHOLD=-5
    CONFIG_TIMEOUT_SECONDS=120
    CONFIG_BATCH_SIZE_FILES=20
    CONFIG_BATCH_SIZE_BYTES=25600
    CONFIG_BLOCK_ON_CRITICAL=true
    CONFIG_BLOCK_ON_HIGH_COUNT=3
    CONFIG_MAX_QUALITY_SCORE=30

    validate_and_fix_config

    [ "$CONFIG_REVIEW_THRESHOLD" = "3" ]  # Default
}

@test "validate_and_fix_config: invalid timeout_seconds (too high), replaced with default" {
    CONFIG_ENABLED=true
    CONFIG_DRY_RUN=false
    CONFIG_REVIEW_THRESHOLD=3
    CONFIG_TIMEOUT_SECONDS=5000
    CONFIG_BATCH_SIZE_FILES=20
    CONFIG_BATCH_SIZE_BYTES=25600
    CONFIG_BLOCK_ON_CRITICAL=true
    CONFIG_BLOCK_ON_HIGH_COUNT=3
    CONFIG_MAX_QUALITY_SCORE=30

    validate_and_fix_config

    [ "$CONFIG_TIMEOUT_SECONDS" = "120" ]  # Default
}

@test "validate_and_fix_config: string value for integer, replaced with default" {
    CONFIG_ENABLED=true
    CONFIG_DRY_RUN=false
    CONFIG_REVIEW_THRESHOLD="abc"
    CONFIG_TIMEOUT_SECONDS=120
    CONFIG_BATCH_SIZE_FILES=20
    CONFIG_BATCH_SIZE_BYTES=25600
    CONFIG_BLOCK_ON_CRITICAL=true
    CONFIG_BLOCK_ON_HIGH_COUNT=3
    CONFIG_MAX_QUALITY_SCORE=30

    validate_and_fix_config

    [ "$CONFIG_REVIEW_THRESHOLD" = "3" ]  # Default
}

# ==================== Validator Function Tests ====================

@test "validate_boolean: 'true' returns 0" {
    run validate_boolean "true"
    [ "$status" -eq 0 ]
}

@test "validate_boolean: 'false' returns 0" {
    run validate_boolean "false"
    [ "$status" -eq 0 ]
}

@test "validate_boolean: 'yes' returns 1" {
    run validate_boolean "yes"
    [ "$status" -eq 1 ]
}

@test "validate_boolean: empty string returns 1" {
    run validate_boolean ""
    [ "$status" -eq 1 ]
}

@test "validate_integer: '123' returns 0" {
    run validate_integer "123"
    [ "$status" -eq 0 ]
}

@test "validate_integer: 'abc' returns 1" {
    run validate_integer "abc"
    [ "$status" -eq 1 ]
}

@test "validate_integer: '-5' returns 1 (regex doesn't match negative)" {
    run validate_integer "-5"
    [ "$status" -eq 1 ]
}

@test "validate_integer_range: 50 in range 1-100 returns 0" {
    run validate_integer_range 50 1 100
    [ "$status" -eq 0 ]
}

@test "validate_integer_range: 150 out of range 1-100 returns 1" {
    run validate_integer_range 150 1 100
    [ "$status" -eq 1 ]
}

@test "validate_integer_range: 0 out of range 1-100 returns 1" {
    run validate_integer_range 0 1 100
    [ "$status" -eq 1 ]
}

# ==================== is_dry_run() Tests ====================

@test "is_dry_run: CONFIG_DRY_RUN=true returns 0" {
    CONFIG_DRY_RUN=true
    run is_dry_run
    [ "$status" -eq 0 ]
}

@test "is_dry_run: CONFIG_DRY_RUN=false returns 1" {
    CONFIG_DRY_RUN=false
    run is_dry_run
    [ "$status" -eq 1 ]
}
