#!/bin/bash
# t47: Failure-injection integration test.
#
# Exercises chaos conditions the state machine must handle without data loss:
#   1. Permission-denied on audit.md during a state transition — state must
#      not advance (audit-first throws before writeStateFile).
#   2. Missing audit.md — tool must either recreate it cleanly or error with
#      a diagnosable message.
#   3. Corrupted state file — tool errors cleanly, doesn't crash or partial-write.
#   4. Read-only state.md — audit lands with an ERROR_LOGGED trail, state stays
#      as before.
#
# Skipped when running as root (chmod 0444 doesn't work for root).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"
STATE="$AIDLC_SRC/tools/aidlc-state.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

# Root can write to chmod 0444 files, defeating the injection.
if [ "$(id -u)" = "0" ]; then
  echo "1..0 # SKIP running as root — chmod guards don't apply"
  exit 0
fi

plan 8

# --- Failure 1: Permission-denied on audit.md during state transition ---
#
# Setup: init bugfix, inject SESSION_COMPACTED, then chmod audit.md to read-
# only right before attempting to acknowledge. Audit-first means appendAuditEntry
# throws, the tool errors, state file stays untouched.
PROJ=$(create_test_project)
AIDLC_WORKFLOW_INTENT="chaos" \
  bun "$UTIL" init --scope bugfix --project-dir "$PROJ" --test-run >/dev/null 2>&1

audit="$PROJ/aidlc-docs/audit.md"
state="$PROJ/aidlc-docs/aidlc-state.md"

# Inject a SESSION_COMPACTED event so acknowledge-compaction has something to act on
cat >> "$audit" <<'EOF'

## Session Compacted
**Timestamp**: 2026-05-03T00:00:00Z
**Event**: SESSION_COMPACTED

---
EOF

# Snapshot state before injecting failure
state_before=$(cat "$state")

trap 'chmod 0644 "$audit" 2>/dev/null; cleanup_test_project "$PROJ"' EXIT INT TERM
chmod 0444 "$audit"

set +e
bun "$STATE" acknowledge-compaction --choice continue --project-dir "$PROJ" >/dev/null 2>&1
rc=$?
set -e

chmod 0644 "$audit"

assert_eq 1 "$rc" "acknowledge exits non-zero when audit.md is read-only"
state_after=$(cat "$state")
if [ "$state_before" = "$state_after" ]; then
  ok "state file unchanged after audit-write failure (audit-first holds)"
else
  not_ok "state file unchanged after audit-write failure (audit-first holds)" \
    "state mutated despite audit failure"
fi

trap - EXIT INT TERM
cleanup_test_project "$PROJ"

# --- Failure 2: Missing audit.md (tool must handle absence cleanly) ---
PROJ=$(create_test_project)
AIDLC_WORKFLOW_INTENT="chaos" \
  bun "$UTIL" init --scope bugfix --project-dir "$PROJ" --test-run >/dev/null 2>&1

rm "$PROJ/aidlc-docs/audit.md"

# gate-start reads state, writes audit. If audit doesn't exist the tool should
# recreate it (ensureAuditFile) — not crash.
set +e
bun "$STATE" gate-start requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
rc=$?
set -e
assert_eq 0 "$rc" "gate-start succeeds when audit.md was missing (ensureAuditFile recovers)"
if [ -f "$PROJ/aidlc-docs/audit.md" ]; then
  ok "audit.md recreated on demand"
else
  not_ok "audit.md recreated on demand" "file still missing"
fi
cleanup_test_project "$PROJ"

# --- Failure 3: Corrupted state file (missing required fields) ---
PROJ=$(create_test_project)
mkdir -p "$PROJ/aidlc-docs"
# State file that's valid markdown but missing Scope, Current Stage, etc.
cat > "$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
# AI-DLC State Tracking

## Project Information
- **Project**: corrupted test
EOF
cp "$REPO_ROOT/tests/fixtures/audit-sample.md" "$PROJ/aidlc-docs/audit.md"

set +e
out=$(bun "$STATE" advance requirements-analysis --project-dir "$PROJ" 2>&1)
rc=$?
set -e
assert_eq 1 "$rc" "advance errors on corrupted state (missing Scope)"
if echo "$out" | grep -q "Scope"; then
  ok "error message mentions the missing Scope field"
else
  not_ok "error message mentions the missing Scope field" "got: $out"
fi
cleanup_test_project "$PROJ"

# --- Failure 4: Read-only state.md (state tool can't write even if audit works) ---
PROJ=$(create_test_project)
AIDLC_WORKFLOW_INTENT="chaos" \
  bun "$UTIL" init --scope bugfix --project-dir "$PROJ" --test-run >/dev/null 2>&1

audit="$PROJ/aidlc-docs/audit.md"
state="$PROJ/aidlc-docs/aidlc-state.md"

# Count pre-existing ERROR_LOGGED events (should be 0 on clean init).
error_before=$(grep -cE '^\*\*Event\*\*: ERROR_LOGGED' "$audit" 2>/dev/null || true)
error_before=${error_before:-0}

trap 'chmod 0644 "$state" 2>/dev/null; cleanup_test_project "$PROJ"' EXIT INT TERM
chmod 0444 "$state"

set +e
bun "$STATE" gate-start requirements-analysis --project-dir "$PROJ" >/dev/null 2>&1
rc=$?
set -e

chmod 0644 "$state"

assert_eq 1 "$rc" "gate-start exits non-zero when state.md is read-only"

# ERROR_LOGGED should fire (via emitError) on the failure path.
error_after=$(grep -cE '^\*\*Event\*\*: ERROR_LOGGED' "$audit" 2>/dev/null || true)
error_after=${error_after:-0}
if [ "$error_after" -gt "$error_before" ]; then
  ok "ERROR_LOGGED emitted on state-write failure"
else
  not_ok "ERROR_LOGGED emitted on state-write failure" "before=$error_before after=$error_after"
fi

trap - EXIT INT TERM
cleanup_test_project "$PROJ"

finish
