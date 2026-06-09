#!/bin/bash
# t16: Phase rules file structure validation (12 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

RULES_DIR="$AIDLC_SRC/rules"
STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"

plan 12

# ============================================================
# Part 1: 4 phase files exist
# ============================================================

for phase in ideation inception construction operation; do
  assert_file_exists "$RULES_DIR/aidlc-phase-$phase.md" "aidlc-phase-$phase.md exists"
done

# ============================================================
# Part 2: Each is non-empty
# ============================================================

for phase in ideation inception construction operation; do
  size=$(wc -c < "$RULES_DIR/aidlc-phase-$phase.md")
  assert_gt "$size" 0 "aidlc-phase-$phase.md is non-empty"
done

# ============================================================
# Part 3: Each references at least one stage slug that exists on disk
# ============================================================

for phase in ideation inception construction operation; do
  found=0
  matched_slug=""
  for stage_file in "$STAGES_DIR/$phase/"*.md; do
    [ -f "$stage_file" ] || continue
    slug=$(basename "$stage_file" .md)
    # Check exact slug match first
    if grep -qF "$slug" "$RULES_DIR/aidlc-phase-$phase.md"; then
      found=1
      matched_slug="$slug"
      break
    fi
    # Fallback: check if any hyphen-separated word (4+ chars) from the slug
    # appears case-insensitively in the rules file (e.g., "deployment" from
    # "deployment-execution" matches in operation.md).
    # Note: Git Bash's grep has a known bug combining -F with -i, so we use
    # -i alone. These are word literals — no regex metacharacters to worry about.
    for word in $(echo "$slug" | tr '-' '\n'); do
      if [ "${#word}" -ge 4 ] && grep -qi "$word" "$RULES_DIR/aidlc-phase-$phase.md"; then
        found=1
        matched_slug="$slug (via word: $word)"
        break 2
      fi
    done
  done
  if [ "$found" -eq 1 ]; then
    ok "aidlc-phase-$phase.md references at least one $phase stage slug ($matched_slug)"
  else
    not_ok "aidlc-phase-$phase.md references at least one $phase stage slug" "no slug or slug-word found in aidlc-phase-$phase.md"
  fi
done

finish
