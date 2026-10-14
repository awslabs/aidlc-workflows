#!/usr/bin/env bash
# step4 driver: <build-root> <label>   (label: before|after)
# Captures: hook-env sync/list/doctor + stamp presence, then vendored compose fallback.
set -u
BUILD="$1"
LABEL="$2"
PLUGIN="$BUILD/dist/plugins/test-pro/devin"
EVID=/tmp/devin-plugin-evidence
OUT="$EVID/step4-${LABEL}-e2e.txt"

run() {
  echo
  echo "+ $*"
  local so se rc
  so=$(mktemp); se=$(mktemp)
  "$@" >"$so" 2>"$se"; rc=$?
  echo "[stdout]"; cat "$so"
  echo "[stderr]"; cat "$se"
  echo "[exit=$rc]"
  rm -f "$so" "$se"
}

{
echo "=== step4 ${LABEL}: BUILD=$BUILD ==="
echo "=== git: $(git -C "$BUILD" rev-parse --short HEAD 2>/dev/null || echo n/a) ==="

# ---------- Part A: SessionStart hook env -> aidlc-plugin.ts ----------
T=$(mktemp -d "/tmp/aidlc-e2e-${LABEL}-XXXX")
cp -a "$BUILD/dist/devin/." "$T/"
echo "--- project: $T ---"
cd "$T" || exit 1

# Devin SessionStart hook env (PLUGIN_ROOT/AIDLC_PLUGIN_ROOT/DEVIN_PLUGIN_ROOT unset)
unset PLUGIN_ROOT AIDLC_PLUGIN_ROOT DEVIN_PLUGIN_ROOT
export CLAUDE_PLUGIN_ROOT="$PLUGIN"
export CLAUDE_PROJECT_DIR="$T"
export DEVIN_PROJECT_DIR="$T"
export AIDLC_HARNESS_DIR=".devin"
export AIDLC_HARNESS_NAME="devin"
export AIDLC_CLAUDE_PLUGIN_REGISTRY="/nonexistent"

echo; echo "===== A1: aidlc-plugin.ts sync --json ====="
run bun "$T/.devin/tools/aidlc-plugin.ts" sync --json --project-dir "$T"

echo; echo "===== A2: aidlc-plugin.ts list --json ====="
run bun "$T/.devin/tools/aidlc-plugin.ts" list --json --project-dir "$T"

echo; echo "===== A3: aidlc.ts engine plugin list --json ====="
run bun "$T/.devin/tools/aidlc.ts" engine plugin list --json --project-dir "$T"

echo; echo "===== A4: aidlc.ts doctor --json ====="
run bun "$T/.devin/tools/aidlc.ts" doctor --json --project-dir "$T"

echo; echo "===== A5: composition stamp / evidence ====="
echo "--- $T/.devin/tools/data plugin-compose files:"
ls -la "$T/.devin/tools/data/" 2>&1 | grep -i "plugin" || echo "(none)"
for f in "$T/.devin/tools/data/"plugin-compose-*.json; do
  [ -e "$f" ] && { echo "--- $f:"; cat "$f"; }
done
echo "--- $T/aidlc plugin-compose markers:"
find "$T/aidlc" \( -name '*plugin-compose*' \) 2>/dev/null || true
echo "--- composed plugin stages under .devin:"
find "$T/.devin" -name 'test-pro-*' | sort
echo "--- stage-graph plugin stages:"
grep -o '"test-pro[^"]*"' "$T/.devin/tools/data/stage-graph.json" 2>/dev/null | sort -u || echo "(no stage-graph.json or no match)"

# ---------- Part B: vendored compose fallback ----------
echo; echo "===== B: vendored compose.ts fallback ====="
T2=$(mktemp -d "/tmp/aidlc-e2e-fb-${LABEL}-XXXX")
cp -a "$BUILD/dist/devin/." "$T2/"
echo "--- project: $T2 ---"
cd "$T2" || exit 1
echo "+ env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR -u AIDLC_PLUGIN_ROOT PLUGIN_ROOT=$PLUGIN AIDLC_PROJECT_DIR=$T2 AIDLC_HARNESS_DIR=.devin AIDLC_HARNESS_NAME=devin bun $PLUGIN/hooks/compose.ts"
SO=$(mktemp); SE=$(mktemp)
env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR -u AIDLC_PLUGIN_ROOT -u DEVIN_PLUGIN_ROOT -u AIDLC_CLAUDE_PLUGIN_REGISTRY \
  PLUGIN_ROOT="$PLUGIN" \
  AIDLC_PROJECT_DIR="$T2" \
  AIDLC_HARNESS_DIR=".devin" \
  AIDLC_HARNESS_NAME="devin" \
  bun "$PLUGIN/hooks/compose.ts" >"$SO" 2>"$SE"
echo "[exit=$?]"
echo "[stdout]"; cat "$SO"
echo "[stderr]"; cat "$SE"
rm -f "$SO" "$SE"

echo "--- markers keyed by plugin name (retry marker, drops):"
find "$T2" \( -name '.plugin-compose-retry-*' -o -name 'plugin-compose-*.drops' \) | sort
echo "--- hooks-health dir contents:"
find "$T2" -path '*hooks-health*' -type f | sort
echo "--- stamp files under .devin/tools/data:"
ls "$T2/.devin/tools/data/" 2>&1 | grep -i "plugin" || echo "(none)"
echo "--- composed plugin stages under .devin:"
find "$T2/.devin" -name 'test-pro-*' | sort
echo "--- stage-graph plugin stages:"
grep -o '"test-pro[^"]*"' "$T2/.devin/tools/data/stage-graph.json" 2>/dev/null | sort -u || echo "(no stage-graph.json or no match)"
} > "$OUT" 2>&1
tail -5 "$OUT"
echo "wrote $OUT"
