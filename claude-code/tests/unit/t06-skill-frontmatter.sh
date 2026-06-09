#!/bin/bash
# t06: SKILL.md frontmatter valid (9 tests)
#
# As of the v0.6.0 hooks-move (Fork 2→B), the orchestrator's SKILL.md no longer
# carries a hooks: block — all framework hooks are registered project-wide in
# settings.json. This test pins the surviving frontmatter (name/description/
# user-invocable) AND that the hooks moved out of SKILL.md and into settings.json
# (the registration is the contract; t131 covers the firing behaviour).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

SKILL="$(cd "$SCRIPT_DIR/../../dist/claude/.claude/skills/aidlc" && pwd)/SKILL.md"
SETTINGS="$(cd "$SCRIPT_DIR/../../dist/claude/.claude" && pwd)/settings.json"

plan 9

# name: aidlc
assert_grep "$SKILL" "^name: aidlc" "SKILL.md name is aidlc"

# description: present
assert_grep "$SKILL" "^description:" "SKILL.md has description"

# user-invocable: true
assert_grep "$SKILL" "^user-invocable: true" "SKILL.md is user-invocable"

# The hooks: block moved out of SKILL.md frontmatter to settings.json.
assert_not_grep "$SKILL" "^hooks:" "SKILL.md carries no hooks: block (moved to settings.json)"

# The spine hooks are now registered in settings.json instead.
assert_grep "$SETTINGS" "aidlc-audit-logger.ts" "settings.json registers audit-logger.ts"
assert_grep "$SETTINGS" "\"PostToolUse\"" "settings.json registers PostToolUse hooks"
assert_grep "$SETTINGS" "\"PreCompact\"" "settings.json registers PreCompact hook"
assert_grep "$SETTINGS" "aidlc-validate-state.ts" "settings.json references validate-state.ts"
assert_grep "$SETTINGS" "aidlc-log-subagent.ts" "settings.json references log-subagent.ts"

finish
