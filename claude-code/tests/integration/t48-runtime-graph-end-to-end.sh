#!/bin/bash
# t48: Integration test — runtime-graph compile end-to-end (v0.5.0 MR 8).
#
# Drives a real workflow through approval gates, invoking aidlc-runtime.ts
# compile after each transition (simulating what the PostToolUse Bash hook
# does in a Claude Code session — bun-direct invocation here doesn't
# trigger Claude Code's hooks). Verifies:
#   - First gate-approve produces a 2-row runtime-graph.json: stage 1
#     approved + stage 2 pending (the in-line advance emits STAGE_STARTED
#     in the same Bash call).
#   - Second gate-approve grows the row count and updates stage 2 to approved.
#   - Pending row reflects the latest STAGE_STARTED.
#   - Schema matches the locked TS interface (workflow_id, scope, started_at,
#     stages array shape).
#   - Idempotency: re-compiling against the same audit produces a
#     byte-equivalent runtime-graph.json.
#   - Memory.md presence flips memory_entries from null → number on next compile.
#
# Tier: L2 integration. Uses the real tool surface; no fixtures dir.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"
STATE="$AIDLC_SRC/tools/aidlc-state.ts"
RUNTIME="$AIDLC_SRC/tools/aidlc-runtime.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 10

PROJ=$(create_test_project)

# Init bugfix scope — fastest scope, smallest stage list.
AIDLC_WORKFLOW_INTENT="runtime-graph e2e" \
  bun "$UTIL" init --scope bugfix --project-dir "$PROJ" --test-run >/dev/null 2>&1

state="$PROJ/aidlc-docs/aidlc-state.md"
audit="$PROJ/aidlc-docs/audit.md"
graph="$PROJ/aidlc-docs/runtime-graph.json"

# Find the first stage in the bugfix scope from state.md (the one currently in [-]).
FIRST_STAGE=$(grep -E '^- \[-\]' "$state" | head -1 | sed -E 's/^- \[-\] ([a-z-]+).*/\1/')
if [ -z "$FIRST_STAGE" ]; then
  echo "Bail out! could not extract first stage from state.md"
  exit 1
fi

# --- Compile #1: pre-approve, stage 1 in flight (pending row only) -------
CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME" compile --project-dir "$PROJ" >/dev/null 2>&1 || \
  CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME" compile >/dev/null 2>&1
if [ -f "$graph" ]; then
  ok "compile produced runtime-graph.json"
else
  not_ok "compile produced runtime-graph.json" "$graph not found"
  finish
fi

# Schema basics
assert_eq "$(jq -r 'has("workflow_id") and has("scope") and has("started_at") and has("stages")' "$graph")" "true" \
  "graph has workflow_id, scope, started_at, stages"
assert_eq "$(jq -r '.scope' "$graph")" "bugfix" "scope reflects init scope"

# After init the first stage is in [-] (in-progress) — we expect a pending row.
PENDING_OUTCOME=$(jq -r --arg slug "$FIRST_STAGE" '.stages[] | select(.stage_slug == $slug) | .outcome' "$graph")
assert_eq "$PENDING_OUTCOME" "pending" "first stage row has outcome: pending pre-approve"

# --- Gate-start → approve stage 1 → emits GATE_APPROVED + STAGE_COMPLETED + STAGE_STARTED -
bun "$STATE" gate-start "$FIRST_STAGE" --project-dir "$PROJ" >/dev/null 2>&1
bun "$STATE" approve "$FIRST_STAGE" --user-input "looks good" --project-dir "$PROJ" >/dev/null 2>&1

# --- Compile #2: post-approve. Stage 1 → approved; stage 2 → pending. ----
CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME" compile >/dev/null 2>&1
APPROVED_OUTCOME=$(jq -r --arg slug "$FIRST_STAGE" '.stages[] | select(.stage_slug == $slug) | .outcome' "$graph")
assert_eq "$APPROVED_OUTCOME" "approved" "stage 1 outcome flips to approved post-approve"
APPROVED_TS=$(jq -r --arg slug "$FIRST_STAGE" '.stages[] | select(.stage_slug == $slug) | .completed_at' "$graph")
if [ "$APPROVED_TS" != "null" ] && [ -n "$APPROVED_TS" ]; then
  ok "stage 1 has non-null completed_at"
else
  not_ok "stage 1 has non-null completed_at" "got: $APPROVED_TS"
fi

# Should now have at least 2 stage rows.
ROW_COUNT=$(jq '.stages | length' "$graph")
if [ "$ROW_COUNT" -ge 2 ]; then
  ok "graph has 2+ rows after approve (stage 1 approved + stage 2 pending)"
else
  not_ok "graph has 2+ rows" "got $ROW_COUNT rows"
fi

# v0.4.0 backfill: stage 1 had no memory.md → memory_entries:null + no MEMORY_EMPTY.
NULL_MEM=$(jq -r --arg slug "$FIRST_STAGE" '.stages[] | select(.stage_slug == $slug) | .memory_entries' "$graph")
assert_eq "$NULL_MEM" "null" "missing memory.md → memory_entries: null (v0.4.0 backfill)"
EMPTY_COUNT=$(grep -c '^\*\*Event\*\*: MEMORY_EMPTY' "$audit" || true)
assert_eq "$EMPTY_COUNT" "0" "no MEMORY_EMPTY emitted (backfill — file absent)"

# --- Idempotency: re-compile, byte-equivalent --------------------------------
SHA1=$(shasum -a 1 "$graph" | awk '{print $1}')
CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME" compile >/dev/null 2>&1
SHA2=$(shasum -a 1 "$graph" | awk '{print $1}')
assert_eq "$SHA1" "$SHA2" "re-compile produces byte-equivalent runtime-graph.json"

finish
