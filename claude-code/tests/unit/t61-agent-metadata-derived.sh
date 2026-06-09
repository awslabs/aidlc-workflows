#!/bin/bash
# t61: AGENT_KNOWLEDGE + AGENT_DISPLAY literals replaced with loadAgents()
# derived from `.claude/agents/*.md` frontmatter. Adding an agent file flows
# through init knowledge scaffolding and statusline rendering with no code
# changes. Also fixes a pre-existing display-string drift: statusline now
# reads "Pipeline & Deploy Agent" (matches docs and --init output) instead
# of "Pipeline Deploy Agent". v0.3.0 Foundation MR 3, #62.
#
# Five assertions:
#   1. Static grep — AGENT_KNOWLEDGE and AGENT_DISPLAY gone from tools/ + hooks/
#   2. Runtime — loadAgents() returns 11 alphabetical agents with "Pipeline & Deploy Agent"
#   3. Fixture accept — init scaffolds knowledge README for a fixture agent
#   4. Fixture reject — missing display_name frontmatter fails init loudly
#   5. Statusline derives from frontmatter (proves AGENT_DISPLAY drift is fixed)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 5

# --- Test 1: static grep — AGENT_KNOWLEDGE and AGENT_DISPLAY gone ---
HITS=$(grep -rnE 'AGENT_KNOWLEDGE|AGENT_DISPLAY' \
  "$AIDLC_SRC/tools/" "$AIDLC_SRC/hooks/" 2>/dev/null || true)
if [ -z "$HITS" ]; then
  ok "no AGENT_KNOWLEDGE/AGENT_DISPLAY references in tools/ or hooks/"
else
  not_ok "no AGENT_KNOWLEDGE/AGENT_DISPLAY references in tools/ or hooks/" "found: $HITS"
fi

# --- Test 2: runtime — loadAgents() returns 11 alphabetical entries with "Pipeline & Deploy Agent" ---
LIB="$AIDLC_SRC/tools/aidlc-lib.ts"
ACTUAL=$(bun -e "import { loadAgents } from '$LIB'; const a = loadAgents(); console.log(a.length); console.log(a.map(x => x.slug).join(',')); console.log(a.find(x => x.slug === 'aidlc-pipeline-deploy-agent').display_name);" 2>&1 | tail -3)
COUNT=$(echo "$ACTUAL" | sed -n '1p')
SLUGS=$(echo "$ACTUAL" | sed -n '2p')
PIPELINE_DISPLAY=$(echo "$ACTUAL" | sed -n '3p')
EXPECTED_SLUGS="aidlc-architect-agent,aidlc-aws-platform-agent,aidlc-compliance-agent,aidlc-delivery-agent,aidlc-design-agent,aidlc-developer-agent,aidlc-devsecops-agent,aidlc-operations-agent,aidlc-pipeline-deploy-agent,aidlc-product-agent,aidlc-quality-agent"
if [ "$COUNT" = "11" ] && [ "$SLUGS" = "$EXPECTED_SLUGS" ] && [ "$PIPELINE_DISPLAY" = "Pipeline & Deploy Agent" ]; then
  ok "loadAgents() returns 11 alphabetically-sorted agents with correct display names"
else
  not_ok "loadAgents() returns 11 alphabetically-sorted agents with correct display names" "count=$COUNT slugs=$SLUGS pipeline=$PIPELINE_DISPLAY"
fi

# --- Shared fixture: add a fixture-agent.md under $PROJ/.claude/agents/ ---
write_fixture_agent() {
  local proj="$1"
  local display="${2:-Fixture Agent}"
  local include_display="${3:-yes}"
  local file="$proj/.claude/agents/fixture-agent.md"
  if [ "$include_display" = "yes" ]; then
    cat > "$file" <<EOF
---
name: fixture-agent
display_name: $display
examples:
  - fixture-one.md
  - fixture-two.md
description: >
  Placeholder fixture agent for t61. Not a real persona.
disallowedTools: Task
modelOverride: opus
---

Fixture agent body.
EOF
  else
    # Broken variant: omits display_name
    cat > "$file" <<EOF
---
name: fixture-agent
examples:
  - fixture-one.md
description: >
  Broken fixture agent — missing display_name.
disallowedTools: Task
modelOverride: opus
---
EOF
  fi
}

# --- Test 3: fixture accept — init scaffolds a knowledge README for the fixture agent ---
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
write_fixture_agent "$PROJ"
set +e
OUT=$(bun "$PROJ/.claude/tools/aidlc-utility.ts" init --scope poc --project-dir "$PROJ" 2>&1)
RC=$?
set -e
README="$PROJ/aidlc-docs/knowledge/fixture-agent/README.md"
if [ $RC -eq 0 ] && [ -f "$README" ] && grep -qE '^# Fixture Agent Knowledge$' "$README" && grep -qE '^- fixture-one\.md$' "$README"; then
  ok "init scaffolds knowledge/fixture-agent/README.md with derived display name + examples"
else
  not_ok "init scaffolds knowledge/fixture-agent/README.md with derived display name + examples" "rc=$RC readme=$([ -f "$README" ] && echo yes || echo no) out=$OUT"
fi
cleanup_test_project "$PROJ"

# --- Test 4: fixture reject — init fails when display_name is missing ---
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
write_fixture_agent "$PROJ" "" "no"
set +e
OUT=$(bun "$PROJ/.claude/tools/aidlc-utility.ts" init --scope poc --project-dir "$PROJ" 2>&1)
RC=$?
set -e
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "fixture-agent" && echo "$OUT" | grep -q "display_name"; then
  ok "init fails loudly when fixture-agent.md lacks display_name (error cites file + field)"
else
  not_ok "init fails loudly when fixture-agent.md lacks display_name" "rc=$RC out=$OUT"
fi
cleanup_test_project "$PROJ"

# --- Test 5: statusline derives agent display from frontmatter ---
# Proves AGENT_DISPLAY drift is fixed — seed aidlc-pipeline-deploy-agent, expect
# "Pipeline & Deploy Agent" (with ampersand) in the output.
PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
write_fixture_agent "$PROJ"
mkdir -p "$PROJ/aidlc-docs"
cat > "$PROJ/aidlc-docs/aidlc-state.md" <<'EOF'
# AI-DLC State Tracking
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ci-pipeline
- **Active Agent**: aidlc-pipeline-deploy-agent
- **Status**: Running
EOF
HOOK="$PROJ/.claude/hooks/aidlc-statusline.ts"
OUT_SHIPPED=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>&1)

# Also verify the fixture agent renders — swap Active Agent and re-run.
sed -i.bak 's/aidlc-pipeline-deploy-agent/fixture-agent/' "$PROJ/aidlc-docs/aidlc-state.md"
OUT_FIXTURE=$(echo "{\"workspace\":{\"project_dir\":\"$PROJ\"}}" | bun "$HOOK" 2>&1)

if echo "$OUT_SHIPPED" | grep -qF "Pipeline & Deploy Agent" && echo "$OUT_FIXTURE" | grep -qF "Fixture Agent"; then
  ok "statusline renders derived display name for both shipped and fixture agents"
else
  not_ok "statusline renders derived display name for both shipped and fixture agents" "shipped=$OUT_SHIPPED fixture=$OUT_FIXTURE"
fi
cleanup_test_project "$PROJ"

finish
