#!/bin/bash
# t70: extractMarkdownSection / appendUnderHeading / replaceSection helpers in
# aidlc-lib.ts.
# These helpers are load-bearing for the practices-discovery cross-row
# promotion (extract reads existing team.md sections, replaceSection
# overwrites them, appendUnderHeading adds rules to project-guardrails.md).
# A future refactor could break a regex or off-by-one without any caller-
# level test catching it — these unit tests pin the behavioural contract.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

LIB="$(cd "$SCRIPT_DIR/../../dist/claude/.claude/tools" && pwd)/aidlc-lib.ts"

plan 12

# ----- extractMarkdownSection -----

# 1. Returns prose between heading and next ## heading
OUT=$(bun -e "
  import { extractMarkdownSection } from '$LIB';
  const c = '# Title\n\n## Branching\n\nWe trunk-base.\n\n## Testing\n\nTDD.\n';
  console.log(JSON.stringify(extractMarkdownSection(c, '## Branching')));
")
assert_eq "$OUT" '"\nWe trunk-base.\n\n"' "extractMarkdownSection returns prose between heading and next ##"

# 2. Returns empty string when heading absent
OUT=$(bun -e "
  import { extractMarkdownSection } from '$LIB';
  const c = '# Title\n\n## Branching\n\nWe trunk-base.\n';
  console.log(JSON.stringify(extractMarkdownSection(c, '## Missing')));
")
assert_eq "$OUT" '""' "extractMarkdownSection returns empty string for missing heading"

# 3. Returns prose to EOF when heading is the last section
OUT=$(bun -e "
  import { extractMarkdownSection } from '$LIB';
  const c = '## Branching\n\nWe trunk-base.\n';
  console.log(JSON.stringify(extractMarkdownSection(c, '## Branching')));
")
assert_eq "$OUT" '"\nWe trunk-base.\n"' "extractMarkdownSection returns prose to EOF when heading is last section"

# 4. Sub-headings (### ) inside the section are preserved (not stopped on)
OUT=$(bun -e "
  import { extractMarkdownSection } from '$LIB';
  const c = '## Branching\n\nMain text.\n\n### Sub\n\nMore.\n\n## Next\n';
  process.stdout.write(extractMarkdownSection(c, '## Branching'));
")
if echo "$OUT" | grep -q "### Sub" && echo "$OUT" | grep -q "More."; then
  ok "extractMarkdownSection treats ### as content, not section boundary"
else
  not_ok "extractMarkdownSection treats ### as content, not section boundary" "got: $OUT"
fi

# ----- appendUnderHeading -----

# 5. Inserts new content before the next ## heading
OUT=$(bun -e "
  import { appendUnderHeading } from '$LIB';
  const c = '## Mandated\n\n## Forbidden\n';
  console.log(JSON.stringify(appendUnderHeading(c, '## Mandated', 'ALWAYS test\n')));
")
assert_eq "$OUT" '"## Mandated\n\nALWAYS test\n## Forbidden\n"' "appendUnderHeading inserts content before the next ## heading"

# 6. Inserts at EOF when heading is the last section
OUT=$(bun -e "
  import { appendUnderHeading } from '$LIB';
  const c = '## Mandated\n';
  console.log(JSON.stringify(appendUnderHeading(c, '## Mandated', 'ALWAYS test\n')));
")
assert_eq "$OUT" '"## Mandated\nALWAYS test\n"' "appendUnderHeading inserts at EOF when heading is the last section"

# 7. Throws when heading is missing
OUT=$(bun -e "
  import { appendUnderHeading } from '$LIB';
  try {
    appendUnderHeading('## Other\n', '## Missing', 'x');
    console.log('NO_THROW');
  } catch (e) {
    console.log('THREW:' + e.message);
  }
")
if echo "$OUT" | grep -q "THREW:.*heading not found"; then
  ok "appendUnderHeading throws on missing heading"
else
  not_ok "appendUnderHeading throws on missing heading" "got: $OUT"
fi

# 8. Append is additive across calls (no de-duplication)
OUT=$(bun -e "
  import { appendUnderHeading } from '$LIB';
  let c = '## Mandated\n';
  c = appendUnderHeading(c, '## Mandated', 'rule\n');
  c = appendUnderHeading(c, '## Mandated', 'rule\n');
  process.stdout.write(c);
")
COUNT=$(echo "$OUT" | grep -c "^rule$")
assert_eq "$COUNT" "2" "appendUnderHeading is additive (does not deduplicate)"

# ----- replaceSection -----

# 9. Overwrites prose between heading and next ## heading
OUT=$(bun -e "
  import { replaceSection } from '$LIB';
  const c = '## Branching\n\nOld text.\n\n## Testing\n\nTDD.\n';
  process.stdout.write(replaceSection(c, '## Branching', '\nNew text.\n\n'));
")
if echo "$OUT" | grep -q "New text" && ! echo "$OUT" | grep -q "Old text"; then
  ok "replaceSection overwrites section content"
else
  not_ok "replaceSection overwrites section content" "got: $OUT"
fi

# 10. Preserves the heading line and downstream sections
OUT=$(bun -e "
  import { replaceSection } from '$LIB';
  const c = '## Branching\n\nOld.\n\n## Testing\n\nTDD.\n';
  process.stdout.write(replaceSection(c, '## Branching', '\nNew.\n\n'));
")
if echo "$OUT" | grep -q "## Branching" && echo "$OUT" | grep -q "## Testing" && echo "$OUT" | grep -q "TDD"; then
  ok "replaceSection preserves heading line and downstream sections"
else
  not_ok "replaceSection preserves heading line and downstream sections" "got: $OUT"
fi

# 11. Idempotent across reruns with the same content (key property for MR 8 cross-row promotion)
OUT=$(bun -e "
  import { replaceSection } from '$LIB';
  let c = '## Branching\n\nOriginal.\n\n## Testing\n\nTDD.\n';
  c = replaceSection(c, '## Branching', '\nAffirmed.\n\n');
  c = replaceSection(c, '## Branching', '\nAffirmed.\n\n');
  // Should NOT have grown — replaceSection is idempotent.
  process.stdout.write(c);
")
AFFIRMED_COUNT=$(echo "$OUT" | grep -c "^Affirmed.$")
assert_eq "$AFFIRMED_COUNT" "1" "replaceSection is idempotent on re-run with same content"

# 12. Throws when heading is missing
OUT=$(bun -e "
  import { replaceSection } from '$LIB';
  try {
    replaceSection('## Other\n', '## Missing', 'x');
    console.log('NO_THROW');
  } catch (e) {
    console.log('THREW:' + e.message);
  }
")
if echo "$OUT" | grep -q "THREW:.*heading not found"; then
  ok "replaceSection throws on missing heading"
else
  not_ok "replaceSection throws on missing heading" "got: $OUT"
fi

finish
