#!/usr/bin/env bash
# Quick local sanity check — runs the probe with NO host at all, simulating the
# env vars a host would inject. Proves the probe logic + all three writes work
# in isolation BEFORE you involve Claude/Codex. Zero-cost, run anytime.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"

echo "==== Quick local probe (no host; simulated env) ===="
echo "scratch project: $TMP/project   plugin data: $TMP/data"
echo

mkdir -p "$TMP/project" "$TMP/data"
CLAUDE_PLUGIN_ROOT="$HERE/claude-plugin" \
CLAUDE_PLUGIN_DATA="$TMP/data" \
CLAUDE_PROJECT_DIR="$TMP/project" \
  bash "$HERE/probe.sh"

echo
echo "---- artifacts written ----"
find "$TMP" -type f | sed 's/^/  /'
echo
echo "If all four checks above read OK, the probe logic is sound and the only"
echo "open question is whether the HOST grants the same writes from inside a"
echo "real SessionStart hook — run the Claude/Codex probes next."
