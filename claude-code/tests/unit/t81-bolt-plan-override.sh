#!/bin/bash
# t81: bolt-plan-marker-conflict semantic for PRACTICES_OVERRIDE (v0.4.0 MR 13).
#
# v5 §3a: instead of introducing a new BOLT_PLAN_OVERRIDDEN event, MR 13
# reuses the existing PRACTICES_OVERRIDE event with a discriminator field
# (Reason). MR 8 emits PRACTICES_OVERRIDE for write-failure semantics
# (Reason: write-failure-*); MR 13 emits it for orchestrator-overrides-
# bolt-plan-marker semantics (Reason: bolt-plan-marker-conflict, plus
# Practices Stance + Bolt-Plan Marker + Bolt slug fields).
#
# This test pins:
#   1. The existing --type override accepts arbitrary --field "Key: Value"
#      pairs without modification — discriminator-field disambiguation
#      requires zero new code in handlePracticesEvent
#   2. The audit row carries Reason=bolt-plan-marker-conflict alongside
#      MR 13's added fields (Practices Stance, Bolt-Plan Marker, Bolt slug)
#   3. t28 audit count tracks current pin (no new event introduced by THIS MR's
#      discriminator-field reuse — bumped 55 → 60 in v0.5.0 MR 1 for sensors;
#      → 61 in v0.5.0 MR 4 for MEMORY_EMPTY)
#   4. Coexists with MR 8's write-failure path (same event, different fields)
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

plan 4

PROJ=$(setup_integration_project --with-greenfield-stub)
STATE_TOOL="bun $AIDLC_SRC/tools/aidlc-state.ts"
AUDIT="$PROJ/aidlc-docs/audit.md"

# --- Test 1: practices-event --type override accepts the MR 13 field set ---
OVERRIDE_OUT=$($STATE_TOOL practices-event \
  --type override \
  --field "Reason: bolt-plan-marker-conflict" \
  --field "Practices Stance: never-skeleton" \
  --field "Bolt-Plan Marker: walking-skeleton" \
  --field "Bolt slug: t81-bolt-1" \
  --project-dir "$PROJ" 2>&1)
if echo "$OVERRIDE_OUT" | grep -q '"emitted":"PRACTICES_OVERRIDE"'; then
  ok "practices-event --type override accepts MR 13 field set"
else
  not_ok "--type override rejected MR 13 fields" "$OVERRIDE_OUT"
fi

# --- Test 2: audit row carries discriminator + MR 13 fields ---
OVERRIDE_BLOCK=$(awk '/PRACTICES_OVERRIDE/{flag=1} flag && /^---$/{exit} flag' "$AUDIT")
if echo "$OVERRIDE_BLOCK" | grep -q "\*\*Reason\*\*: bolt-plan-marker-conflict" \
  && echo "$OVERRIDE_BLOCK" | grep -q "\*\*Practices Stance\*\*: never-skeleton" \
  && echo "$OVERRIDE_BLOCK" | grep -q "\*\*Bolt-Plan Marker\*\*: walking-skeleton" \
  && echo "$OVERRIDE_BLOCK" | grep -q "\*\*Bolt slug\*\*: t81-bolt-1"; then
  ok "PRACTICES_OVERRIDE audit row carries discriminator Reason + MR 13 fields"
else
  not_ok "PRACTICES_OVERRIDE row missing discriminator or MR 13 fields" "$OVERRIDE_BLOCK"
fi

# --- Test 3: t28 audit count unchanged BY THIS MR's discriminator reuse ---
# Read the current pinned count from t28 itself. The bolt-plan-marker-conflict
# semantic reuses PRACTICES_OVERRIDE (discriminator-field disambiguation) and
# does NOT bump the count. The pinned value tracks the framework's current
# total — bumped 55 → 60 in v0.5.0 MR 1 when sensor events were pre-registered;
# → 61 in v0.5.0 MR 4 when MEMORY_EMPTY was pre-registered;
# → 63 in v0.5.0 MR 12 when RULE_LEARNED + SENSOR_PROPOSED were registered;
# → 61 in v0.5.0 MR 15 when the dead GUARDRAIL_TRIGGERED + GUARDRAIL_LEARNED
#   guardrail-learning events were retired (subsystem superseded by the §13
#   learnings ritual; GUARDRAIL_LOADED is a separate live doctor event, kept);
# → 66 in v0.6.0 MR 2 when the five SWARM_* lifecycle events were pre-registered
#   (Reserved rows; emitters wired by aidlc-swarm.ts in a later MR);
# → 67 in v0.6.0 Wave 4 MR 16 when SWARM_DEGRADED was born live (the loud-degrade
#   audit cell the referee's `prepare` emits on a Workflow-tool downgrade).
T28="$REPO_ROOT/tests/unit/t28-audit-event-sync.sh"
PINNED=$(grep -E "assert_eq[[:space:]]+[0-9]+[[:space:]]+\"\\\$TS_COUNT\"" "$T28" | sed -E 's/.*assert_eq[[:space:]]+([0-9]+).*/\1/')
if [ "$PINNED" = "67" ]; then
  ok "t28 pins event count at 67 (v0.6.0 Wave 4 MR 16 baseline; no bump from this MR's discriminator reuse)"
else
  not_ok "t28 pin drifted from 67" "got: $PINNED"
fi

# --- Test 4: MR 8 write-failure path coexists (different Reason value) ---
# Synthesise an MR 8-style emit and confirm both rows live in the same event
# space without collision.
WRITE_FAIL_OUT=$($STATE_TOOL practices-event \
  --type override \
  --field "Reason: write-failure-permission-denied" \
  --project-dir "$PROJ" 2>&1)
WRITE_FAIL_COUNT=$(grep -c "PRACTICES_OVERRIDE" "$AUDIT")
if echo "$WRITE_FAIL_OUT" | grep -q '"emitted":"PRACTICES_OVERRIDE"' \
  && [ "$WRITE_FAIL_COUNT" -ge 2 ]; then
  ok "PRACTICES_OVERRIDE coexists across both Reason discriminators"
else
  not_ok "Discriminator field doesn't disambiguate two PRACTICES_OVERRIDE emits" \
    "envelope: $WRITE_FAIL_OUT; count: $WRITE_FAIL_COUNT"
fi

cleanup_test_project "$PROJ"
finish
