#!/usr/bin/env bats
# Integration tests for Unit 4: Reporting & Audit Trail
#
# Tests cover:
# - End-to-end report generation workflow
# - Audit logging for all review events
# - Post-review decision flow
# - Bypass detection workflow

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
    export CONFIG_TIMEOUT_SECONDS=2

    # Source all modules under test
    source "${LIB_DIR}/report-generator.sh"
    source "${LIB_DIR}/audit-logger.sh"
    source "${LIB_DIR}/user-interaction.sh"

    # Create test directories
    mkdir -p "${CWD}/aidlc-docs"
    mkdir -p "${CWD}/.claude"
    mkdir -p "${CWD}/reports/design_review"
    mkdir -p "${LIB_DIR}/../templates"
}

# Teardown: Clean up test fixtures
teardown() {
    rm -rf "${CWD}/aidlc-docs"
    rm -rf "${CWD}/.claude"
    rm -rf "${CWD}/reports"
    rm -rf "${LIB_DIR}/../templates"
}

# ==================== End-to-End Report Generation ====================

@test "integration: complete report generation workflow" {
    # Create report template
    cat > "${LIB_DIR}/../templates/design-review-report.md" <<EOF
# Report: {{UNIT_NAME}}
Quality Score: {{QUALITY_SCORE}}
Quality Label: {{QUALITY_LABEL}}
Recommendation: {{RECOMMENDATION}}

{{FINDINGS_CONTENT}}
EOF

    # Simulate AI response
    ai_response="CRITICAL: Missing error handling
HIGH: Performance concern
MEDIUM: Code style issue
LOW: Minor typo
Quality Score: 25"

    # Generate report
    generate_report "test-unit" "$ai_response"

    # Verify report exists
    report_file=$(ls "${CWD}/reports/design_review/"*-designreview.md 2>/dev/null | head -1)
    [ -f "$report_file" ]

    # Verify report content
    content=$(cat "$report_file")
    [[ "$content" =~ "test-unit" ]]
    [[ "$content" =~ "Quality Score: 25" ]]
    [[ "$content" =~ "Quality Label: Good" ]]
}

# ==================== Audit Logging Integration ====================

@test "integration: audit logging for review start" {
    log_audit_entry "Review Started" "User initiated review for unit2-config-yaml"

    [ -f "${CWD}/aidlc-docs/audit.md" ]

    content=$(cat "${CWD}/aidlc-docs/audit.md")
    [[ "$content" =~ "Review Started" ]]
    [[ "$content" =~ "unit2-config-yaml" ]]
}

@test "integration: audit logging for multiple events" {
    log_audit_entry "Review Started" "User started review"
    log_audit_entry "Findings Detected" "3 critical findings"
    log_audit_entry "Review Completed" "User stopped code generation"

    content=$(cat "${CWD}/aidlc-docs/audit.md")
    [[ "$content" =~ "Review Started" ]]
    [[ "$content" =~ "Findings Detected" ]]
    [[ "$content" =~ "Review Completed" ]]
}

@test "integration: audit logging preserves chronological order" {
    log_audit_entry "Event 1" "Description 1"
    log_audit_entry "Event 2" "Description 2"
    log_audit_entry "Event 3" "Description 3"

    content=$(cat "${CWD}/aidlc-docs/audit.md")

    # Extract event order
    events=$(echo "$content" | grep "^## Event" | tr '\n' ' ')
    [[ "$events" =~ "Event 1.*Event 2.*Event 3" ]]
}

# ==================== Post-Review Decision Flow ====================

@test "integration: post-review stop decision blocks code generation" {
    findings="CRITICAL: Security vulnerability found"

    # Simulate user choosing to stop
    result=$(echo "S" | prompt_post_review "$findings")

    [ "$result" = "S" ]
}

@test "integration: post-review continue decision allows code generation" {
    findings="LOW: Minor issue found"

    # Simulate user choosing to continue
    result=$(echo "C" | prompt_post_review "$findings")

    [ "$result" = "C" ]
}

@test "integration: post-review timeout defaults to continue (fail-open)" {
    findings="Test findings"

    # Simulate timeout
    result=$(timeout 3 bash -c 'source '"${LIB_DIR}"'/user-interaction.sh; export CONFIG_TIMEOUT_SECONDS=1; echo "" | prompt_post_review "Test"' </dev/null)

    [ "$result" = "C" ]
}

# ==================== Bypass Detection Workflow ====================

@test "integration: review marker file lifecycle" {
    # Create marker
    create_review_marker "test-unit"
    [ -f "${CWD}/.claude/.review-in-progress" ]

    # Verify marker content
    content=$(cat "${CWD}/.claude/.review-in-progress")
    [[ "$content" =~ "test-unit" ]]

    # Remove marker
    remove_review_marker
    [ ! -f "${CWD}/.claude/.review-in-progress" ]
}

@test "integration: bypass detection with marker file present" {
    # Create marker file
    create_review_marker "test-unit"

    # Detection should pass (no bypass)
    run detect_bypass

    [ "$status" -eq 0 ]
}

@test "integration: bypass detection logs to audit trail" {
    # Create artifacts but no marker (simulates bypass)
    mkdir -p "${CWD}/aidlc-docs/construction"

    # Simulate user confirming bypass
    bash -c "echo 'y' | source ${LIB_DIR}/audit-logger.sh; export CWD=${CWD}; detect_bypass"

    # Check audit log
    [ -f "${CWD}/aidlc-docs/audit.md" ]
    content=$(cat "${CWD}/aidlc-docs/audit.md")
    [[ "$content" =~ "Bypass" ]]
}

# ==================== Cross-Module Integration ====================

@test "integration: parse → format → report generation workflow" {
    # Create template
    cat > "${LIB_DIR}/../templates/design-review-report.md" <<EOF
# {{UNIT_NAME}}
{{FINDINGS_CONTENT}}
EOF

    # AI response with findings
    response="CRITICAL: Issue 1
HIGH: Issue 2
Quality Score: 20"

    # Parse response
    parse_response "$response"
    [ ${#FINDINGS_CRITICAL[@]} -eq 1 ]
    [ ${#FINDINGS_HIGH[@]} -eq 1 ]

    # Format findings
    formatted=$(format_findings)
    [[ "$formatted" =~ "Critical Findings (1)" ]]
    [[ "$formatted" =~ "High Findings (1)" ]]

    # Generate report
    generate_report "test-unit" "$response"

    # Verify report
    report_file=$(ls "${CWD}/reports/design_review/"*-designreview.md 2>/dev/null | head -1)
    [ -f "$report_file" ]
}

@test "integration: audit → report → post-review workflow" {
    # Create template
    cat > "${LIB_DIR}/../templates/design-review-report.md" <<EOF
# Report
Score: {{QUALITY_SCORE}}
EOF

    # Step 1: Log review start
    log_audit_entry "Review Started" "Starting review"
    [ -f "${CWD}/aidlc-docs/audit.md" ]

    # Step 2: Generate report
    response="CRITICAL: Issue\nQuality Score: 15"
    generate_report "test-unit" "$response"

    # Step 3: User decision
    result=$(echo "C" | prompt_post_review "Test findings")
    [ "$result" = "C" ]

    # Step 4: Log completion
    log_audit_entry "Review Completed" "User chose to continue"

    # Verify audit log has all events
    content=$(cat "${CWD}/aidlc-docs/audit.md")
    [[ "$content" =~ "Review Started" ]]
    [[ "$content" =~ "Review Completed" ]]
}
