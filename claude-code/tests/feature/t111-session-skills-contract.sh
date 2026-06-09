#!/bin/bash
# t111: Behavioural contract between the read-only session skills and the
# `aidlc-runtime.ts summary --json` data plane they consume.
#
# t107 is structural — it proves each skill *says* it reads summary --json.
# This test proves the *seam holds*: every JSON field the skills reference is
# actually emitted by the tool, and every field the tool emits is consumed by
# at least one skill. If the summary schema drifts (a renamed/removed field),
# this test fails instead of the skills silently rendering blanks at runtime.
#
# Surface tested:
#   - The tool emits the expected top-level keys (workflow_id, scope,
#     duration_minutes, stages, by_phase, memory, sensors, learnings).
#   - Every leaf field the three skills reference resolves in real tool output
#     (run against a synthetic compiled graph) — no skill cites a phantom field.
#   - The skills collectively consume every leaf the tool emits — no emitted
#     field is silently dropped (catches the tool growing a field the skills
#     forget to surface).
#
# L1 — pure bash + bun + jq. Compiles a synthetic audit, then diffs the tool's
# emitted leaf set against the field set grepped from the skill files.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-runtime.ts"
SKILLS_DIR="$REPO_ROOT/dist/claude/.claude/skills"
COST="$SKILLS_DIR/aidlc-session-cost/SKILL.md"
REPLAY="$SKILLS_DIR/aidlc-replay/SKILL.md"
PACK="$SKILLS_DIR/aidlc-outcomes-pack/SKILL.md"

if [ ! -f "$RUNTIME_TS" ]; then
  echo "Bail out! aidlc-runtime.ts not found at $RUNTIME_TS"
  exit 1
fi

plan 10

# --- Build a synthetic compiled graph (one completed stage) ----------------
PROJ=$(mktemp -d -t aidlc-t111-XXXXXX)
trap 'rm -rf "$PROJ"' EXIT
mkdir -p "$PROJ/aidlc-docs/ideation/intent-capture"
cat > "$PROJ/aidlc-docs/audit.md" <<'EOF'
## Workflow Start
**Timestamp**: 2026-05-27T10:00:00Z
**Event**: WORKFLOW_STARTED
**Scope**: feature

---

## Stage Start
**Timestamp**: 2026-05-27T10:01:00Z
**Event**: STAGE_STARTED
**Stage**: intent-capture
**Agent**: aidlc-product-agent

---

## Stage Completion
**Timestamp**: 2026-05-27T10:10:00Z
**Event**: STAGE_COMPLETED
**Stage**: intent-capture
**Details**: done

---
EOF
printf -- '- **Scope**: feature\n- **Current Stage**: intent-capture\n' > "$PROJ/aidlc-docs/aidlc-state.md"
cat > "$PROJ/aidlc-docs/ideation/intent-capture/memory.md" <<'EOF'
## Interpretations
- one
## Tradeoffs
- a tradeoff
EOF

CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME_TS" compile >/dev/null 2>&1
JSON=$(CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME_TS" summary --json)

# --- Top-level keys the skills' render templates depend on (8) -------------
for key in workflow_id scope duration_minutes stages by_phase memory sensors learnings; do
  if echo "$JSON" | jq -e "has(\"$key\")" >/dev/null 2>&1; then
    ok "summary --json emits top-level key: $key"
  else
    not_ok "summary --json emits top-level key: $key"
  fi
done

# --- The emitted leaf set, phase-normalised -------------------------------
# Leaf paths (scalars), with concrete phase names collapsed to <phase> so the
# by_phase.* family compares as a single shape regardless of which phases ran.
EMITTED=$(echo "$JSON" \
  | jq -r 'paths(scalars) | join(".")' \
  | sed -E 's/\.(initialization|ideation|inception|construction|operation)\./.<phase>./' \
  | sort -u)

# --- Every leaf the skills reference must be emitted by the tool (1) -------
# Grep the dotted field paths the three skills cite (e.g. stages.approved,
# summary.memory.total) under the known JSON parent objects, with an OPEN leaf
# pattern so a renamed/typo'd field (sensors.budget_overide) is caught as a
# phantom rather than silently ignored. `.md` is excluded so prose filenames
# like `memory.md` / `summary.md` are not mistaken for field references.
# by_phase.<leaf> references are normalised to the tool's by_phase.<phase>.<leaf>.
REFERENCED=$(grep -ohE "(summary\.)?(stages|memory|sensors|learnings|by_phase)\.[a-z_]+|(summary\.)?(workflow_id|scope|duration_minutes)" "$COST" "$REPLAY" "$PACK" \
  | sed -E 's/^summary\.//' \
  | grep -vE '\.md$' \
  | sed -E 's/^by_phase\.(.+)$/by_phase.<phase>.\1/' \
  | sort -u)

MISSING=""
while IFS= read -r ref; do
  [ -z "$ref" ] && continue
  echo "$EMITTED" | grep -qxF "$ref" || MISSING="$MISSING $ref"
done <<< "$REFERENCED"

if [ -z "$MISSING" ]; then
  ok "every summary field referenced by the skills is emitted by the tool"
else
  not_ok "every summary field referenced by the skills is emitted by the tool (phantom:$MISSING)"
fi

# --- No emitted scalar family is left unconsumed by all three skills (1) ---
# Guards the reverse drift: the tool grows a field but no skill surfaces it.
# Compares emitted leaf *names* (last dot-segment) against the union of names
# the skills mention anywhere, so a new tally can't ship dark.
UNCONSUMED=""
while IFS= read -r leaf; do
  [ -z "$leaf" ] && continue
  name="${leaf##*.}"
  # started_at is an internal field the human/JSON render does not surface; skip.
  [ "$name" = "started_at" ] && continue
  if ! grep -qhE "$name" "$COST" "$REPLAY" "$PACK"; then
    UNCONSUMED="$UNCONSUMED $leaf"
  fi
done <<< "$EMITTED"

if [ -z "$UNCONSUMED" ]; then
  ok "every summary field the tool emits is consumed by at least one skill"
else
  not_ok "every summary field the tool emits is consumed by at least one skill (orphan:$UNCONSUMED)"
fi
