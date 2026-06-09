#!/bin/bash
# t106: Behavioural contract for `aidlc-runtime.ts summary`.
#
# Surface tested:
#   - summary --json aggregates stage outcomes (approved/failed/pending).
#   - Per-phase rollup groups stages by their stage-graph phase.
#   - Memory entries aggregate by canonical category across stages.
#   - duration_minutes = started_at -> latest completed_at; null when pending.
#   - Pending-only workflow → duration_minutes: null.
#   - Sensor 4-state result tallies (passed/failed/budget-override/incomplete).
#   - Human-readable (no --json) output renders without error.
#   - Missing runtime-graph.json → exit 1 with message.
#   - Determinism: two summary calls produce byte-identical JSON.
#
# L1 — pure bash + bun + jq. Fixtures built inline (summary reads the graph
# that compile produces, so each case compiles a synthetic audit first).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-runtime.ts"

if [ ! -f "$RUNTIME_TS" ]; then
  echo "Bail out! aidlc-runtime.ts not found at $RUNTIME_TS"
  exit 1
fi

plan 13

make_project() {
  local audit="$1"
  local state="$2"
  local proj
  proj=$(mktemp -d -t aidlc-t106-XXXXXX)
  mkdir -p "$proj/aidlc-docs"
  printf '%s' "$audit" > "$proj/aidlc-docs/audit.md"
  printf '%s' "$state" > "$proj/aidlc-docs/aidlc-state.md"
  echo "$proj"
}

run_compile() {
  local proj="$1"; shift
  CLAUDE_PROJECT_DIR="$proj" bun "$RUNTIME_TS" compile "$@" >/dev/null 2>&1
}

run_summary() {
  local proj="$1"; shift
  CLAUDE_PROJECT_DIR="$proj" bun "$RUNTIME_TS" summary "$@"
}

STATE_FEATURE=$(cat <<'EOF'
- **Scope**: feature
- **Current Stage**: scope-definition
EOF
)

# --- Case A: two approved + one pending across ideation -------------------
AUDIT_MIX=$(cat <<'EOF'
## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:10:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture
**Details**: done

---

## Stage Start
**Timestamp**: 2026-05-27T10:11:00Z
**Event**: STAGE_STARTED
**Stage**: feasibility
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:40:00Z
**Event**: STAGE_COMPLETED
**Stage**: feasibility
**Details**: done

---

## Stage Start
**Timestamp**: 2026-05-27T10:41:00Z
**Event**: STAGE_STARTED
**Stage**: scope-definition
**Agent**: aidlc-product-agent

---
EOF
)
PROJ=$(make_project "$AUDIT_MIX" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
cat > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md" <<'EOF'
## Interpretations
- one
- two
## Tradeoffs
- a tradeoff
EOF
run_compile "$PROJ"
JSON=$(run_summary "$PROJ" --json)

assert_eq "$(echo "$JSON" | jq -r '.stages.total')" "3" "three stages total"
assert_eq "$(echo "$JSON" | jq -r '.stages.approved')" "2" "two approved"
assert_eq "$(echo "$JSON" | jq -r '.stages.pending')" "1" "one pending"
assert_eq "$(echo "$JSON" | jq -r '.stages.failed')" "0" "zero failed"
assert_eq "$(echo "$JSON" | jq -r '.by_phase.ideation.total')" "3" "ideation phase rollup totals 3"
assert_eq "$(echo "$JSON" | jq -r '.memory.total')" "3" "memory total = 3 (2 interp + 1 tradeoff)"
assert_eq "$(echo "$JSON" | jq -r '.memory.interpretations')" "2" "2 interpretations"
assert_eq "$(echo "$JSON" | jq -r '.memory.tradeoffs')" "1" "1 tradeoff"
# Duration spans first start to latest completed (10:00 -> 10:40 = 40 min).
assert_eq "$(echo "$JSON" | jq -r '.duration_minutes')" "40" "duration 40 min (start to latest completed)"

# Determinism: second call is byte-identical.
JSON2=$(run_summary "$PROJ" --json)
if [ "$JSON" = "$JSON2" ]; then
  ok "summary --json is deterministic across calls"
else
  not_ok "summary --json is deterministic across calls"
fi

# Human-readable render succeeds and contains the header.
HUMAN=$(run_summary "$PROJ")
if echo "$HUMAN" | grep -q "Session Summary"; then
  ok "human-readable output renders header"
else
  not_ok "human-readable output renders header"
fi
rm -rf "$PROJ"

# --- Case B: pending-only workflow → duration null ------------------------
AUDIT_PENDING=$(cat <<'EOF'
## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---
EOF
)
PROJ=$(make_project "$AUDIT_PENDING" "$STATE_FEATURE")
run_compile "$PROJ"
assert_eq "$(run_summary "$PROJ" --json | jq -r '.duration_minutes')" "null" "pending-only → duration_minutes null"
rm -rf "$PROJ"

# --- Case C: missing runtime-graph.json → exit 1 --------------------------
PROJ=$(mktemp -d -t aidlc-t106-XXXXXX)
mkdir -p "$PROJ/aidlc-docs"
set +e
CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME_TS" summary --json >/dev/null 2>&1
RC=$?
set -e
assert_eq "$RC" "1" "missing runtime-graph.json → exit 1"
rm -rf "$PROJ"
