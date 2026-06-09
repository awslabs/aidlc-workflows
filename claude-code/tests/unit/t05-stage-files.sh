#!/bin/bash
# t05: 32 stages parse to slug + phase matching filename and directory (64 tests: 2 per stage)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

STAGES_DIR="$(cd "$SCRIPT_DIR/../../dist/claude/.claude/aidlc-common/stages" && pwd)"
LIB="$(cd "$SCRIPT_DIR/../../dist/claude/.claude/tools" && pwd)/aidlc-lib.ts"

plan 64

# stage_check phase slug
stage_check() {
  local phase="$1" slug="$2"
  local file="$STAGES_DIR/$phase/$slug.md"

  # slug matches filename stem (parse YAML frontmatter)
  local actual_slug
  actual_slug=$(bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$file', 'utf8'));
    console.log(obj.slug);
  " 2>/dev/null)
  if [ "$actual_slug" = "$slug" ]; then
    ok "$phase/$slug slug matches filename"
  else
    not_ok "$phase/$slug slug matches filename" "got: '$actual_slug'"
  fi

  # phase matches directory
  local actual_phase
  actual_phase=$(bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { readFileSync } from 'fs';
    const obj = parseStageFrontmatter(readFileSync('$file', 'utf8'));
    console.log(obj.phase);
  " 2>/dev/null)
  if [ "$actual_phase" = "$phase" ]; then
    ok "$phase/$slug phase matches directory"
  else
    not_ok "$phase/$slug phase matches directory" "got: '$actual_phase'"
  fi
}

# Initialization (3)
stage_check initialization workspace-scaffold
stage_check initialization workspace-detection
stage_check initialization state-init

# Ideation (7)
stage_check ideation intent-capture
stage_check ideation market-research
stage_check ideation feasibility
stage_check ideation scope-definition
stage_check ideation team-formation
stage_check ideation rough-mockups
stage_check ideation approval-handoff

# Inception (8)
stage_check inception reverse-engineering
stage_check inception practices-discovery
stage_check inception requirements-analysis
stage_check inception user-stories
stage_check inception refined-mockups
stage_check inception application-design
stage_check inception units-generation
stage_check inception delivery-planning

# Construction (7)
stage_check construction functional-design
stage_check construction nfr-requirements
stage_check construction nfr-design
stage_check construction infrastructure-design
stage_check construction code-generation
stage_check construction build-and-test
stage_check construction ci-pipeline

# Operation (7)
stage_check operation deployment-pipeline
stage_check operation environment-provisioning
stage_check operation deployment-execution
stage_check operation observability-setup
stage_check operation incident-response
stage_check operation performance-validation
stage_check operation feedback-optimization

finish
