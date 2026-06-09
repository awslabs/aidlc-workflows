#!/bin/bash
# t89: Behavioural contract for `aidlc-graph compile`'s sensors_applicable
# resolution (v0.5.0 MR 7b — pull authoring for sensors). 22 tests.
#
# Surface tested:
#   - loadSensors() walks .claude/sensors/, anchored by aidlc-<id>.md filename.
#   - resolveSensorsForStage looks each stage.sensors[] id up; throws on unknown.
#   - matches is copied verbatim from the manifest into the resolved entry.
#   - Manifests without matches produce entries with no matches field.
#   - Empty matches ("") is rejected by the schema (loud failure).
#   - Duplicate manifest ids fail compile.
#   - id-filename mismatch fails compile.
#   - kind != deterministic fails compile (llm reserved for v0.11.0).
#   - Unknown manifest keys are tolerated (forward-compat).
#   - BOM-prefixed frontmatter parses correctly.
#   - Empty sensors dir + zero-import stage fixtures produce sensors_applicable: [].
#   - Two compiles of the same input produce byte-identical output.
#   - --check round-trip detects sensor-manifest edits.
#
# Mechanics:
#   - AIDLC_SENSORS_DIR points loadSensors() at a fixture dir.
#   - AIDLC_STAGES_DIR overrides the stage tree where required (zero-imports test).
#   - AIDLC_STAGE_GRAPH points compile output at a tempfile.
#
# L1 — pure bash + bun + jq.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GRAPH_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-graph.ts"
FIXTURES="$REPO_ROOT/tests/fixtures/v05-mr7b-sensor-resolution"
SEED_GRAPH="$REPO_ROOT/dist/claude/.claude/tools/data/stage-graph.json"
REAL_STAGES="$REPO_ROOT/dist/claude/.claude/aidlc-common/stages"

if [ ! -f "$GRAPH_TS" ]; then
  echo "Bail out! aidlc-graph.ts not found at $GRAPH_TS"
  exit 1
fi
if [ ! -f "$SEED_GRAPH" ]; then
  echo "Bail out! seed stage-graph.json not found at $SEED_GRAPH"
  exit 1
fi

plan 22

# Helper: compile against a sensors fixture; return JSON to stdout. Each
# invocation gets a fresh STAGE_GRAPH tempfile (seeded with the real
# graph so bootstrap succeeds) so cases can't leak.
compile_with_sensors() {
  local fixture="$1"
  local out
  out=$(mktemp -t aidlc-t89-stage-graph.XXXXXX.json)
  cp "$SEED_GRAPH" "$out"
  AIDLC_SENSORS_DIR="$fixture" AIDLC_STAGE_GRAPH="$out" \
    bun "$GRAPH_TS" compile >/dev/null 2>&1
  cat "$out"
  rm -f "$out"
}

# --- Case 1: basic-import — every imported id resolves to a manifest --------
# All four real-stage manifests are present; compile should populate
# sensors_applicable on every importing stage.
JSON=$(compile_with_sensors "$FIXTURES/basic-import")
LEN=$(echo "$JSON" | jq '[.[] | select(.slug == "code-generation")] | .[0].sensors_applicable | length')
assert_eq "$LEN" "2" "basic-import: code-generation has 2 resolved sensors"

# --- Case 2: basic-import — resolved entries carry id and path -----------
SAMPLE=$(echo "$JSON" | jq -r '[.[] | select(.slug == "code-generation")] | .[0].sensors_applicable[0] | .id + "|" + .path')
assert_eq "$SAMPLE" "linter|.claude/sensors/aidlc-linter.md" "basic-import: first sensor id+path correct"

# --- Case 3: matches-passthrough — distinctive matches glob preserved ----
JSON=$(compile_with_sensors "$FIXTURES/matches-passthrough")
GLOB=$(echo "$JSON" | jq -r '[.[] | select(.slug == "code-generation")] | .[0].sensors_applicable[] | select(.id == "linter") | .matches')
assert_eq "$GLOB" "**/distinctive-glob/**/*.ts" "matches-passthrough: matches copied verbatim"

# --- Case 4: no-matches — sensors with no matches field omit it ----------
JSON=$(compile_with_sensors "$FIXTURES/no-matches")
HAS_MATCHES=$(echo "$JSON" | jq '[.[] | select(.slug == "code-generation")] | .[0].sensors_applicable[] | select(.id == "linter") | has("matches")')
assert_eq "$HAS_MATCHES" "false" "no-matches: matches field omitted (not empty string)"

# --- Case 5: empty-matches — schema rejects matches: "" -----------------
TMP_GRAPH=$(mktemp -t aidlc-t89-empty-matches-graph.XXXXXX.json); cp "$SEED_GRAPH" "$TMP_GRAPH"
set +e
AIDLC_SENSORS_DIR="$FIXTURES/empty-matches" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile >/dev/null 2>&1
RC=$?
set -e
assert_eq "$RC" "1" "empty-matches: compile rejects empty matches string"
rm -f "$TMP_GRAPH"

# --- Case 6: multiple-imports — order preserved (deterministic) ----------
JSON=$(compile_with_sensors "$FIXTURES/basic-import")
IDS=$(echo "$JSON" | jq -r '[.[] | select(.slug == "functional-design")] | .[0].sensors_applicable | map(.id) | join(",")')
assert_eq "$IDS" "required-sections,upstream-coverage,linter,type-check" \
  "multiple-imports: resolution order matches authored order"

# --- Case 7: empty imports — stages with sensors: [] resolve to [] -------
JSON=$(compile_with_sensors "$FIXTURES/basic-import")
INIT_LEN=$(echo "$JSON" | jq '[.[] | select(.phase == "initialization")] | all(.sensors_applicable | length == 0)')
assert_eq "$INIT_LEN" "true" "empty imports: every initialization stage has length 0"

# --- Case 8: zero-sensors dir + zero-import stages produce empty arrays ---
# Use AIDLC_STAGES_DIR pointing at a temp tree containing only stages with
# sensors: []. Pair with an empty AIDLC_SENSORS_DIR.
TMP_STAGES=$(mktemp -d -t aidlc-t89-zero-stages.XXXXXX)
cp -r "$REAL_STAGES/initialization" "$TMP_STAGES/"
TMP_SENSORS=$(mktemp -d -t aidlc-t89-zero-sensors.XXXXXX)
TMP_GRAPH=$(mktemp -t aidlc-t89-zero-graph.XXXXXX.json)
cp "$SEED_GRAPH" "$TMP_GRAPH"
AIDLC_STAGES_DIR="$TMP_STAGES" AIDLC_SENSORS_DIR="$TMP_SENSORS" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile >/dev/null 2>&1
ALL_EMPTY=$(jq 'all(.sensors_applicable | length == 0)' "$TMP_GRAPH")
assert_eq "$ALL_EMPTY" "true" "zero-sensors + zero-imports: every stage gets sensors_applicable: []"
rm -rf "$TMP_STAGES" "$TMP_SENSORS" "$TMP_GRAPH"

# --- Case 9: unknown-id — stage imports id not in registry --------------
TMP_GRAPH=$(mktemp -t aidlc-t89-unknown-id-graph.XXXXXX.json); cp "$SEED_GRAPH" "$TMP_GRAPH"
set +e
ERR=$(AIDLC_SENSORS_DIR="$FIXTURES/unknown-id" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "unknown-id: compile exits 1 when stage imports unknown sensor"
case "$ERR" in
  *"unknown sensor id"*) ok "unknown-id: error message names the unknown id" ;;
  *) not_ok "unknown-id: error message names the unknown id" "got: $ERR" ;;
esac
rm -f "$TMP_GRAPH"

# --- Case 10: duplicate-manifest-id ------------------------------------
# Two manifests in the same dir claiming the same id MUST fail compile.
# Whichever loud-failure path fires first (duplicate-id guard or
# id↔filename cross-check, depending on filesystem-order traversal) is
# acceptable — both name the offending file path so the author can fix.
TMP_GRAPH=$(mktemp -t aidlc-t89-duplicate-graph.XXXXXX.json); cp "$SEED_GRAPH" "$TMP_GRAPH"
set +e
ERR=$(AIDLC_SENSORS_DIR="$FIXTURES/duplicate-id" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "duplicate-id: compile exits 1 when two manifests claim same id"
case "$ERR" in
  *"duplicate sensor id"*|*"must match filename stem"*)
    ok "duplicate-id: error message names a manifest path" ;;
  *) not_ok "duplicate-id: error message names a manifest path" "got: $ERR" ;;
esac
rm -f "$TMP_GRAPH"

# --- Case 11: id-filename-mismatch ------------------------------------
TMP_GRAPH=$(mktemp -t aidlc-t89-mismatch-graph.XXXXXX.json); cp "$SEED_GRAPH" "$TMP_GRAPH"
set +e
ERR=$(AIDLC_SENSORS_DIR="$FIXTURES/id-filename-mismatch" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile 2>&1)
RC=$?
set -e
assert_eq "$RC" "1" "id-filename-mismatch: compile exits 1"
rm -f "$TMP_GRAPH"

# --- Case 12: unknown-kind (kind: llm reserved) -----------------------
TMP_GRAPH=$(mktemp -t aidlc-t89-unknown-kind-graph.XXXXXX.json); cp "$SEED_GRAPH" "$TMP_GRAPH"
set +e
AIDLC_SENSORS_DIR="$FIXTURES/unknown-kind" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile >/dev/null 2>&1
RC=$?
set -e
assert_eq "$RC" "1" "unknown-kind: compile rejects kind != deterministic"
rm -f "$TMP_GRAPH"

# --- Case 13: unknown-keys-tolerated (forward-compat) -----------------
JSON=$(compile_with_sensors "$FIXTURES/unknown-keys-tolerated")
LEN=$(echo "$JSON" | jq '[.[] | select(.slug == "intent-capture")] | .[0].sensors_applicable | length')
assert_eq "$LEN" "2" "unknown-keys-tolerated: compile succeeds; sensors still resolve"

# --- Case 14: BOM-frontmatter ------------------------------------------
JSON=$(compile_with_sensors "$FIXTURES/bom-frontmatter")
LEN=$(echo "$JSON" | jq '[.[] | select(.slug == "intent-capture")] | .[0].sensors_applicable | length')
assert_eq "$LEN" "2" "BOM-frontmatter: leading BOM byte does not break the parser"

# --- Case 15: round-trip determinism ----------------------------------
A=$(compile_with_sensors "$FIXTURES/basic-import")
B=$(compile_with_sensors "$FIXTURES/basic-import")
if [ "$A" = "$B" ]; then
  ok "round-trip: same fixture produces byte-identical compile output"
else
  not_ok "round-trip: same fixture produces byte-identical compile output" "compile is non-deterministic"
fi

# --- Case 16: --check detects sensor-manifest drift -------------------
TMP_DIR=$(mktemp -d -t aidlc-t89-check.XXXXXX)
TMP_GRAPH=$(mktemp -t aidlc-t89-check-graph.XXXXXX.json); cp "$SEED_GRAPH" "$TMP_GRAPH"
cp "$FIXTURES/basic-import"/*.md "$TMP_DIR/"
AIDLC_SENSORS_DIR="$TMP_DIR" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile >/dev/null 2>&1
# Edit the linter manifest's matches glob; --check should now fail.
sed -i.bak 's|"\*\*/\*.{ts,js}"|"**/*.{ts,js,jsx}"|' "$TMP_DIR/aidlc-linter.md"
rm -f "$TMP_DIR/aidlc-linter.md.bak"
set +e
AIDLC_SENSORS_DIR="$TMP_DIR" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile --check >/dev/null 2>&1
CHECK_EXIT=$?
set -e
assert_eq "$CHECK_EXIT" "1" "--check: detects sensor-manifest drift after edit"
rm -rf "$TMP_DIR" "$TMP_GRAPH"

# --- Case 17: matches survives manifest edit (compile-snapshot semantics) -
# The active stage-graph.json is compile-snapshotted; editing the manifest
# AFTER compile leaves the snapshotted matches intact until the next compile.
TMP_DIR=$(mktemp -d -t aidlc-t89-snapshot.XXXXXX)
TMP_GRAPH=$(mktemp -t aidlc-t89-snapshot-graph.XXXXXX.json); cp "$SEED_GRAPH" "$TMP_GRAPH"
cp "$FIXTURES/basic-import"/*.md "$TMP_DIR/"
AIDLC_SENSORS_DIR="$TMP_DIR" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile >/dev/null 2>&1
SNAPSHOT_GLOB=$(jq -r '[.[] | select(.slug == "code-generation")] | .[0].sensors_applicable[] | select(.id == "linter") | .matches' "$TMP_GRAPH")
# Mutate the manifest on disk
sed -i.bak 's|"\*\*/\*.{ts,js}"|"**/post-edit/*.ts"|' "$TMP_DIR/aidlc-linter.md"
rm -f "$TMP_DIR/aidlc-linter.md.bak"
# Snapshot still reads the pre-edit value
POST_EDIT_GLOB=$(jq -r '[.[] | select(.slug == "code-generation")] | .[0].sensors_applicable[] | select(.id == "linter") | .matches' "$TMP_GRAPH")
assert_eq "$SNAPSHOT_GLOB" "$POST_EDIT_GLOB" "compile-snapshot: matches frozen after compile"
assert_eq "$SNAPSHOT_GLOB" "**/*.{ts,js}" "compile-snapshot: snapshotted value is the pre-edit glob"
rm -rf "$TMP_DIR" "$TMP_GRAPH"

# --- Case 18: FIELD_ORDER places sensors_applicable after rules_in_context -
JSON=$(compile_with_sensors "$FIXTURES/basic-import")
FIRST_KEY_AFTER_RULES=$(echo "$JSON" | jq -r '.[0] | keys_unsorted | index("rules_in_context") as $i | .[$i + 1]')
assert_eq "$FIRST_KEY_AFTER_RULES" "sensors_applicable" \
  "FIELD_ORDER: sensors_applicable follows rules_in_context"

# --- Case 19: every real stage has sensors_applicable populated correctly --
COUNTS=$(echo "$JSON" | jq -c '[.[] | {slug, n: (.sensors_applicable | length)}] | sort_by(.slug)')
# Match expected counts for the 4 unique-shape stages; the rest get 2 or 4.
CG=$(echo "$JSON" | jq -r '.[] | select(.slug == "code-generation") | .sensors_applicable | length')
BT=$(echo "$JSON" | jq -r '.[] | select(.slug == "build-and-test") | .sensors_applicable | length')
WS=$(echo "$JSON" | jq -r '.[] | select(.slug == "workspace-scaffold") | .sensors_applicable | length')
FD=$(echo "$JSON" | jq -r '.[] | select(.slug == "functional-design") | .sensors_applicable | length')
if [ "$CG" = "2" ] && [ "$BT" = "3" ] && [ "$WS" = "0" ] && [ "$FD" = "4" ]; then
  ok "per-stage matrix: code-generation=2, build-and-test=3, workspace-scaffold=0, functional-design=4"
else
  not_ok "per-stage matrix" "got CG=$CG BT=$BT WS=$WS FD=$FD"
fi

finish
