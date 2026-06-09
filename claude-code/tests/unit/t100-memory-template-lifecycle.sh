#!/bin/bash
# t100 (unit): Per-stage memory.md template structure + parser-safety +
# aidlc-state.ts advance/approve memory_path JSON key (v0.5.0 MR 13) (19 tests)
#
# Surface tested:
#   - Template exists at .claude/knowledge/aidlc-shared/memory-template.md.
#   - The four canonical `## ` H2 headings (exact HEADING_TO_KEY strings,
#     lowercase-q "## Open questions", column 0, no leading/trailing space).
#   - Blockquote ownership header (verbatim card string), parser-skipped.
#   - Seed examples are SINGLE-LINE HTML comments → a fresh template parses
#     to total === 0 (so MEMORY_EMPTY still fires) — the load-bearing case.
#   - Appending one real bullet → interpretations === 1, total === 1.
#   - `aidlc-state.ts advance` JSON gains a `memory_path` key; `approve`
#     inherits it via handleAdvance delegation; forward-slashes, relative.
#
# Generic parser behaviour (empty input, fence/blockquote/comment exclusion,
# CRLF/BOM, exact-match strictness) is the authority of
# tests/unit/t88-parse-memory-headings.sh (18 cases). t100 covers the
# TEMPLATE FILE specifically and does not re-prove generic parser behaviour.
#
# L1 — pure bash + bun + jq. No LLM.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

LIB="$AIDLC_SRC/tools/aidlc-lib.ts"
TOOL="$AIDLC_SRC/tools/aidlc-state.ts"
TEMPLATE="$AIDLC_SRC/knowledge/aidlc-shared/memory-template.md"

# Parse the template (or a copy) and print one field expression.
parse_field() {
  local file="$1"
  local expr="$2"
  bun -e "
    import { parseMemoryHeadings } from '$LIB';
    import { readFileSync } from 'fs';
    const r = parseMemoryHeadings(readFileSync('$file','utf-8'));
    console.log($expr);
  " 2>/dev/null
}

plan 19

# --- Case 1: template file exists at the resolved path ----------------------
assert_file_exists "$TEMPLATE" "template exists at .claude/knowledge/aidlc-shared/memory-template.md"

# --- Cases 2-5: four canonical headings as exact `## ` H2 lines -------------
assert_grep "$TEMPLATE" '^## Interpretations$' "template has '## Interpretations' H2"
assert_grep "$TEMPLATE" '^## Deviations$' "template has '## Deviations' H2"
assert_grep "$TEMPLATE" '^## Tradeoffs$' "template has '## Tradeoffs' H2"
assert_grep "$TEMPLATE" '^## Open questions$' "template has '## Open questions' H2"

# --- Case 6: no non-canonical `## ` heading (excluding the four) ------------
# Any stray `## X` heading would reset `current` to null in the parser. Count
# all `## ` headings; there must be exactly four (the canonical set).
H2_COUNT=$(grep -cE '^## ' "$TEMPLATE")
assert_eq "$H2_COUNT" "4" "template has exactly four '## ' H2 headings (no stray heading)"

# --- Case 7: "Open questions" is lowercase-q (the silent-zero trap) ---------
assert_grep "$TEMPLATE" '^## Open questions$' "open-questions heading is lowercase-q"
assert_not_grep "$TEMPLATE" '^## Open Questions$' "template does NOT contain capital-Q '## Open Questions'"

# --- Case 8: each canonical heading at column 0, no leading/trailing space --
# Parser matches the RAW line (lib.ts:1015) — leading or trailing whitespace
# silently counts nothing. Refute any whitespace-padded variant.
assert_not_grep "$TEMPLATE" '^ *## Interpretations  *$' "no trailing-whitespace on '## Interpretations'"
assert_not_grep "$TEMPLATE" '^  *## ' "no leading-whitespace before any '## ' heading"

# --- Case 9: ownership header is a blockquote with the verbatim card string -
assert_grep "$TEMPLATE" '^> This file is maintained by the orchestrator during stage execution\. Add observations at the gate ritual, not by editing here directly\.$' "ownership header is blockquote with verbatim card string"

# --- Case 10: each seed example is a SINGLE-LINE HTML comment ---------------
# Count single-line HTML comments that carry an "example:" marker — there must
# be exactly four (one per heading), each opening and closing on one line.
EXAMPLE_COUNT=$(grep -cE '^<!-- example:.*-->$' "$TEMPLATE")
assert_eq "$EXAMPLE_COUNT" "4" "exactly four single-line HTML-comment seed examples"

# --- Case 11: parseMemoryHeadings(template) → total === 0 (LOAD-BEARING) ----
assert_eq "$(parse_field "$TEMPLATE" "r.total")" "0" "fresh template parses to total === 0 (MEMORY_EMPTY survives)"

# --- Case 12: all four sub-counts === 0 -------------------------------------
SUBS=$(parse_field "$TEMPLATE" 'r.interpretations + "," + r.deviations + "," + r.tradeoffs + "," + r.open_questions')
assert_eq "$SUBS" "0,0,0,0" "fresh template: all four sub-counts === 0"

# --- Case 13: append one real bullet under ## Interpretations → counts 1 ----
PROJ=$(create_test_project)
COPY="$PROJ/memory.md"
cp "$TEMPLATE" "$COPY"
# Insert a real bullet directly under the ## Interpretations heading.
bun -e "
  import { readFileSync, writeFileSync } from 'fs';
  let raw = readFileSync('$COPY','utf-8');
  raw = raw.replace('## Interpretations\n', '## Interpretations\n- 2026-05-29T11:00:00Z — a real observation\n');
  writeFileSync('$COPY', raw);
"
APPENDED=$(parse_field "$COPY" 'r.interpretations + "," + r.total')
assert_eq "$APPENDED" "1,1" "append one real bullet under ## Interpretations → interpretations === 1, total === 1"
cleanup_test_project "$PROJ"

# --- Case 14: advance stdout JSON carries memory_path key -------------------
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
ADV_OUT=$(bun "$TOOL" advance "feasibility" "scope-definition" --project-dir "$PROJ" 2>&1)
ADV_PATH=$(echo "$ADV_OUT" | jq -r '.memory_path')
assert_eq "$ADV_PATH" "aidlc-docs/ideation/scope-definition/memory.md" "advance JSON has memory_path === aidlc-docs/<phase>/<slug>/memory.md"
cleanup_test_project "$PROJ"

# --- Case 15: memory_path uses forward slashes, projectDir-relative ---------
# Inspect the EMITTED literal (not the non-exported helper). The advance
# output's memory_path must use '/' (no '\') and start with 'aidlc-docs/'.
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
ADV_PATH2=$(bun "$TOOL" advance "feasibility" "scope-definition" --project-dir "$PROJ" 2>&1 | jq -r '.memory_path')
assert_not_contains "$ADV_PATH2" '\' "memory_path uses no backslashes (forward-slash, worktree-portable)"
assert_match "$ADV_PATH2" '^aidlc-docs/' "memory_path is projectDir-relative (starts with aidlc-docs/)"
cleanup_test_project "$PROJ"

# --- Case 16: approve inherits memory_path via handleAdvance delegation -----
PROJ=$(create_test_project)
seed_state_file "$PROJ" "$FIXTURES_DIR/state-mid-ideation.md"
bun "$TOOL" gate-start "feasibility" --project-dir "$PROJ" >/dev/null 2>&1
APPROVE_OUT=$(bun "$TOOL" approve "feasibility" --project-dir "$PROJ" 2>&1)
# approve auto-advances to the next in-scope stage (scope-definition) and the
# delegated handleAdvance prints the envelope carrying memory_path.
APPROVE_PATH=$(echo "$APPROVE_OUT" | jq -r '.memory_path')
assert_eq "$APPROVE_PATH" "aidlc-docs/ideation/scope-definition/memory.md" "approve inherits memory_path key via handleAdvance delegation"
cleanup_test_project "$PROJ"

finish
