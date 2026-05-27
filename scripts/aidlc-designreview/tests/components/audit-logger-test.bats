#!/usr/bin/env bats
# Unit tests for audit-logger.sh
#
# Tests cover:
# - log_audit_entry() audit logging to aidlc-docs/audit.md
# - format_audit_entry() markdown formatting
# - detect_bypass() bypass detection with marker files
# - create_review_marker() / remove_review_marker() marker file management

# Setup: Source the module and create test environment
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
    source "${LIB_DIR}/audit-logger.sh"

    # Create test directories
    mkdir -p "${CWD}/aidlc-docs"
    mkdir -p "${CWD}/.claude"
}

# Teardown: Clean up test fixtures
teardown() {
    rm -rf "${CWD}/aidlc-docs"
    rm -rf "${CWD}/.claude"
}

# ==================== log_audit_entry() Tests ====================

@test "log_audit_entry: creates audit file if missing" {
    rm -f "${CWD}/aidlc-docs/audit.md"

    log_audit_entry "Test Event" "Test description"

    [ -f "${CWD}/aidlc-docs/audit.md" ]
}

@test "log_audit_entry: appends entry to existing audit file" {
    echo "Existing content" > "${CWD}/aidlc-docs/audit.md"

    log_audit_entry "Test Event" "Test description"

    content=$(cat "${CWD}/aidlc-docs/audit.md")
    [[ "$content" =~ "Existing content" ]]
    [[ "$content" =~ "Test Event" ]]
}

@test "log_audit_entry: includes event name and description" {
    log_audit_entry "Review Started" "User initiated review for unit2"

    content=$(cat "${CWD}/aidlc-docs/audit.md")
    [[ "$content" =~ "Review Started" ]]
    [[ "$content" =~ "User initiated review for unit2" ]]
}

@test "log_audit_entry: returns 0 on success" {
    run log_audit_entry "Test Event" "Test description"

    [ "$status" -eq 0 ]
}

@test "log_audit_entry: creates aidlc-docs directory if missing" {
    rm -rf "${CWD}/aidlc-docs"

    log_audit_entry "Test Event" "Test description"

    [ -d "${CWD}/aidlc-docs" ]
    [ -f "${CWD}/aidlc-docs/audit.md" ]
}

# ==================== format_audit_entry() Tests ====================

@test "format_audit_entry: includes event name as header" {
    result=$(format_audit_entry "Test Event" "Description")

    [[ "$result" =~ "## Test Event" ]]
}

@test "format_audit_entry: includes timestamp" {
    result=$(format_audit_entry "Test Event" "Description")

    [[ "$result" =~ "**Timestamp**:" ]]
}

@test "format_audit_entry: includes event description" {
    result=$(format_audit_entry "Test Event" "Test description text")

    [[ "$result" =~ "Test description text" ]]
}

@test "format_audit_entry: uses ISO 8601 timestamp format" {
    result=$(format_audit_entry "Test Event" "Description")

    # Check for ISO 8601 pattern: YYYY-MM-DDTHH:MM:SSZ
    [[ "$result" =~ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z ]]
}

@test "format_audit_entry: includes markdown structure" {
    result=$(format_audit_entry "Test Event" "Description")

    [[ "$result" =~ "## Test Event" ]]
    [[ "$result" =~ "**Timestamp**:" ]]
    [[ "$result" =~ "**Event**:" ]]
    [[ "$result" =~ "**Description**:" ]]
    [[ "$result" =~ "---" ]]
}

# ==================== detect_bypass() Tests ====================

@test "detect_bypass: returns 0 when marker file exists" {
    # Create marker file
    echo "Marker" > "${CWD}/.claude/.review-in-progress"

    run detect_bypass

    [ "$status" -eq 0 ]
}

@test "detect_bypass: returns 0 when no artifacts exist (first review)" {
    # No marker file and no artifacts directory
    rm -rf "${CWD}/.claude/.review-in-progress"
    rm -rf "${CWD}/aidlc-docs/construction"

    run detect_bypass

    [ "$status" -eq 0 ]
}

@test "detect_bypass: prompts user when marker missing but artifacts exist" {
    # Remove marker file but create artifacts directory
    rm -f "${CWD}/.claude/.review-in-progress"
    mkdir -p "${CWD}/aidlc-docs/construction"

    # Simulate user confirmation (y)
    run bash -c "echo 'y' | source ${LIB_DIR}/audit-logger.sh; detect_bypass"

    [ "$status" -eq 0 ]
}

@test "detect_bypass: returns 1 when user denies bypass" {
    # Remove marker file but create artifacts directory
    rm -f "${CWD}/.claude/.review-in-progress"
    mkdir -p "${CWD}/aidlc-docs/construction"

    # Simulate user denial (n)
    run bash -c "echo 'n' | source ${LIB_DIR}/audit-logger.sh; detect_bypass"

    [ "$status" -eq 1 ]
}

# ==================== create_review_marker() Tests ====================

@test "create_review_marker: creates marker file" {
    create_review_marker "test-unit"

    [ -f "${CWD}/.claude/.review-in-progress" ]
}

@test "create_review_marker: includes unit name in marker" {
    create_review_marker "test-unit"

    content=$(cat "${CWD}/.claude/.review-in-progress")
    [[ "$content" =~ "test-unit" ]]
}

@test "create_review_marker: includes timestamp in marker" {
    create_review_marker "test-unit"

    content=$(cat "${CWD}/.claude/.review-in-progress")
    [[ "$content" =~ "Started:" ]]
}

@test "create_review_marker: creates .claude directory if missing" {
    rm -rf "${CWD}/.claude"

    create_review_marker "test-unit"

    [ -d "${CWD}/.claude" ]
    [ -f "${CWD}/.claude/.review-in-progress" ]
}

# ==================== remove_review_marker() Tests ====================

@test "remove_review_marker: removes marker file" {
    echo "Marker" > "${CWD}/.claude/.review-in-progress"

    remove_review_marker

    [ ! -f "${CWD}/.claude/.review-in-progress" ]
}

@test "remove_review_marker: succeeds when marker file missing" {
    rm -f "${CWD}/.claude/.review-in-progress"

    run remove_review_marker

    [ "$status" -eq 0 ]
}

@test "remove_review_marker: always returns 0" {
    run remove_review_marker

    [ "$status" -eq 0 ]
}
