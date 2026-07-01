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

# The harness-dir token substitution the packager applies to core .md prose.
# Plugin .md files carry {{HARNESS_DIR}}; substitute it to the actual dir
# (.claude) so composed stage/sensor prose is harness-correct. Applied only to
# the files this plugin adds (by relative path), never the wider tree.
HARNESS_LEAF=".claude"

# copy_and_substitute <src-dir> <dst-dir> — copy the tree, then substitute the
# harness-dir token in every copied .md file.
copy_and_substitute() {
  local src="$1" dst="$2"
  [ -d "$src" ] || return 0
  cp -rn "$src"/* "$dst/" 2>/dev/null || cp -r "$src"/* "$dst/"
  # substitute the token in the files we just copied (match by relative path)
  while IFS= read -r f; do
    local rel="${f#"$src"/}"
    local target="$dst/$rel"
    [ -f "$target" ] || continue
    case "$target" in
      *.md) sed -i "s|{{HARNESS_DIR}}|${HARNESS_LEAF}|g" "$target" ;;
    esac
  done < <(find "$src" -type f)
}

# --- 1. Copy NEW stages into the project's stage tree (with token substitution) ---
copy_and_substitute "$PLUGIN_ROOT/stages" "$HARNESS_DIR/aidlc-common/stages"

# --- 2. Copy sensors into the project's sensor tree (with token substitution) ---
copy_and_substitute "$PLUGIN_ROOT/sensors" "$HARNESS_DIR/sensors"

# --- 3. Copy tools (sensor scripts) into the project's tools tree (verbatim; .ts) ---
if [ -d "$PLUGIN_ROOT/tools" ]; then
  cp -rn "$PLUGIN_ROOT/tools"/* "$HARNESS_DIR/tools/" 2>/dev/null || cp -r "$PLUGIN_ROOT/tools"/* "$HARNESS_DIR/tools/"
fi

# --- 4. Merge contributions into the STAGE SOURCE files (before compile) ---
# Appends each contribution's adds.produces/sensors into the target stage's
# frontmatter list. Editing source (not the compiled JSON) makes the merge
# DURABLE: it survives any later recompile (--init, runtime-compile hook).
# Idempotent — already-present items are not re-added. consumes + fragments
# are future work.
"$BUN" "$PLUGIN_ROOT/hooks/compose-contributions.ts" 2>/dev/null || true

# --- 5. Recompile the stage graph (picks up new stages + merged produces) ---
"$BUN" "$HARNESS_DIR/tools/aidlc-graph.ts" compile 2>/dev/null || true

exit 0
