#!/bin/bash
# t32: Cross-reference Stage Graph table in SKILL.md against actual stage files
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"
STAGES_DIR="$AIDLC_SRC/aidlc-common/stages"
AGENTS_DIR="$AIDLC_SRC/agents"
LIB="$AIDLC_SRC/tools/aidlc-lib.ts"

# Extract Stage Graph table rows (skip header and separator lines)
GRAPH_ROWS=$(sed -n '/^## Stage Graph/,/^---$/p' "$SKILL" | grep '^|' | tail -n +3)

# Count rows and files for plan
ROW_COUNT=$(echo "$GRAPH_ROWS" | wc -l | tr -d ' ')
FILE_COUNT=$(find "$STAGES_DIR" -name "*.md" -type f | wc -l | tr -d ' ')

# Assertions (post-MR-8 — Display Order dropped; computed by MR 9 compile):
#   - Each row's slug has a file (ROW_COUNT assertions)
#   - Each file on disk has a row (FILE_COUNT assertions)
#   - Lead Agent references existing agent file (ROW_COUNT assertions)
#   - Execution field matches YAML frontmatter (ROW_COUNT assertions)
# Total = ROW_COUNT*3 + FILE_COUNT
PLAN_COUNT=$(( ROW_COUNT * 3 + FILE_COUNT ))
plan "$PLAN_COUNT"

# Phase name to directory mapping (lowercase)
phase_to_dir() {
  echo "$1" | tr '[:upper:]' '[:lower:]'
}

# Extract a YAML frontmatter scalar field via parseStageFrontmatter.
frontmatter_field() {
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$1', 'utf8'));
    const v = obj['$2'];
    console.log(typeof v === 'string' ? v : '');
  " 2>/dev/null
}

# --- For each row in the graph: verify file exists, lead agent, execution ---
GRAPH_SLUG_LIST=""
while IFS='|' read -r _ slug num stage phase execution lead_agent _ _; do
  slug=$(echo "$slug" | xargs)
  num=$(echo "$num" | xargs)
  phase=$(echo "$phase" | xargs)
  execution=$(echo "$execution" | xargs)
  lead_agent=$(echo "$lead_agent" | xargs)

  [ -z "$slug" ] && continue
  GRAPH_SLUG_LIST+="$slug"$'\n'

  phase_dir=$(phase_to_dir "$phase")
  stage_file="$STAGES_DIR/$phase_dir/${slug}.md"

  # 1. Slug has a file on disk
  assert_file_exists "$stage_file" "graph row '$slug' has stage file"

  if [ -f "$stage_file" ]; then
    # 2. Execution field in YAML matches graph
    file_execution=$(frontmatter_field "$stage_file" execution)
    assert_eq "$file_execution" "$execution" "graph '$slug' Execution matches file ($execution)"
  else
    not_ok "graph '$slug' Execution matches file ($execution)" "file not found"
  fi

  # 3. Lead Agent references an existing agent file (skip orchestrator)
  if [ "$lead_agent" = "(orchestrator)" ]; then
    ok "graph '$slug' lead agent is orchestrator (no file needed)"
  else
    agent_file="$AGENTS_DIR/${lead_agent}.md"
    assert_file_exists "$agent_file" "graph '$slug' lead agent '$lead_agent' has agent file"
  fi
done <<< "$GRAPH_ROWS"

# --- Every stage file on disk has a row in the graph ---
for phase_dir in "$STAGES_DIR"/*/; do
  for f in "$phase_dir"*.md; do
    [ -f "$f" ] || continue
    slug=$(basename "$f" .md)
    if echo "$GRAPH_SLUG_LIST" | grep -qxF "$slug"; then
      ok "stage file '$slug' has row in graph table"
    else
      not_ok "stage file '$slug' has row in graph table" "no graph row found"
    fi
  done
done

finish
