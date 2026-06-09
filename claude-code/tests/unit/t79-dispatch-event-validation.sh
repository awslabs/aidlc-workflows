#!/bin/bash
# t79: aidlc-bolt dispatch-event subcommand contract (v0.4.0 MR 13).
#
# MR 13 wires the three pre-registered MERGE_DISPATCH_* audit events
# (audit-format.md:147-149) by adding a new dispatch-event subcommand to
# aidlc-bolt.ts. The subcommand emits one literal appendAuditEntry per
# event variant — t48 emitter-pairing requires this (Map indirection on
# the --event flag would break t48's literal-string grep).
#
# This test pins the contract:
#   1. INVOKED variant emits with required fields (Bolt slug, Practices
#      section excerpt) — orchestrator pre-call instrumentation
#   2. RETURNED variant validates --strategy enum (squash|merge|rebase),
#      --confidence range [0, 1], and emits all 5 fields
#   3. FALLBACK variant emits with required fields (Bolt slug, Fallback
#      reason, Defaults applied) — orchestrator post-call advisory
#   4. Unknown --event values are rejected with a meaningful error
#   5. Missing required flags are rejected per variant
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 12

PROJ=$(setup_integration_project --with-greenfield-stub)
BOLT="bun $AIDLC_SRC/tools/aidlc-bolt.ts"
AUDIT="$PROJ/aidlc-docs/audit.md"

# --- Test 1: MERGE_DISPATCH_INVOKED emits with required fields ---
INVOKED_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_INVOKED \
  --slug t79-bolt-1 \
  --practices-excerpt "We use trunk-based development" \
  --project-dir "$PROJ" 2>&1)
if echo "$INVOKED_OUT" | grep -q '"emitted":"MERGE_DISPATCH_INVOKED"'; then
  ok "INVOKED returns JSON envelope with emitted=MERGE_DISPATCH_INVOKED"
else
  not_ok "INVOKED envelope missing emitted field" "$INVOKED_OUT"
fi

# --- Test 2: INVOKED audit row appears in audit.md ---
if grep -q "MERGE_DISPATCH_INVOKED" "$AUDIT"; then
  ok "INVOKED row landed in audit.md"
else
  not_ok "INVOKED row missing from audit.md" "$(grep -c MERGE_ "$AUDIT" || echo 0)"
fi

# --- Test 3: MERGE_DISPATCH_RETURNED emits with all 5 fields ---
RETURNED_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_RETURNED \
  --slug t79-bolt-1 \
  --strategy squash \
  --target main \
  --confidence 0.92 \
  --notes "trunk-based per team.md" \
  --project-dir "$PROJ" 2>&1)
if echo "$RETURNED_OUT" | grep -q '"emitted":"MERGE_DISPATCH_RETURNED"'; then
  ok "RETURNED returns JSON envelope"
else
  not_ok "RETURNED envelope missing emitted field" "$RETURNED_OUT"
fi

# --- Test 4: RETURNED audit row carries all 5 schema fields ---
RETURNED_BLOCK=$(awk '/MERGE_DISPATCH_RETURNED/{flag=1} flag && /^---$/{exit} flag' "$AUDIT")
if echo "$RETURNED_BLOCK" | grep -q "\*\*Strategy\*\*: squash" \
  && echo "$RETURNED_BLOCK" | grep -q "\*\*Target branch\*\*: main" \
  && echo "$RETURNED_BLOCK" | grep -q "\*\*Confidence\*\*: 0.92" \
  && echo "$RETURNED_BLOCK" | grep -q "\*\*Notes\*\*: trunk-based per team.md"; then
  ok "RETURNED audit row carries Strategy, Target, Confidence, Notes"
else
  not_ok "RETURNED audit row missing one or more fields" "$RETURNED_BLOCK"
fi

# --- Test 5: MERGE_DISPATCH_FALLBACK emits with required fields ---
FALLBACK_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_FALLBACK \
  --slug t79-bolt-1 \
  --reason timeout \
  --defaults "squash + main" \
  --project-dir "$PROJ" 2>&1)
if echo "$FALLBACK_OUT" | grep -q '"emitted":"MERGE_DISPATCH_FALLBACK"'; then
  ok "FALLBACK returns JSON envelope"
else
  not_ok "FALLBACK envelope missing emitted field" "$FALLBACK_OUT"
fi

# --- Test 6: FALLBACK audit row carries Fallback reason + Defaults applied ---
FALLBACK_BLOCK=$(awk '/MERGE_DISPATCH_FALLBACK/{flag=1} flag && /^---$/{exit} flag' "$AUDIT")
if echo "$FALLBACK_BLOCK" | grep -q "\*\*Fallback reason\*\*: timeout" \
  && echo "$FALLBACK_BLOCK" | grep -q "\*\*Defaults applied\*\*: squash + main"; then
  ok "FALLBACK audit row carries Fallback reason and Defaults applied"
else
  not_ok "FALLBACK audit row missing fields" "$FALLBACK_BLOCK"
fi

# --- Test 7: Unknown --event value is rejected ---
BAD_EVENT_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_INVALID \
  --slug t79-bolt-x \
  --project-dir "$PROJ" 2>&1 || true)
if echo "$BAD_EVENT_OUT" | grep -q "Invalid --event"; then
  ok "Unknown --event rejected with error"
else
  not_ok "Unknown --event accepted (should be rejected)" "$BAD_EVENT_OUT"
fi

# --- Test 8: Missing --slug rejected ---
NO_SLUG_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_INVOKED \
  --practices-excerpt "x" \
  --project-dir "$PROJ" 2>&1 || true)
if echo "$NO_SLUG_OUT" | grep -q "Missing --slug"; then
  ok "Missing --slug rejected"
else
  not_ok "Missing --slug accepted" "$NO_SLUG_OUT"
fi

# --- Test 9: INVOKED rejects missing --practices-excerpt ---
NO_EXCERPT_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_INVOKED \
  --slug t79-bolt-x \
  --project-dir "$PROJ" 2>&1 || true)
if echo "$NO_EXCERPT_OUT" | grep -q "requires --practices-excerpt"; then
  ok "INVOKED requires --practices-excerpt"
else
  not_ok "INVOKED accepted without --practices-excerpt" "$NO_EXCERPT_OUT"
fi

# --- Test 10: RETURNED rejects invalid --strategy ---
BAD_STRAT_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_RETURNED \
  --slug t79-bolt-x \
  --strategy badstrat \
  --target main \
  --confidence 0.5 \
  --notes "x" \
  --project-dir "$PROJ" 2>&1 || true)
if echo "$BAD_STRAT_OUT" | grep -q "Invalid --strategy"; then
  ok "Invalid --strategy rejected"
else
  not_ok "Invalid --strategy accepted" "$BAD_STRAT_OUT"
fi

# --- Test 11: RETURNED rejects --confidence out of range ---
BAD_CONF_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_RETURNED \
  --slug t79-bolt-x \
  --strategy squash \
  --target main \
  --confidence 1.5 \
  --notes "x" \
  --project-dir "$PROJ" 2>&1 || true)
if echo "$BAD_CONF_OUT" | grep -q "Invalid --confidence"; then
  ok "--confidence out of [0,1] rejected"
else
  not_ok "Out-of-range --confidence accepted" "$BAD_CONF_OUT"
fi

# --- Test 12: FALLBACK rejects missing --reason ---
NO_REASON_OUT=$($BOLT dispatch-event \
  --event MERGE_DISPATCH_FALLBACK \
  --slug t79-bolt-x \
  --defaults "x" \
  --project-dir "$PROJ" 2>&1 || true)
if echo "$NO_REASON_OUT" | grep -q "requires --reason"; then
  ok "FALLBACK requires --reason"
else
  not_ok "FALLBACK accepted without --reason" "$NO_REASON_OUT"
fi

cleanup_test_project "$PROJ"
finish
