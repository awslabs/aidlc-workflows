#!/usr/bin/env bash
# =============================================================================
# AI-DLC Setup Script (macOS / Linux)
# =============================================================================
# Automates the platform-specific setup of AI-DLC rules for supported coding
# agents. Downloads the latest release from GitHub or uses a local path if
# GitHub is unreachable.
# =============================================================================

set -euo pipefail

# --- Constants ---------------------------------------------------------------
REPO="awslabs/aidlc-workflows"
GITHUB_API="https://api.github.com/repos/${REPO}/releases/latest"
GITHUB_RELEASES="https://github.com/${REPO}/releases"
TMP_DIR=""

# --- Colors ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# --- Helper Functions --------------------------------------------------------
info()    { printf "${BLUE}ℹ${NC}  %s\n" "$1"; }
success() { printf "${GREEN}✔${NC}  %s\n" "$1"; }
warn()    { printf "${YELLOW}⚠${NC}  %s\n" "$1"; }
error()   { printf "${RED}✖${NC}  %s\n" "$1" >&2; }
header()  { printf "\n${BOLD}${CYAN}%s${NC}\n" "$1"; printf '%*s\n' "${#1}" '' | tr ' ' '─'; }

cleanup() {
    if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
        rm -rf "${TMP_DIR}"
    fi
}
trap cleanup EXIT

# --- Detect Project Root -----------------------------------------------------
detect_project_root() {
    # Use current directory as project root
    PROJECT_ROOT="$(pwd)"
    info "Project root: ${PROJECT_ROOT}"
}

# --- Download or Locate Rules ------------------------------------------------
get_aidlc_rules() {
    header "Step 1: Obtaining AI-DLC Rules"

    # Try downloading from GitHub first
    info "Attempting to download latest release from GitHub..."

    local can_download=false
    local download_url=""
    local version=""

    # Check if curl or wget is available
    if command -v curl &>/dev/null; then
        local dl_cmd="curl"
    elif command -v wget &>/dev/null; then
        local dl_cmd="wget"
    else
        warn "Neither curl nor wget found. Cannot download from GitHub."
        get_local_path
        return
    fi

    # Try to get latest release info
    if [[ "${dl_cmd}" == "curl" ]]; then
        local response
        response=$(curl -sL --connect-timeout 10 --max-time 30 "${GITHUB_API}" 2>/dev/null) || true
    else
        local response
        response=$(wget -qO- --timeout=10 "${GITHUB_API}" 2>/dev/null) || true
    fi

    if [[ -n "${response}" ]]; then
        # Parse the tag name and zip URL from the response
        version=$(echo "${response}" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
        download_url=$(echo "${response}" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.zip"' | head -1 | sed 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

        if [[ -n "${download_url}" && -n "${version}" ]]; then
            can_download=true
        fi
    fi

    if [[ "${can_download}" == true ]]; then
        printf "\n"
        info "Found latest release: ${version}"
        printf "  Download from GitHub? [Y/n]: "
        read -r choice
        choice="${choice:-Y}"

        if [[ "${choice}" =~ ^[Yy] ]]; then
            TMP_DIR=$(mktemp -d)
            local zip_file="${TMP_DIR}/aidlc-rules.zip"

            info "Downloading ${download_url}..."
            if [[ "${dl_cmd}" == "curl" ]]; then
                curl -sL --progress-bar -o "${zip_file}" "${download_url}"
            else
                wget -q --show-progress -O "${zip_file}" "${download_url}"
            fi

            info "Extracting..."
            unzip -q "${zip_file}" -d "${TMP_DIR}"

            # Find the aidlc-rules directory (may be nested)
            AIDLC_RULES_PATH=$(find "${TMP_DIR}" -type d -name "aidlc-rules" | head -1)

            if [[ -z "${AIDLC_RULES_PATH}" ]]; then
                # Try looking for aws-aidlc-rules directly
                local aws_rules_dir
                aws_rules_dir=$(find "${TMP_DIR}" -type d -name "aws-aidlc-rules" | head -1)
                if [[ -n "${aws_rules_dir}" ]]; then
                    AIDLC_RULES_PATH=$(dirname "${aws_rules_dir}")
                fi
            fi

            if [[ -n "${AIDLC_RULES_PATH}" && -d "${AIDLC_RULES_PATH}/aws-aidlc-rules" ]]; then
                success "Downloaded and extracted successfully."
                return
            else
                error "Could not find aidlc-rules in the downloaded archive."
                warn "Falling back to local path..."
                get_local_path
                return
            fi
        fi
    else
        warn "Could not reach GitHub or find a release."
        printf "\n"
    fi

    get_local_path
}

get_local_path() {
    printf "\n"
    info "Please provide the path to the extracted 'aidlc-rules' folder."
    info "This folder should contain 'aws-aidlc-rules/' and 'aws-aidlc-rule-details/'."
    printf "\n"

    # Try common locations
    local common_paths=(
        "${HOME}/Downloads/aidlc-rules"
        "${HOME}/Desktop/aidlc-rules"
        "./aidlc-rules"
    )

    local found_path=""
    for p in "${common_paths[@]}"; do
        if [[ -d "${p}/aws-aidlc-rules" && -d "${p}/aws-aidlc-rule-details" ]]; then
            found_path="${p}"
            break
        fi
    done

    if [[ -n "${found_path}" ]]; then
        info "Auto-detected: ${found_path}"
        printf "  Use this path? [Y/n]: "
        read -r choice
        choice="${choice:-Y}"
        if [[ "${choice}" =~ ^[Yy] ]]; then
            AIDLC_RULES_PATH="${found_path}"
            return
        fi
    fi

    while true; do
        printf "  Path to aidlc-rules folder: "
        read -r user_path

        # Expand ~ if present
        user_path="${user_path/#\~/$HOME}"

        if [[ -d "${user_path}/aws-aidlc-rules" && -d "${user_path}/aws-aidlc-rule-details" ]]; then
            AIDLC_RULES_PATH="${user_path}"
            success "Valid path confirmed."
            return
        else
            error "Invalid path. Expected to find 'aws-aidlc-rules/' and 'aws-aidlc-rule-details/' inside."
            printf "  Try again? [Y/n]: "
            read -r retry
            retry="${retry:-Y}"
            if [[ ! "${retry}" =~ ^[Yy] ]]; then
                error "Cannot proceed without valid aidlc-rules path."
                exit 1
            fi
        fi
    done
}

# --- Select Agent ------------------------------------------------------------
select_agent() {
    header "Step 2: Select Your Coding Agent"

    printf "\n"
    printf "  ${BOLD}1)${NC} Kiro\n"
    printf "  ${BOLD}2)${NC} Amazon Q Developer\n"
    printf "  ${BOLD}3)${NC} Cursor IDE\n"
    printf "  ${BOLD}4)${NC} Cline\n"
    printf "  ${BOLD}5)${NC} Claude Code\n"
    printf "  ${BOLD}6)${NC} GitHub Copilot\n"
    printf "  ${BOLD}7)${NC} OpenAI Codex\n"
    printf "  ${BOLD}8)${NC} All agents\n"
    printf "\n"
    printf "  Select agent [1-8]: "
    read -r agent_choice

    case "${agent_choice}" in
        1) AGENTS=("kiro") ;;
        2) AGENTS=("amazonq") ;;
        3) AGENTS=("cursor") ;;
        4) AGENTS=("cline") ;;
        5) AGENTS=("claude") ;;
        6) AGENTS=("copilot") ;;
        7) AGENTS=("codex") ;;
        8) AGENTS=("kiro" "amazonq" "cursor" "cline" "claude" "copilot" "codex") ;;
        *)
            error "Invalid selection. Please choose 1-8."
            select_agent
            ;;
    esac
}

# --- Setup Functions ---------------------------------------------------------
setup_kiro() {
    info "Setting up for Kiro..."
    mkdir -p "${PROJECT_ROOT}/.kiro/steering"
    cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rules" "${PROJECT_ROOT}/.kiro/steering/"
    cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details" "${PROJECT_ROOT}/.kiro/"
    success "Kiro setup complete."
    printf "    └── .kiro/steering/aws-aidlc-rules/\n"
    printf "    └── .kiro/aws-aidlc-rule-details/\n"
}

setup_amazonq() {
    info "Setting up for Amazon Q Developer..."
    mkdir -p "${PROJECT_ROOT}/.amazonq/rules"
    cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rules" "${PROJECT_ROOT}/.amazonq/rules/"
    cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details" "${PROJECT_ROOT}/.amazonq/"
    success "Amazon Q Developer setup complete."
    printf "    └── .amazonq/rules/aws-aidlc-rules/\n"
    printf "    └── .amazonq/aws-aidlc-rule-details/\n"
}

setup_cursor() {
    printf "\n"
    info "Cursor IDE has two setup options:"
    printf "    ${BOLD}1)${NC} Project Rules (.cursor/rules/) — Recommended\n"
    printf "    ${BOLD}2)${NC} AGENTS.md (simple alternative)\n"
    printf "  Select option [1/2]: "
    read -r cursor_option
    cursor_option="${cursor_option:-1}"

    if [[ "${cursor_option}" == "2" ]]; then
        info "Setting up Cursor with AGENTS.md..."
        cp "${AIDLC_RULES_PATH}/aws-aidlc-rules/core-workflow.md" "${PROJECT_ROOT}/AGENTS.md"
        mkdir -p "${PROJECT_ROOT}/.aidlc-rule-details"
        cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details/"* "${PROJECT_ROOT}/.aidlc-rule-details/"
        success "Cursor setup complete (AGENTS.md)."
        printf "    └── AGENTS.md\n"
        printf "    └── .aidlc-rule-details/\n"
    else
        info "Setting up Cursor with Project Rules..."
        mkdir -p "${PROJECT_ROOT}/.cursor/rules"

        # Create the .mdc file with frontmatter + core workflow
        {
            printf '%s\n' '---'
            printf '%s\n' 'description: "AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development"'
            printf '%s\n' 'alwaysApply: true'
            printf '%s\n' '---'
            printf '\n'
            cat "${AIDLC_RULES_PATH}/aws-aidlc-rules/core-workflow.md"
        } > "${PROJECT_ROOT}/.cursor/rules/ai-dlc-workflow.mdc"

        mkdir -p "${PROJECT_ROOT}/.aidlc-rule-details"
        cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details/"* "${PROJECT_ROOT}/.aidlc-rule-details/"
        success "Cursor setup complete (Project Rules)."
        printf "    └── .cursor/rules/ai-dlc-workflow.mdc\n"
        printf "    └── .aidlc-rule-details/\n"
    fi
}

setup_cline() {
    printf "\n"
    info "Cline has two setup options:"
    printf "    ${BOLD}1)${NC} .clinerules directory — Recommended\n"
    printf "    ${BOLD}2)${NC} AGENTS.md (simple alternative)\n"
    printf "  Select option [1/2]: "
    read -r cline_option
    cline_option="${cline_option:-1}"

    if [[ "${cline_option}" == "2" ]]; then
        info "Setting up Cline with AGENTS.md..."
        cp "${AIDLC_RULES_PATH}/aws-aidlc-rules/core-workflow.md" "${PROJECT_ROOT}/AGENTS.md"
        mkdir -p "${PROJECT_ROOT}/.aidlc-rule-details"
        cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details/"* "${PROJECT_ROOT}/.aidlc-rule-details/"
        success "Cline setup complete (AGENTS.md)."
        printf "    └── AGENTS.md\n"
        printf "    └── .aidlc-rule-details/\n"
    else
        info "Setting up Cline with .clinerules..."
        mkdir -p "${PROJECT_ROOT}/.clinerules"
        cp "${AIDLC_RULES_PATH}/aws-aidlc-rules/core-workflow.md" "${PROJECT_ROOT}/.clinerules/"
        mkdir -p "${PROJECT_ROOT}/.aidlc-rule-details"
        cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details/"* "${PROJECT_ROOT}/.aidlc-rule-details/"
        success "Cline setup complete (.clinerules)."
        printf "    └── .clinerules/core-workflow.md\n"
        printf "    └── .aidlc-rule-details/\n"
    fi
}

setup_claude() {
    printf "\n"
    info "Claude Code has two setup options:"
    printf "    ${BOLD}1)${NC} Project root CLAUDE.md — Recommended\n"
    printf "    ${BOLD}2)${NC} .claude/CLAUDE.md directory\n"
    printf "  Select option [1/2]: "
    read -r claude_option
    claude_option="${claude_option:-1}"

    if [[ "${claude_option}" == "2" ]]; then
        info "Setting up Claude Code with .claude/CLAUDE.md..."
        mkdir -p "${PROJECT_ROOT}/.claude"
        cp "${AIDLC_RULES_PATH}/aws-aidlc-rules/core-workflow.md" "${PROJECT_ROOT}/.claude/CLAUDE.md"
        mkdir -p "${PROJECT_ROOT}/.aidlc-rule-details"
        cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details/"* "${PROJECT_ROOT}/.aidlc-rule-details/"
        success "Claude Code setup complete (.claude/CLAUDE.md)."
        printf "    └── .claude/CLAUDE.md\n"
        printf "    └── .aidlc-rule-details/\n"
    else
        info "Setting up Claude Code with CLAUDE.md..."
        cp "${AIDLC_RULES_PATH}/aws-aidlc-rules/core-workflow.md" "${PROJECT_ROOT}/CLAUDE.md"
        mkdir -p "${PROJECT_ROOT}/.aidlc-rule-details"
        cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details/"* "${PROJECT_ROOT}/.aidlc-rule-details/"
        success "Claude Code setup complete (CLAUDE.md)."
        printf "    └── CLAUDE.md\n"
        printf "    └── .aidlc-rule-details/\n"
    fi
}

setup_copilot() {
    info "Setting up for GitHub Copilot..."
    mkdir -p "${PROJECT_ROOT}/.github"
    cp "${AIDLC_RULES_PATH}/aws-aidlc-rules/core-workflow.md" "${PROJECT_ROOT}/.github/copilot-instructions.md"
    mkdir -p "${PROJECT_ROOT}/.aidlc-rule-details"
    cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details/"* "${PROJECT_ROOT}/.aidlc-rule-details/"
    success "GitHub Copilot setup complete."
    printf "    └── .github/copilot-instructions.md\n"
    printf "    └── .aidlc-rule-details/\n"
}

setup_codex() {
    info "Setting up for OpenAI Codex..."
    cp "${AIDLC_RULES_PATH}/aws-aidlc-rules/core-workflow.md" "${PROJECT_ROOT}/AGENTS.md"
    mkdir -p "${PROJECT_ROOT}/.aidlc-rule-details"
    cp -R "${AIDLC_RULES_PATH}/aws-aidlc-rule-details/"* "${PROJECT_ROOT}/.aidlc-rule-details/"
    success "OpenAI Codex setup complete."
    printf "    └── AGENTS.md\n"
    printf "    └── .aidlc-rule-details/\n"
}

# --- Main --------------------------------------------------------------------
main() {
    printf "\n"
    printf "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${NC}\n"
    printf "${BOLD}${CYAN}║          AI-DLC Setup — Automated Installer             ║${NC}\n"
    printf "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${NC}\n"
    printf "\n"
    info "This script sets up AI-DLC rules for your coding agent."
    info "Run this from your project root directory."
    printf "\n"

    detect_project_root
    get_aidlc_rules
    select_agent

    header "Step 3: Installing Rules"

    for agent in "${AGENTS[@]}"; do
        printf "\n"
        case "${agent}" in
            kiro)    setup_kiro ;;
            amazonq) setup_amazonq ;;
            cursor)  setup_cursor ;;
            cline)   setup_cline ;;
            claude)  setup_claude ;;
            copilot) setup_copilot ;;
            codex)   setup_codex ;;
        esac
    done

    header "Setup Complete"
    printf "\n"
    success "AI-DLC rules have been installed successfully."
    printf "\n"
    info "Next steps:"
    printf "    1. Open your project in your coding agent\n"
    printf "    2. Start a chat with: ${BOLD}\"Using AI-DLC, ...\"${NC}\n"
    printf "    3. The workflow will guide you from there\n"
    printf "\n"
    info "For verification steps, see: https://github.com/${REPO}#platform-specific-setup"
    printf "\n"
}

main "$@"
