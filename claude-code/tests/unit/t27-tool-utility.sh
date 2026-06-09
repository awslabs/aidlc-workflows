#!/bin/bash
# t27: Unit tests for aidlc-utility.ts CLI tool (81 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

# Ensure no AIDLC env vars leak in from the dev shell or a prior test case.
# Without this, a developer running `AWS_AIDLC_DEFAULT_SCOPE=workshop` in their
# shell could see state-init tests in this file pick up the env default and
# silently shadow the explicit `--scope` flag the tests pass.
reset_aidlc_env

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-utility.ts"

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 81

# --- Test 1: help contains AI-DLC ---
OUT=$(bun "$TOOL" help 2>/dev/null)
assert_contains "$OUT" "AI-DLC" "help output contains AI-DLC"

# --- Test 2: help contains --status ---
assert_contains "$OUT" "--status" "help output contains --status"

# --- Test 3: help contains enterprise ---
assert_contains "$OUT" "enterprise" "help output contains enterprise"

# --- Test 4: help contains all 8 scopes ---
for scope in enterprise feature mvp poc bugfix refactor infra security-patch; do
  echo "$OUT" | grep -q "$scope" || { not_ok "help lists $scope"; break; }
done
ok "help lists all 8 scopes"

# --- Test 5: status without state shows no-active message ---
PROJ=$(create_test_project)
rm -rf "$PROJ/aidlc-docs"
mkdir -p "$PROJ/aidlc-docs"
OUT=$(bun "$TOOL" status --project-dir "$PROJ" 2>/dev/null)
assert_contains "$OUT" "No active" "status without state shows no-active message"
cleanup_test_project "$PROJ"

# --- Test 6: status with state fixture shows phase ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" status --project-dir "$PROJ" 2>/dev/null)
assert_contains "$OUT" "IDEATION" "status shows IDEATION phase"
cleanup_test_project "$PROJ"

# --- Test 7: status with state fixture shows feasibility ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" status --project-dir "$PROJ" 2>/dev/null)
assert_contains "$OUT" "Feasibility" "status shows feasibility stage"
cleanup_test_project "$PROJ"

# --- Test 8: status with state fixture shows feature scope ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT=$(bun "$TOOL" status --project-dir "$PROJ" 2>/dev/null)
assert_contains "$OUT" "feature" "status shows feature scope"
cleanup_test_project "$PROJ"

# --- Test 9: status does not modify state file ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
bun "$TOOL" status --project-dir "$PROJ" >/dev/null 2>&1
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
assert_eq "$MD5_BEFORE" "$MD5_AFTER" "status does not modify state file"
cleanup_test_project "$PROJ"

# --- Test 10: doctor mentions aidlc-statusline (statusline hook is TS, no jq needed) ---
# Doctor exits non-zero on any failing check. On a skeletal create_test_project
# fixture (no .claude/), many checks fail — but the output still lists every
# check label, which is all these assertions verify. || true absorbs the exit
# code so set -euo pipefail doesn't abort the script.
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" doctor --project-dir "$PROJ" 2>/dev/null || true)
assert_contains "$OUT" "aidlc-statusline" "doctor output mentions aidlc-statusline hook"
cleanup_test_project "$PROJ"

# --- Test 11: doctor mentions audit-logger ---
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" doctor --project-dir "$PROJ" 2>/dev/null || true)
assert_contains "$OUT" "audit-logger" "doctor output mentions audit-logger"
cleanup_test_project "$PROJ"

# --- Test 12: doctor mentions settings ---
PROJ=$(create_test_project)
OUT=$(bun "$TOOL" doctor --project-dir "$PROJ" 2>/dev/null || true)
assert_contains "$OUT" "settings" "doctor output mentions settings"
cleanup_test_project "$PROJ"

# --- Test 13: doctor appends audit event when audit.md exists ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
SIZE_BEFORE=$(wc -c < "$PROJ/aidlc-docs/audit.md")
bun "$TOOL" doctor --project-dir "$PROJ" >/dev/null 2>&1 || true
SIZE_AFTER=$(wc -c < "$PROJ/aidlc-docs/audit.md")
assert_gt "$SIZE_AFTER" "$SIZE_BEFORE" "doctor appends to audit.md"
cleanup_test_project "$PROJ"

# --- Test 14: init creates aidlc-state.md, audit.md, and knowledge/ ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-XXXXXX")
OUT=$(bun "$TOOL" init --scope poc --project-dir "$PROJ" 2>/dev/null)
assert_file_exists "$PROJ/aidlc-docs/aidlc-state.md" "init creates aidlc-state.md"
assert_file_exists "$PROJ/aidlc-docs/audit.md" "init creates audit.md"
assert_dir_exists "$PROJ/aidlc-docs/knowledge" "init creates knowledge/ directory"
cleanup_test_project "$PROJ"

# --- Test 15: init scaffold summary in output ---
# Welcome message is now displayed via companyAnnouncements, init only shows scaffold summary
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-XXXXXX")
OUT=$(bun "$TOOL" init --scope poc --project-dir "$PROJ" 2>/dev/null)
assert_contains "$OUT" "Workspace scaffolded" "init output contains scaffold summary"
cleanup_test_project "$PROJ"

# --- Init rejection contract: init on existing state without --force ---
# This locks down the deterministic CLI boundary that the orchestrator relies
# on. t21b covers the behavioral (orchestrator) side — state/events unchanged
# when the tool rejects — but the rejection *message* itself is owned here,
# where we can assert on stderr without LLM-prose variance.
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-XXXXXX")
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
set +e
STDERR=$(bun "$TOOL" init --scope poc --project-dir "$PROJ" 2>&1 >/dev/null)
RC=$?
set -e
assert_eq "$RC" "1" "init on existing state exits 1 without --force"
assert_contains "$STDERR" "already exists" "init rejection stderr mentions 'already exists'"
assert_contains "$STDERR" "--force" "init rejection stderr mentions --force"
cleanup_test_project "$PROJ"

# --- Test 16: scope-change poc→mvp updates Scope field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# state-mid-ideation uses "feature" scope; seed with poc scope first
sed_i 's/\*\*Scope\*\*: feature/**Scope**: poc/' "$PROJ/aidlc-docs/aidlc-state.md"
seed_audit_file "$PROJ"
OUT=$(bun "$TOOL" scope-change --scope mvp --project-dir "$PROJ" 2>/dev/null)
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Scope.*mvp' "scope-change updates Scope field to mvp"
cleanup_test_project "$PROJ"

# --- Test 17: scope-change poc→mvp updates Stages to Execute ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
sed_i 's/\*\*Scope\*\*: feature/**Scope**: poc/' "$PROJ/aidlc-docs/aidlc-state.md"
seed_audit_file "$PROJ"
bun "$TOOL" scope-change --scope mvp --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Stages to Execute' "scope-change updates Stages to Execute"
cleanup_test_project "$PROJ"

# --- Test 18: scope-change poc→mvp updates Depth field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
sed_i 's/\*\*Scope\*\*: feature/**Scope**: poc/' "$PROJ/aidlc-docs/aidlc-state.md"
sed_i 's/\*\*Depth\*\*: Standard/**Depth**: Minimal/' "$PROJ/aidlc-docs/aidlc-state.md"
seed_audit_file "$PROJ"
bun "$TOOL" scope-change --scope mvp --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Depth.*Standard' "scope-change updates Depth to Standard for mvp"
cleanup_test_project "$PROJ"

# --- Test 19: scope-change same scope is a no-op ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
OUT=$(bun "$TOOL" scope-change --scope feature --project-dir "$PROJ" 2>/dev/null)
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
assert_eq "$MD5_BEFORE" "$MD5_AFTER" "scope-change same scope does not modify state"

# --- Test 20: scope-change same scope prints already message ---
assert_contains "$OUT" "already" "scope-change same scope prints already message"
cleanup_test_project "$PROJ"

# --- Test 21: scope-change unknown scope errors ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
OUT=$(bun "$TOOL" scope-change --scope nonexistent --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT" "Unknown scope" "scope-change unknown scope prints error"
cleanup_test_project "$PROJ"

# --- Test 22: scope-change appends SCOPE_CHANGED audit event ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" scope-change --scope poc --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" 'SCOPE_CHANGED' "scope-change appends SCOPE_CHANGED audit event"
cleanup_test_project "$PROJ"

# --- Test 25: set-status updates Lifecycle Phase ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" set-status --stage feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Lifecycle Phase.*IDEATION' "set-status updates Lifecycle Phase to IDEATION"
cleanup_test_project "$PROJ"

# --- Test 26: set-status updates Current Stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" set-status --stage feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Current Stage.*feasibility' "set-status updates Current Stage to feasibility"
cleanup_test_project "$PROJ"

# --- Test 27: set-status derives Active Agent from graph ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" set-status --stage feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Active Agent.*aidlc-architect-agent' "set-status derives Active Agent from graph"
cleanup_test_project "$PROJ"

# --- Test 28: set-status marks checkbox [-] ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
# Reset feasibility to [ ] first so we can verify [-] gets set
sed_i 's/\[-\] feasibility/[ ] feasibility/' "$PROJ/aidlc-docs/aidlc-state.md"
bun "$TOOL" set-status --stage feasibility --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" '\[-\] feasibility' "set-status marks checkbox [-]"
cleanup_test_project "$PROJ"

# --- Test 29: set-status errors on unknown stage ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT29=$(bun "$TOOL" set-status --stage nonexistent --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT29" "Unknown stage" "set-status errors on unknown stage"
cleanup_test_project "$PROJ"

# --- Test 30: set-status errors without state file ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
OUT30=$(bun "$TOOL" set-status --stage feasibility --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT30" "No state file" "set-status errors without state file"
cleanup_test_project "$PROJ"

# --- Test 31: set-status cross-phase sets CONSTRUCTION for code-generation ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" set-status --stage code-generation --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Lifecycle Phase.*CONSTRUCTION' "set-status cross-phase sets CONSTRUCTION"
cleanup_test_project "$PROJ"

# --- Test 32: set-status explicit --agent overrides graph default ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" set-status --stage feasibility --agent custom-agent --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Active Agent.*custom-agent' "set-status explicit --agent overrides graph default"
cleanup_test_project "$PROJ"

# --- Test 33: init bootstrap has init-phase checkboxes ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-XXXXXX")
bun "$TOOL" init --scope poc --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'workspace-scaffold' "init bootstrap has workspace-scaffold checkbox"
cleanup_test_project "$PROJ"

# --- Test 34: enable-test-run adds Test Run Mode field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" enable-test-run --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Test Run Mode.*true' "enable-test-run adds Test Run Mode field"
cleanup_test_project "$PROJ"

# --- Test 35: enable-test-run is idempotent ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" enable-test-run --project-dir "$PROJ" >/dev/null 2>&1
OUT35=$(bun "$TOOL" enable-test-run --project-dir "$PROJ" 2>&1)
assert_contains "$OUT35" "already set" "enable-test-run is idempotent"
cleanup_test_project "$PROJ"

# --- Test 36: enable-test-run errors without state file ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
OUT36=$(bun "$TOOL" enable-test-run --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT36" "No state file" "enable-test-run errors without state file"
cleanup_test_project "$PROJ"

# --- Test 37: help contains --depth ---
OUT37=$(bun "$TOOL" help 2>/dev/null)
assert_contains "$OUT37" "--depth" "help output contains --depth"

# --- Test 38: config-change updates Depth field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" config-change --depth minimal --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Depth.*Minimal' "config-change updates Depth to Minimal"
cleanup_test_project "$PROJ"

# --- Test 39: config-change same depth is no-op ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
OUT39=$(bun "$TOOL" config-change --depth standard --project-dir "$PROJ" 2>/dev/null)
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
assert_eq "$MD5_BEFORE" "$MD5_AFTER" "config-change same depth does not modify state"

# --- Test 40: config-change same depth prints already message ---
assert_contains "$OUT39" "already" "config-change same depth prints already message"
cleanup_test_project "$PROJ"

# --- Test 41: config-change unknown depth errors ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
OUT41=$(bun "$TOOL" config-change --depth extreme --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT41" "Unknown depth" "config-change unknown depth prints error"
cleanup_test_project "$PROJ"

# --- Test 42: config-change appends DEPTH_CHANGED audit event ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" config-change --depth minimal --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" 'DEPTH_CHANGED' "config-change appends DEPTH_CHANGED audit event"
cleanup_test_project "$PROJ"

# --- Test 43: config-change without state file errors ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
OUT43=$(bun "$TOOL" config-change --depth minimal --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT43" "No state file" "config-change errors without state file"
cleanup_test_project "$PROJ"

# --- Test 44: scope-change with --depth overrides default ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
sed_i 's/\*\*Scope\*\*: feature/**Scope**: poc/' "$PROJ/aidlc-docs/aidlc-state.md"
sed_i 's/\*\*Depth\*\*: Standard/**Depth**: Minimal/' "$PROJ/aidlc-docs/aidlc-state.md"
seed_audit_file "$PROJ"
bun "$TOOL" scope-change --scope mvp --depth comprehensive --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Depth.*Comprehensive' "scope-change with --depth overrides default"
cleanup_test_project "$PROJ"

# --- Test 45: init with --depth overrides scope default ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-XXXXXX")
bun "$TOOL" init --scope bugfix --depth standard --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Depth.*Standard' "init with --depth overrides bugfix default"
cleanup_test_project "$PROJ"

# --- Test 46: help contains --test-strategy ---
OUT46=$(bun "$TOOL" help 2>/dev/null)
assert_contains "$OUT46" "--test-strategy" "help output contains --test-strategy"

# --- Test 47: help contains workshop scope ---
assert_contains "$OUT46" "workshop" "help output contains workshop scope"

# --- Test 48: config-change updates Test Strategy field ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" config-change --test-strategy minimal --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Test Strategy.*Minimal' "config-change updates Test Strategy to Minimal"
cleanup_test_project "$PROJ"

# --- Test 49: config-change same strategy is no-op ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
# state-mid-ideation has Depth: Standard, so Test Strategy defaults to Standard if present
# First set it to Standard explicitly
bun "$TOOL" config-change --test-strategy standard --project-dir "$PROJ" >/dev/null 2>&1
MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
OUT49=$(bun "$TOOL" config-change --test-strategy standard --project-dir "$PROJ" 2>/dev/null)
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
assert_eq "$MD5_BEFORE" "$MD5_AFTER" "config-change same strategy does not modify state"

# --- Test 50: config-change same strategy prints already message ---
assert_contains "$OUT49" "already" "config-change same strategy prints already message"
cleanup_test_project "$PROJ"

# --- Test 51: config-change unknown strategy errors ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
OUT51=$(bun "$TOOL" config-change --test-strategy extreme --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT51" "Unknown test strategy" "config-change unknown strategy prints error"
cleanup_test_project "$PROJ"

# --- Test 52: config-change appends TEST_STRATEGY_CHANGED audit event ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" config-change --test-strategy minimal --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" 'TEST_STRATEGY_CHANGED' "config-change appends TEST_STRATEGY_CHANGED audit event"
cleanup_test_project "$PROJ"

# --- Test 53: config-change without state file errors ---
PROJ=$(create_test_project)
rm -f "$PROJ/aidlc-docs/aidlc-state.md"
OUT53=$(bun "$TOOL" config-change --test-strategy minimal --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT53" "No state file" "config-change errors without state file"
cleanup_test_project "$PROJ"

# --- Test 54: init with --test-strategy overrides default ---
PROJ=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-XXXXXX")
bun "$TOOL" init --scope feature --test-strategy minimal --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Test Strategy.*Minimal' "init with --test-strategy overrides default"
cleanup_test_project "$PROJ"

# --- Test 55: config-change with both flags updates both fields atomically ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
bun "$TOOL" config-change --depth minimal --test-strategy minimal --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Depth.*Minimal' "config-change --depth --test-strategy updates Depth"
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" 'Test Strategy.*Minimal' "config-change --depth --test-strategy updates Test Strategy"
DEPTH_COUNT=$(grep -c '^\*\*Event\*\*: DEPTH_CHANGED' "$PROJ/aidlc-docs/audit.md")
STRAT_COUNT=$(grep -c '^\*\*Event\*\*: TEST_STRATEGY_CHANGED' "$PROJ/aidlc-docs/audit.md")
assert_eq "$DEPTH_COUNT" "1" "config-change with both flags logs exactly one DEPTH_CHANGED"
assert_eq "$STRAT_COUNT" "1" "config-change with both flags logs exactly one TEST_STRATEGY_CHANGED"
cleanup_test_project "$PROJ"

# --- Test 56: config-change with depth no-op emits only TEST_STRATEGY_CHANGED ---
# Test strategy defaults to "Comprehensive" in state-mid-ideation fixture (matches depth "Standard" is wrong actually — check)
# state-mid-ideation has Depth: Standard, so --depth standard is a no-op.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
OUT56=$(bun "$TOOL" config-change --depth standard --test-strategy minimal --project-dir "$PROJ" 2>/dev/null)
assert_contains "$OUT56" "Depth is already Standard" "config-change depth no-op prints already message"
# DEPTH_CHANGED must not be appended when depth is a no-op.
if grep -q '^\*\*Event\*\*: DEPTH_CHANGED' "$PROJ/aidlc-docs/audit.md"; then
  not_ok "config-change depth no-op does not append DEPTH_CHANGED"
else
  ok "config-change depth no-op does not append DEPTH_CHANGED"
fi
cleanup_test_project "$PROJ"

# --- Test 57: config-change validates both flags before any state write ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
seed_audit_file "$PROJ"
MD5_BEFORE=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
OUT57=$(bun "$TOOL" config-change --depth minimal --test-strategy extreme --project-dir "$PROJ" 2>&1 || true)
MD5_AFTER=$(md5sum "$PROJ/aidlc-docs/aidlc-state.md" | awk '{print $1}')
assert_contains "$OUT57" "Unknown test strategy" "config-change invalid strategy prints error"
assert_eq "$MD5_BEFORE" "$MD5_AFTER" "config-change validates both flags before writing"
cleanup_test_project "$PROJ"

# --- Test 58: config-change with no flags errors ---
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
OUT58=$(bun "$TOOL" config-change --project-dir "$PROJ" 2>&1 || true)
assert_contains "$OUT58" "requires" "config-change with no flags prints usage error"
cleanup_test_project "$PROJ"

# --- Test 59: doctor reports AWS_AIDLC_DEFAULT_SCOPE unset ---
# reset_aidlc_env at top of file guarantees unset state for this case.
PROJ=$(create_test_project)
OUT59=$(bun "$TOOL" doctor --project-dir "$PROJ" 2>/dev/null || true)
assert_contains "$OUT59" "AWS_AIDLC_DEFAULT_SCOPE (unset" "doctor reports unset env scope"
cleanup_test_project "$PROJ"

# --- Test 60: doctor reports AWS_AIDLC_DEFAULT_SCOPE=workshop as valid ---
PROJ=$(create_test_project)
OUT60=$(AWS_AIDLC_DEFAULT_SCOPE=workshop bun "$TOOL" doctor --project-dir "$PROJ" 2>/dev/null || true)
assert_contains "$OUT60" "AWS_AIDLC_DEFAULT_SCOPE=workshop (valid)" "doctor reports valid env scope"
cleanup_test_project "$PROJ"

# --- Test 61: doctor reports AWS_AIDLC_DEFAULT_SCOPE=bogus as invalid ---
PROJ=$(create_test_project)
OUT61=$(AWS_AIDLC_DEFAULT_SCOPE=bogus bun "$TOOL" doctor --project-dir "$PROJ" 2>/dev/null || true)
assert_contains "$OUT61" "AWS_AIDLC_DEFAULT_SCOPE=bogus (invalid)" "doctor reports invalid env scope"
cleanup_test_project "$PROJ"

# --- Test 62: resolve-env-scope with unset env prints nothing and exits 0 ---
OUT62=$(bun "$TOOL" resolve-env-scope 2>&1)
RC62=$?
assert_eq "$RC62" "0" "resolve-env-scope unset exits 0"
assert_eq "$OUT62" "" "resolve-env-scope unset prints nothing"

# --- Test 63: resolve-env-scope with valid env prints scope= line ---
OUT63=$(AWS_AIDLC_DEFAULT_SCOPE=workshop bun "$TOOL" resolve-env-scope 2>&1)
RC63=$?
assert_eq "$RC63" "0" "resolve-env-scope valid exits 0"
assert_contains "$OUT63" "scope=workshop" "resolve-env-scope valid prints scope line"

# --- Test 64: resolve-env-scope with invalid env exits 1 with canonical error ---
set +e
OUT64=$(AWS_AIDLC_DEFAULT_SCOPE=bogus bun "$TOOL" resolve-env-scope 2>&1)
RC64=$?
set -e
assert_eq "$RC64" "1" "resolve-env-scope invalid exits 1"
assert_contains "$OUT64" 'Invalid AWS_AIDLC_DEFAULT_SCOPE' "resolve-env-scope invalid prints canonical error"

# --- Test 65: detect-scope emits SCOPE_DETECTED ---
PROJ=$(create_test_project)
bun "$TOOL" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" detect-scope --scope feature --input "build a todo app" --source freeform --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "SCOPE_DETECTED" "detect-scope emits SCOPE_DETECTED"
cleanup_test_project "$PROJ"

# --- Test 66: detect-scope rejects invalid scope ---
PROJ=$(create_test_project)
bun "$TOOL" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
set +e
OUT=$(bun "$TOOL" detect-scope --scope bogus --input "x" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "detect-scope invalid scope exits 1"
cleanup_test_project "$PROJ"

# --- Test 67: status shows "Awaiting your approval" for [?] stage ---
PROJ=$(create_test_project)
bun "$TOOL" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
STATE_TOOL="$AIDLC_SRC/tools/aidlc-state.ts"
bun "$STATE_TOOL" advance workspace-scaffold --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE_TOOL" advance workspace-detection --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE_TOOL" advance state-init --project-dir "$PROJ" >/dev/null 2>&1
CURRENT=$(bun "$STATE_TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
bun "$STATE_TOOL" gate-start "$CURRENT" --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" status --project-dir "$PROJ" 2>/dev/null)
assert_contains "$OUT" "Awaiting your approval" "status shows awaiting-approval for [?] stage"
cleanup_test_project "$PROJ"

# --- Test 68: status shows "Revising" for [R] stage ---
PROJ=$(create_test_project)
bun "$TOOL" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE_TOOL" advance workspace-scaffold --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE_TOOL" advance workspace-detection --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE_TOOL" advance state-init --project-dir "$PROJ" >/dev/null 2>&1
CURRENT=$(bun "$STATE_TOOL" get "Current Stage" --project-dir "$PROJ" 2>&1)
bun "$STATE_TOOL" gate-start "$CURRENT" --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE_TOOL" reject "$CURRENT" --feedback "try again" --project-dir "$PROJ" >/dev/null 2>&1
OUT=$(bun "$TOOL" status --project-dir "$PROJ" 2>/dev/null)
assert_contains "$OUT" "Revising" "status shows Revising for [R] stage"
assert_contains "$OUT" "revision 1 of 3" "status shows revision count"
cleanup_test_project "$PROJ"

# --- Test 69: handleInit emits WORKFLOW_STARTED as first event ---
PROJ=$(create_test_project)
bun "$TOOL" init --scope bugfix --project-dir "$PROJ" >/dev/null 2>&1
# First event after the `# AI-DLC Audit Log` header should be WORKFLOW_STARTED
FIRST_EVENT=$(grep -m 1 "^\*\*Event\*\*:" "$PROJ/aidlc-docs/audit.md" | awk '{print $2}')
assert_eq "$FIRST_EVENT" "WORKFLOW_STARTED" "init emits WORKFLOW_STARTED as first event"
cleanup_test_project "$PROJ"

finish
