#!/usr/bin/env bash
# Kiro probe — there is NO plugin store and NO host SessionStart hook on Kiro,
# so this simulates the manual rollout a Kiro team would actually do:
#   git pull the plugin repo -> copy the projected tree into the project ->
#   run the composer once by hand.
#
# It is NOT testing "does a hook fire" (it can't on Kiro). It's measuring how
# many manual steps the no-store path costs, which is the Kiro con in the
# decision. Run from an empty scratch project dir:  bash install.sh <scratch-dir>
set -u
SCRATCH="${1:-./kiro-scratch}"
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "==== Kiro manual rollout probe ===="
echo "simulating: a Kiro team with no plugin store, doing it by hand"
echo

mkdir -p "$SCRATCH"
steps=0
step() { steps=$((steps+1)); echo "  step $steps: $*"; }

# 1. They git pull your plugin repo (here: it's already on disk as $SRC).
step "git pull <your-plugin-repo>   (already on disk: $SRC)"

# 2. They copy the projected harness tree + workspace shell into their project.
#    On a real build these come from the packager's Kiro projection target.
step "copy .kiro/ + aidlc/ + AGENTS.md into the project"
mkdir -p "$SCRATCH/.kiro" "$SCRATCH/aidlc"
printf 'placeholder Kiro projection (real build: dist/kiro/.kiro/)\n' > "$SCRATCH/.kiro/PLACEHOLDER"
printf 'placeholder workspace shell (real build: aidlc/spaces/default/...)\n' > "$SCRATCH/aidlc/PLACEHOLDER"
printf 'placeholder AGENTS.md\n' > "$SCRATCH/AGENTS.md"

# 3. They run the composer once, by hand (no hook to do it for them).
step "run the composer by hand (the project-tree write the hook would have done)"
( cd "$SCRATCH" && CLAUDE_PROJECT_DIR="$PWD" PLUGIN_ROOT="$SRC/claude-plugin" bash "$SRC/probe.sh" >/dev/null 2>&1 )

echo
echo "manual steps a Kiro team performs: $steps  (vs Claude/Codex: 0 — host hook composes)"
echo "project tree after rollout:"
find "$SCRATCH" -type f | sed 's/^/    /'
echo
echo "verdict input: $steps manual steps is the Kiro cost until a thin 'aidlc plugin' command wraps them."
echo "see /tmp/aidlc-dist-probe.log (or $SCRATCH/.aidlc-probe/report.log) for the compose-write result."
