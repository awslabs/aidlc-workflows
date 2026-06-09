#!/bin/bash
# t70: Static checks for the worktree KB rewrites + the pipeline-deploy agent's
# practices-loading wiring.
#
# Pins shape, not exact line numbers — uses heading markers and awk-extracted
# regions so tests survive future edits inside those regions.
#
# The original SKILL.md assertions (the per-Bolt execution Steps 0/0.5/6.5/6.75
# and the halt-and-ask worktree-dispatch failure shapes) were RETIRED when the
# orchestrator was cut over to the engine forwarding loop: those per-Bolt
# orchestration steps are now engine concerns (run-stage / future invoke-swarm
# directives), no longer SKILL.md dispatch prose. The KB + agent checks below
# are unaffected by the cutover and remain the substance of this test.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

plan 9

AGENT="$AIDLC_SRC/agents/aidlc-pipeline-deploy-agent.md"
BS="$AIDLC_SRC/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md"
PR="$AIDLC_SRC/knowledge/aidlc-shared/rules-reading.md"

# --- 1. shared/rules-reading.md exists with all expected sections ---
assert_file_exists "$PR" "shared/rules-reading.md exists"
assert_grep "$PR" "## 1. Empty-template detection" \
  "rules-reading.md has empty-template detection section"
assert_grep "$PR" "## 2. Semantic-topic matching" \
  "rules-reading.md has semantic-topic matching section"
assert_grep "$PR" "## 3. Fallback chain" \
  "rules-reading.md has fallback chain section"

# --- 2. branching-strategies.md has Execution runbook + Failure modes per
#       strategy + Response contract ---
RUNBOOK_COUNT=$(grep -c "^### Execution runbook" "$BS")
assert_eq "$RUNBOOK_COUNT" "5" \
  "branching-strategies.md has 5 Execution runbook sub-sections (one per strategy)"
FAILURE_COUNT=$(grep -c "^### Failure modes" "$BS")
assert_eq "$FAILURE_COUNT" "5" \
  "branching-strategies.md has 5 Failure modes sub-sections (one per strategy)"
assert_grep "$BS" "^## Response contract" \
  "branching-strategies.md has Response contract top-level section"
# Cites the new shared KB.
assert_grep "$BS" "shared/rules-reading.md" \
  "branching-strategies.md references shared/rules-reading.md"

# --- 3. aidlc-pipeline-deploy-agent.md loads .claude/rules/ at position 4 ---
# Extract Knowledge Loading numbered list and confirm position 4 matches.
POS4=$(awk '
  /^## Knowledge Loading/ { inside=1; next }
  inside && /^## / { exit }
  inside { print }
' "$AGENT" | grep -E "^[0-9]+\. " | sed -n '4p')
assert_contains "$POS4" ".claude/rules/" \
  "aidlc-pipeline-deploy-agent.md Knowledge Loading position 4 is .claude/rules/"

# NOTE: the former Sections 4 & 5 (SKILL.md per-Bolt Steps 0/0.5/6.5/6.75 and
# the halt-and-ask worktree-dispatch failure shapes) were RETIRED at the engine
# cutover — that per-Bolt orchestration prose moved into the engine, so there is
# no SKILL.md dispatch text left to assert on here. The per-Bolt directive
# behaviour is covered by the engine's own differential corpus (t118).

finish
