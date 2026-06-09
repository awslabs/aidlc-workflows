#!/bin/bash
# t40: Validate settings.json hook configuration (6 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SETTINGS="$AIDLC_SRC/settings.json"
SETTINGS_LOCAL_EXAMPLE="$AIDLC_SRC/settings.local.json.example"

plan 6

# Test 1: hooks.SessionStart array exists
assert_grep "$SETTINGS" '"SessionStart"' "SessionStart hook configured"

# Test 2: SessionStart references session-start.ts via bun
assert_grep "$SETTINGS" 'session-start.ts' "SessionStart references session-start.ts"

# Test 3: statusLine.type is "command"
if [ "$(jq -r '.statusLine.type' "$SETTINGS" 2>/dev/null)" = "command" ]; then
  ok "statusLine.type is command"
else
  not_ok "statusLine.type is command"
fi

# Test 4: statusLine.command references aidlc-statusline.ts
assert_grep "$SETTINGS" 'aidlc-statusline.ts' "statusLine references aidlc-statusline.ts"

# Test 5: permissions.allow has exactly 9 tools (including bun tools pattern)
TOOL_COUNT=$(jq '.permissions.allow | length' "$SETTINGS" 2>/dev/null)
assert_eq "$TOOL_COUNT" "9" "permissions.allow has exactly 9 tools"

# Test 6: settings.local.json.example is valid JSON
if jq empty "$SETTINGS_LOCAL_EXAMPLE" 2>/dev/null; then
  ok "settings.local.json.example is valid JSON"
else
  not_ok "settings.local.json.example is valid JSON"
fi

finish
