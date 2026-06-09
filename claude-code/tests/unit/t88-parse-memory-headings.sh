#!/bin/bash
# t88: Unit tests for parseMemoryHeadings (18 tests)
#
# Validates MR 8's parseMemoryHeadings() in lib.ts. Runs bun -e snippets
# against inline memory.md fixtures so we exercise the real runtime
# behaviour. Covers empty input, all-four-headings present/absent,
# bullet/prose/ISO-line counting, fenced-code exclusion, blockquote and
# HTML-comment exclusion, non-canonical heading termination, CRLF and
# BOM tolerance, and exact-match heading strictness. Pinned by
# tests/smoke/t86-stage-protocol-section-13.sh which guarantees the four
# canonical headings stay in stage-protocol.md.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

LIB="$AIDLC_SRC/tools/aidlc-lib.ts"

# ------------------------------------------------------------
# Parse a memory.md fixture and print one count field
# (`r.interpretations`, `r.total`, etc.). The fixture is passed via
# AIDLC_T88_RAW env var so triple-backtick fences in the input don't
# collide with bun -e's outer template-literal quoting.
# ------------------------------------------------------------
parse_count() {
  local raw="$1"
  local expr="$2"
  AIDLC_T88_RAW="$raw" bun -e "
    import { parseMemoryHeadings } from '$LIB';
    const r = parseMemoryHeadings(process.env.AIDLC_T88_RAW);
    console.log($expr);
  " 2>/dev/null
}

# Parse and emit JSON of the full result for multi-field assertions.
parse_json() {
  local raw="$1"
  AIDLC_T88_RAW="$raw" bun -e "
    import { parseMemoryHeadings } from '$LIB';
    console.log(JSON.stringify(parseMemoryHeadings(process.env.AIDLC_T88_RAW)));
  " 2>/dev/null
}

plan 18

# ============================================================
# Empty / minimal input (3 assertions)
# ============================================================

assert_eq "$(parse_count "" "r.total")" "0" "empty string → total 0"

ALL_HEADINGS_EMPTY=$(cat <<'EOF'
## Interpretations

## Deviations

## Tradeoffs

## Open questions

EOF
)
assert_eq "$(parse_count "$ALL_HEADINGS_EMPTY" "r.total")" "0" "all four headings, no entries → total 0"

ONE_BULLET_EACH=$(cat <<'EOF'
## Interpretations
- a
## Deviations
- b
## Tradeoffs
- c
## Open questions
- d
EOF
)
assert_eq "$(parse_count "$ONE_BULLET_EACH" "r.total")" "4" "one bullet under each of four headings → total 4"

# ============================================================
# Per-heading attribution (4 assertions)
# ============================================================

assert_eq "$(parse_count "$ONE_BULLET_EACH" "r.interpretations")" "1" "one bullet under Interpretations → 1"
assert_eq "$(parse_count "$ONE_BULLET_EACH" "r.deviations")" "1" "one bullet under Deviations → 1"
assert_eq "$(parse_count "$ONE_BULLET_EACH" "r.tradeoffs")" "1" "one bullet under Tradeoffs → 1"
assert_eq "$(parse_count "$ONE_BULLET_EACH" "r.open_questions")" "1" "one bullet under Open questions → 1"

# ============================================================
# Mixed entry shapes — bullets, prose, ISO-timestamped lines (1 assertion)
# ============================================================

MIXED=$(cat <<'EOF'
## Interpretations
- 2026-05-20T10:14:32Z — bullet with ISO prefix
* alternate bullet glyph
1. numbered bullet
prose paragraph counts as one
EOF
)
assert_eq "$(parse_count "$MIXED" "r.interpretations")" "4" "bullets + prose + ISO line each count one"

# ============================================================
# Excluded line shapes (3 assertions)
# ============================================================

BLOCKQUOTE=$(cat <<'EOF'
## Deviations
> blockquote line should not count
- counted bullet
EOF
)
assert_eq "$(parse_count "$BLOCKQUOTE" "r.deviations")" "1" "blockquote-only line excluded"

HTML_COMMENT=$(cat <<'EOF'
## Tradeoffs
<!-- pure comment -->
- counted bullet
EOF
)
assert_eq "$(parse_count "$HTML_COMMENT" "r.tradeoffs")" "1" "HTML-comment-only line excluded"

FENCED=$(cat <<'EOF'
## Interpretations
```
- not counted (inside fence)
- also not counted
```
- counted bullet
EOF
)
assert_eq "$(parse_count "$FENCED" "r.interpretations")" "1" "lines inside fenced code block excluded"

# ============================================================
# Section termination + missing headings (3 assertions)
# ============================================================

NON_CANONICAL=$(cat <<'EOF'
## Tradeoffs
- counted
## Notes
- not counted
- still not counted
EOF
)
assert_eq "$(parse_count "$NON_CANONICAL" "r.total")" "1" "non-canonical heading terminates prior section"

MISSING_HEADING=$(cat <<'EOF'
## Interpretations
- a
## Deviations
- b
EOF
)
assert_eq "$(parse_count "$MISSING_HEADING" "r.tradeoffs")" "0" "missing canonical heading → 0 (no throw)"
assert_eq "$(parse_count "$MISSING_HEADING" "r.open_questions")" "0" "missing Open questions → 0"

# ============================================================
# Tolerance — CRLF, BOM (2 assertions)
# ============================================================

# CRLF input — bash heredoc keeps newlines as LF, so we synthesise CRLF
# inline via printf in a sub-bun snippet. Uses the BOM-stripping +
# CRLF-normalising path.
CRLF_RESULT=$(bun -e "
  import { parseMemoryHeadings } from '$LIB';
  const raw = '## Interpretations\r\n- a\r\n- b\r\n';
  const r = parseMemoryHeadings(raw);
  console.log(r.interpretations);
" 2>/dev/null)
assert_eq "$CRLF_RESULT" "2" "CRLF input → counts identical to LF"

BOM_RESULT=$(bun -e "
  import { parseMemoryHeadings } from '$LIB';
  const raw = '﻿## Interpretations\n- a\n';
  const r = parseMemoryHeadings(raw);
  console.log(r.interpretations);
" 2>/dev/null)
assert_eq "$BOM_RESULT" "1" "leading BOM tolerated"

# ============================================================
# Exact-match heading strictness (2 assertions)
# ============================================================

LOWERCASE_HEADING=$(cat <<'EOF'
## interpretations
- a
EOF
)
assert_eq "$(parse_count "$LOWERCASE_HEADING" "r.total")" "0" "lowercase '## interpretations' does NOT anchor"

SINGULAR_HEADING=$(cat <<'EOF'
## Interpretation
- a
EOF
)
assert_eq "$(parse_count "$SINGULAR_HEADING" "r.total")" "0" "singular '## Interpretation' does NOT anchor"

finish
