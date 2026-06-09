#!/bin/bash
# t128: a CUSTOM stage authored as a file becomes drivable through the generated
# runner with NO code change (v0.6.0 Wave 3 MR 14). This is the proof of the
# extensibility headline — "to add a stage, write a stage file": drop a stage
# `.md` into `aidlc-common/stages/<phase>/`, recompile the graph, run the
# stage-runner generator, and the new stage gets a spec-conformant
# `skills/aidlc-<slug>/` runner that drives `--single` end-to-end. The runner
# shell is opt-in sugar over `/aidlc --stage <slug> --single`, which works the
# moment the stage compiles in.
#
# Runs entirely in a sandbox copy of `.claude/` (setup_integration_project), so
# the shipped tree is never touched. The custom slug is injected as EXECUTE into a
# fixture scope (mirrors t60's scope-injection) so the stage is in-scope. (8 tests)
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

plan 8

CUSTOM_SLUG="custom-smoke-stage"

PROJ=$(setup_integration_project --no-aidlc-docs --strip-env-scope)
CLAUDE="$PROJ/.claude"
ORCH="$CLAUDE/tools/aidlc-orchestrate.ts"
GEN="$CLAUDE/tools/aidlc-runner-gen.ts"
GRAPH="$CLAUDE/tools/aidlc-graph.ts"

# --- Drop a fixture scope .md so `fixture-scope` is a valid scope (post-MR-12,
# validScopes() derives from .claude/scopes/*.md presence, not scope-mapping.json
# which is deleted). The custom stage declares membership in it via `scopes:`
# frontmatter (the transpose source), so the compiled scope-grid marks the custom
# stage EXECUTE under fixture-scope and every shipped stage SKIP. Mirrors t60. ---
mkdir -p "$CLAUDE/scopes"
cat > "$CLAUDE/scopes/aidlc-fixture-scope.md" <<EOF
---
name: fixture-scope
depth: Minimal
keywords:
  - fixture-scope-keyword
description: Test-only scope dropped to prove the extensibility path end-to-end
---
# fixture-scope

Test-only scope authored to drive the custom stage via --single.
EOF

# --- Author the custom stage file (operation phase, minimal valid frontmatter) ---
# No produces/consumes edges so it slots in without disturbing the rest of the
# graph; lead_agent is a real shipped agent so loadAgents() validation passes.
# `scopes: [fixture-scope]` is the transpose source: at compile the custom stage
# becomes EXECUTE under fixture-scope (and that scope's only EXECUTE member).
mkdir -p "$CLAUDE/aidlc-common/stages/operation"
cat > "$CLAUDE/aidlc-common/stages/operation/$CUSTOM_SLUG.md" <<EOF
---
slug: $CUSTOM_SLUG
phase: operation
execution: ALWAYS
condition: Always runs — a custom stage authored to prove the extensibility path
lead_agent: aidlc-operations-agent
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
scopes:
  - fixture-scope
inputs: None — this is a standalone custom stage with no upstream artifacts
outputs: None — the stage body is illustrative
---

# Custom Smoke Stage

## Steps

1. A custom stage authored as a file to prove the extensibility path.

## Sensors

## Learn
EOF

# --- Pre-seed the new stage's {slug, number, name} row in stage-graph.json ---
# The compiler is a drift guard, not an inserter: it fills a PRE-SEEDED row from
# the YAML, but refuses to invent a row for an unknown slug (sole-writer
# discipline). Authoring a new stage means seeding its identity row first, then
# compiling — the documented harness recipe. Use a 4.8 number (after the last
# operation stage 4.7) so it sorts last.
bun -e "
  const fs = require('fs');
  const p = '$CLAUDE/tools/data/stage-graph.json';
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  j.push({ slug: '$CUSTOM_SLUG', number: '4.8', name: 'Custom Smoke Stage', phase: 'operation' });
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
"

# --- Test 1: recompile the graph; the custom stage appears ---
set +e
COMPILE_OUT=$(bun "$GRAPH" compile --project-dir "$PROJ" 2>&1)
COMPILE_RC=$?
set -e
if [ $COMPILE_RC -eq 0 ]; then
  ok "graph recompiles after authoring the custom stage file"
else
  not_ok "graph recompiles after authoring the custom stage file" "rc=$COMPILE_RC out=$COMPILE_OUT"
fi

TOPO=$(bun "$GRAPH" topo --project-dir "$PROJ" 2>&1)
assert_contains "$TOPO" "$CUSTOM_SLUG" "the custom stage is in the compiled graph (topo lists it)"

# --- Test 3: the generator now emits a runner for the custom stage ---
bun "$GEN" write --project-dir "$PROJ" >/dev/null 2>&1
RUNNER="$CLAUDE/skills/aidlc-$CUSTOM_SLUG/SKILL.md"
assert_file_exists "$RUNNER" "the generator emits skills/aidlc-$CUSTOM_SLUG/SKILL.md for the custom stage"

# --- Test 4: the generated runner is spec-conformant (name == dir) ---
RUNNER_NAME=$(grep -m1 "^name:" "$RUNNER" | sed 's/name:[[:space:]]*//')
assert_eq "$RUNNER_NAME" "aidlc-$CUSTOM_SLUG" "the custom runner's frontmatter name equals its dir"

# --- Test 5: the runner body drives --single for the custom slug ---
assert_grep "$RUNNER" "next --stage $CUSTOM_SLUG --single" \
  "the custom runner drives \`next --stage $CUSTOM_SLUG --single\`"

# --- Test 6: the drift guard is back IN SYNC after regeneration ---
set +e
CHECK_OUT=$(bun "$GEN" check --project-dir "$PROJ" 2>&1)
CHECK_RC=$?
set -e
if [ $CHECK_RC -eq 0 ]; then
  ok "stage-runner-drift check passes after regenerating (set == compiled list)"
else
  not_ok "stage-runner-drift check passes after regenerating" "rc=$CHECK_RC out=$CHECK_OUT"
fi

# --- Tests 7-8: the custom stage is drivable via --single ---
# The custom stage is already EXECUTE under `fixture-scope` in the compiled
# scope-grid.json — Test 1's `compile` transposed the stage's `scopes:
# [fixture-scope]` frontmatter into the grid (post-MR-12 there is no
# scope-mapping.json to edit; membership lives on the stage + the dropped
# `.claude/scopes/aidlc-fixture-scope.md` makes fixture-scope a valid scope). A
# brand-new slug is SKIP for every SHIPPED scope, so a dedicated fixture scope is
# how it becomes in-scope; mirrors t60.
SINGLE=$(bun "$ORCH" next --stage "$CUSTOM_SLUG" --single --scope fixture-scope --project-dir "$PROJ" 2>&1)
assert_contains "$SINGLE" '"kind":"run-stage"' "next --single drives the custom stage to a run-stage directive"
assert_contains "$SINGLE" "\"stage\":\"$CUSTOM_SLUG\"" "the run-stage directive targets the custom stage"
cleanup_test_project "$PROJ"

finish
