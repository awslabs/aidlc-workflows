#!/bin/bash
# t33: Unit tests for aidlc-bolt.ts (start, complete, fail, set-autonomy)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-bolt.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 25

# --- Test 1: start emits BOLT_STARTED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" start --name "auth-service" --batch 1 --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: BOLT_STARTED" "start emits BOLT_STARTED"
cleanup_test_project "$PROJ"

# --- Test 2: start records Bolt names + Batch number ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" start --name "auth-service" --batch 1 --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Batch number\*\*: 1' "start records Batch number"
cleanup_test_project "$PROJ"

# --- Test 3: start accepts CSV bolt names (parallel batch) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" start --name "auth-service,payment-service,user-service" --batch 2 --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "auth-service,payment-service,user-service" "start records CSV bolt names"
cleanup_test_project "$PROJ"

# --- Test 4: start --walking-skeleton true flags Walking skeleton=true ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" start --name b1 --batch 1 --walking-skeleton true --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Walking skeleton\*\*: true' "start --walking-skeleton true flags correctly"
cleanup_test_project "$PROJ"

# --- Test 5: start missing --name exits 1 ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" start --batch 1 --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "start missing --name exits 1"
cleanup_test_project "$PROJ"

# --- Test 6: start missing --batch exits 1 ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" start --name b1 --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "start missing --batch exits 1"
cleanup_test_project "$PROJ"

# --- Test 7: complete emits BOLT_COMPLETED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" complete --name "auth-service" --batch 1 --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: BOLT_COMPLETED" "complete emits BOLT_COMPLETED"
cleanup_test_project "$PROJ"

# --- Test 8: fail emits BOLT_FAILED with error summary ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" fail --name "auth-service" --error "Compilation failed" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Error summary\*\*: Compilation failed' "fail records Error summary"
cleanup_test_project "$PROJ"

# --- Test 9: fail --succeeded-siblings records sibling bolts ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" fail --name "auth" --error "boom" --succeeded-siblings "payment,user" --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Succeeded siblings\*\*: payment,user' "fail records Succeeded siblings"
cleanup_test_project "$PROJ"

# Helper — seed the Construction fixture and inject Construction Autonomy Mode
# (the fixture pre-dates the field). Done via setup helper so each test has a
# known-good starting state.
setup_construction_project() {
  local proj
  proj=$(create_test_project)
  seed_state_file "$proj" "$FIXTURES_DIR/state-construction.md"
  seed_audit_file "$proj"
  # Inject the field right before Construction Autonomy Mode's parent section
  # (append to end of file is fine — setFieldStrict parses by key, not location)
  printf '\n- **Construction Autonomy Mode**: gated\n' >> "$proj/aidlc-docs/aidlc-state.md"
  echo "$proj"
}

# --- Test 10: set-autonomy emits AUTONOMY_MODE_SET ---
PROJ=$(setup_construction_project)
bun "$TOOL" set-autonomy --mode autonomous --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" "^\*\*Event\*\*: AUTONOMY_MODE_SET" "set-autonomy emits AUTONOMY_MODE_SET"
cleanup_test_project "$PROJ"

# --- Test 11: set-autonomy updates Construction Autonomy Mode in state file ---
PROJ=$(setup_construction_project)
bun "$TOOL" set-autonomy --mode autonomous --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" "Construction Autonomy Mode.*autonomous" \
  "set-autonomy updates state field"
cleanup_test_project "$PROJ"

# --- Test 12: set-autonomy --mode gated is accepted ---
PROJ=$(setup_construction_project)
bun "$TOOL" set-autonomy --mode gated --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/aidlc-state.md" "Construction Autonomy Mode.*gated" \
  "set-autonomy --mode gated updates state"
cleanup_test_project "$PROJ"

# --- Test 13: set-autonomy --mode bogus exits 1 ---
PROJ=$(setup_construction_project)
set +e
OUT=$(bun "$TOOL" set-autonomy --mode bogus --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "set-autonomy --mode bogus exits 1"
cleanup_test_project "$PROJ"

# --- Test 14: set-autonomy missing --mode exits 1 ---
PROJ=$(setup_construction_project)
set +e
OUT=$(bun "$TOOL" set-autonomy --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "set-autonomy missing --mode exits 1"
cleanup_test_project "$PROJ"

# --- Test 15: set-autonomy errors cleanly when state field is absent (adversarial finding E) ---
PROJ=$(create_test_project)
# Make a minimal state file WITHOUT Construction Autonomy Mode field
cat > "$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
# AIDLC State
- **Scope**: feature
- **Status**: Running
## Stage Progress
- [-] feasibility — EXECUTE
EOF
seed_audit_file "$PROJ"
set +e
OUT=$(bun "$TOOL" set-autonomy --mode autonomous --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "set-autonomy exits 1 when Construction Autonomy Mode absent (v4 state file guard)"
cleanup_test_project "$PROJ"

# --- Test 16: unknown subcommand exits 1 ---
PROJ=$(create_test_project)
set +e
OUT=$(bun "$TOOL" bogus --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "unknown subcommand exits 1"
cleanup_test_project "$PROJ"

# --- Test 17: set-autonomy on v4 state file leaves NO orphan audit (audit-first) ---
# Regression test: previously emitted AUTONOMY_MODE_SET before validating the
# state field existed, leaving an orphan audit entry when the field was absent.
PROJ=$(create_test_project)
cat > "$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
# AIDLC State
- **Scope**: feature
- **Status**: Running
## Stage Progress
- [-] feasibility — EXECUTE
EOF
seed_audit_file "$PROJ"
set +e
bun "$TOOL" set-autonomy --mode autonomous --project-dir "$PROJ" >/dev/null 2>&1
RC=$?
set -e
assert_eq "$RC" "1" "set-autonomy on v4 state file exits 1"
assert_not_grep "$PROJ/aidlc-docs/audit.md" "AUTONOMY_MODE_SET" \
  "set-autonomy on v4 state file does NOT leave orphan AUTONOMY_MODE_SET in audit"
cleanup_test_project "$PROJ"

# --- Test 18: start --batch non-numeric exits 1 ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
set +e
OUT=$(bun "$TOOL" start --name b1 --batch "not-a-number" --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "start --batch non-numeric exits 1"
cleanup_test_project "$PROJ"

# --- Test 19: start --batch 0 exits 1 (must be positive) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
set +e
OUT=$(bun "$TOOL" start --name b1 --batch 0 --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "start --batch 0 exits 1 (must be positive)"
cleanup_test_project "$PROJ"

# --- Test 20: parseFlags rejects --flag without value (no silent flag-as-value) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
set +e
OUT=$(bun "$TOOL" start --name --batch 1 --project-dir "$PROJ" 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "start --name without value (followed by --batch) errors cleanly"
cleanup_test_project "$PROJ"

# --- Test 21: start --walking-skeleton absent defaults to Walking skeleton: false ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" start --name b1 --batch 1 --project-dir "$PROJ" >/dev/null 2>&1
assert_grep "$PROJ/aidlc-docs/audit.md" '\*\*Walking skeleton\*\*: false' \
  "start without --walking-skeleton defaults to false"
cleanup_test_project "$PROJ"

# --- Test 22: start prints JSON ack on stdout ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
OUT=$(bun "$TOOL" start --name b1 --batch 1 --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"emitted":"BOLT_STARTED"' "start prints JSON with emitted field"
cleanup_test_project "$PROJ"

# --- Test 23: set-autonomy JSON ack includes state_updated:true ---
PROJ=$(setup_construction_project)
OUT=$(bun "$TOOL" set-autonomy --mode autonomous --project-dir "$PROJ" 2>&1)
assert_contains "$OUT" '"state_updated":true' "set-autonomy JSON ack includes state_updated:true"
cleanup_test_project "$PROJ"

# --- Test 24: Full bolt lifecycle — start → complete sequence ---
# Integration-style test proving the orchestrator's per-Bolt sequence produces
# the expected audit stream (BOLT_STARTED then BOLT_COMPLETED for the same
# bolt names).
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
bun "$TOOL" start --name "auth-service" --batch 1 --walking-skeleton true --project-dir "$PROJ" >/dev/null 2>&1
bun "$TOOL" complete --name "auth-service" --batch 1 --project-dir "$PROJ" >/dev/null 2>&1
START_LINE=$(grep -n "^\*\*Event\*\*: BOLT_STARTED" "$PROJ/aidlc-docs/audit.md" | head -1 | cut -d: -f1)
COMPLETE_LINE=$(grep -n "^\*\*Event\*\*: BOLT_COMPLETED" "$PROJ/aidlc-docs/audit.md" | head -1 | cut -d: -f1)
if [ -n "$START_LINE" ] && [ -n "$COMPLETE_LINE" ] && [ "$START_LINE" -lt "$COMPLETE_LINE" ]; then
  ok "bolt lifecycle: BOLT_STARTED precedes BOLT_COMPLETED for same bolt"
else
  not_ok "bolt lifecycle: start→complete ordering" "start=$START_LINE complete=$COMPLETE_LINE"
fi
cleanup_test_project "$PROJ"

finish
