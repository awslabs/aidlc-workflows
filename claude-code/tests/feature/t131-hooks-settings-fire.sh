#!/bin/bash
# t131 (feature): The hooks move (Fork 2→B). With the six workflow-spine hooks
# relocated from aidlc/SKILL.md frontmatter into project-wide settings.json,
# this asserts two halves:
#
#   (1) REGISTRATION — settings.json registers all six spine hooks (audit-logger,
#       sensor-fire on PostToolUse Write|Edit; sync-statusline on TaskUpdate;
#       runtime-compile on Bash; validate-state on PreCompact; log-subagent on
#       SubagentStop) plus the Stop hook, and aidlc/SKILL.md no longer carries a
#       hooks: block. After the move, all hooks are project-wide.
#
#   (2) BEHAVIOUR — inside a workflow the spine still fires: a Write under
#       aidlc-docs/ makes audit-logger append an audit row and sensor-fire
#       dispatch; an aidlc-state.ts Bash transition makes runtime-compile emit
#       runtime-graph.json. Outside any workflow (no aidlc-state.md / audit.md)
#       every hook self-gates to a no-op.
#
# The hooks are driven directly (CLAUDE_PROJECT_DIR), the same mechanism Claude
# Code uses when it reads them from settings.json — the registration half proves
# the wiring, the behaviour half proves the self-gate holds. Pure bash + bun,
# NO LLM; feature tier (runs in --ci). (16 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC="$REPO_ROOT/dist/claude/.claude"
SETTINGS="$SRC/settings.json"
SKILL="$SRC/skills/aidlc/SKILL.md"
HOOKS="$SRC/hooks"

plan 16

# === (1) REGISTRATION ======================================================

# settings.json is valid JSON and registers each spine hook under the right
# event. Emits "event:command" pairs for a single jq pass.
REG=$(bun -e '
  import { readFileSync } from "fs";
  const s = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const out = [];
  const hooks = s.hooks || {};
  for (const ev of Object.keys(hooks)) {
    for (const group of hooks[ev]) {
      for (const h of (group.hooks || [])) {
        out.push(ev + "::" + (h.command || ""));
      }
    }
  }
  console.log(out.join("\n"));
' "$SETTINGS" 2>/dev/null || true)

assert_contains "$REG" "PostToolUse::"      "settings.json registers a PostToolUse hook block"
if echo "$REG" | grep -q "PostToolUse::.*aidlc-audit-logger.ts"; then ok "audit-logger registered on PostToolUse"; else not_ok "audit-logger on PostToolUse" "missing"; fi
if echo "$REG" | grep -q "PostToolUse::.*aidlc-sensor-fire.ts"; then ok "sensor-fire registered on PostToolUse"; else not_ok "sensor-fire on PostToolUse" "missing"; fi
if echo "$REG" | grep -q "PostToolUse::.*aidlc-sync-statusline.ts"; then ok "sync-statusline registered on PostToolUse"; else not_ok "sync-statusline on PostToolUse" "missing"; fi
if echo "$REG" | grep -q "PostToolUse::.*aidlc-runtime-compile.ts"; then ok "runtime-compile registered on PostToolUse"; else not_ok "runtime-compile on PostToolUse" "missing"; fi
if echo "$REG" | grep -q "PreCompact::.*aidlc-validate-state.ts"; then ok "validate-state registered on PreCompact"; else not_ok "validate-state on PreCompact" "missing"; fi
if echo "$REG" | grep -q "SubagentStop::.*aidlc-log-subagent.ts"; then ok "log-subagent registered on SubagentStop"; else not_ok "log-subagent on SubagentStop" "missing"; fi
if echo "$REG" | grep -q "Stop::.*aidlc-stop.ts"; then ok "stop registered on Stop"; else not_ok "stop on Stop" "missing"; fi

# The matchers landed correctly: Write|Edit for audit/sensor, Bash for compile.
WE_MATCHER=$(bun -e '
  import { readFileSync } from "fs";
  const s = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const g = (s.hooks.PostToolUse || []).find((b) => (b.hooks||[]).some((h)=> (h.command||"").includes("aidlc-audit-logger.ts")));
  console.log(g ? g.matcher : "");
' "$SETTINGS" 2>/dev/null || true)
assert_eq "$WE_MATCHER" "Write|Edit" "audit-logger matcher is Write|Edit"

# SKILL.md no longer carries a hooks: block (the move removed it entirely).
assert_not_grep "$SKILL" "^hooks:" "aidlc/SKILL.md carries no hooks: block (moved to settings.json)"

# === (2) BEHAVIOUR — spine fires inside a workflow =========================

make_workflow() {
  local proj
  proj=$(mktemp -d -t t131-wf-XXXXXX)
  mkdir -p "$proj/aidlc-docs" "$proj/.claude/tools/data" "$proj/.claude/hooks"
  cp "$SRC/tools/aidlc-runtime.ts" "$SRC/tools/aidlc-lib.ts" "$SRC/tools/aidlc-audit.ts" "$proj/.claude/tools/"
  cp "$SRC/tools/data/stage-graph.json" "$proj/.claude/tools/data/"
  cp "$HOOKS/aidlc-audit-logger.ts" "$HOOKS/aidlc-runtime-compile.ts" "$proj/.claude/hooks/"
  printf '%s' "- **Scope**: bugfix" > "$proj/aidlc-docs/aidlc-state.md"
  echo "$proj"
}

# audit-logger: a Write under aidlc-docs/ (audit.md exists) appends an audit row.
PROJ=$(make_workflow)
printf '%s\n' "# audit" > "$PROJ/aidlc-docs/audit.md"
BEFORE=$(wc -l < "$PROJ/aidlc-docs/audit.md" | tr -d ' ')
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$PROJ"'/aidlc-docs/inception/requirements-analysis/requirements.md"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" timeout 15 bun "$PROJ/.claude/hooks/aidlc-audit-logger.ts" >/dev/null 2>&1 || true
AFTER=$(wc -l < "$PROJ/aidlc-docs/audit.md" | tr -d ' ')
if [ "$AFTER" -gt "$BEFORE" ]; then ok "in-workflow Write → audit-logger appends an audit row"; else not_ok "audit-logger appends" "before=$BEFORE after=$AFTER"; fi
rm -rf "$PROJ"

# runtime-compile: an aidlc-state.ts Bash transition with a GATE_APPROVED tail
# compiles runtime-graph.json.
PROJ=$(make_workflow)
cat > "$PROJ/aidlc-docs/audit.md" <<'EOF'
## Stage Start
**Event**: STAGE_STARTED
**Stage**: requirements-analysis

---

## Stage Completion
**Event**: STAGE_COMPLETED
**Stage**: requirements-analysis

---

## Gate Approved
**Event**: GATE_APPROVED
**Stage**: requirements-analysis

---
EOF
echo '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-state.ts approve --stage requirements-analysis"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" timeout 15 bun "$PROJ/.claude/hooks/aidlc-runtime-compile.ts" >/dev/null 2>&1 || true
if [ -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then ok "in-workflow transition → runtime-compile emits runtime-graph.json"; else not_ok "runtime-compile emits graph" "no runtime-graph.json"; fi
rm -rf "$PROJ"

# === (3) BEHAVIOUR — self-gate no-op outside a workflow ====================

# No aidlc-state.md, no audit.md: every hook must exit 0 and write nothing.
PROJ=$(mktemp -d -t t131-bare-XXXXXX)
mkdir -p "$PROJ/aidlc-docs" "$PROJ/.claude/tools/data" "$PROJ/.claude/hooks"
cp "$SRC/tools/aidlc-runtime.ts" "$SRC/tools/aidlc-lib.ts" "$SRC/tools/aidlc-audit.ts" "$PROJ/.claude/tools/"
cp "$SRC/tools/data/stage-graph.json" "$PROJ/.claude/tools/data/"
cp "$HOOKS/aidlc-audit-logger.ts" "$HOOKS/aidlc-runtime-compile.ts" "$PROJ/.claude/hooks/"
# (no audit.md, no aidlc-state.md)

echo '{"tool_name":"Write","tool_input":{"file_path":"'"$PROJ"'/aidlc-docs/inception/x.md"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" timeout 15 bun "$PROJ/.claude/hooks/aidlc-audit-logger.ts" >/dev/null 2>&1
RC=$?
assert_eq "$RC" "0" "outside a workflow → audit-logger exits 0 (self-gate)"
if [ ! -f "$PROJ/aidlc-docs/audit.md" ]; then ok "outside a workflow → audit-logger writes no audit.md (no-op)"; else not_ok "audit-logger no-op" "audit.md unexpectedly created"; fi

echo '{"tool_name":"Bash","tool_input":{"command":"bun .claude/tools/aidlc-state.ts approve --stage requirements-analysis"}}' \
  | CLAUDE_PROJECT_DIR="$PROJ" timeout 15 bun "$PROJ/.claude/hooks/aidlc-runtime-compile.ts" >/dev/null 2>&1
RC=$?
assert_eq "$RC" "0" "outside a workflow → runtime-compile exits 0 (self-gate)"
if [ ! -f "$PROJ/aidlc-docs/runtime-graph.json" ]; then ok "outside a workflow → runtime-compile writes no runtime-graph.json (no-op)"; else not_ok "runtime-compile no-op" "graph unexpectedly created"; fi
rm -rf "$PROJ"

finish
