#!/bin/bash
# t112 (unit): isFrameworkDistributionPath guard recognises the RELOCATED
# framework tree (v0.6.0 MR 0 — aidlc-claude-code/ → dist/claude/) (3 tests). The §13
# learning loop must refuse to scaffold a learnt sensor manifest INTO the
# framework distribution (it writes to the PROJECT's .claude/sensors only).
# The repo move changed the framework path, so the guard's path segments moved
# from join("aidlc-claude-code", ".claude", "sensors") to
# join("dist", "claude", ".claude", "sensors"). This test pins that the guard
# still fires on the new path and still lets a normal project path through —
# a dedicated regression guard so a future refactor that breaks the relocated
# segment recognition fails loudly (the move otherwise breaks it SILENTLY).
#
# The guard is internal (not exported), so it is exercised BEHAVIOURALLY via
# `aidlc-learnings.ts persist` with a sensor-binding selection, mirroring
# t97's case 21 — but here the relocated path IS the subject under test.
# 3 assertions: framework-path refuse / project-path accept / refuse-leaves-no-write.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOOLS="$REPO_ROOT/dist/claude/.claude/tools"
LEARNINGS_TS="$TOOLS/aidlc-learnings.ts"

if [ ! -f "$LEARNINGS_TS" ]; then
  echo "Bail out! aidlc-learnings.ts not found at $LEARNINGS_TS"
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 3

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/t112-XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

# Build a minimal active-stage project rooted at $1 (an absolute project dir).
# Mirrors t97's mkproj but parameterised on the project root so we can place
# the root at .../dist/claude (framework-tree shape) vs a plain project.
seed_project() {
  local pd="$1"
  mkdir -p "$pd/aidlc-docs/inception/user-stories" "$pd/.claude/rules" \
           "$pd/.claude/aidlc-common/stages/inception" "$pd/.claude/sensors"
  cat > "$pd/aidlc-docs/aidlc-state.md" <<EOF
# AI-DLC State Tracking
- **Current Stage**: user-stories
- **Scope**: feature
EOF
  cat > "$pd/aidlc-docs/runtime-graph.json" <<EOF
{ "workflow_id": "w1", "scope": "feature", "started_at": "2026-05-28T13:00:00Z",
  "stages": [ { "stage_slug": "user-stories", "memory_path": "aidlc-docs/inception/user-stories/memory.md" } ] }
EOF
  cat > "$pd/.claude/aidlc-common/stages/inception/user-stories.md" <<EOF
---
slug: user-stories
phase: inception
execution: ALWAYS
lead_agent: aidlc-product-agent
support_agents: []
sensors:
  - required-sections
inputs: foo
outputs: bar
---

# User Stories

## Steps
1. do the thing
EOF
  # A sensor-binding selection — persist resolves the manifest path under the
  # project's .claude/sensors and runs it through isFrameworkDistributionPath.
  cat > "$pd/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c9", "type": "sensor", "origin_stage": "user-stories",
    "manifest_fields": { "id": "bad", "kind": "deterministic", "command": "x", "default_severity": "advisory", "description": "d", "matches": "**/*" } } ] }
EOF
}

# --- 1. RELOCATED framework path → refuse (exit 1) --------------------------
# Project dir whose tail IS the relocated framework tree: .../dist/claude.
# The resolved manifest path therefore contains dist/claude/.claude/sensors,
# which isFrameworkDistributionPath must now recognise.
FWROOT="$TMP_ROOT/fw/dist/claude"
seed_project "$FWROOT"
set +e
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$FWROOT/sel.json" --project-dir "$FWROOT" >/dev/null 2>&1; EC_FW=$?
set -e
assert_eq "$EC_FW" "1" "relocated framework path (dist/claude/.claude/sensors) → refused, exit 1"

# --- 2. refuse left NO manifest behind --------------------------------------
# The guard must reject BEFORE writing — no aidlc-bad.md scaffolded.
if [ -e "$FWROOT/.claude/sensors/aidlc-bad.md" ]; then
  not_ok "refused framework write leaves no manifest" "aidlc-bad.md was scaffolded despite refusal"
else
  ok "refused framework write leaves no manifest"
fi

# --- 3. ordinary PROJECT path → accepted (not the framework tree) -----------
# A normal project root (no dist/claude tail) must pass the guard and write.
PROJROOT="$TMP_ROOT/proj/my-app"
seed_project "$PROJROOT"
set +e
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PROJROOT/sel.json" --project-dir "$PROJROOT" >/dev/null 2>&1; EC_PROJ=$?
set -e
# exit 0 AND the manifest landed under the project's own .claude/sensors.
if [ "$EC_PROJ" = "0" ] && [ -e "$PROJROOT/.claude/sensors/aidlc-bad.md" ]; then
  ok "ordinary project path → accepted, manifest scaffolded under project .claude/sensors"
else
  not_ok "ordinary project path → accepted" "exit=$EC_PROJ, manifest present=$([ -e "$PROJROOT/.claude/sensors/aidlc-bad.md" ] && echo yes || echo no)"
fi

finish
