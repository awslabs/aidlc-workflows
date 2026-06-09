#!/bin/bash
# t102 (integration): memory.md producer → MR 8 runtime-compile round-trip
# (v0.5.0 MR 13) (6 tests)
#
# The two-workflow round-trip the card implies, run scripted/deterministic:
# the producer side writes memory.md from the real MR 13 template (and appends
# real entries), then the MR 8 consumer (`aidlc-runtime.ts compile` — the
# subcommand the PostToolUse hook fires after state/jump/bolt/utility calls)
# reads them. Asserts:
#   - a stage's memory.md is created from the template at start (4 headings,
#     parses to total 0),
#   - after N real entries + approval, compile records memory_entries === N and
#     a breakdown summing to N,
#   - a template-only (zero-entry) approved stage emits MEMORY_EMPTY,
#   - a stage with N≥1 entries does NOT emit MEMORY_EMPTY,
#   - the file persists across a second compile (across sessions),
#   - an absent memory.md compiles to memory_entries: null and emits no
#     MEMORY_EMPTY (no-storm backfill semantics, MR 8).
#
# L2 — pure bash + bun + jq, scripted (no LLM). Mirrors t90's compile pattern.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AIDLC_SRC="$REPO_ROOT/dist/claude/.claude"
RUNTIME="$AIDLC_SRC/tools/aidlc-runtime.ts"
LIB="$AIDLC_SRC/tools/aidlc-lib.ts"
TEMPLATE="$AIDLC_SRC/knowledge/aidlc-shared/memory-template.md"

[ -f "$RUNTIME" ] || { echo "Bail out! aidlc-runtime.ts not found at $RUNTIME"; exit 1; }
[ -f "$TEMPLATE" ] || { echo "Bail out! memory-template.md not found at $TEMPLATE"; exit 1; }

plan 6

# Standard 1-stage approved audit (intent-capture, ideation phase).
AUDIT_APPROVED=$(cat <<'EOF'
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

make_project() {
  local proj
  proj=$(mktemp -d -t aidlc-t102-XXXXXX)
  mkdir -p "$proj/aidlc-docs"
  printf '%s' "$AUDIT_APPROVED" > "$proj/aidlc-docs/audit.md"
  printf '%s' "$STATE_FEATURE" > "$proj/aidlc-docs/aidlc-state.md"
  echo "$proj"
}

run_compile() {
  local proj="$1"; shift
  CLAUDE_PROJECT_DIR="$proj" bun "$RUNTIME" compile "$@" 2>&1
}

memdir() { echo "$1/aidlc-docs/ideation/intent-capture"; }

# --- Case 1: memory.md created from template at start -----------------------
PROJ=$(make_project)
mkdir -p "$(memdir "$PROJ")"
cp "$TEMPLATE" "$(memdir "$PROJ")/memory.md"
FRESH_TOTAL=$(bun -e "
  import { parseMemoryHeadings } from '$LIB';
  import { readFileSync } from 'fs';
  console.log(parseMemoryHeadings(readFileSync('$(memdir "$PROJ")/memory.md','utf-8')).total);
" 2>/dev/null)
H2=$(grep -cE '^## ' "$(memdir "$PROJ")/memory.md")
if [ "$H2" = "4" ] && [ "$FRESH_TOTAL" = "0" ]; then
  ok "memory.md created from template at start (4 headings, parses to total 0)"
else
  not_ok "memory.md created from template at start" "headings=$H2 total=$FRESH_TOTAL (expected 4 / 0)"
fi
rm -rf "$PROJ"

# --- Case 2: N real entries → compile records memory_entries === N ----------
PROJ=$(make_project)
mkdir -p "$(memdir "$PROJ")"
cp "$TEMPLATE" "$(memdir "$PROJ")/memory.md"
# Append 3 real entries: 2 interpretations + 1 tradeoff.
bun -e "
  import { readFileSync, writeFileSync } from 'fs';
  let raw = readFileSync('$(memdir "$PROJ")/memory.md','utf-8');
  raw = raw.replace('## Interpretations\n', '## Interpretations\n- 2026-05-29T10:00:00Z — chose A over B\n- 2026-05-29T10:01:00Z — confirmed C\n');
  raw = raw.replace('## Tradeoffs\n', '## Tradeoffs\n- 2026-05-29T10:02:00Z — accepted D for E\n');
  writeFileSync('$(memdir "$PROJ")/memory.md', raw);
"
run_compile "$PROJ" >/dev/null
graph="$PROJ/aidlc-docs/runtime-graph.json"
ENTRIES=$(jq -r '.stages[0].memory_entries' "$graph")
BREAKDOWN_SUM=$(jq -r '.stages[0].memory_breakdown | (.interpretations + .deviations + .tradeoffs + .open_questions)' "$graph")
if [ "$ENTRIES" = "3" ] && [ "$BREAKDOWN_SUM" = "3" ]; then
  ok "N=3 real entries → memory_entries === 3, breakdown sums to 3 (MR 8 reads MR 13's file)"
else
  not_ok "N real entries → memory_entries === N" "entries=$ENTRIES breakdown_sum=$BREAKDOWN_SUM (expected 3 / 3)"
fi
rm -rf "$PROJ"

# --- Case 3: template-only (zero-entry) approved stage emits MEMORY_EMPTY ---
PROJ=$(make_project)
mkdir -p "$(memdir "$PROJ")"
cp "$TEMPLATE" "$(memdir "$PROJ")/memory.md"
run_compile "$PROJ" >/dev/null
EMPTY_COUNT=$(grep -c "^\*\*Event\*\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$EMPTY_COUNT" "1" "template-only (zero-entry) approved stage → one MEMORY_EMPTY (signal survives end-to-end)"
rm -rf "$PROJ"

# --- Case 4: N≥1 entries does NOT emit MEMORY_EMPTY -------------------------
PROJ=$(make_project)
mkdir -p "$(memdir "$PROJ")"
cp "$TEMPLATE" "$(memdir "$PROJ")/memory.md"
bun -e "
  import { readFileSync, writeFileSync } from 'fs';
  let raw = readFileSync('$(memdir "$PROJ")/memory.md','utf-8');
  raw = raw.replace('## Deviations\n', '## Deviations\n- 2026-05-29T10:00:00Z — skipped F\n');
  writeFileSync('$(memdir "$PROJ")/memory.md', raw);
"
run_compile "$PROJ" >/dev/null
EMPTY_COUNT=$(grep -c "^\*\*Event\*\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
assert_eq "$EMPTY_COUNT" "0" "stage with N≥1 entries → no MEMORY_EMPTY (guard correctness)"
rm -rf "$PROJ"

# --- Case 5: file persists across a second compile (across sessions) --------
PROJ=$(make_project)
mkdir -p "$(memdir "$PROJ")"
cp "$TEMPLATE" "$(memdir "$PROJ")/memory.md"
bun -e "
  import { readFileSync, writeFileSync } from 'fs';
  let raw = readFileSync('$(memdir "$PROJ")/memory.md','utf-8');
  raw = raw.replace('## Open questions\n', '## Open questions\n- 2026-05-29T10:00:00Z — confirm retention window\n');
  writeFileSync('$(memdir "$PROJ")/memory.md', raw);
"
run_compile "$PROJ" >/dev/null
# Run-2: a fresh compile (simulating a later session) still reads the file.
run_compile "$PROJ" >/dev/null
graph="$PROJ/aidlc-docs/runtime-graph.json"
PERSIST_ENTRIES=$(jq -r '.stages[0].memory_entries' "$graph")
if [ -f "$(memdir "$PROJ")/memory.md" ] && [ "$PERSIST_ENTRIES" = "1" ]; then
  ok "memory.md persists across sessions; re-compile still reads memory_entries"
else
  not_ok "memory.md persists across sessions" "file_exists/entries=$PERSIST_ENTRIES (expected 1)"
fi
rm -rf "$PROJ"

# --- Case 6: absent memory.md → memory_entries: null, no MEMORY_EMPTY -------
PROJ=$(make_project)
# No memory.md created (a stage the orchestrator never touched).
run_compile "$PROJ" >/dev/null
graph="$PROJ/aidlc-docs/runtime-graph.json"
NULL_ENTRIES=$(jq -r '.stages[0].memory_entries' "$graph")
EMPTY_COUNT=$(grep -c "^\*\*Event\*\*: MEMORY_EMPTY" "$PROJ/aidlc-docs/audit.md" || true)
if [ "$NULL_ENTRIES" = "null" ] && [ "$EMPTY_COUNT" = "0" ]; then
  ok "absent memory.md → memory_entries: null + no MEMORY_EMPTY (no-storm backfill)"
else
  not_ok "absent memory.md → null + no MEMORY_EMPTY" "entries=$NULL_ENTRIES empty_count=$EMPTY_COUNT"
fi
rm -rf "$PROJ"

finish
