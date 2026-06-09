#!/bin/bash
# t01: Verify all expected files exist in dist/claude/.claude/
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

CLAUDE_DIR="$(cd "$SCRIPT_DIR/../../dist/claude/.claude" && pwd)"

plan 63

# 1 SKILL.md
assert_file_exists "$CLAUDE_DIR/skills/aidlc/SKILL.md" "SKILL.md exists"

# 3 stage-protocol files (relocated to the aidlc-common/ spine)
assert_file_exists "$CLAUDE_DIR/aidlc-common/protocols/stage-protocol.md" "stage-protocol.md exists"
assert_file_exists "$CLAUDE_DIR/aidlc-common/protocols/stage-protocol-recovery.md" "stage-protocol-recovery.md exists"
assert_file_exists "$CLAUDE_DIR/aidlc-common/protocols/stage-protocol-governance.md" "stage-protocol-governance.md exists"

# 10 hooks (all TypeScript, run via bun)
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-audit-logger.ts" "hook: audit-logger.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-sensor-fire.ts" "hook: sensor-fire.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-runtime-compile.ts" "hook: runtime-compile.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-sync-statusline.ts" "hook: sync-statusline.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-validate-state.ts" "hook: validate-state.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-log-subagent.ts" "hook: log-subagent.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-session-start.ts" "hook: session-start.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-session-end.ts" "hook: session-end.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-statusline.ts" "hook: aidlc-statusline.ts exists"
assert_file_exists "$CLAUDE_DIR/hooks/aidlc-stop.ts" "hook: aidlc-stop.ts exists"

# 11 agents
for agent in product design delivery architect aws-platform compliance devsecops developer quality pipeline-deploy operations; do
  assert_file_exists "$CLAUDE_DIR/agents/aidlc-${agent}-agent.md" "agent: aidlc-${agent}-agent.md exists"
done

# 32 stage files
# Initialization (3)
for stage in workspace-scaffold workspace-detection state-init; do
  assert_file_exists "$CLAUDE_DIR/aidlc-common/stages/initialization/${stage}.md" "stage: initialization/${stage}.md exists"
done

# Ideation (7)
for stage in intent-capture market-research feasibility scope-definition team-formation rough-mockups approval-handoff; do
  assert_file_exists "$CLAUDE_DIR/aidlc-common/stages/ideation/${stage}.md" "stage: ideation/${stage}.md exists"
done

# Inception (8)
for stage in reverse-engineering practices-discovery requirements-analysis user-stories refined-mockups application-design units-generation delivery-planning; do
  assert_file_exists "$CLAUDE_DIR/aidlc-common/stages/inception/${stage}.md" "stage: inception/${stage}.md exists"
done

# Construction (7)
for stage in functional-design nfr-requirements nfr-design infrastructure-design code-generation build-and-test ci-pipeline; do
  assert_file_exists "$CLAUDE_DIR/aidlc-common/stages/construction/${stage}.md" "stage: construction/${stage}.md exists"
done

# Operation (7)
for stage in deployment-pipeline environment-provisioning deployment-execution observability-setup incident-response performance-validation feedback-optimization; do
  assert_file_exists "$CLAUDE_DIR/aidlc-common/stages/operation/${stage}.md" "stage: operation/${stage}.md exists"
done

# settings.json + settings.local.json.example
assert_file_exists "$CLAUDE_DIR/settings.json" "settings.json exists"
assert_file_exists "$CLAUDE_DIR/settings.local.json.example" "settings.local.json.example exists"

# state template
assert_file_exists "$CLAUDE_DIR/knowledge/aidlc-shared/state-template.md" "state-template.md exists"

# 2 guardrails
assert_file_exists "$CLAUDE_DIR/rules/aidlc-org.md" "org-guardrails.md exists"
assert_file_exists "$CLAUDE_DIR/rules/aidlc-project.md" "project-guardrails.md exists"

# CLAUDE.md
assert_file_exists "$CLAUDE_DIR/CLAUDE.md" "CLAUDE.md exists"

finish
