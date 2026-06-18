#!/usr/bin/env bats
# Unit tests for review-executor.sh
#
# Tests cover:
# - discover_artifacts() artifact discovery with glob patterns
# - calculate_total_size() size calculation
# - sequential_aggregation() content aggregation for small datasets
# - batch_aggregation() batched aggregation for large datasets
# - sanitize_content() delimiter collision prevention
# - generate_subagent_instructions() template generation

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

    # Set up mock config variables for batching
    export CONFIG_BATCH_SIZE_FILES=3
    export CONFIG_BATCH_SIZE_BYTES=1000

    # Source the module under test
    source "${LIB_DIR}/review-executor.sh"

    # Create test artifacts directory structure
    mkdir -p "${CWD}/aidlc-docs/construction/test-unit/functional-design"
    mkdir -p "${CWD}/aidlc-docs/construction/test-unit/nfr-requirements"
    mkdir -p "${CWD}/aidlc-docs/construction/test-unit/plans"
}

# Teardown: Clean up test fixtures
teardown() {
    rm -rf "${CWD}/aidlc-docs"
}

# ==================== discover_artifacts() Tests ====================

@test "discover_artifacts: finds markdown files in unit directory" {
    # Create test artifacts
    echo "Design content 1" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/design1.md"
    echo "Design content 2" > "${CWD}/aidlc-docs/construction/test-unit/nfr-requirements/nfr1.md"

    run discover_artifacts "test-unit"

    [ "$status" -eq 0 ]
    [ ${#DISCOVERED_ARTIFACTS[@]} -eq 2 ]
}

@test "discover_artifacts: excludes plans/ subdirectory" {
    # Create test artifacts including plans
    echo "Design content" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/design1.md"
    echo "Plan content" > "${CWD}/aidlc-docs/construction/test-unit/plans/plan1.md"

    discover_artifacts "test-unit"

    # Should find only design1.md, not plan1.md
    [ ${#DISCOVERED_ARTIFACTS[@]} -eq 1 ]
    [[ "${DISCOVERED_ARTIFACTS[0]}" =~ design1.md ]]
    [[ ! "${DISCOVERED_ARTIFACTS[0]}" =~ plans ]]
}

@test "discover_artifacts: returns 1 when unit directory missing" {
    run discover_artifacts "nonexistent-unit"

    [ "$status" -eq 1 ]
    [ ${#DISCOVERED_ARTIFACTS[@]} -eq 0 ]
}

@test "discover_artifacts: returns 1 when no markdown files found" {
    # Create unit directory but no markdown files
    mkdir -p "${CWD}/aidlc-docs/construction/test-unit/functional-design"

    run discover_artifacts "test-unit"

    [ "$status" -eq 1 ]
    [ ${#DISCOVERED_ARTIFACTS[@]} -eq 0 ]
}

@test "discover_artifacts: handles nested subdirectories" {
    # Create nested structure
    mkdir -p "${CWD}/aidlc-docs/construction/test-unit/functional-design/subsection"
    echo "Nested design" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/subsection/nested.md"
    echo "Top level design" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/top.md"

    discover_artifacts "test-unit"

    [ ${#DISCOVERED_ARTIFACTS[@]} -eq 2 ]
}

# ==================== calculate_total_size() Tests ====================

@test "calculate_total_size: calculates total size of discovered artifacts" {
    # Create test artifacts with known sizes
    echo "12345" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file1.md"  # 6 bytes (includes newline)
    echo "67890" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file2.md"  # 6 bytes

    discover_artifacts "test-unit"
    calculate_total_size

    [ "$TOTAL_SIZE_BYTES" -eq 12 ]
}

@test "calculate_total_size: returns 0 for empty artifact list" {
    DISCOVERED_ARTIFACTS=()

    calculate_total_size

    [ "$TOTAL_SIZE_BYTES" -eq 0 ]
}

@test "calculate_total_size: handles missing files gracefully" {
    DISCOVERED_ARTIFACTS=("${CWD}/nonexistent.md")

    calculate_total_size

    [ "$TOTAL_SIZE_BYTES" -eq 0 ]
}

# ==================== aggregate_artifacts() Tests ====================

@test "aggregate_artifacts: dispatches to sequential for small dataset" {
    # Create small artifacts (under batch thresholds)
    echo "Small content 1" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/small1.md"
    echo "Small content 2" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/small2.md"

    run aggregate_artifacts "test-unit"

    [ "$status" -eq 0 ]
    [ "$BATCH_COUNT" -eq 1 ]
    [[ "$AGGREGATED_CONTENT" =~ "Small content 1" ]]
    [[ "$AGGREGATED_CONTENT" =~ "Small content 2" ]]
}

@test "aggregate_artifacts: dispatches to batch for large dataset" {
    # Create artifacts that exceed CONFIG_BATCH_SIZE_FILES (3 files)
    echo "File 1" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file1.md"
    echo "File 2" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file2.md"
    echo "File 3" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file3.md"
    echo "File 4" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file4.md"

    run aggregate_artifacts "test-unit"

    [ "$status" -eq 0 ]
    [ "$BATCH_COUNT" -gt 1 ]
}

@test "aggregate_artifacts: returns 1 when no artifacts found" {
    run aggregate_artifacts "nonexistent-unit"

    [ "$status" -eq 1 ]
}

# ==================== sequential_aggregation() Tests ====================

@test "sequential_aggregation: concatenates all artifacts with delimiters" {
    echo "Content A" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/fileA.md"
    echo "Content B" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/fileB.md"

    discover_artifacts "test-unit"
    sequential_aggregation

    [ "$BATCH_COUNT" -eq 1 ]
    [[ "$AGGREGATED_CONTENT" =~ "--- FILE:" ]]
    [[ "$AGGREGATED_CONTENT" =~ "--- END FILE ---" ]]
    [[ "$AGGREGATED_CONTENT" =~ "Content A" ]]
    [[ "$AGGREGATED_CONTENT" =~ "Content B" ]]
}

@test "sequential_aggregation: includes relative file paths" {
    echo "Test content" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/test.md"

    discover_artifacts "test-unit"
    sequential_aggregation

    [[ "$AGGREGATED_CONTENT" =~ "aidlc-docs/construction/test-unit/functional-design/test.md" ]]
}

@test "sequential_aggregation: handles empty files" {
    touch "${CWD}/aidlc-docs/construction/test-unit/functional-design/empty.md"

    discover_artifacts "test-unit"
    sequential_aggregation

    [ "$BATCH_COUNT" -eq 1 ]
    [[ "$AGGREGATED_CONTENT" =~ "--- FILE:" ]]
}

# ==================== batch_aggregation() Tests ====================

@test "batch_aggregation: splits into batches when exceeding file limit" {
    # Create 5 files (exceeds CONFIG_BATCH_SIZE_FILES=3)
    for i in {1..5}; do
        echo "Content $i" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file$i.md"
    done

    discover_artifacts "test-unit"
    batch_aggregation

    [ "$BATCH_COUNT" -ge 2 ]
}

@test "batch_aggregation: splits into batches when exceeding byte limit" {
    # Create files that exceed CONFIG_BATCH_SIZE_BYTES=1000
    # Each file is ~50 bytes, so 25 files = ~1250 bytes
    for i in {1..25}; do
        echo "This is content for file number $i and it has text" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file$i.md"
    done

    discover_artifacts "test-unit"
    batch_aggregation

    [ "$BATCH_COUNT" -ge 2 ]
}

@test "batch_aggregation: first batch stored in AGGREGATED_CONTENT" {
    # Create files
    echo "First batch content 1" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file1.md"
    echo "First batch content 2" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file2.md"
    echo "First batch content 3" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file3.md"
    echo "Second batch content" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file4.md"

    discover_artifacts "test-unit"
    batch_aggregation

    [[ "$AGGREGATED_CONTENT" =~ "First batch content" ]]
    [[ ! "$AGGREGATED_CONTENT" =~ "Second batch content" ]]
}

@test "batch_aggregation: handles single file per batch" {
    # Set very small batch limits
    CONFIG_BATCH_SIZE_FILES=1
    CONFIG_BATCH_SIZE_BYTES=50

    echo "File 1" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file1.md"
    echo "File 2" > "${CWD}/aidlc-docs/construction/test-unit/functional-design/file2.md"

    discover_artifacts "test-unit"
    batch_aggregation

    [ "$BATCH_COUNT" -eq 2 ]
}

# ==================== sanitize_content() Tests ====================

@test "sanitize_content: escapes delimiter patterns" {
    local input="This has --- FILE: pattern"

    result=$(sanitize_content "$input")

    [[ "$result" =~ "\-\-\- FILE:" ]]
    [[ ! "$result" =~ "--- FILE:" ]]
}

@test "sanitize_content: escapes end delimiter patterns" {
    local input="This has --- END FILE --- pattern"

    result=$(sanitize_content "$input")

    [[ "$result" =~ "\-\-\- END FILE \-\-\-" ]]
    [[ ! "$result" =~ "--- END FILE ---" ]]
}

@test "sanitize_content: preserves regular content" {
    local input="This is regular content without special patterns"

    result=$(sanitize_content "$input")

    [ "$result" = "$input" ]
}

@test "sanitize_content: handles empty input" {
    local input=""

    result=$(sanitize_content "$input")

    [ "$result" = "" ]
}

# ==================== generate_subagent_instructions() Tests ====================

@test "generate_subagent_instructions: includes unit name" {
    result=$(generate_subagent_instructions "test-unit" "Sample content")

    [[ "$result" =~ "test-unit" ]]
}

@test "generate_subagent_instructions: includes aggregated content" {
    result=$(generate_subagent_instructions "test-unit" "My aggregated design artifacts")

    [[ "$result" =~ "My aggregated design artifacts" ]]
}

@test "generate_subagent_instructions: includes severity levels" {
    result=$(generate_subagent_instructions "test-unit" "Content")

    [[ "$result" =~ "CRITICAL" ]]
    [[ "$result" =~ "HIGH" ]]
    [[ "$result" =~ "MEDIUM" ]]
    [[ "$result" =~ "LOW" ]]
}

@test "generate_subagent_instructions: includes output format guidance" {
    result=$(generate_subagent_instructions "test-unit" "Content")

    [[ "$result" =~ "Output Format" ]]
    [[ "$result" =~ "Quality Score" ]]
}

@test "generate_subagent_instructions: includes example finding" {
    result=$(generate_subagent_instructions "test-unit" "Content")

    [[ "$result" =~ "Example:" ]]
    [[ "$result" =~ "Issue:" ]]
    [[ "$result" =~ "Impact:" ]]
    [[ "$result" =~ "Recommendation:" ]]
}
