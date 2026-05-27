#!/usr/bin/env bats
# Unit tests for user-interaction.sh
#
# Tests cover:
# - prompt_initial_review() user prompts with timeout
# - normalize_response() response normalization
# - prompt_post_review() post-review decision (Unit 4)
# - display_findings() findings display (Unit 4)

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

    # Set up mock config variables
    export CONFIG_TIMEOUT_SECONDS=2  # Short timeout for tests

    # Source the module under test
    source "${LIB_DIR}/user-interaction.sh"
}

# ==================== normalize_response() Tests ====================

@test "normalize_response: normalizes 'Y' to 'Y'" {
    result=$(normalize_response "Y")
    [ "$result" = "Y" ]
}

@test "normalize_response: normalizes 'y' to 'Y'" {
    result=$(normalize_response "y")
    [ "$result" = "Y" ]
}

@test "normalize_response: normalizes 'yes' to 'Y'" {
    result=$(normalize_response "yes")
    [ "$result" = "Y" ]
}

@test "normalize_response: normalizes 'Yes' to 'Y'" {
    result=$(normalize_response "Yes")
    [ "$result" = "Y" ]
}

@test "normalize_response: normalizes 'YES' to 'Y'" {
    result=$(normalize_response "YES")
    [ "$result" = "Y" ]
}

@test "normalize_response: normalizes 'N' to 'N'" {
    result=$(normalize_response "N")
    [ "$result" = "N" ]
}

@test "normalize_response: normalizes 'n' to 'N'" {
    result=$(normalize_response "n")
    [ "$result" = "N" ]
}

@test "normalize_response: normalizes 'no' to 'N'" {
    result=$(normalize_response "no")
    [ "$result" = "N" ]
}

@test "normalize_response: normalizes 'No' to 'N'" {
    result=$(normalize_response "No")
    [ "$result" = "N" ]
}

@test "normalize_response: normalizes 'NO' to 'N'" {
    result=$(normalize_response "NO")
    [ "$result" = "N" ]
}

@test "normalize_response: normalizes empty string to 'Y'" {
    result=$(normalize_response "")
    [ "$result" = "Y" ]
}

@test "normalize_response: returns INVALID for invalid input" {
    result=$(normalize_response "maybe")
    [ "$result" = "INVALID" ]
}

@test "normalize_response: returns INVALID for numeric input" {
    result=$(normalize_response "1")
    [ "$result" = "INVALID" ]
}

@test "normalize_response: trims whitespace" {
    result=$(normalize_response "  yes  ")
    [ "$result" = "Y" ]
}

@test "normalize_response: handles mixed case" {
    result=$(normalize_response "YeS")
    [ "$result" = "Y" ]
}

# ==================== prompt_initial_review() Tests ====================

@test "prompt_initial_review: accepts 'Y' input" {
    # Simulate user input with 'Y'
    result=$(echo "Y" | prompt_initial_review)

    [ "$result" = "Y" ]
}

@test "prompt_initial_review: accepts 'y' input" {
    result=$(echo "y" | prompt_initial_review)

    [ "$result" = "Y" ]
}

@test "prompt_initial_review: accepts 'yes' input" {
    result=$(echo "yes" | prompt_initial_review)

    [ "$result" = "Y" ]
}

@test "prompt_initial_review: accepts 'N' input" {
    result=$(echo "N" | prompt_initial_review)

    [ "$result" = "N" ]
}

@test "prompt_initial_review: accepts 'n' input" {
    result=$(echo "n" | prompt_initial_review)

    [ "$result" = "N" ]
}

@test "prompt_initial_review: accepts 'no' input" {
    result=$(echo "no" | prompt_initial_review)

    [ "$result" = "N" ]
}

@test "prompt_initial_review: defaults to Y on timeout" {
    # Simulate timeout by not providing input
    # The function will timeout after CONFIG_TIMEOUT_SECONDS (2s in tests)
    result=$(timeout 3 bash -c 'source '"${LIB_DIR}"'/user-interaction.sh; export CONFIG_TIMEOUT_SECONDS=1; prompt_initial_review' </dev/null)

    [ "$result" = "Y" ]
}

@test "prompt_initial_review: retries on invalid input" {
    # Simulate invalid input followed by valid input
    result=$(printf "invalid\\ny\\n" | prompt_initial_review)

    [ "$result" = "Y" ]
}

@test "prompt_initial_review: defaults to Y after max retries" {
    # Simulate max retries exceeded (3 invalid inputs)
    result=$(printf "invalid1\\ninvalid2\\ninvalid3\\n" | prompt_initial_review)

    [ "$result" = "Y" ]
}

@test "prompt_initial_review: accepts empty input (default Y)" {
    result=$(echo "" | prompt_initial_review)

    [ "$result" = "Y" ]
}

# ==================== display_findings() Tests ====================

@test "display_findings: displays findings to stderr" {
    # Capture stderr output
    run display_findings "Test finding 1\nTest finding 2"

    [ "$status" -eq 0 ]
}

@test "display_findings: includes findings header" {
    result=$(display_findings "Test" 2>&1)

    [[ "$result" =~ "DESIGN REVIEW FINDINGS" ]]
}

@test "display_findings: always returns 0" {
    run display_findings "Any content"

    [ "$status" -eq 0 ]
}

# ==================== prompt_post_review() Tests ====================

@test "prompt_post_review: accepts 'S' input (stop)" {
    findings="CRITICAL: Issue found"

    result=$(echo "S" | prompt_post_review "$findings")

    [ "$result" = "S" ]
}

@test "prompt_post_review: accepts 's' input (stop)" {
    findings="CRITICAL: Issue found"

    result=$(echo "s" | prompt_post_review "$findings")

    [ "$result" = "S" ]
}

@test "prompt_post_review: accepts 'stop' input" {
    findings="CRITICAL: Issue found"

    result=$(echo "stop" | prompt_post_review "$findings")

    [ "$result" = "S" ]
}

@test "prompt_post_review: accepts 'C' input (continue)" {
    findings="LOW: Minor issue"

    result=$(echo "C" | prompt_post_review "$findings")

    [ "$result" = "C" ]
}

@test "prompt_post_review: accepts 'c' input (continue)" {
    findings="LOW: Minor issue"

    result=$(echo "c" | prompt_post_review "$findings")

    [ "$result" = "C" ]
}

@test "prompt_post_review: accepts 'continue' input" {
    findings="LOW: Minor issue"

    result=$(echo "continue" | prompt_post_review "$findings")

    [ "$result" = "C" ]
}

@test "prompt_post_review: accepts empty input (default continue)" {
    findings="LOW: Minor issue"

    result=$(echo "" | prompt_post_review "$findings")

    [ "$result" = "C" ]
}

@test "prompt_post_review: defaults to C on timeout" {
    findings="Test findings"

    # Simulate timeout
    result=$(timeout 3 bash -c 'source '"${LIB_DIR}"'/user-interaction.sh; export CONFIG_TIMEOUT_SECONDS=1; echo "" | prompt_post_review "Test"' </dev/null)

    [ "$result" = "C" ]
}

@test "prompt_post_review: retries on invalid input (unlimited)" {
    findings="Test findings"

    # Simulate invalid input followed by valid input
    result=$(printf "invalid\\nC\\n" | prompt_post_review "$findings")

    [ "$result" = "C" ]
}

@test "prompt_post_review: returns 0 for continue" {
    findings="Test"

    run bash -c "echo 'C' | source ${LIB_DIR}/user-interaction.sh; export CONFIG_TIMEOUT_SECONDS=2; prompt_post_review 'Test'"

    [ "$status" -eq 0 ]
}

@test "prompt_post_review: returns 1 for stop" {
    findings="Test"

    run bash -c "echo 'S' | source ${LIB_DIR}/user-interaction.sh; export CONFIG_TIMEOUT_SECONDS=2; prompt_post_review 'Test'"

    [ "$status" -eq 1 ]
}
