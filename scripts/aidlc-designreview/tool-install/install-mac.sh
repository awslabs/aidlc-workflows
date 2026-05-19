#!/usr/bin/env bash
# AIDLC Design Review Hook - macOS/Linux Installer
# Version: 1.0
# Copyright (c) 2026 AIDLC Design Reviewer Contributors
# Licensed under the MIT License

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Installation paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${SCRIPT_DIR}"  # tool-install/ directory

# Find workspace root by walking up directory tree looking for markers
# Prioritizes .git and aidlc-rules over pyproject.toml for monorepo support
find_workspace_root() {
    local current_dir="$SCRIPT_DIR"
    local max_depth=10
    local depth=0
    local fallback_dir=""

    while [ "$current_dir" != "/" ] && [ $depth -lt $max_depth ]; do
        # Check for high-priority workspace markers (definitive)
        if [ -d "$current_dir/.git" ] || [ -d "$current_dir/aidlc-rules" ]; then
            echo "$current_dir"
            return 0
        fi

        # Check for low-priority marker (remember but keep searching)
        if [ -f "$current_dir/pyproject.toml" ] && [ -z "$fallback_dir" ]; then
            fallback_dir="$current_dir"
        fi

        current_dir="$(cd "$current_dir/.." && pwd)"
        depth=$((depth + 1))
    done

    # Use fallback if we found pyproject.toml but no .git or aidlc-rules
    if [ -n "$fallback_dir" ]; then
        echo "$fallback_dir"
        return 0
    fi

    # Final fallback to parent directory (backward compatibility)
    echo "$(cd "${SCRIPT_DIR}/.." && pwd)"
    return 0
}

WORKSPACE_DIR=$(find_workspace_root)
TARGET_DIR="${WORKSPACE_DIR}/.claude"

# Configuration
BACKUP_DIR="${TARGET_DIR}.backup.$(date +%Y%m%d_%H%M%S)"

# ============================================================================
# Helper Functions
# ============================================================================

print_header() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                                                                ║${NC}"
    echo -e "${BLUE}║       AIDLC Design Review Hook - Installation Tool            ║${NC}"
    echo -e "${BLUE}║                   Version 1.0                                  ║${NC}"
    echo -e "${BLUE}║                                                                ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# ============================================================================
# Dependency Checks
# ============================================================================

check_dependencies() {
    print_info "Checking dependencies..."
    echo ""

    local all_ok=true

    # Check bash version
    if [[ "${BASH_VERSINFO[0]}" -lt 4 ]]; then
        print_error "Bash 4.0 or higher required (found ${BASH_VERSION})"
        all_ok=false
    else
        print_success "Bash ${BASH_VERSION} - OK"
    fi

    # Check for yq (optional)
    if command -v yq &> /dev/null; then
        local yq_version=$(yq --version 2>&1 | head -n1)
        print_success "yq installed - $yq_version"
    else
        print_warning "yq not found (optional - will use Python fallback)"
        echo "  To install yq: brew install yq (macOS) or see https://github.com/mikefarah/yq"
    fi

    # Check for Python 3 (optional)
    if command -v python3 &> /dev/null; then
        local python_version=$(python3 --version 2>&1)
        print_success "$python_version - OK"

        # Check for PyYAML
        if python3 -c "import yaml" 2>/dev/null; then
            print_success "Python PyYAML module - OK"
        else
            print_warning "Python PyYAML not found (optional - will use defaults)"
            echo "  To install: pip3 install pyyaml"
        fi
    else
        print_warning "Python 3 not found (optional - will use defaults)"
    fi

    echo ""

    if [ "$all_ok" = false ]; then
        print_error "Critical dependencies missing. Please install required software and try again."
        exit 1
    fi

    print_success "Dependency check complete"
    echo ""
}

# ============================================================================
# Installation Type Detection
# ============================================================================

detect_installation_type() {
    if [ -d "$TARGET_DIR" ]; then
        echo "update"
    else
        echo "fresh"
    fi
}

# ============================================================================
# Backup Existing Installation
# ============================================================================

backup_existing() {
    if [ -d "$TARGET_DIR" ]; then
        print_info "Backing up existing installation to ${BACKUP_DIR##*/}"
        cp -r "$TARGET_DIR" "$BACKUP_DIR"
        print_success "Backup created"
        echo ""
    fi
}

# ============================================================================
# Configuration Prompts
# ============================================================================

prompt_config() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  Configuration Setup${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""

    # Enabled (default: true)
    echo -n "Enable design review hook? (yes/no) [yes]: "
    read -r enabled
    enabled=${enabled:-yes}
    if [[ "$enabled" =~ ^(yes|y|true)$ ]]; then
        CONFIG_ENABLED=true
    else
        CONFIG_ENABLED=false
    fi

    # Dry run (default: false)
    echo -n "Enable dry-run mode (no blocking, only reports)? (yes/no) [no]: "
    read -r dry_run
    dry_run=${dry_run:-no}
    if [[ "$dry_run" =~ ^(yes|y|true)$ ]]; then
        CONFIG_DRY_RUN=true
    else
        CONFIG_DRY_RUN=false
    fi

    # Review threshold (default: 3)
    echo -n "Review threshold (1=Low, 2=Medium, 3=High, 4=Critical) [3]: "
    read -r threshold
    threshold=${threshold:-3}
    CONFIG_REVIEW_THRESHOLD=$threshold

    # Enable alternatives (default: true)
    echo -n "Enable alternative approaches analysis? (yes/no) [yes]: "
    read -r alternatives
    alternatives=${alternatives:-yes}
    if [[ "$alternatives" =~ ^(yes|y|true)$ ]]; then
        CONFIG_ENABLE_ALTERNATIVES=true
    else
        CONFIG_ENABLE_ALTERNATIVES=false
    fi

    # Enable gap analysis (default: true)
    echo -n "Enable gap analysis? (yes/no) [yes]: "
    read -r gaps
    gaps=${gaps:-yes}
    if [[ "$gaps" =~ ^(yes|y|true)$ ]]; then
        CONFIG_ENABLE_GAP_ANALYSIS=true
    else
        CONFIG_ENABLE_GAP_ANALYSIS=false
    fi

    echo ""
    print_success "Configuration captured"
    echo ""
}

# ============================================================================
# Create Configuration File
# ============================================================================

create_config() {
    local config_file="${TARGET_DIR}/review-config.yaml"

    print_info "Creating configuration file: ${config_file}"

    cat > "$config_file" <<EOF
# AIDLC Design Review Hook Configuration
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Hook behavior
enabled: ${CONFIG_ENABLED}
dry_run: ${CONFIG_DRY_RUN}

# Review depth
review:
  # Severity threshold (1=Low, 2=Medium, 3=High, 4=Critical)
  threshold: ${CONFIG_REVIEW_THRESHOLD}

  # Enable alternative approaches analysis (default: true)
  enable_alternatives: ${CONFIG_ENABLE_ALTERNATIVES}

  # Enable gap analysis (default: true)
  enable_gap_analysis: ${CONFIG_ENABLE_GAP_ANALYSIS}

# Reporting
reports:
  # Directory for storing review reports (relative to workspace root)
  output_dir: reports/design_review

  # Report format (markdown or both)
  format: markdown

# Performance
performance:
  # Maximum files per batch (for large projects)
  batch_size: 20

  # Maximum total size per batch in KB
  batch_max_size: 25

# Logging
logging:
  # Audit trail file (relative to workspace root)
  audit_file: aidlc-docs/audit.md

  # Log level (debug, info, warn, error)
  level: info
EOF

    print_success "Configuration file created"
    echo ""
}

# ============================================================================
# Install Files
# ============================================================================

install_files() {
    print_info "Installing AIDLC Design Review Hook..."
    echo ""

    # Create directory structure
    mkdir -p "${TARGET_DIR}"/{lib,hooks,templates}
    print_success "Created directory structure"

    # Copy library files
    print_info "Copying library files..."
    cp "${SOURCE_DIR}"/lib/*.sh "${TARGET_DIR}/lib/"
    chmod +x "${TARGET_DIR}"/lib/*.sh
    print_success "Copied 6 library files"

    # Copy hook file
    print_info "Copying hook file..."
    cp "${SOURCE_DIR}/hooks/pre-tool-use" "${TARGET_DIR}/hooks/"
    chmod +x "${TARGET_DIR}/hooks/pre-tool-use"
    print_success "Copied hook file"

    # Copy template
    print_info "Copying report template..."
    cp "${SOURCE_DIR}/templates/design-review-report.md" "${TARGET_DIR}/templates/"
    print_success "Copied report template"

    # Copy prompts
    print_info "Copying AI prompts..."
    mkdir -p "${TARGET_DIR}/prompts"
    cp "${SOURCE_DIR}"/prompts/*.md "${TARGET_DIR}/prompts/"
    print_success "Copied AI prompts"

    # Copy patterns
    print_info "Copying architectural patterns..."
    mkdir -p "${TARGET_DIR}/patterns"
    cp "${SOURCE_DIR}"/patterns/*.md "${TARGET_DIR}/patterns/"
    print_success "Copied architectural patterns"

    # Copy example config (keep for reference)
    cp "${SOURCE_DIR}/review-config.yaml.example" "${TARGET_DIR}/"
    print_success "Copied example configuration"

    echo ""
    print_success "All files installed successfully"
    echo ""
}

# ============================================================================
# Validation Test
# ============================================================================

run_validation() {
    print_info "Running installation validation test..."
    echo ""

    # Test 1: Check all required files exist
    print_info "Test 1: Checking file integrity..."
    local missing_files=()

    local required_files=(
        "hooks/pre-tool-use"
        "lib/logger.sh"
        "lib/config-defaults.sh"
        "lib/config-parser.sh"
        "lib/user-interaction.sh"
        "lib/review-executor.sh"
        "lib/report-generator.sh"
        "lib/audit-logger.sh"
        "templates/design-review-report.md"
        "review-config.yaml"
    )

    for file in "${required_files[@]}"; do
        if [ ! -f "${TARGET_DIR}/${file}" ]; then
            missing_files+=("$file")
        fi
    done

    if [ ${#missing_files[@]} -eq 0 ]; then
        print_success "All required files present"
    else
        print_error "Missing files: ${missing_files[*]}"
        return 1
    fi

    # Test 2: Check hook is executable
    print_info "Test 2: Checking hook permissions..."
    if [ -x "${TARGET_DIR}/hooks/pre-tool-use" ]; then
        print_success "Hook is executable"
    else
        print_error "Hook is not executable"
        return 1
    fi

    # Test 3: Check config file is valid YAML
    print_info "Test 3: Validating configuration file..."
    if command -v yq &> /dev/null; then
        if yq eval . "${TARGET_DIR}/review-config.yaml" > /dev/null 2>&1; then
            print_success "Configuration file is valid YAML"
        else
            print_error "Configuration file has YAML syntax errors"
            return 1
        fi
    elif command -v python3 &> /dev/null && python3 -c "import yaml" 2>/dev/null; then
        if python3 -c "import yaml; yaml.safe_load(open('${TARGET_DIR}/review-config.yaml'))" > /dev/null 2>&1; then
            print_success "Configuration file is valid YAML"
        else
            print_error "Configuration file has YAML syntax errors"
            return 1
        fi
    else
        print_warning "Cannot validate YAML (yq or Python PyYAML not available)"
    fi

    # Test 4: Source check (basic syntax)
    print_info "Test 4: Checking bash syntax..."
    local syntax_errors=0
    for script in "${TARGET_DIR}"/lib/*.sh "${TARGET_DIR}/hooks/pre-tool-use"; do
        if ! bash -n "$script" 2>/dev/null; then
            print_error "Syntax error in $(basename "$script")"
            syntax_errors=$((syntax_errors + 1))
        fi
    done

    if [ $syntax_errors -eq 0 ]; then
        print_success "All scripts have valid bash syntax"
    else
        print_error "Found $syntax_errors script(s) with syntax errors"
        return 1
    fi

    echo ""
    print_success "✓ Installation validation passed"
    echo ""

    return 0
}

# ============================================================================
# Post-Installation Instructions
# ============================================================================

show_instructions() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  Installation Complete!${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""

    print_success "AIDLC Design Review Hook is now installed"
    echo ""

    echo -e "${BLUE}Next Steps:${NC}"
    echo ""
    echo "1. The hook is now active in this workspace"
    echo "2. Design artifacts in aidlc-docs/construction/ will be reviewed automatically"
    echo "3. Reports will be generated in reports/design_review/"
    echo ""

    echo -e "${BLUE}Configuration:${NC}"
    echo "  File: ${TARGET_DIR}/review-config.yaml"
    echo "  Edit this file to customize hook behavior"
    echo ""

    echo -e "${BLUE}Testing:${NC}"
    echo "  Run: TEST_MODE=1 .claude/hooks/pre-tool-use"
    echo "  This will generate a test report without blocking"
    echo ""

    if [ -d "$BACKUP_DIR" ]; then
        echo -e "${BLUE}Backup:${NC}"
        echo "  Previous installation backed up to: ${BACKUP_DIR##*/}"
        echo "  Remove backup: rm -rf ${BACKUP_DIR}"
        echo ""
    fi

    echo -e "${BLUE}Documentation:${NC}"
    echo "  Example config: ${TARGET_DIR}/review-config.yaml.example"
    echo "  Source files: ${SOURCE_DIR}/"
    echo ""

    echo -e "${GREEN}Installation successful!${NC}"
    echo ""
}

# ============================================================================
# Main Installation Flow
# ============================================================================

main() {
    print_header

    # Display detected workspace directory
    print_info "Detected workspace directory: $WORKSPACE_DIR"
    print_info "Installation target: $TARGET_DIR"
    echo ""

    # Check if source files exist
    if [ ! -f "$SOURCE_DIR/hooks/pre-tool-use" ]; then
        print_error "Source files not found in: $SOURCE_DIR"
        print_error "Please run this script from tool-install/ directory"
        print_error "Example: ./tool-install/install-linux.sh"
        exit 1
    fi

    # Detect installation type
    local install_type=$(detect_installation_type)

    if [ "$install_type" = "update" ]; then
        print_info "Existing installation detected - will update"
        echo ""
    else
        print_info "Fresh installation"
        echo ""
    fi

    # Check dependencies
    check_dependencies

    # Backup if updating
    if [ "$install_type" = "update" ]; then
        backup_existing
    fi

    # Prompt for configuration
    prompt_config

    # Install files
    install_files

    # Create configuration file
    create_config

    # Run validation
    if ! run_validation; then
        print_error "Installation validation failed"
        print_warning "Hook may not work correctly"
        echo ""

        if [ -d "$BACKUP_DIR" ]; then
            echo -n "Restore from backup? (yes/no): "
            read -r restore
            if [[ "$restore" =~ ^(yes|y)$ ]]; then
                rm -rf "$TARGET_DIR"
                mv "$BACKUP_DIR" "$TARGET_DIR"
                print_success "Restored from backup"
            fi
        fi

        exit 1
    fi

    # Show post-installation instructions
    show_instructions
}

# Run main installation
main "$@"
