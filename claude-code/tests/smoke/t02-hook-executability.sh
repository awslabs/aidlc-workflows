#!/bin/bash
# t02: All 10 hooks are present (all .ts, run via bun — no executable bit needed)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

HOOKS_DIR="$(cd "$SCRIPT_DIR/../../dist/claude/.claude/hooks" && pwd)"

plan 10

assert_file_exists "$HOOKS_DIR/aidlc-audit-logger.ts" "aidlc-audit-logger.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-sensor-fire.ts" "aidlc-sensor-fire.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-sync-statusline.ts" "aidlc-sync-statusline.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-runtime-compile.ts" "aidlc-runtime-compile.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-validate-state.ts" "aidlc-validate-state.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-log-subagent.ts" "aidlc-log-subagent.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-session-start.ts" "aidlc-session-start.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-session-end.ts" "aidlc-session-end.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-statusline.ts" "aidlc-statusline.ts present"
assert_file_exists "$HOOKS_DIR/aidlc-stop.ts" "aidlc-stop.ts present (the loop-enforcement Stop hook)"

finish
