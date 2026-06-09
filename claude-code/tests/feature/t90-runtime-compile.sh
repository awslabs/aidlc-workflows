#!/bin/bash
# t90: Behavioural contract for `aidlc-runtime.ts compile` (v0.5.0 MR 8). 29 tests.
#
# Surface tested:
#   - WORKFLOW_STARTED + STAGE_STARTED + STAGE_COMPLETED → one approved row.
#   - STAGE_STARTED with no later STAGE_COMPLETED → outcome: pending row.
#   - Re-jump (STARTED, COMPLETED, STARTED for same slug) → latest STARTED wins; pending.
#   - Per-stage memory.md populates memory_entries + memory_breakdown.
#   - Missing memory.md → memory_entries: null, memory_breakdown: null (v0.4.0 backfill).
#   - Empty memory.md (file exists, zero entries under canonical headings) → 0 + emit MEMORY_EMPTY.
#   - Pending rows do NOT emit MEMORY_EMPTY (even with zero entries).
#   - --test-run propagates Test-Run=true onto MEMORY_EMPTY rows.
#   - Idempotency: two compiles produce byte-equivalent runtime-graph.json.
#   - Missing aidlc-state.md → exit 0, no graph written.
#   - Missing audit.md but state present → empty stages array.
#
# L1 — pure bash + bun + jq. Fixtures built inline; no on-disk fixtures dir
# because the audit + state + memory.md combinations are too combinatorial.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-runtime.ts"

if [ ! -f "$RUNTIME_TS" ]; then
  echo "Bail out! aidlc-runtime.ts not found at $RUNTIME_TS"
  exit 1
fi

plan 29

# Helper: build a fresh project dir with the given audit.md + state.md.
# Returns the project dir path on stdout. Caller is responsible for
# adding memory.md files under aidlc-docs/<phase>/<slug>/ before invoking.
make_project() {
  local audit="$1"
  local state="$2"
  local proj
  proj=$(mktemp -d -t aidlc-t90-XXXXXX)
  mkdir -p "$proj/aidlc-docs"
  printf '%s' "$audit" > "$proj/aidlc-docs/audit.md"
  printf '%s' "$state" > "$proj/aidlc-docs/aidlc-state.md"
  echo "$proj"
}

run_compile() {
  local proj="$1"; shift
  CLAUDE_PROJECT_DIR="$proj" bun "$RUNTIME_TS" compile "$@" 2>&1
}

# Standard 1-stage approved audit.
AUDIT_ONE_APPROVED=$(cat <<'EOF'
## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature
**Request**: /aidlc feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture
**Details**: done

---
EOF
)

STATE_FEATURE=$(cat <<'EOF'
- **Scope**: feature
- **Current Stage**: scope-definition
EOF
)

# --- Case 1: one approved stage produces one approved row -----------------
PROJ=$(make_project "$AUDIT_ONE_APPROVED" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
cat > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md" <<'EOF'
## Interpretations
- entry one
EOF
run_compile "$PROJ" >/dev/null
OUTCOME=$(jq -r '.stages[0].outcome' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$OUTCOME" "approved" "one approved stage → outcome: approved"
ENTRIES=$(jq -r '.stages[0].memory_entries' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$ENTRIES" "1" "one approved stage → memory_entries: 1"
rm -rf "$PROJ"

# --- Case 2: STAGE_STARTED without later COMPLETED → pending row ----------
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
run_compile "$PROJ" >/dev/null
PEND=$(jq -r '.stages[0].outcome' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$PEND" "pending" "STAGE_STARTED without COMPLETED → outcome: pending"
PEND_TS=$(jq -r '.stages[0].completed_at' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$PEND_TS" "null" "pending row → completed_at: null"
rm -rf "$PROJ"

# --- Case 3: re-jump pairing — latest STARTED supersedes prior approved row -
AUDIT_REJUMP=$(cat <<'EOF'
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
**Timestamp**: 2026-05-27T10:02:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Stage Start
**Timestamp**: 2026-05-27T10:10:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---
EOF
)
PROJ=$(make_project "$AUDIT_REJUMP" "$STATE_FEATURE")
run_compile "$PROJ" >/dev/null
LEN=$(jq '.stages | length' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$LEN" "1" "re-jump → one row per slug"
REJUMP_OUTCOME=$(jq -r '.stages[0].outcome' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$REJUMP_OUTCOME" "pending" "re-jump → latest STARTED wins (pending)"
REJUMP_START=$(jq -r '.stages[0].started_at' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$REJUMP_START" "2026-05-27T10:10:00Z" "re-jump → started_at = latest STARTED"
rm -rf "$PROJ"

# --- Case 4: missing memory.md → memory_entries:null + no MEMORY_EMPTY -----
PROJ=$(make_project "$AUDIT_ONE_APPROVED" "$STATE_FEATURE")
# no memory.md created
run_compile "$PROJ" >/dev/null
NULL_ENTRIES=$(jq -r '.stages[0].memory_entries' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$NULL_ENTRIES" "null" "missing memory.md → memory_entries: null"
NULL_BREAK=$(jq -r '.stages[0].memory_breakdown' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$NULL_BREAK" "null" "missing memory.md → memory_breakdown: null"
EMPTY_COUNT=$(grep -c "^\\*\\*Event\\*\\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$EMPTY_COUNT" "0" "missing memory.md → no MEMORY_EMPTY emit (v0.4.0 backfill)"
rm -rf "$PROJ"

# --- Case 5: empty memory.md → memory_entries:0 + MEMORY_EMPTY emit --------
PROJ=$(make_project "$AUDIT_ONE_APPROVED" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
echo "" > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md"
run_compile "$PROJ" >/dev/null
ZERO_ENTRIES=$(jq -r '.stages[0].memory_entries' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$ZERO_ENTRIES" "0" "empty memory.md → memory_entries: 0"
EMPTY_COUNT=$(grep -c "^\\*\\*Event\\*\\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$EMPTY_COUNT" "1" "empty memory.md (approved) → one MEMORY_EMPTY row"
rm -rf "$PROJ"

# --- Case 6: --test-run propagates Test-Run=true to MEMORY_EMPTY -----------
PROJ=$(make_project "$AUDIT_ONE_APPROVED" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
echo "" > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md"
run_compile "$PROJ" --test-run >/dev/null
TR=$(awk '/^## Memory Empty$/,/^---$/' "$PROJ/aidlc-docs/audit.md" | grep -c '^\*\*Test-Run\*\*: true$' || true)
assert_eq "$TR" "1" "--test-run → MEMORY_EMPTY carries Test-Run: true"
rm -rf "$PROJ"

# --- Case 7: idempotency — re-compile is byte-equivalent -------------------
PROJ=$(make_project "$AUDIT_ONE_APPROVED" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
cat > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md" <<'EOF'
## Interpretations
- entry
EOF
run_compile "$PROJ" >/dev/null
SHA1=$(shasum -a 1 "$PROJ/aidlc-docs/runtime-graph.json" | awk '{print $1}')
run_compile "$PROJ" >/dev/null
SHA2=$(shasum -a 1 "$PROJ/aidlc-docs/runtime-graph.json" | awk '{print $1}')
assert_eq "$SHA1" "$SHA2" "two compiles → byte-equivalent runtime-graph.json"
rm -rf "$PROJ"

# --- Case 8: missing state.md → exit 0, no graph written -------------------
PROJ=$(mktemp -d -t aidlc-t90-XXXXXX)
mkdir -p "$PROJ/aidlc-docs"
# no state.md, no audit.md
OUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME_TS" compile 2>&1 || true)
if [ ! -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "missing state.md → no runtime-graph.json written"
else
  not_ok "missing state.md → no runtime-graph.json written" "graph file unexpectedly created"
fi
rm -rf "$PROJ"

# --- Case 9: approved + non-zero memory_entries → NO MEMORY_EMPTY emit -----
# Negative coverage for the MEMORY_EMPTY rule. The rule is "approved AND
# zero entries"; a populated diary is the happy path and must stay silent.
PROJ=$(make_project "$AUDIT_ONE_APPROVED" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
cat > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md" <<'EOF'
## Interpretations
- one entry
- another entry
EOF
run_compile "$PROJ" >/dev/null
ENTRIES_NONZERO=$(jq -r '.stages[0].memory_entries' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$ENTRIES_NONZERO" "2" "approved + populated memory.md → memory_entries: 2"
EMPTY_COUNT=$(grep -c "^\\*\\*Event\\*\\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$EMPTY_COUNT" "0" "approved + non-zero entries → no MEMORY_EMPTY emit"
rm -rf "$PROJ"

# --- Case 10: sub-second timestamp collision → deterministic ordering ------
# Two STAGE_COMPLETED rows at the same ISO-second. findAllEvents preserves
# source-position order; the compile's stream sort breaks timestamp ties on
# the (++index) tag captured at insert time. Result: rows ordered as they
# appeared in audit.md, not Map-iteration-order.
AUDIT_COLLISION=$(cat <<'EOF'
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

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: scope-definition
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Stage Completion
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: scope-definition

---
EOF
)
PROJ=$(make_project "$AUDIT_COLLISION" "$STATE_FEATURE")
run_compile "$PROJ" >/dev/null
FIRST_SLUG=$(jq -r '.stages[0].stage_slug' "$PROJ/aidlc-docs/runtime-graph.json")
SECOND_SLUG=$(jq -r '.stages[1].stage_slug' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$FIRST_SLUG" "intent-capture" "ISO-second tie → first STAGE_STARTED in source order is row 1"
assert_eq "$SECOND_SLUG" "scope-definition" "ISO-second tie → second STAGE_STARTED in source order is row 2"
# Re-compile and verify ordering is byte-equivalent (the determinism check).
SHA1=$(shasum -a 1 "$PROJ/aidlc-docs/runtime-graph.json" | awk '{print $1}')
run_compile "$PROJ" >/dev/null
SHA2=$(shasum -a 1 "$PROJ/aidlc-docs/runtime-graph.json" | awk '{print $1}')
assert_eq "$SHA1" "$SHA2" "ISO-second tie → ordering deterministic across compiles"
rm -rf "$PROJ"

# --- Case 11: --init --force re-init → LAST WORKFLOW_STARTED wins ----------
# Two WORKFLOW_STARTED rows in audit (re-init scenario). workflow_id and
# started_at must reflect the LIVE workflow, not the dead one. Stage rows
# from before the latest WORKFLOW_STARTED must be filtered out (otherwise
# slug collisions silently merge two workflows into one graph).
AUDIT_REINIT=$(cat <<'EOF'
## Workflow Start
**Timestamp**: 2026-05-27T08:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: bugfix

---

## Stage Start
**Timestamp**: 2026-05-27T08:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T08:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

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
PROJ=$(make_project "$AUDIT_REINIT" "$STATE_FEATURE")
run_compile "$PROJ" >/dev/null
WID=$(jq -r '.workflow_id' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$WID" "2026-05-27T10:00:00Z" "re-init → workflow_id is the LATEST WORKFLOW_STARTED"
ROW_COUNT=$(jq '.stages | length' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$ROW_COUNT" "1" "re-init → stage rows from prior workflow filtered out"
LIVE_OUTCOME=$(jq -r '.stages[0].outcome' "$PROJ/aidlc-docs/runtime-graph.json")
assert_eq "$LIVE_OUTCOME" "pending" "re-init → live workflow's only row is pending (no STAGE_COMPLETED yet)"
rm -rf "$PROJ"

# --- Case 12: MEMORY_EMPTY re-emit suppression -----------------------------
# Doctor's MEMORY_EMPTY-rate metric depends on exactly-one emit per
# (stage, gate-completion). Without suppression, every subsequent compile
# in the workflow re-emits at a fresh wallclock — Doctor's tuples diverge
# and the rate metric inflates. Past timestamps in the fixture (2024) so
# wallclock at compile time is definitely after completed_at, exercising
# the suppression scan.
AUDIT_PAST_APPROVED=$(cat <<'EOF'
## Workflow Start
**Timestamp**: 2024-01-01T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2024-01-01T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2024-01-01T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---
EOF
)
PROJ=$(make_project "$AUDIT_PAST_APPROVED" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
echo "" > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md"
run_compile "$PROJ" >/dev/null
N1=$(grep -c "^\\*\\*Event\\*\\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$N1" "1" "first compile emits MEMORY_EMPTY for zero-entry approved stage"
run_compile "$PROJ" >/dev/null
N2=$(grep -c "^\\*\\*Event\\*\\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$N2" "1" "second compile suppresses re-emit (count stays at 1)"
run_compile "$PROJ" >/dev/null
N3=$(grep -c "^\\*\\*Event\\*\\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$N3" "1" "third compile still suppressed (count stays at 1)"
rm -rf "$PROJ"

# --- Case 13: re-approve still-empty stage emits a fresh MEMORY_EMPTY ------
# Re-jump + re-approve produces a new completed_at. If the stage is still
# empty at re-approval, a fresh MEMORY_EMPTY row must emit because the
# prior row's Timestamp lies before the new completed_at. Without this,
# Doctor would miss the second skip event.
#
# Mechanic: compile #1 emits MEMORY_EMPTY at wallclock-T1. Sleep, then
# append a re-jump where the new STAGE_COMPLETED Timestamp is "now" (a
# wallclock-after-T1 ISO string). Compile #2 sees prior MEMORY_EMPTY @ T1
# < new completed_at, so emit fires; compile #3 sees prior MEMORY_EMPTY
# @ T2 >= new completed_at, suppressed.
PROJ=$(make_project "$AUDIT_PAST_APPROVED" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
echo "" > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md"
run_compile "$PROJ" >/dev/null
# Sleep 2s so wallclock advances past compile-#1's MEMORY_EMPTY Timestamp.
sleep 2
# Compute a re-completed_at that's strictly between compile-#1's wallclock
# emit and compile-#2's wallclock emit. "now" works — by the time compile
# #2 emits, wallclock has advanced past this.
NEW_COMPLETED=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat >> "$PROJ/aidlc-docs/audit.md" <<EOF

## Stage Start
**Timestamp**: $NEW_COMPLETED
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: $NEW_COMPLETED
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---
EOF
sleep 2
run_compile "$PROJ" >/dev/null
N=$(grep -c "^\\*\\*Event\\*\\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$N" "2" "re-approve with still-empty memory.md → fresh MEMORY_EMPTY emit (total 2)"
run_compile "$PROJ" >/dev/null
N_RE=$(grep -c "^\\*\\*Event\\*\\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$N_RE" "2" "re-approve scenario: third compile suppressed (count stays at 2)"
rm -rf "$PROJ"

# --- Case 14: Schema nullability — TS interface allows null on instance fields ---
# MR 11 will populate `instances` and set the parent stage row's
# single-instance fields (started_at, agent, completed_at, memory_entries,
# memory_breakdown) to null. The TS interface must accept those nulls so
# MR 11 doesn't have to widen the type post-hoc. We can't test MR 11's
# emit yet, but we CAN verify the read subcommand parses a manually
# constructed instance-bearing graph without throwing.
PROJ=$(make_project "$AUDIT_ONE_APPROVED" "$STATE_FEATURE")
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/runtime-graph.json" <<'EOF'
{
  "workflow_id": "2024-01-01T10:00:00Z",
  "scope": "feature",
  "started_at": "2024-01-01T10:00:00Z",
  "stages": [
    {
      "stage_slug": "code-generation",
      "started_at": null,
      "completed_at": null,
      "agent": null,
      "memory_path": "aidlc-docs/construction/code-generation/memory.md",
      "memory_entries": null,
      "memory_breakdown": null,
      "sensor_firings": [],
      "outcome": "pending",
      "learnings_captured": null,
      "instances": [
        {
          "bolt": "auth-flow",
          "worktree": ".aidlc/worktrees/bolt-auth-flow/",
          "started_at": "2024-01-01T11:00:00Z",
          "completed_at": null,
          "memory_path": ".aidlc/worktrees/bolt-auth-flow/aidlc-docs/construction/code-generation/memory.md",
          "memory_entries": 2,
          "memory_breakdown": {
            "interpretations": 1,
            "deviations": 1,
            "tradeoffs": 0,
            "open_questions": 0
          },
          "sensor_firings": [],
          "outcome": "pending"
        }
      ]
    }
  ]
}
EOF
READ_OUT=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME_TS" read code-generation 2>&1)
echo "$READ_OUT" | jq -e '.started_at == null and .agent == null and (.instances | length) == 1' >/dev/null
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "schema accepts null started_at/agent on instance-bearing parent row"
else
  not_ok "schema accepts null started_at/agent on instance-bearing parent row" "read failed: $READ_OUT"
fi
rm -rf "$PROJ"

finish
