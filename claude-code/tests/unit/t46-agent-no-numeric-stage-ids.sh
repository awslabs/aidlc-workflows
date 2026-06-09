#!/bin/bash
# t46: Agent files must reference stages by slug, not numeric ID (22 tests).
#
# v0.3.0 MR 1 stripped digit.dot.digit stage identifiers (e.g. "1.1",
# "3.4–3.7") from the 11 agent files. Stages are identified by slug
# (e.g. "intent-capture") per SKILL.md's canonical-identifier rule.
# Numbers live in stage-graph.json for graph-machine use.
#
# Two assertions per agent (22 total):
#   A: format — grep -E '[0-9]+\.[0-9]+' returns zero matches,
#      except content-based exclusion for 'WCAG' (W3C version number
#      in aidlc-design-agent.md that is not a stage ID).
#   B: semantic — every slug in the "Stages Owned" list exists in
#      stage-graph.json. Catches typos or wrong-slug mappings that
#      the format check alone would miss.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

AGENTS_DIR="$AIDLC_SRC/agents"
STAGE_GRAPH="$AIDLC_SRC/tools/data/stage-graph.json"

AGENTS="product design delivery architect aws-platform compliance devsecops developer quality pipeline-deploy operations"

if ! command -v jq >/dev/null 2>&1; then
  echo "1..0 # SKIP jq not installed"
  exit 0
fi

plan 22

for agent in $AGENTS; do
  FILE="$AGENTS_DIR/aidlc-${agent}-agent.md"

  # Assertion A: no digit.dot.digit stage IDs (WCAG version refs excluded)
  HITS=$(grep -En '[0-9]+\.[0-9]+' "$FILE" 2>/dev/null | grep -v 'WCAG' || true)
  if [ -z "$HITS" ]; then
    ok "${agent}-agent has no numeric stage IDs"
  else
    not_ok "${agent}-agent has no numeric stage IDs" "matches: $(echo "$HITS" | head -3 | tr '\n' ';')"
  fi

  # Assertion B: every slug bullet in "Stages Owned" resolves in stage-graph.json
  # Pattern for a Stages Owned bullet: "- <slug> — <rest of line>"
  # Slug is lowercase letters, digits, and hyphens.
  SLUGS=$(awk '
    /^## Stages Owned/ {in_section=1; next}
    /^## / && in_section {in_section=0}
    in_section && /^- [a-z][a-z0-9-]* — / {
      sub(/^- /, "")
      sub(/ — .*$/, "")
      print
    }
  ' "$FILE")

  UNKNOWN=""
  for slug in $SLUGS; do
    if ! jq -e --arg s "$slug" '.[] | select(.slug == $s)' "$STAGE_GRAPH" >/dev/null 2>&1; then
      UNKNOWN="$UNKNOWN $slug"
    fi
  done

  if [ -z "$UNKNOWN" ]; then
    ok "${agent}-agent Stages Owned slugs all resolve in stage-graph.json"
  else
    not_ok "${agent}-agent Stages Owned slugs all resolve in stage-graph.json" "unknown slugs:$UNKNOWN"
  fi
done

finish
