#!/bin/bash
# t91: Behavioural contract for `aidlc-runtime-compile.ts` PostToolUse hook
# (v0.5.0 MR 8). 13 tests.
#
# Surface tested:
#   - Bash matcher only fires on bun aidlc-(state|jump|bolt|utility).ts.
#   - aidlc-runtime.ts is excluded (recursion guard at command-regex level).
#   - Last-3-block scan finds GATE_APPROVED behind STAGE_STARTED + STAGE_COMPLETED.
#   - WORKFLOW_COMPLETED in transition regex covers terminal-WORKFLOW approve
#     where the last 3 blocks are PHASE_COMPLETED + PHASE_VERIFIED + WORKFLOW_COMPLETED.
#   - No-transition last-3 blocks (QUESTION_ANSWERED / DECISION_RECORDED /
#     ARTIFACT_UPDATED) → no compile dispatch (heartbeat still fires).
#   - TTY guard / empty-stdin path → exit 0, no work.
#   - Test-Run propagation → MEMORY_EMPTY rows carry Test-Run: true.
#
# L1 — pure bash + bun + jq. Builds a self-contained `.claude/` skeleton
# under tempdir so the hook resolves project paths via CLAUDE_PROJECT_DIR.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_TOOLS="$REPO_ROOT/dist/claude/.claude/tools"
SRC_HOOKS="$REPO_ROOT/dist/claude/.claude/hooks"

if [ ! -f "$SRC_HOOKS/aidlc-runtime-compile.ts" ]; then
  echo "Bail out! aidlc-runtime-compile.ts not found"
  exit 1
fi

plan 13

# Stage a self-contained .claude/ skeleton so the hook + compile resolve
# paths via CLAUDE_PROJECT_DIR. Returns the project dir on stdout.
make_project() {
  local proj
  proj=$(mktemp -d -t aidlc-t91-XXXXXX)
  mkdir -p "$proj/aidlc-docs" "$proj/.claude/tools/data" "$proj/.claude/hooks"
  cp "$SRC_TOOLS/aidlc-runtime.ts" "$proj/.claude/tools/"
  cp "$SRC_TOOLS/aidlc-lib.ts" "$proj/.claude/tools/"
  cp "$SRC_TOOLS/aidlc-audit.ts" "$proj/.claude/tools/"
  cp "$SRC_TOOLS/data/stage-graph.json" "$proj/.claude/tools/data/"
  cp "$SRC_HOOKS/aidlc-runtime-compile.ts" "$proj/.claude/hooks/"
  printf '%s' "- **Scope**: feature" > "$proj/aidlc-docs/aidlc-state.md"
  echo "$proj"
}

run_hook() {
  local proj="$1"
  local payload="$2"
  echo "$payload" | CLAUDE_PROJECT_DIR="$proj" timeout 10 bun "$proj/.claude/hooks/aidlc-runtime-compile.ts" 2>&1 || true
}

# Audit fixtures. Trailing newline matters — split('\n---\n') produces an
# extra empty element, but slice(-3) is robust to that.
AUDIT_GATE_APPROVED=$(cat <<'EOF'
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
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Gate Approved
**Timestamp**: 2026-05-27T10:05:01Z
**Event**: GATE_APPROVED
**Stage**: intent-capture

---
EOF
)

AUDIT_TERMINAL_WORKFLOW=$(cat <<'EOF'
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

## Gate Approved
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: GATE_APPROVED
**Stage**: intent-capture

---

## Stage Completion
**Timestamp**: 2026-05-27T10:05:01Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture

---

## Phase Completion
**Timestamp**: 2026-05-27T10:05:02Z
**Event**: PHASE_COMPLETED
**From phase**: ideation
**To phase**: inception

---

## Phase Verification
**Timestamp**: 2026-05-27T10:05:03Z
**Event**: PHASE_VERIFIED
**Phase boundary**: ideation → inception

---

## Workflow Completion
**Timestamp**: 2026-05-27T10:05:04Z
**Event**: WORKFLOW_COMPLETED
**Reason**: terminal-stage-approved

---
EOF
)

AUDIT_NO_TRANSITION=$(cat <<'EOF'
## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Question Answered
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: QUESTION_ANSWERED
**Stage**: intent-capture

---

## Decision Recorded
**Timestamp**: 2026-05-27T10:02:00Z
**Event**: DECISION_RECORDED
**Stage**: intent-capture

---

## Artifact Updated
**Timestamp**: 2026-05-27T10:03:00Z
**Event**: ARTIFACT_UPDATED
**Tool**: Edit

---
EOF
)

# --- Case 1: filter pass — GATE_APPROVED in last 3 → dispatch -------------
PROJ=$(make_project)
printf '%s' "$AUDIT_GATE_APPROVED" > "$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-state.ts approve --stage intent-capture"}}' >/dev/null
if [ -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "GATE_APPROVED in last-3 → compile dispatched"
else
  not_ok "GATE_APPROVED in last-3 → compile dispatched" "no runtime-graph.json"
fi
rm -rf "$PROJ"

# --- Case 2: filter pass — terminal-WORKFLOW (last 3 = PHASE_COMPLETED + ---
#     PHASE_VERIFIED + WORKFLOW_COMPLETED) → dispatch via WORKFLOW_COMPLETED.
PROJ=$(make_project)
printf '%s' "$AUDIT_TERMINAL_WORKFLOW" > "$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-state.ts approve --stage intent-capture"}}' >/dev/null
if [ -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "terminal-WORKFLOW (WORKFLOW_COMPLETED in last-3) → compile dispatched"
else
  not_ok "terminal-WORKFLOW → compile dispatched" "no runtime-graph.json"
fi
rm -rf "$PROJ"

# --- Case 2b: filter pass — STAGE_AWAITING_APPROVAL (gate-start) → dispatch -
# Without this in the transition regex, the gate ritual at MR 12 would
# read a memory_entries count snapshotted at STAGE_STARTED time, before
# the orchestrator wrote any §13 entries. Refreshing on gate-start gives
# the gate ritual current data.
AUDIT_GATE_START=$(cat <<'EOF'
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

## Stage Awaiting Approval
**Timestamp**: 2026-05-27T10:05:00Z
**Event**: STAGE_AWAITING_APPROVAL
**Stage**: intent-capture
**Artifacts**: intent-statement

---
EOF
)
PROJ=$(make_project)
printf '%s' "$AUDIT_GATE_START" > "$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-state.ts gate-start intent-capture"}}' >/dev/null
if [ -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "STAGE_AWAITING_APPROVAL in last-3 → compile dispatched (gate-start refresh)"
else
  not_ok "STAGE_AWAITING_APPROVAL in last-3 → compile dispatched" "no runtime-graph.json"
fi
rm -rf "$PROJ"

# --- Case 3: filter skip — non-aidlc Bash (git status) → no dispatch + ----
#     no heartbeat (early exit at command-regex).
PROJ=$(make_project)
printf '%s' "$AUDIT_GATE_APPROVED" > "$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"tool_name":"Bash","tool_input":{"command":"git status"}}' >/dev/null
if [ ! -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "non-aidlc Bash → no compile dispatched"
else
  not_ok "non-aidlc Bash → no compile dispatched" "graph file unexpectedly created"
fi
if [ ! -f "$PROJ/aidlc-docs/.aidlc-hooks-health/runtime-compile.last" ]; then
  ok "non-aidlc Bash → cheap exit before heartbeat"
else
  not_ok "non-aidlc Bash → cheap exit before heartbeat" "heartbeat unexpectedly written"
fi
rm -rf "$PROJ"

# --- Case 4: filter skip — aidlc-runtime.ts (recursion guard) ------------
PROJ=$(make_project)
printf '%s' "$AUDIT_GATE_APPROVED" > "$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-runtime.ts compile"}}' >/dev/null
if [ ! -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "aidlc-runtime.ts → recursion-guarded (no compile)"
else
  not_ok "aidlc-runtime.ts → recursion-guarded" "compile fired despite guard"
fi
rm -rf "$PROJ"

# --- Case 4b: composite Bash containing aidlc-runtime.ts AND aidlc-state.ts -
# A positive-only allowlist would let `bun aidlc-runtime.ts compile && bun
# aidlc-state.ts approve` through and loop. The explicit aidlc-runtime.ts
# reject must fire FIRST regardless of what else is in the command.
PROJ=$(make_project)
printf '%s' "$AUDIT_GATE_APPROVED" > "$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-runtime.ts compile && bun .claude/tools/aidlc-state.ts approve"}}' >/dev/null
if [ ! -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "composite Bash with aidlc-runtime.ts → recursion-guarded (no compile)"
else
  not_ok "composite Bash with aidlc-runtime.ts → recursion-guarded" "compile fired despite explicit reject"
fi
rm -rf "$PROJ"

# --- Case 5: filter skip — aidlc Bash but no transition in last 3 --------
#     QUESTION_ANSWERED / DECISION_RECORDED / ARTIFACT_UPDATED last 3 → no dispatch.
PROJ=$(make_project)
printf '%s' "$AUDIT_NO_TRANSITION" > "$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-state.ts session"}}' >/dev/null
if [ ! -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "no transition in last-3 → no compile dispatched"
else
  not_ok "no transition in last-3 → no compile dispatched" "graph file unexpectedly created"
fi
if [ -f "$PROJ/aidlc-docs/.aidlc-hooks-health/runtime-compile.last" ]; then
  ok "no transition in last-3 → heartbeat still updated"
else
  not_ok "no transition → heartbeat updated" "no heartbeat file"
fi
rm -rf "$PROJ"

# --- Case 6: TTY/empty-stdin guard ----------------------------------------
PROJ=$(make_project)
printf '%s' "$AUDIT_GATE_APPROVED" > "$PROJ/aidlc-docs/audit.md"
CLAUDE_PROJECT_DIR="$PROJ" timeout 5 bun "$PROJ/.claude/hooks/aidlc-runtime-compile.ts" </dev/null >/dev/null
rc=$?
assert_eq "$rc" "0" "empty stdin → exit 0"
if [ ! -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then
  ok "empty stdin → no compile (exits before work)"
else
  not_ok "empty stdin → no compile" "graph file unexpectedly created"
fi
rm -rf "$PROJ"

# --- Case 7: malformed JSON stdin → exit 0, no work ----------------------
PROJ=$(make_project)
printf '%s' "$AUDIT_GATE_APPROVED" > "$PROJ/aidlc-docs/audit.md"
echo "this is not json" | CLAUDE_PROJECT_DIR="$PROJ" timeout 5 bun "$PROJ/.claude/hooks/aidlc-runtime-compile.ts" >/dev/null
rc=$?
assert_eq "$rc" "0" "malformed stdin JSON → exit 0"
rm -rf "$PROJ"

# --- Case 8: Test-Run propagation -----------------------------------------
PROJ=$(make_project)
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
echo "" > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md"
# Inject a Test-Run: true line into the GATE_APPROVED block
TR_AUDIT=$(printf '%s' "$AUDIT_GATE_APPROVED" | sed '/^\*\*Event\*\*: GATE_APPROVED$/a\
**Test-Run**: true')
printf '%s' "$TR_AUDIT" > "$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-state.ts approve --stage intent-capture --test-run"}}' >/dev/null
TR_COUNT=$(awk '/^## Memory Empty$/,/^---$/' "$PROJ/aidlc-docs/audit.md" | grep -c '^\*\*Test-Run\*\*: true$' || true)
assert_eq "$TR_COUNT" "1" "Test-Run in matched block → MEMORY_EMPTY carries Test-Run: true"
rm -rf "$PROJ"

finish
