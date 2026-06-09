#!/bin/bash
# t38: Cross-check Lead Agent in each stage file against Stage Graph table in SKILL.md (32 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"
STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"
LIB="$AIDLC_SRC/tools/aidlc-lib.ts"

plan 32

# Extract Stage Graph table rows (skip header and separator lines)
GRAPH_ROWS=$(sed -n '/^## Stage Graph/,/^---$/p' "$SKILL" | grep '^|' | tail -n +3)

# Phase name to directory mapping (lowercase)
phase_to_dir() {
  echo "$1" | tr '[:upper:]' '[:lower:]'
}

# For each row in the Stage Graph table, cross-check Lead Agent against the stage file
while IFS='|' read -r _ slug _ _ phase _ lead_agent _ _; do
  slug=$(echo "$slug" | xargs)
  phase=$(echo "$phase" | xargs)
  lead_agent=$(echo "$lead_agent" | xargs)

  [ -z "$slug" ] && continue

  phase_dir=$(phase_to_dir "$phase")
  stage_file="$STAGES_DIR/$phase_dir/${slug}.md"

  if [ ! -f "$stage_file" ]; then
    not_ok "$slug: Lead Agent cross-check" "stage file not found: $stage_file"
    continue
  fi

  # Extract lead_agent from stage file YAML frontmatter
  file_agent=$(bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$stage_file', 'utf8'));
    console.log(typeof obj.lead_agent === 'string' ? obj.lead_agent : '');
  " 2>/dev/null)

  # Graph uses "(orchestrator)" for orchestrator-led stages; YAML uses bare "orchestrator"
  # Normalize graph value by stripping parentheses to compare slugs directly.
  graph_normalized=$(echo "$lead_agent" | tr -d '()')

  if [ "$file_agent" = "$graph_normalized" ]; then
    ok "$slug: Lead Agent matches ($graph_normalized)"
  else
    not_ok "$slug: Lead Agent mismatch" "file='$file_agent' graph='$graph_normalized'"
  fi
done <<< "$GRAPH_ROWS"

finish
