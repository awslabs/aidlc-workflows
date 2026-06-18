#!/usr/bin/env bats
# Unit tests for report-generator.sh
#
# Tests cover:
# - parse_response() regex extraction from AI responses
# - format_findings() findings formatting with top-5 logic
# - calculate_quality_label() quality label calculation
# - generate_report() report generation end-to-end

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
    source "${LIB_DIR}/report-generator.sh"

    # Create test directories
    mkdir -p "${CWD}/reports/design_review"
    mkdir -p "${LIB_DIR}/../templates"
}

# Teardown: Clean up test fixtures
teardown() {
    rm -rf "${CWD}/reports"
    rm -rf "${LIB_DIR}/../templates"
}

# ==================== parse_response() Tests ====================

@test "parse_response: extracts critical findings" {
    response="CRITICAL: Missing error handling
CRITICAL: Security vulnerability"

    parse_response "$response"

    [ ${#FINDINGS_CRITICAL[@]} -eq 2 ]
    [[ "${FINDINGS_CRITICAL[0]}" =~ "Missing error handling" ]]
    [[ "${FINDINGS_CRITICAL[1]}" =~ "Security vulnerability" ]]
}

@test "parse_response: extracts high findings with HIGH keyword" {
    response="HIGH: Performance concern
HIGH: Scalability issue"

    parse_response "$response"

    [ ${#FINDINGS_HIGH[@]} -eq 2 ]
}

@test "parse_response: extracts high findings with WARNING keyword (backwards compat)" {
    response="WARNING: Performance concern
WARNING: Scalability issue"

    parse_response "$response"

    [ ${#FINDINGS_HIGH[@]} -eq 2 ]
}

@test "parse_response: extracts medium findings" {
    response="MEDIUM: Code style issue
MEDIUM: Documentation gap"

    parse_response "$response"

    [ ${#FINDINGS_MEDIUM[@]} -eq 2 ]
}

@test "parse_response: extracts low findings" {
    response="LOW: Minor typo
LOW: Formatting inconsistency"

    parse_response "$response"

    [ ${#FINDINGS_LOW[@]} -eq 2 ]
}

@test "parse_response: extracts quality score" {
    response="Quality Score: 42"

    parse_response "$response"

    [ "$QUALITY_SCORE" -eq 42 ]
}

@test "parse_response: handles missing quality score" {
    response="CRITICAL: Issue"

    parse_response "$response"

    [ "$QUALITY_SCORE" -eq 0 ]
}

@test "parse_response: handles no findings" {
    response="No issues found."

    parse_response "$response"

    [ ${#FINDINGS_CRITICAL[@]} -eq 0 ]
    [ ${#FINDINGS_HIGH[@]} -eq 0 ]
    [ ${#FINDINGS_MEDIUM[@]} -eq 0 ]
    [ ${#FINDINGS_LOW[@]} -eq 0 ]
}

@test "parse_response: handles mixed severity findings" {
    response="CRITICAL: Critical issue
HIGH: High issue
MEDIUM: Medium issue
LOW: Low issue
Quality Score: 15"

    parse_response "$response"

    [ ${#FINDINGS_CRITICAL[@]} -eq 1 ]
    [ ${#FINDINGS_HIGH[@]} -eq 1 ]
    [ ${#FINDINGS_MEDIUM[@]} -eq 1 ]
    [ ${#FINDINGS_LOW[@]} -eq 1 ]
    [ "$QUALITY_SCORE" -eq 15 ]
}

# ==================== format_findings() Tests ====================

@test "format_findings: formats critical findings" {
    FINDINGS_CRITICAL=("Issue 1" "Issue 2")
    FINDINGS_HIGH=()
    FINDINGS_MEDIUM=()
    FINDINGS_LOW=()

    result=$(format_findings)

    [[ "$result" =~ "Critical Findings (2)" ]]
    [[ "$result" =~ "Issue 1" ]]
    [[ "$result" =~ "Issue 2" ]]
}

@test "format_findings: formats all severity levels" {
    FINDINGS_CRITICAL=("Critical 1")
    FINDINGS_HIGH=("High 1")
    FINDINGS_MEDIUM=("Medium 1")
    FINDINGS_LOW=("Low 1")

    result=$(format_findings)

    [[ "$result" =~ "Critical Findings (1)" ]]
    [[ "$result" =~ "High Findings (1)" ]]
    [[ "$result" =~ "Medium Findings (1)" ]]
    [[ "$result" =~ "Low Findings (1)" ]]
}

@test "format_findings: limits to top 5 when more than 10 findings" {
    # Create 12 critical findings
    FINDINGS_CRITICAL=()
    for i in {1..12}; do
        FINDINGS_CRITICAL+=("Finding $i")
    done
    FINDINGS_HIGH=()
    FINDINGS_MEDIUM=()
    FINDINGS_LOW=()

    result=$(format_findings)

    [[ "$result" =~ "Critical Findings (12)" ]]
    [[ "$result" =~ "Finding 1" ]]
    [[ "$result" =~ "Finding 5" ]]
    [[ "$result" =~ "and 7 more critical findings" ]]
    [[ ! "$result" =~ "Finding 6" ]]  # Should not show 6th finding
}

@test "format_findings: shows all findings when <= 10" {
    # Create 10 findings
    FINDINGS_CRITICAL=()
    for i in {1..10}; do
        FINDINGS_CRITICAL+=("Finding $i")
    done
    FINDINGS_HIGH=()
    FINDINGS_MEDIUM=()
    FINDINGS_LOW=()

    result=$(format_findings)

    [[ "$result" =~ "Finding 10" ]]
    [[ ! "$result" =~ "and" ]]  # Should not show "and X more"
}

@test "format_findings: handles no findings" {
    FINDINGS_CRITICAL=()
    FINDINGS_HIGH=()
    FINDINGS_MEDIUM=()
    FINDINGS_LOW=()

    result=$(format_findings)

    [[ "$result" =~ "No findings detected" ]]
}

# ==================== calculate_quality_label() Tests ====================

@test "calculate_quality_label: score 0 returns Excellent" {
    result=$(calculate_quality_label 0)
    [ "$result" = "Excellent" ]
}

@test "calculate_quality_label: score 20 returns Excellent" {
    result=$(calculate_quality_label 20)
    [ "$result" = "Excellent" ]
}

@test "calculate_quality_label: score 21 returns Good" {
    result=$(calculate_quality_label 21)
    [ "$result" = "Good" ]
}

@test "calculate_quality_label: score 50 returns Good" {
    result=$(calculate_quality_label 50)
    [ "$result" = "Good" ]
}

@test "calculate_quality_label: score 51 returns Needs Improvement" {
    result=$(calculate_quality_label 51)
    [ "$result" = "Needs Improvement" ]
}

@test "calculate_quality_label: score 80 returns Needs Improvement" {
    result=$(calculate_quality_label 80)
    [ "$result" = "Needs Improvement" ]
}

@test "calculate_quality_label: score 81 returns Poor" {
    result=$(calculate_quality_label 81)
    [ "$result" = "Poor" ]
}

@test "calculate_quality_label: score 100 returns Poor" {
    result=$(calculate_quality_label 100)
    [ "$result" = "Poor" ]
}

# ==================== generate_report() Tests ====================

@test "generate_report: creates report file" {
    # Create minimal template
    cat > "${LIB_DIR}/../templates/design-review-report.md" <<EOF
# {{UNIT_NAME}}
Score: {{QUALITY_SCORE}}
EOF

    response="CRITICAL: Issue 1
Quality Score: 10"

    generate_report "test-unit" "$response"

    # Check report file exists
    report_file=$(ls "${CWD}/reports/design_review/"*-designreview.md 2>/dev/null | head -1)
    [ -f "$report_file" ]
}

@test "generate_report: substitutes template variables" {
    # Create template with variables
    cat > "${LIB_DIR}/../templates/design-review-report.md" <<EOF
# Report: {{UNIT_NAME}}
Quality Score: {{QUALITY_SCORE}}
Quality Label: {{QUALITY_LABEL}}
Critical: {{FINDINGS_CRITICAL}}
High: {{FINDINGS_HIGH}}
Medium: {{FINDINGS_MEDIUM}}
Low: {{FINDINGS_LOW}}
Total: {{FINDINGS_TOTAL}}
EOF

    response="CRITICAL: Issue 1
HIGH: Issue 2
MEDIUM: Issue 3
LOW: Issue 4
Quality Score: 15"

    generate_report "test-unit" "$response"

    # Read report content
    report_file=$(ls "${CWD}/reports/design_review/"*-designreview.md 2>/dev/null | head -1)
    content=$(cat "$report_file")

    [[ "$content" =~ "test-unit" ]]
    [[ "$content" =~ "Quality Score: 15" ]]
    [[ "$content" =~ "Quality Label: Excellent" ]]
    [[ "$content" =~ "Critical: 1" ]]
    [[ "$content" =~ "Total: 4" ]]
}

@test "generate_report: returns 1 when template missing" {
    response="CRITICAL: Issue"

    run generate_report "test-unit" "$response"

    [ "$status" -eq 1 ]
}

@test "generate_report: recommendation BLOCK for critical findings" {
    cat > "${LIB_DIR}/../templates/design-review-report.md" <<EOF
Recommendation: {{RECOMMENDATION}}
EOF

    response="CRITICAL: Issue 1"

    generate_report "test-unit" "$response"

    report_file=$(ls "${CWD}/reports/design_review/"*-designreview.md 2>/dev/null | head -1)
    content=$(cat "$report_file")

    [[ "$content" =~ "BLOCK" ]]
}

@test "generate_report: recommendation REVIEW for high quality score" {
    cat > "${LIB_DIR}/../templates/design-review-report.md" <<EOF
Recommendation: {{RECOMMENDATION}}
EOF

    response="HIGH: Issue 1
HIGH: Issue 2
Quality Score: 85"

    generate_report "test-unit" "$response"

    report_file=$(ls "${CWD}/reports/design_review/"*-designreview.md 2>/dev/null | head -1)
    content=$(cat "$report_file")

    [[ "$content" =~ "REVIEW" ]]
}

@test "generate_report: recommendation APPROVE for low quality score" {
    cat > "${LIB_DIR}/../templates/design-review-report.md" <<EOF
Recommendation: {{RECOMMENDATION}}
EOF

    response="LOW: Issue 1
Quality Score: 10"

    generate_report "test-unit" "$response"

    report_file=$(ls "${CWD}/reports/design_review/"*-designreview.md 2>/dev/null | head -1)
    content=$(cat "$report_file")

    [[ "$content" =~ "APPROVE" ]]
}
