#!/usr/bin/env bats
# Integration tests for Unit 3: Review Execution & Subagent
#
# Tests cover:
# - End-to-end artifact aggregation workflow
# - User prompt integration with hook workflow
# - Configuration integration (batch sizes, timeout)
# - Integration between review-executor and user-interaction modules

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

    # Set up mock config variables
    export CONFIG_BATCH_SIZE_FILES=20
    export CONFIG_BATCH_SIZE_BYTES=25600
    export CONFIG_TIMEOUT_SECONDS=2

    # Source both modules under test
    source "${LIB_DIR}/review-executor.sh"
    source "${LIB_DIR}/user-interaction.sh"

    # Create test artifacts directory structure
    mkdir -p "${CWD}/aidlc-docs/construction/integration-test-unit/functional-design"
    mkdir -p "${CWD}/aidlc-docs/construction/integration-test-unit/nfr-requirements"
    mkdir -p "${CWD}/aidlc-docs/construction/integration-test-unit/nfr-design"
}

# Teardown: Clean up test fixtures
teardown() {
    rm -rf "${CWD}/aidlc-docs"
}

# ==================== End-to-End Artifact Aggregation ====================

@test "integration: complete artifact aggregation workflow" {
    # Create realistic design artifacts
    cat > "${CWD}/aidlc-docs/construction/integration-test-unit/functional-design/business-logic.md" <<EOF
# Business Logic Model

## Overview
This unit implements configuration management with YAML parsing.

## Key Components
1. Config Parser
2. Default Values
3. Validation Logic
EOF

    cat > "${CWD}/aidlc-docs/construction/integration-test-unit/nfr-requirements/nfr-requirements.md" <<EOF
# Non-Functional Requirements

## Performance
- Parse YAML in < 100ms

## Reliability
- Fail-open design (never block user)
EOF

    # Execute complete workflow
    run aggregate_artifacts "integration-test-unit"

    [ "$status" -eq 0 ]
    [ ${#DISCOVERED_ARTIFACTS[@]} -eq 2 ]
    [ "$BATCH_COUNT" -eq 1 ]
    [[ "$AGGREGATED_CONTENT" =~ "Business Logic Model" ]]
    [[ "$AGGREGATED_CONTENT" =~ "Non-Functional Requirements" ]]
}

@test "integration: subagent instructions generation with aggregated content" {
    # Create test artifact
    echo "Test design content" > "${CWD}/aidlc-docs/construction/integration-test-unit/functional-design/test.md"

    # Execute aggregation
    aggregate_artifacts "integration-test-unit"

    # Generate subagent instructions
    instructions=$(generate_subagent_instructions "integration-test-unit" "$AGGREGATED_CONTENT")

    [[ "$instructions" =~ "integration-test-unit" ]]
    [[ "$instructions" =~ "Test design content" ]]
    [[ "$instructions" =~ "Design Review Task" ]]
}

# ==================== Configuration Integration ====================

@test "integration: batch size files threshold triggers batch aggregation" {
    # Set low threshold
    CONFIG_BATCH_SIZE_FILES=2

    # Create 3 files (exceeds threshold)
    echo "File 1" > "${CWD}/aidlc-docs/construction/integration-test-unit/functional-design/file1.md"
    echo "File 2" > "${CWD}/aidlc-docs/construction/integration-test-unit/functional-design/file2.md"
    echo "File 3" > "${CWD}/aidlc-docs/construction/integration-test-unit/functional-design/file3.md"

    aggregate_artifacts "integration-test-unit"

    [ "$BATCH_COUNT" -gt 1 ]
}

@test "integration: batch size bytes threshold triggers batch aggregation" {
    # Set low byte threshold
    CONFIG_BATCH_SIZE_BYTES=100

    # Create files that exceed byte threshold
    for i in {1..5}; do
        echo "This is a longer piece of content for file $i to exceed the byte threshold" > "${CWD}/aidlc-docs/construction/integration-test-unit/functional-design/file$i.md"
    done

    aggregate_artifacts "integration-test-unit"

    [ "$BATCH_COUNT" -gt 1 ]
}

@test "integration: timeout configuration affects user prompt" {
    CONFIG_TIMEOUT_SECONDS=1

    # Simulate timeout (no input provided)
    result=$(timeout 2 bash -c 'source '"${LIB_DIR}"'/user-interaction.sh; export CONFIG_TIMEOUT_SECONDS=1; prompt_initial_review' </dev/null)

    [ "$result" = "Y" ]
}

# ==================== User Interaction Integration ====================

@test "integration: user prompt accepts input and returns normalized response" {
    # Simulate user input 'yes'
    result=$(echo "yes" | prompt_initial_review)

    [ "$result" = "Y" ]
}

@test "integration: user prompt with 'no' returns N" {
    result=$(echo "no" | prompt_initial_review)

    [ "$result" = "N" ]
}

@test "integration: user prompt retries on invalid input then succeeds" {
    # Simulate invalid input followed by valid
    result=$(printf "invalid\\ny\\n" | prompt_initial_review)

    [ "$result" = "Y" ]
}

# ==================== Cross-Module Integration ====================

@test "integration: discover → calculate → aggregate → generate workflow" {
    # Create test artifacts
    echo "Design 1" > "${CWD}/aidlc-docs/construction/integration-test-unit/functional-design/design1.md"
    echo "Design 2" > "${CWD}/aidlc-docs/construction/integration-test-unit/nfr-requirements/design2.md"

    # Step 1: Discover
    discover_artifacts "integration-test-unit"
    [ ${#DISCOVERED_ARTIFACTS[@]} -eq 2 ]

    # Step 2: Calculate
    calculate_total_size
    [ "$TOTAL_SIZE_BYTES" -gt 0 ]

    # Step 3: Aggregate
    sequential_aggregation
    [ "$BATCH_COUNT" -eq 1 ]

    # Step 4: Generate
    instructions=$(generate_subagent_instructions "integration-test-unit" "$AGGREGATED_CONTENT")
    [[ "$instructions" =~ "Design 1" ]]
    [[ "$instructions" =~ "Design 2" ]]
}

# ==================== Error Handling Integration ====================

@test "integration: graceful handling of missing artifacts" {
    # Attempt to aggregate non-existent unit
    run aggregate_artifacts "nonexistent-unit"

    [ "$status" -eq 1 ]
    [ ${#DISCOVERED_ARTIFACTS[@]} -eq 0 ]
}

@test "integration: empty artifacts directory returns error" {
    # Create empty unit directory
    mkdir -p "${CWD}/aidlc-docs/construction/empty-unit"

    run aggregate_artifacts "empty-unit"

    [ "$status" -eq 1 ]
}
