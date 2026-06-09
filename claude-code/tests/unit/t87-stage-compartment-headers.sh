#!/bin/bash
# t87: Every stage file under aidlc-common/stages/ contains both ^## Sensors$ and ^## Learn$ H2 headings (64 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"

plan 64

# Match a top-level H2 heading outside fenced code blocks. A heading inside a
# triple-backtick fence is documentation, not a real compartment, so the awk
# walker toggles a flag at every fence line and only emits matches outside.
heading_outside_fence() {
  local heading="$1" file="$2"
  awk -v h="$heading" '
    /^```/ { fenced = !fenced; next }
    !fenced && $0 == h { found = 1; exit }
    END { exit found ? 0 : 1 }
  ' "$file"
}

for phase_dir in "$STAGES_DIR"/*/; do
  for stage_file in "$phase_dir"*.md; do
    [ -f "$stage_file" ] || continue
    slug=$(basename "$stage_file" .md)

    # 1. ## Sensors compartment present (outside fenced code blocks)
    if heading_outside_fence "## Sensors" "$stage_file"; then
      ok "$slug has ## Sensors compartment"
    else
      not_ok "$slug has ## Sensors compartment" "no '^## Sensors$' heading found outside fenced code blocks"
    fi

    # 2. ## Learn compartment present (outside fenced code blocks)
    if heading_outside_fence "## Learn" "$stage_file"; then
      ok "$slug has ## Learn compartment"
    else
      not_ok "$slug has ## Learn compartment" "no '^## Learn$' heading found outside fenced code blocks"
    fi
  done
done

finish
