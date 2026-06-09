#!/bin/bash
# t13: Adversarial input testing for the framework's stdin-driven hooks (20 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

HOOK_AUDIT="$AIDLC_SRC/hooks/aidlc-audit-logger.ts"
HOOK_VALIDATE="$AIDLC_SRC/hooks/aidlc-validate-state.ts"
HOOK_SESSION="$AIDLC_SRC/hooks/aidlc-session-start.ts"
HOOK_STATUS="$AIDLC_SRC/hooks/aidlc-statusline.ts"
HOOK_SUBAGENT="$AIDLC_SRC/hooks/aidlc-log-subagent.ts"
HOOK_SENSOR="$AIDLC_SRC/hooks/aidlc-sensor-fire.ts"
HOOK_RUNTIME="$AIDLC_SRC/hooks/aidlc-runtime-compile.ts"

plan 20

# ============================================================
# Test A: Shell injection — hook must not execute injected commands
# ============================================================

# --- Test 1: audit-logger shell injection ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/\$(whoami)/test.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_AUDIT" 2>/dev/null
RC=$?
AUDIT_CONTENT=$(cat "$PROJ/aidlc-docs/audit.md")
if [ "$RC" -eq 0 ]; then
  ok "audit-logger: shell injection exits 0"
else
  not_ok "audit-logger: shell injection exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 2: validate-state shell injection ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'STATEEOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: $(whoami)
- **Current Stage**: `whoami`
## Stage Progress
### $(whoami) PHASE
- [ ] test — EXECUTE
STATEEOF
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_VALIDATE" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "validate-state: shell injection in state file exits 0"
else
  not_ok "validate-state: shell injection in state file exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 3: session-start shell injection ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'STATEEOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: $(whoami)
- **Current Stage**: `whoami`
- **Active Agent**: aidlc-product-agent
- **Scope**: feature
## Stage Progress
### $(whoami) PHASE
- [ ] test — EXECUTE
STATEEOF
CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_SESSION" >/dev/null 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "session-start: shell injection in state file exits 0"
else
  not_ok "session-start: shell injection in state file exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 4: statusline shell injection ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'STATEEOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: $(whoami)
- **Active Agent**: aidlc-product-agent
## Stage Progress
### IDEATION PHASE
- [ ] test — EXECUTE
STATEEOF
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK_STATUS" 2>/dev/null)
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "statusline: shell injection exits 0"
else
  not_ok "statusline: shell injection exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 5: log-subagent shell injection ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{"agent_type":"$(whoami)","agent_id":"`whoami`","last_assistant_message":"done"}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_SUBAGENT" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "log-subagent: shell injection exits 0"
else
  not_ok "log-subagent: shell injection exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# ============================================================
# Test B: Paths with spaces — hooks handle spaces gracefully
# ============================================================

# --- Test 6: audit-logger paths with spaces ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/my folder/test file.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_AUDIT" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "audit-logger: paths with spaces exits 0"
else
  not_ok "audit-logger: paths with spaces exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 7: validate-state paths with spaces ---
PROJ_SPACE=$(mktemp -d "/tmp/aidlc test space XXXXXX")
mkdir -p "$PROJ_SPACE/aidlc-docs"
cat > "$PROJ_SPACE/aidlc-docs/aidlc-state.md" << 'STATEEOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
## Stage Progress
### IDEATION PHASE
- [ ] feasibility — EXECUTE
STATEEOF
CLAUDE_PROJECT_DIR="$PROJ_SPACE" bun "$HOOK_VALIDATE" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "validate-state: project dir with spaces exits 0"
else
  not_ok "validate-state: project dir with spaces exits 0" "exit code: $RC"
fi
rm -rf "$PROJ_SPACE"

# --- Test 8: session-start paths with spaces ---
PROJ_SPACE=$(mktemp -d "/tmp/aidlc test space XXXXXX")
mkdir -p "$PROJ_SPACE/aidlc-docs"
cat > "$PROJ_SPACE/aidlc-docs/aidlc-state.md" << 'STATEEOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
- **Active Agent**: aidlc-product-agent
- **Scope**: feature
## Stage Progress
### IDEATION PHASE
- [ ] feasibility — EXECUTE
STATEEOF
CLAUDE_PROJECT_DIR="$PROJ_SPACE" bun "$HOOK_SESSION" >/dev/null 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "session-start: project dir with spaces exits 0"
else
  not_ok "session-start: project dir with spaces exits 0" "exit code: $RC"
fi
rm -rf "$PROJ_SPACE"

# --- Test 9: statusline paths with spaces ---
PROJ_SPACE=$(mktemp -d "/tmp/aidlc test space XXXXXX")
mkdir -p "$PROJ_SPACE/aidlc-docs"
cat > "$PROJ_SPACE/aidlc-docs/aidlc-state.md" << 'STATEEOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
- **Active Agent**: aidlc-product-agent
## Stage Progress
### IDEATION PHASE
- [ ] feasibility — EXECUTE
STATEEOF
OUTPUT=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ_SPACE\"}}" | bun "$HOOK_STATUS" 2>/dev/null)
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "statusline: project dir with spaces exits 0"
else
  not_ok "statusline: project dir with spaces exits 0" "exit code: $RC"
fi
rm -rf "$PROJ_SPACE"

# --- Test 10: log-subagent paths with spaces ---
PROJ_SPACE=$(mktemp -d "/tmp/aidlc test space XXXXXX")
mkdir -p "$PROJ_SPACE/aidlc-docs"
cp "$FIXTURES_DIR/audit-sample.md" "$PROJ_SPACE/aidlc-docs/audit.md"
echo '{"agent_type":"developer","agent_id":"test-123","last_assistant_message":"done"}' | \
  CLAUDE_PROJECT_DIR="$PROJ_SPACE" bun "$HOOK_SUBAGENT" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "log-subagent: project dir with spaces exits 0"
else
  not_ok "log-subagent: project dir with spaces exits 0" "exit code: $RC"
fi
rm -rf "$PROJ_SPACE"

# ============================================================
# Test C: Missing JSON keys — empty JSON {} to stdin hooks
# ============================================================

# --- Test 11: audit-logger empty JSON ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_AUDIT" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "audit-logger: empty JSON exits 0"
else
  not_ok "audit-logger: empty JSON exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 12: log-subagent empty JSON ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_SUBAGENT" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "log-subagent: empty JSON exits 0"
else
  not_ok "log-subagent: empty JSON exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 13: statusline empty JSON ---
PROJ=$(create_test_project)
OUTPUT=$(echo '{}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_STATUS" 2>/dev/null)
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "statusline: empty JSON exits 0"
else
  not_ok "statusline: empty JSON exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# ============================================================
# Edge cases (3 additional tests)
# ============================================================

# --- Test 14: null JSON values to audit-logger ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{"tool_name":null,"tool_input":null}' | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_AUDIT" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "audit-logger: null JSON values exits 0"
else
  not_ok "audit-logger: null JSON values exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 15: backtick injection to audit-logger ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"\`whoami\`/aidlc-docs/test.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_AUDIT" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "audit-logger: backtick injection exits 0"
else
  not_ok "audit-logger: backtick injection exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 16: unicode in path to audit-logger ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/\u00e9\u00e8\u00ea/t\u00ebst.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_AUDIT" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "audit-logger: unicode in path exits 0"
else
  not_ok "audit-logger: unicode in path exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 17: validate-state with empty JSON on stdin (should ignore stdin) ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'STATEEOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
## Stage Progress
### IDEATION PHASE
- [ ] feasibility — EXECUTE
STATEEOF
echo '{}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_VALIDATE" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "validate-state: ignores stdin gracefully exits 0"
else
  not_ok "validate-state: ignores stdin gracefully exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 18: session-start with empty JSON on stdin (should ignore stdin) ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" << 'STATEEOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
- **Active Agent**: aidlc-product-agent
- **Scope**: feature
## Stage Progress
### IDEATION PHASE
- [ ] feasibility — EXECUTE
STATEEOF
echo '{}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_SESSION" >/dev/null 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "session-start: ignores stdin gracefully exits 0"
else
  not_ok "session-start: ignores stdin gracefully exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# ============================================================
# Test D: New v0.5.0 PostToolUse hooks (sensor-fire, runtime-compile)
# Both carry an always-exit-0 contract; assert they survive adversarial
# input the same way the other seven do.
# ============================================================

# --- Test 19: sensor-fire shell injection in file_path ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/\$(whoami)/test.md\"}}" | \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_SENSOR" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "sensor-fire: shell injection exits 0"
else
  not_ok "sensor-fire: shell injection exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# --- Test 20: runtime-compile empty JSON (no matching command) exits 0 ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
echo '{}' | CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK_RUNTIME" 2>/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "runtime-compile: empty JSON exits 0"
else
  not_ok "runtime-compile: empty JSON exits 0" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

finish
