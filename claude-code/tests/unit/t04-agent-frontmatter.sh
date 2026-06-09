#!/bin/bash
# t04: 11 agents have valid frontmatter (55 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

AGENTS_DIR="$(cd "$SCRIPT_DIR/../../dist/claude/.claude/agents" && pwd)"

AGENTS="product design delivery architect aws-platform compliance devsecops developer quality pipeline-deploy operations"

# Expected modelOverride per agent. opus = high-judgment / high-blast-radius work;
# sonnet = templated config/scaffolding. See docs/reference/05-agent-system.md.
expected_model() {
  case "$1" in
    architect|product|design|developer|quality|devsecops|compliance|aws-platform) echo opus ;;
    delivery|pipeline-deploy|operations) echo sonnet ;;
    *) echo unknown ;;
  esac
}

plan 55

for agent in $AGENTS; do
  FILE="$AGENTS_DIR/aidlc-${agent}-agent.md"

  # name: matches filename
  if grep -q "^name:.*aidlc-${agent}-agent" "$FILE" 2>/dev/null; then
    ok "aidlc-${agent}-agent has name: matching filename"
  else
    not_ok "aidlc-${agent}-agent has name: matching filename" "name field mismatch"
  fi

  # description: present
  if grep -q "^description:" "$FILE" 2>/dev/null; then
    ok "aidlc-${agent}-agent has description:"
  else
    not_ok "aidlc-${agent}-agent has description:" "missing description field"
  fi

  # allowedTools: must be ABSENT (silently-ignored field removed in v0.5.4)
  if grep -q "^allowedTools:" "$FILE" 2>/dev/null; then
    not_ok "aidlc-${agent}-agent has no allowedTools: (ignored field removed)" "allowedTools field still present"
  else
    ok "aidlc-${agent}-agent has no allowedTools: (ignored field removed)"
  fi

  # disallowedTools contains Task
  if grep -q "^disallowedTools:.*Task" "$FILE" 2>/dev/null; then
    ok "aidlc-${agent}-agent disallowedTools includes Task"
  else
    not_ok "aidlc-${agent}-agent disallowedTools includes Task" "Task not in disallowedTools"
  fi

  # modelOverride matches expected value
  EXPECTED=$(expected_model "$agent")
  ACTUAL=$(awk -F': *' '/^modelOverride:/ {print $2; exit}' "$FILE" 2>/dev/null)
  if [ "$ACTUAL" = "$EXPECTED" ]; then
    ok "${agent}-agent modelOverride is ${EXPECTED}"
  else
    not_ok "${agent}-agent modelOverride is ${EXPECTED}" "got: ${ACTUAL:-<missing>}"
  fi
done

finish
