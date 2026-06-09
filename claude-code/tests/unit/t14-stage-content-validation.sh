#!/bin/bash
# t14: Validates content structure inside each of 32 stage files (160 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"
LIB="$AIDLC_SRC/tools/aidlc-lib.ts"

plan 160

# Extract a YAML frontmatter scalar field via parseStageFrontmatter.
# Prints empty string if absent or non-string.
frontmatter_field() {
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$1', 'utf8'));
    const v = obj['$2'];
    console.log(typeof v === 'string' ? v : '');
  " 2>/dev/null
}

for phase_dir in "$STAGES_DIR"/*/; do
  for stage_file in "$phase_dir"*.md; do
    [ -f "$stage_file" ] || continue
    slug=$(basename "$stage_file" .md)

    # 1. YAML frontmatter has non-empty `phase` field
    phase_val=$(frontmatter_field "$stage_file" phase)
    if [ -n "$phase_val" ]; then
      ok "$slug has Phase field"
    else
      not_ok "$slug has Phase field" "frontmatter phase empty or absent"
    fi

    # 2. YAML frontmatter has non-empty `lead_agent` field
    agent_val=$(frontmatter_field "$stage_file" lead_agent)
    if [ -n "$agent_val" ]; then
      ok "$slug has Lead Agent field"
    else
      not_ok "$slug has Lead Agent field" "frontmatter lead_agent empty or absent"
    fi

    # 3. References stage-protocol
    assert_grep "$stage_file" "stage-protocol" "$slug references stage-protocol"

    # 4. Has Steps or PART section (structural heading for execution steps)
    if grep -q "^## Steps\|^## PART" "$stage_file" 2>/dev/null; then
      ok "$slug has Steps/PART section"
    else
      not_ok "$slug has Steps/PART section" "no '## Steps' or '## PART' heading found"
    fi

    # 5. Has Outputs field (case-insensitive)
    if grep -qi "outputs" "$stage_file" 2>/dev/null; then
      ok "$slug has Outputs field"
    else
      not_ok "$slug has Outputs field" "no Outputs reference found"
    fi
  done
done

finish
