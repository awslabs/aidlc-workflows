#!/bin/bash
# t26: Content guardrail — aidlc-delivery-agent surface must not use human-timeline
# framing (velocity, burndown, sprint goals, story points, daily mob schedule,
# weeks of effort). Issue #18: estimates were meaningless in the AI build world.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

# Pattern that must not appear in any of the files below. Case-insensitive grep.
FORBIDDEN='velocity|burndown|daily mob schedule|sprint goal|story point|weeks of effort'

FILES=(
  "$AIDLC_SRC/aidlc-common/stages/inception/delivery-planning.md"
  "$AIDLC_SRC/agents/aidlc-delivery-agent.md"
  "$AIDLC_SRC/knowledge/aidlc-delivery-agent/workflow-planning-guide.md"
)

plan "${#FILES[@]}"

for file in "${FILES[@]}"; do
  name=$(basename "$file")
  if ! grep -Eiq "$FORBIDDEN" "$file" 2>/dev/null; then
    ok "$name has no human-timeline framing"
  else
    hits=$(grep -Ein "$FORBIDDEN" "$file" 2>/dev/null | head -3)
    not_ok "$name has no human-timeline framing" "matches: $hits"
  fi
done

finish
