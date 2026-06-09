#!/bin/bash
# t132 (unit): Doc-count drift guard for the hook-scope sentence in
# docs/reference/06-hooks-and-tools.md. Wave 3 MR 13 corrected the prose to
# "ten hook scripts ... All ten are project-wide ... the other nine via the
# `hooks` block", but no test pinned those counts, so they can silently
# re-drift away from ground truth (t131 pins the settings.json WIRING, not the
# prose count). This guard derives the hook-scope count from two ground-truth
# sources — the `hooks/aidlc-*.ts` files on disk AND the settings.json
# registrations (the `hooks` block + the `statusLine` key) — then asserts the
# doc's count-words agree, both directions, mirroring t28's two-source
# set-equality discipline. Pure bash + bun, no LLM (8 tests).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

SRC="$(cd "$SCRIPT_DIR/../../dist/claude/.claude" && pwd)"
HOOKS_DIR="$SRC/hooks"
SETTINGS="$SRC/settings.json"
DOC="$(cd "$SCRIPT_DIR/../../docs/reference" && pwd)/06-hooks-and-tools.md"

plan 8

# --- Ground truth A: hook scripts on disk (hooks/aidlc-*.ts) ----------------
DISK_COUNT=$(ls -1 "$HOOKS_DIR"/aidlc-*.ts 2>/dev/null | wc -l | tr -d ' ')
assert_gt "$DISK_COUNT" 0 "found $DISK_COUNT hooks/aidlc-*.ts files on disk"

# --- Ground truth B: settings.json registrations ----------------------------
# Split into the `hooks` block command count and the `statusLine` key (1 when
# present). Parsed with bun (no jq dependency — the framework ships jq-free).
REG=$(bun -e '
  import { readFileSync } from "fs";
  const s = JSON.parse(readFileSync(process.argv[1], "utf8"));
  let block = 0;
  for (const ev of Object.keys(s.hooks || {}))
    for (const g of s.hooks[ev])
      for (const _ of (g.hooks || [])) block++;
  const statusline = (s.statusLine && s.statusLine.command) ? 1 : 0;
  console.log(block + " " + statusline);
' "$SETTINGS" 2>/dev/null || echo "0 0")
SETTINGS_BLOCK_COUNT=$(echo "$REG" | awk '{print $1}')
SETTINGS_STATUSLINE_COUNT=$(echo "$REG" | awk '{print $2}')
SETTINGS_TOTAL=$((SETTINGS_BLOCK_COUNT + SETTINGS_STATUSLINE_COUNT))
assert_eq "$SETTINGS_STATUSLINE_COUNT" "1" "settings.json registers exactly 1 statusLine hook"

# --- Ground truth cross-check: disk == settings total -----------------------
assert_eq "$SETTINGS_TOTAL" "$DISK_COUNT" \
  "settings.json total registrations ($SETTINGS_TOTAL) == hook files on disk ($DISK_COUNT)"

# --- Doc counts (number-words → ints) ---------------------------------------
# Map an English number-word to its integer; "MISS" if not a known word.
# A `case` (not an associative array) keeps this `set -u`-clean and portable
# across the macOS / Linux / Git-Bash bash versions the suite runs on.
word2int() {
  case "$1" in
    zero) echo 0 ;;  one) echo 1 ;;   two) echo 2 ;;    three) echo 3 ;;
    four) echo 4 ;;  five) echo 5 ;;  six) echo 6 ;;     seven) echo 7 ;;
    eight) echo 8 ;; nine) echo 9 ;;  ten) echo 10 ;;    eleven) echo 11 ;;
    twelve) echo 12 ;;
    *) echo "MISS" ;;
  esac
}

# "<subject> uses <word> hook scripts" — the total hook-scope count. The
# subject may be "AI-DLC" or "This implementation" (the v0.6.0 docs attribute
# the hooks — a Claude-Code artifact — to the implementation, not the
# methodology); this guard pins the count-word, not the subject noun.
DOC_TOTAL_WORD=$(grep -oE 'uses [a-z]+ hook scripts' "$DOC" | head -1 \
  | sed -E 's/uses ([a-z]+) hook scripts/\1/')
DOC_TOTAL=$(word2int "$DOC_TOTAL_WORD")

# "All <word> are **project-wide**" — must restate the same total.
DOC_ALL_PW_WORD=$(grep -oE 'All [a-z]+ are \*\*project-wide\*\*' "$DOC" | head -1 \
  | sed -E 's/All ([a-z]+) are \*\*project-wide\*\*/\1/')
DOC_ALL_PW=$(word2int "$DOC_ALL_PW_WORD")

# "the other <word> via the \`hooks\` block" — the hooks-block subcount
# (total minus the single statusLine entry).
DOC_BLOCK_WORD=$(grep -oE 'the other [a-z]+ via the `hooks` block' "$DOC" | head -1 \
  | sed -E 's/the other ([a-z]+) via the `hooks` block/\1/')
DOC_BLOCK=$(word2int "$DOC_BLOCK_WORD")

# Test: the doc's three count-words parsed cleanly (a prose reword that drops
# the pinned phrasing trips this before any equality check).
if [ "$DOC_TOTAL" != "MISS" ] && [ "$DOC_ALL_PW" != "MISS" ] && [ "$DOC_BLOCK" != "MISS" ]; then
  ok "doc count-words parsed: total='$DOC_TOTAL_WORD' all-project-wide='$DOC_ALL_PW_WORD' hooks-block='$DOC_BLOCK_WORD'"
else
  not_ok "doc count-words parse" "total='$DOC_TOTAL_WORD'($DOC_TOTAL) all-pw='$DOC_ALL_PW_WORD'($DOC_ALL_PW) block='$DOC_BLOCK_WORD'($DOC_BLOCK) — sentence reworded?"
fi

# Test: the doc's two total-restatements agree with each other (internal
# consistency — "uses N" must equal "All N are project-wide").
assert_eq "$DOC_ALL_PW" "$DOC_TOTAL" \
  "doc internal: 'All $DOC_ALL_PW_WORD project-wide' matches 'uses $DOC_TOTAL_WORD hook scripts'"

# Test: doc total == ground-truth total (forward — the doc cannot over/under-state).
assert_eq "$DOC_TOTAL" "$DISK_COUNT" \
  "doc 'uses $DOC_TOTAL_WORD hook scripts' == ground truth ($DISK_COUNT on disk / $SETTINGS_TOTAL registered)"

# Test: doc hooks-block subcount == settings.json hooks-block count (the
# total-minus-statusLine split the sentence makes explicit).
assert_eq "$DOC_BLOCK" "$SETTINGS_BLOCK_COUNT" \
  "doc 'other $DOC_BLOCK_WORD via the hooks block' == settings.json hooks-block count ($SETTINGS_BLOCK_COUNT)"

# Test: the doc's own split is arithmetically whole — block + statusLine == total
# (reverse — a half-correction that fixes one word but not the other is caught).
assert_eq "$((DOC_BLOCK + 1))" "$DOC_TOTAL" \
  "doc split is whole: hooks-block ($DOC_BLOCK) + statusLine (1) == total ($DOC_TOTAL)"

finish
