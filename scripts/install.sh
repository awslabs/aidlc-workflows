#!/usr/bin/env bash
# AI-DLC Workflow Installer (macOS/Linux)
# Sets up AI-DLC rules in your target project from this cloned repository.
# Usage: ./scripts/install.sh [agent] [target-project-dir]
#   agent: kiro | amazonq | cursor | cline | claude-code | copilot | codex
#   target-project-dir: path to the project you want to set up (defaults to current directory)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
RULES_DIR="${REPO_ROOT}/aidlc-rules"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_error()   { echo -e "${RED}✗${NC} $1"; }
print_info()    { echo -e "${BLUE}ℹ${NC} $1"; }

if [ ! -d "$RULES_DIR" ]; then
    print_error "Cannot find aidlc-rules/ at: $RULES_DIR"
    print_error "Run this script from within the cloned aidlc-workflows repository."
    exit 1
fi

RULES_SRC="${RULES_DIR}/aws-aidlc-rules"
DETAILS_SRC="${RULES_DIR}/aws-aidlc-rule-details"

# ── Agent selection ────────────────────────────────────────────────────────────

if [ -n "${1:-}" ]; then
    AGENT="$1"
else
    echo "AI-DLC Workflow Installer"
    echo "========================="
    echo ""
    echo "Select your coding agent:"
    echo "  1) Kiro"
    echo "  2) Amazon Q Developer"
    echo "  3) Cursor IDE"
    echo "  4) Cline"
    echo "  5) Claude Code"
    echo "  6) GitHub Copilot"
    echo "  7) OpenAI Codex"
    echo ""
    read -r -p "Enter choice [1-7]: " choice
    case "$choice" in
        1) AGENT="kiro" ;;
        2) AGENT="amazonq" ;;
        3) AGENT="cursor" ;;
        4) AGENT="cline" ;;
        5) AGENT="claude-code" ;;
        6) AGENT="copilot" ;;
        7) AGENT="codex" ;;
        *) print_error "Invalid choice: $choice"; exit 1 ;;
    esac
fi

# ── Target project directory ───────────────────────────────────────────────────

if [ -n "${2:-}" ]; then
    TARGET_PROJECT="$2"
else
    read -r -p "Target project directory [$(pwd)]: " TARGET_PROJECT
    TARGET_PROJECT="${TARGET_PROJECT:-$(pwd)}"
fi

if [ ! -d "$TARGET_PROJECT" ]; then
    print_error "Directory not found: $TARGET_PROJECT"
    exit 1
fi
TARGET_PROJECT="$(cd "$TARGET_PROJECT" && pwd)"

print_info "Installing AI-DLC rules for agent '$AGENT' into: $TARGET_PROJECT"
echo ""

# ── Copy rules ─────────────────────────────────────────────────────────────────

case "$AGENT" in
    kiro)
        mkdir -p "${TARGET_PROJECT}/.kiro/steering"
        cp -R "$RULES_SRC" "${TARGET_PROJECT}/.kiro/steering/"
        cp -R "$DETAILS_SRC" "${TARGET_PROJECT}/.kiro/"
        print_success "Kiro steering files installed"
        ;;
    amazonq)
        mkdir -p "${TARGET_PROJECT}/.amazonq/rules"
        cp -R "$RULES_SRC" "${TARGET_PROJECT}/.amazonq/rules/"
        cp -R "$DETAILS_SRC" "${TARGET_PROJECT}/.amazonq/"
        print_success "Amazon Q Developer rules installed"
        ;;
    cursor)
        mkdir -p "${TARGET_PROJECT}/.cursor/rules"
        {
            printf -- '---\ndescription: "AI-DLC (AI-Driven Development Life Cycle) adaptive workflow for software development"\nalwaysApply: true\n---\n\n'
            cat "${RULES_SRC}/core-workflow.md"
        } > "${TARGET_PROJECT}/.cursor/rules/ai-dlc-workflow.mdc"
        mkdir -p "${TARGET_PROJECT}/.aidlc-rule-details"
        cp -R "${DETAILS_SRC}/"* "${TARGET_PROJECT}/.aidlc-rule-details/"
        print_success "Cursor IDE rules installed"
        ;;
    cline)
        mkdir -p "${TARGET_PROJECT}/.clinerules"
        cp "${RULES_SRC}/core-workflow.md" "${TARGET_PROJECT}/.clinerules/"
        mkdir -p "${TARGET_PROJECT}/.aidlc-rule-details"
        cp -R "${DETAILS_SRC}/"* "${TARGET_PROJECT}/.aidlc-rule-details/"
        print_success "Cline rules installed"
        ;;
    claude-code)
        cp "${RULES_SRC}/core-workflow.md" "${TARGET_PROJECT}/CLAUDE.md"
        mkdir -p "${TARGET_PROJECT}/.aidlc-rule-details"
        cp -R "${DETAILS_SRC}/"* "${TARGET_PROJECT}/.aidlc-rule-details/"
        print_success "Claude Code rules installed"
        ;;
    copilot)
        mkdir -p "${TARGET_PROJECT}/.github"
        cp "${RULES_SRC}/core-workflow.md" "${TARGET_PROJECT}/.github/copilot-instructions.md"
        mkdir -p "${TARGET_PROJECT}/.aidlc-rule-details"
        cp -R "${DETAILS_SRC}/"* "${TARGET_PROJECT}/.aidlc-rule-details/"
        print_success "GitHub Copilot rules installed"
        ;;
    codex)
        cp "${RULES_SRC}/core-workflow.md" "${TARGET_PROJECT}/AGENTS.md"
        mkdir -p "${TARGET_PROJECT}/.aidlc-rule-details"
        cp -R "${DETAILS_SRC}/"* "${TARGET_PROJECT}/.aidlc-rule-details/"
        print_success "OpenAI Codex rules installed"
        ;;
    *)
        print_error "Unknown agent: $AGENT"
        echo "Valid agents: kiro | amazonq | cursor | cline | claude-code | copilot | codex"
        exit 1
        ;;
esac

echo ""
print_success "Done. Open your project in your coding agent and start with: 'Using AI-DLC, ...'"
