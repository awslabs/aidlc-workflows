#!/bin/bash
# t80: practices-runtime — extractMarkdownSection edges + practices-event
# --type empty emit (v0.4.0 MR 13).
#
# MR 13's SKILL.md U1 reads two sections from team practices via
# extractMarkdownSection (lib.ts:1081). The orchestrator must handle:
#   - Empty section (heading + blank lines) — fall back, emit advisory
#   - Section with only HTML comments — same as empty after strip
#   - Trailing whitespace on heading lines (normal markdown editor behaviour)
#   - Sub-heading collisions (## Walking vs ## Walking Skeleton — exact match)
#
# This test pins:
#   1-4. extractMarkdownSection regex behaviour for the four edge cases
#   5. PRACTICES_SECTION_EMPTY emits via aidlc-state.ts practices-event
#      --type empty (newly added in MR 13)
#   6. The audit row carries Section + Fallback fields
#   7. extractMarkdownSection ignores `## Heading` lines inside fenced code
#      blocks (post-merge MR 13 review fold-in — the regex used to match
#      teaching-example headings inside ``` fences, which would let an
#      unrelated example masquerade as the live section).
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

plan 7

LIB="$AIDLC_SRC/tools/aidlc-lib.ts"

# --- Tests 1-4: extractMarkdownSection regex edge cases ---
PROBE=$(bun -e "
  import { extractMarkdownSection } from '$LIB';
  // Edge 1: empty section body
  const empty = '## Walking Skeleton\n\n## Branching\nfoo\n';
  console.log('EMPTY=' + JSON.stringify(extractMarkdownSection(empty, '## Walking Skeleton')));
  // Edge 2: section with only HTML comments
  const commented = '## Walking Skeleton\n<!-- placeholder -->\n\n## Branching\nfoo\n';
  console.log('COMMENT=' + JSON.stringify(extractMarkdownSection(commented, '## Walking Skeleton')));
  // Edge 3: trailing whitespace on heading line
  const ws = '## Walking Skeleton   \nbody\n## Branching\nfoo';
  console.log('WS=' + JSON.stringify(extractMarkdownSection(ws, '## Walking Skeleton')));
  // Edge 4: sub-heading collision — searching for '## Walking' must NOT match '## Walking Skeleton'
  const sub = '## Walking Skeleton\nskeleton-body\n## Branching\nbranch-body';
  console.log('SUB=' + JSON.stringify(extractMarkdownSection(sub, '## Walking')));
" 2>&1)

EMPTY=$(echo "$PROBE" | grep '^EMPTY=' | cut -d= -f2-)
# Body-less section returns whitespace-only (the newline between heading and next ##).
# rules-reading.md §1: caller treats this as empty after trim.
if [ "$EMPTY" = '""' ] || [ "$EMPTY" = '"\n"' ]; then
  ok "extractMarkdownSection returns whitespace-only body for body-less section (caller trims)"
else
  not_ok "extractMarkdownSection should return whitespace-only for body-less section" "got: $EMPTY"
fi

COMMENT=$(echo "$PROBE" | grep '^COMMENT=' | cut -d= -f2-)
# HTML-comments-only section is non-empty per the helper (it returns the prose verbatim
# including trailing newlines). rules-reading.md §1 documents that the CALLER
# (orchestrator) is responsible for treating every-line-starts-with-<!-- as empty.
if echo "$COMMENT" | grep -q "<!-- placeholder -->"; then
  ok "extractMarkdownSection returns literal HTML-comment body (caller decides empty)"
else
  not_ok "extractMarkdownSection should return literal comment body" "got: $COMMENT"
fi

WS=$(echo "$PROBE" | grep '^WS=' | cut -d= -f2-)
# Helper preserves trailing newlines (no .trim() — caller can normalise).
if echo "$WS" | grep -q "^\"body"; then
  ok "extractMarkdownSection tolerates trailing whitespace on heading line"
else
  not_ok "extractMarkdownSection failed on trailing-whitespace heading" "got: $WS"
fi

SUB=$(echo "$PROBE" | grep '^SUB=' | cut -d= -f2-)
# Searching for '## Walking' against a doc that only has '## Walking Skeleton' should return ""
# (no exact match — regex is anchored to end-of-line via `[ \t]*$`).
if [ "$SUB" = '""' ]; then
  ok "extractMarkdownSection requires exact heading match (no sub-heading false positive)"
else
  not_ok "extractMarkdownSection matched a sub-heading (regex too permissive)" "got: $SUB"
fi

# --- Tests 5-6: PRACTICES_SECTION_EMPTY emit via practices-event --type empty ---
PROJ=$(setup_integration_project --with-greenfield-stub)
STATE_TOOL="bun $AIDLC_SRC/tools/aidlc-state.ts"
AUDIT="$PROJ/aidlc-docs/audit.md"

EMPTY_OUT=$($STATE_TOOL practices-event \
  --type empty \
  --field "Section: Walking Skeleton" \
  --field "Fallback: org.md" \
  --project-dir "$PROJ" 2>&1)
if echo "$EMPTY_OUT" | grep -q '"emitted":"PRACTICES_SECTION_EMPTY"'; then
  ok "practices-event --type empty returns PRACTICES_SECTION_EMPTY envelope"
else
  not_ok "--type empty failed to emit PRACTICES_SECTION_EMPTY" "$EMPTY_OUT"
fi

EMPTY_BLOCK=$(awk '/PRACTICES_SECTION_EMPTY/{flag=1} flag && /^---$/{exit} flag' "$AUDIT")
if echo "$EMPTY_BLOCK" | grep -q "\*\*Section\*\*: Walking Skeleton" \
  && echo "$EMPTY_BLOCK" | grep -q "\*\*Fallback\*\*: org.md"; then
  ok "PRACTICES_SECTION_EMPTY audit row carries Section + Fallback fields"
else
  not_ok "PRACTICES_SECTION_EMPTY audit row missing fields" "$EMPTY_BLOCK"
fi

cleanup_test_project "$PROJ"

# --- Test 7: code-fenced ## headings are ignored ---
# Post-merge MR 13 fold-in. A teaching-example `## Walking Skeleton` line
# inside a ``` fence must not be mistaken for the actual section. The first
# real heading in the doc is `## Walking Skeleton` at top; the fence in the
# Branching section contains a sample `## Walking Skeleton: never` that the
# pre-fix regex would have surfaced if it appeared first in the file.
FENCED=$(bun -e "
  import { extractMarkdownSection } from '$LIB';
  const doc = '## Branching\nuse trunk-based.\n\n\`\`\`\n## Walking Skeleton: never\n\`\`\`\n\n## Walking Skeleton\nreal-body\n';
  console.log('FENCED=' + JSON.stringify(extractMarkdownSection(doc, '## Walking Skeleton')));
" 2>&1 | grep '^FENCED=' | cut -d= -f2-)
if echo "$FENCED" | grep -q "real-body"; then
  ok "extractMarkdownSection ignores '## Heading' lines inside fenced code blocks"
else
  not_ok "extractMarkdownSection should skip fenced ## lines" "got: $FENCED"
fi

finish
