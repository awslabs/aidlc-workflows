#!/usr/bin/env bash
# AIDLC test-pro plugin — SessionStart compose hook.
# Runs automatically when installed as a Claude Code plugin. Merges the plugin's
# stages, sensors, and tools into the project's .claude/ tree and recompiles the
# stage graph so the orchestrator routes the new stages.
#
# Idempotent: safe to re-run on every session start (only copies + recompile).
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT not set}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR not set}"
HARNESS_DIR="$PROJECT_DIR/.claude"

# Guard: only compose if this is an AIDLC project (has the graph compiler)
if [ ! -f "$HARNESS_DIR/tools/aidlc-graph.ts" ]; then
  exit 0
fi

# Resolve bun (the probe showed it may not be on bare PATH in hook context)
BUN="${BUN:-}"
if [ -z "$BUN" ]; then
  if command -v bun >/dev/null 2>&1; then
    BUN="bun"
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    BUN="$HOME/.bun/bin/bun"
  else
    echo "aidlc-test-pro: bun not found; skipping compose" >&2
    exit 0
  fi
fi

# --- 1. Copy NEW stages into the project's stage tree ---
STAGE_SRC="$PLUGIN_ROOT/stages"
STAGE_DST="$HARNESS_DIR/aidlc-common/stages"
if [ -d "$STAGE_SRC" ]; then
  cp -rn "$STAGE_SRC"/* "$STAGE_DST/" 2>/dev/null || cp -r "$STAGE_SRC"/* "$STAGE_DST/"
fi

# --- 2. Copy sensors into the project's sensor tree ---
SENSOR_SRC="$PLUGIN_ROOT/sensors"
SENSOR_DST="$HARNESS_DIR/sensors"
if [ -d "$SENSOR_SRC" ]; then
  cp -rn "$SENSOR_SRC"/* "$SENSOR_DST/" 2>/dev/null || cp -r "$SENSOR_SRC"/* "$SENSOR_DST/"
fi

# --- 3. Copy tools (sensor scripts) into the project's tools tree ---
TOOLS_SRC="$PLUGIN_ROOT/tools"
TOOLS_DST="$HARNESS_DIR/tools"
if [ -d "$TOOLS_SRC" ]; then
  cp -rn "$TOOLS_SRC"/* "$TOOLS_DST/" 2>/dev/null || cp -r "$TOOLS_SRC"/* "$TOOLS_DST/"
fi

# --- 4. Recompile the stage graph (picks up new stages) ---
"$BUN" "$HARNESS_DIR/tools/aidlc-graph.ts" compile 2>/dev/null || true

# --- 5. Merge contributions into the COMPILED graph (structural surfaces) ---
# Post-processes stage-graph.json to set-union each contribution's
# adds.produces/consumes/sensors into the target stage's compiled node.
# Runs AFTER compile so we modify the output, not the fragile stage YAML.
# Fragments (prose splicing) are future work.
"$BUN" "$PLUGIN_ROOT/hooks/compose-contributions.ts" 2>/dev/null || true

exit 0
