#!/bin/bash
# t52: Meta-test on t48 drift test.
#
# t48 enforces doc/code consistency with 5 checks (forward, reverse, tertiary,
# pairing, MD-MD). This meta-test verifies t48 actually CATCHES each failure
# mode by injecting a synthetic regression into a sandboxed copy of the source
# tree, running t48 against it, and asserting t48 fails with a diagnostic.
#
# Without this meta-test, t48 could regress silently — a bug in the drift
# test's detection logic would let real drift slip through unnoticed.
#
# Each injection works on a git-clean copy of the repo in a tmpdir so the real
# source stays untouched. Injections target specific patterns t48 is supposed
# to catch.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

plan 5

# Create a sandbox copy of the repo that we can mutate. Copy just the pieces
# t48 touches: the drift test itself, the doc, and the source tree it scans.
SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/t52-sandbox-XXXXXX")
trap 'rm -rf "$SANDBOX"' EXIT INT TERM
mkdir -p "$SANDBOX/dist" && cp -R "$REPO_ROOT/dist/claude" "$SANDBOX/dist/claude"
cp -R "$REPO_ROOT/docs" "$SANDBOX/docs"
cp -R "$REPO_ROOT/tests" "$SANDBOX/tests"

# Helper: run t48 against a custom REPO_ROOT by pointing its shell vars at the
# sandbox. t48 resolves paths via REPO_ROOT (set by fixtures.sh from the
# test's script location), so we run it with pwd set to the sandbox root.
run_t48_in_sandbox() {
  (
    cd "$SANDBOX"
    bash tests/feature/t48-audit-event-emitters.sh
  ) 2>&1
}

# --- Injection 1: rename an event at call site (forward check should fail) ---
reset_sandbox() {
  rm -rf "$SANDBOX/dist/claude" "$SANDBOX/docs"
  mkdir -p "$SANDBOX/dist" && cp -R "$REPO_ROOT/dist/claude" "$SANDBOX/dist/claude"
  cp -R "$REPO_ROOT/docs" "$SANDBOX/docs"
}

reset_sandbox
sed_i 's/emitAudit(pd, "GATE_APPROVED"/emitAudit(pd, "GATE_APPROVED_RENAMED"/' \
  "$SANDBOX/dist/claude/.claude/tools/aidlc-state.ts"
out=$(run_t48_in_sandbox || true)
# After rename, forward check loses the emission site for GATE_APPROVED.
# The forward check reports a failure in that row.
if echo "$out" | grep -qE "not ok.*forward|GATE_APPROVED"; then
  ok "forward check catches renamed emission"
else
  not_ok "forward check catches renamed emission" "t48 output:\n$out"
fi

# --- Injection 2: add undocumented emission (reverse check should fail) ---
reset_sandbox
# Append a stray emission with an event name NOT in VALID_EVENT_TYPES or the doc.
# Use an existing emitAudit-style line to bypass the comment-stripping decommented() helper.
echo 'emitAudit(pd, "PHANTOM_EVENT", { x: "y" });' >> \
  "$SANDBOX/dist/claude/.claude/tools/aidlc-state.ts"
out=$(run_t48_in_sandbox || true)
if echo "$out" | grep -qE "not ok.*(reverse|PHANTOM_EVENT)"; then
  ok "reverse check catches undocumented emission"
else
  not_ok "reverse check catches undocumented emission" "t48 output (last 30 lines):\n$(echo "$out" | tail -30)"
fi

# --- Injection 3: resurrect a deleted event (tertiary check should fail) ---
reset_sandbox
# JUMP_AUTO_STOPPED is one of the deleted events the tertiary check guards.
echo 'emitAudit(pd, "JUMP_AUTO_STOPPED", { x: "y" });' >> \
  "$SANDBOX/dist/claude/.claude/tools/aidlc-state.ts"
out=$(run_t48_in_sandbox || true)
if echo "$out" | grep -qE "not ok.*(tertiary|JUMP_AUTO_STOPPED|resurrected)"; then
  ok "tertiary check catches resurrected deleted event"
else
  not_ok "tertiary check catches resurrected deleted event" "t48 output:\n$(echo "$out" | tail -30)"
fi

# --- Injection 4: rename a handler (pairing check should fail) ---
reset_sandbox
sed_i 's/function handleApprove(args/function handleApproveRenamed(args/' \
  "$SANDBOX/dist/claude/.claude/tools/aidlc-state.ts"
out=$(run_t48_in_sandbox || true)
if echo "$out" | grep -qE "not ok.*(pairing|handleApprove.*not found|renamed)"; then
  ok "pairing check catches renamed handler"
else
  not_ok "pairing check catches renamed handler" "t48 output:\n$(echo "$out" | tail -30)"
fi

# --- Injection 5: desync audit-format.md vs 12-state-machine.md (MD-MD check) ---
reset_sandbox
# Remove ARTIFACT_REUSED from audit-format.md only; 12-state-machine.md still
# has it. MD-MD check should catch the divergence.
sed_i '/| `ARTIFACT_REUSED` |/d' \
  "$SANDBOX/dist/claude/.claude/knowledge/aidlc-shared/audit-format.md"
out=$(run_t48_in_sandbox || true)
if echo "$out" | grep -qE "not ok.*(md-md|ARTIFACT_REUSED)"; then
  ok "md-md check catches audit-format ↔ 12-state-machine drift"
else
  not_ok "md-md check catches audit-format ↔ 12-state-machine drift" \
    "t48 output:\n$(echo "$out" | tail -30)"
fi

finish
