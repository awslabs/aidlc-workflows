#!/usr/bin/env bash
# Test the AIDLC Design Review Hook with custom aidlc-docs folder
#
# Purpose: Test the hook against any aidlc-docs folder
#
# Usage:
#   ./tool-install/test-hook-with-docs.sh /path/to/aidlc-docs
#   ./test-hook-with-docs.sh test_data/sci-calc/golden-aidlc-docs

set -euo pipefail

# Determine workspace root (handle both execution locations)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$SCRIPT_DIR" == */tool-install ]]; then
    WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    WORKSPACE_ROOT="$SCRIPT_DIR"
fi

if [ $# -eq 0 ]; then
    echo "Usage: $0 <path-to-aidlc-docs>"
    echo ""
    echo "Examples:"
    echo "  $0 test_data/sci-calc/golden-aidlc-docs"
    echo "  $0 /path/to/my/project/aidlc-docs"
    echo ""
    exit 1
fi

DOCS_PATH="$1"

# Convert to absolute path (relative to workspace root, not current directory)
if [[ "$DOCS_PATH" != /* ]]; then
    DOCS_PATH="$WORKSPACE_ROOT/$DOCS_PATH"
fi

# Verify path exists
if [ ! -d "$DOCS_PATH" ]; then
    echo "ERROR: Directory not found: $DOCS_PATH"
    exit 1
fi

# Verify it looks like an aidlc-docs folder
if [ ! -d "$DOCS_PATH/construction" ]; then
    echo "WARNING: No construction/ subdirectory found in $DOCS_PATH"
    echo "Are you sure this is an aidlc-docs folder?"
    echo ""
fi

cd "$WORKSPACE_ROOT"

echo "=========================================================================="
echo "AIDLC Design Review Hook - Testing with Custom Docs"
echo "=========================================================================="
echo ""
echo "Workspace: $WORKSPACE_ROOT"
echo "Docs Location: $DOCS_PATH"
echo ""

# Check if hook exists
if [ ! -f ".claude/hooks/pre-tool-use" ]; then
    echo "ERROR: Hook not found at .claude/hooks/pre-tool-use"
    echo "Have you run the installer? ./tool-install/install-mac.sh"
    exit 1
fi

# Show current configuration
if [ -f ".claude/review-config.yaml" ]; then
    echo "Configuration file: .claude/review-config.yaml"
    echo "---"
    cat ".claude/review-config.yaml"
    echo "---"
    echo ""
else
    echo "Configuration file: NOT FOUND (will use defaults)"
    echo ""
fi

echo "Press ENTER to run the hook, or Ctrl+C to cancel..."
read -r

echo ""
echo "=========================================================================="
echo "Running Hook..."
echo "=========================================================================="
echo ""

# Execute the hook with custom docs path (test mode enabled)
if TEST_MODE=1 AIDLC_DOCS_PATH="$DOCS_PATH" ./.claude/hooks/pre-tool-use; then
    exit_code=0
else
    exit_code=$?
fi

echo ""
echo "=========================================================================="
echo "Hook Execution Complete"
echo "=========================================================================="
echo ""
echo "Exit Code: $exit_code"

if [ $exit_code -eq 0 ]; then
    echo "Result: ✅ ALLOW - Code generation would proceed"
else
    echo "Result: 🛑 BLOCK - Code generation would be stopped"
fi

echo ""
echo "Check the following for results:"
echo "  - Reports: reports/design_review/"
echo "  - Audit Log: $DOCS_PATH/audit.md"
echo ""

exit $exit_code
