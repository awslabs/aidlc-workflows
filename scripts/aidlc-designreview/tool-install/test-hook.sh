#!/usr/bin/env bash
# Test script for AIDLC Design Review Hook
#
# Purpose: Manually test the hook without Claude Code
#
# Usage:
#   ./tool-install/test-hook.sh       # From workspace root
#   ./test-hook.sh                    # From tool-install/ directory
#   DEBUG=1 ./test-hook.sh            # Debug mode
#   SKIP_REVIEW=1 ./test-hook.sh      # Test bypass

set -euo pipefail

# Determine workspace root (handle both execution locations)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$SCRIPT_DIR" == */tool-install ]]; then
    WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
    WORKSPACE_ROOT="$SCRIPT_DIR"
fi

cd "$WORKSPACE_ROOT"

echo "=========================================================================="
echo "AIDLC Design Review Hook - Manual Test"
echo "=========================================================================="
echo ""
echo "Workspace: $WORKSPACE_ROOT"
echo "This script simulates what happens when Claude Code invokes the hook."
echo ""

# Check if hook exists
if [ ! -f ".claude/hooks/pre-tool-use" ]; then
    echo "ERROR: Hook not found at .claude/hooks/pre-tool-use"
    echo "Have you run the installer? ./tool-install/install-mac.sh"
    exit 1
fi

# Check if hook is executable
if [ ! -x ".claude/hooks/pre-tool-use" ]; then
    echo "ERROR: Hook is not executable. Run: chmod +x .claude/hooks/pre-tool-use"
    exit 1
fi

# Check if aidlc-docs exists
if [ ! -d "aidlc-docs/construction" ]; then
    echo "WARNING: No aidlc-docs/construction directory found"
    echo "The hook will exit early with no artifacts to review"
    echo ""
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

# Execute the hook (test mode enabled)
if TEST_MODE=1 ./.claude/hooks/pre-tool-use; then
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
echo "  - Audit Log: aidlc-docs/audit.md"
echo ""

exit $exit_code
