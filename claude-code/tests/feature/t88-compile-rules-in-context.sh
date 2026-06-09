#!/bin/bash
# t88: Behavioural contract for `aidlc-graph compile`'s rules_in_context
# resolution (v0.5.0 MR 7a + MR 7b — strict-additive runtime, pull
# authoring).
#
# Surface tested:
#   - loadRules() walks .claude/rules/, anchored by aidlc-{org,team,project,
#     team-learnings,project-learnings,phase-*}.md filename pattern.
#   - resolveRulesForStage builds the strict-additive chain per stage:
#       org → team → project → phase (when stage's `phase:` matches the
#       phase-rule filename suffix). No glob filter — pull authoring
#       puts the relationship on the stage's existing phase: declaration.
#   - Empty rules dir produces rules_in_context: [] on every stage.
#   - pairing: keyword passes shape validation (cross-validation is MR 14).
#   - --check round-trip detects rule-file edits.
#
# Mechanics:
#   - AIDLC_RULES_DIR points loadRules() at a fixture dir.
#   - AIDLC_STAGE_GRAPH points the compile output at a tempfile.
#   - The real STAGES_DIR is used because rule resolution doesn't depend on
#     stage YAML; only stage.phase + stage.slug feed the resolver.
#
# L1 — pure bash + bun + jq.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
GRAPH_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-graph.ts"
FIXTURES="$REPO_ROOT/tests/fixtures/v05-mr7a-rule-resolution"
# compileStageGraph bootstraps {number, name} from the existing stage-graph
# (number + name are computed-not-authored — see stage-definition.md). Tests
# seed each AIDLC_STAGE_GRAPH tempfile with a copy of the real graph so the
# bootstrap succeeds. AIDLC_RULES_DIR is what we vary; STAGES_DIR stays real.
SEED_GRAPH="$REPO_ROOT/dist/claude/.claude/tools/data/stage-graph.json"

if [ ! -f "$GRAPH_TS" ]; then
  echo "Bail out! aidlc-graph.ts not found at $GRAPH_TS"
  exit 1
fi
if [ ! -f "$SEED_GRAPH" ]; then
  echo "Bail out! seed stage-graph.json not found at $SEED_GRAPH"
  exit 1
fi

plan 11

# Helper: compile against a fixture and print the JSON to stdout.
# Each invocation gets a fresh STAGE_GRAPH tempfile (seeded with the real
# graph so bootstrap succeeds) so cases can't leak.
compile_with_fixture() {
  local fixture="$1"
  local out
  out=$(mktemp -t aidlc-t88-stage-graph.XXXXXX.json)
  cp "$SEED_GRAPH" "$out"
  AIDLC_RULES_DIR="$fixture" AIDLC_STAGE_GRAPH="$out" \
    bun "$GRAPH_TS" compile >/dev/null 2>&1
  cat "$out"
  rm -f "$out"
}

# --- Case 1: org-only ---------------------------------------------------------
JSON=$(compile_with_fixture "$FIXTURES/org-only")
LEN=$(echo "$JSON" | jq '.[0].rules_in_context | length')
assert_eq "$LEN" "1" "org-only: rules_in_context length is 1"
SCOPE=$(echo "$JSON" | jq -r '.[0].rules_in_context[0].scope')
assert_eq "$SCOPE" "org" "org-only: single entry has scope=org"

# --- Case 2: org-team-project -------------------------------------------------
JSON=$(compile_with_fixture "$FIXTURES/org-team-project")
SCOPES=$(echo "$JSON" | jq -r '.[0].rules_in_context | map(.scope) | join(",")')
assert_eq "$SCOPES" "org,team,project" \
  "org-team-project: precedence order org→team→project"

# --- Case 3: all-four (formerly phase-paths-match) ---------------------------
# Cross-phase assertion: every construction stage gets length 4; every
# initialization stage gets length 3 (no aidlc-phase-initialization.md).
JSON=$(compile_with_fixture "$FIXTURES/all-four")
CONSTRUCTION_ALL_LEN_4=$(echo "$JSON" \
  | jq '[.[] | select(.phase=="construction")] | all(.rules_in_context | length == 4)')
INIT_ALL_LEN_3=$(echo "$JSON" \
  | jq '[.[] | select(.phase=="initialization")] | all(.rules_in_context | length == 3)')
assert_eq "$CONSTRUCTION_ALL_LEN_4" "true" "all-four: every construction stage has length 4"
assert_eq "$INIT_ALL_LEN_3" "true" "all-four: every initialization stage has length 3 (no phase rule)"

# --- Case 7: pairing-feedforward-only -----------------------------------------
# Validates schema accepts pairing: feedforward-only without throwing.
JSON=$(compile_with_fixture "$FIXTURES/pairing-feedforward-only")
LEN=$(echo "$JSON" | jq '.[0].rules_in_context | length')
assert_eq "$LEN" "1" "pairing-feedforward-only: schema-valid; rule still resolves"

# --- Case 8: zero-rules -------------------------------------------------------
JSON=$(compile_with_fixture "$FIXTURES/zero-rules")
ALL_EMPTY=$(echo "$JSON" | jq 'all(.rules_in_context | length == 0)')
assert_eq "$ALL_EMPTY" "true" "zero-rules: every stage gets rules_in_context: []"

# --- Case 9: --check round-trip detects rule-file edits ----------------------
# Compile with one rule set, then add a rule and re-run --check; expect drift.
TMP_DIR=$(mktemp -d -t aidlc-t88-check.XXXXXX)
TMP_GRAPH=$(mktemp -t aidlc-t88-check-graph.XXXXXX.json)
cp "$SEED_GRAPH" "$TMP_GRAPH"
cp "$FIXTURES/org-only/aidlc-org.md" "$TMP_DIR/aidlc-org.md"
AIDLC_RULES_DIR="$TMP_DIR" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile >/dev/null 2>&1
# Add a team rule. --check should now fail.
echo "# team rule added after compile" > "$TMP_DIR/aidlc-team.md"
set +e
AIDLC_RULES_DIR="$TMP_DIR" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile --check >/dev/null 2>&1
CHECK_EXIT=$?
set -e
assert_eq "$CHECK_EXIT" "1" "--check: detects rule-file drift after edit"
rm -rf "$TMP_DIR" "$TMP_GRAPH"

# --- Case 10: round-trip stability (deterministic compile) -------------------
# Two compiles of the same fixture produce byte-identical output.
A=$(compile_with_fixture "$FIXTURES/all-four")
B=$(compile_with_fixture "$FIXTURES/all-four")
if [ "$A" = "$B" ]; then
  ok "round-trip: same fixture produces byte-identical compile output"
else
  not_ok "round-trip: same fixture produces byte-identical compile output" \
    "compile is non-deterministic"
fi

# --- Case 8: schema rejection on bad pairing ---------------------------------
# pairing: must be "feedforward-only" or start with "aidlc-". A bare token
# like "garbage" should fail validation; compile should exit non-zero with
# the file path in the error.
TMP_RULES=$(mktemp -d -t aidlc-t88-bad-pairing.XXXXXX)
cat > "$TMP_RULES/aidlc-org.md" <<'EOF'
---
pairing: garbage
---

# Org rule with invalid pairing
EOF
TMP_GRAPH=$(mktemp -t aidlc-t88-bad-pairing-graph.XXXXXX.json); cp "$SEED_GRAPH" "$TMP_GRAPH"
set +e
AIDLC_RULES_DIR="$TMP_RULES" AIDLC_STAGE_GRAPH="$TMP_GRAPH" \
  bun "$GRAPH_TS" compile >/dev/null 2>&1
RC=$?
set -e
assert_eq "$RC" "1" "schema: invalid pairing value fails compile"
rm -rf "$TMP_RULES" "$TMP_GRAPH"

# --- Case 12: BOM-prefixed frontmatter parses correctly ---------------------
# macOS/Windows editors sometimes save markdown with a leading UTF-8 BOM
# (EF BB BF). Without BOM stripping, the `^---\r?\n` regex anchor would miss,
# the file would parse as frontmatter-less. Under pull authoring there's no
# `paths:` glob to silently broaden, but a missed `pairing:` would still drop
# the schema-valid pairing value. The fixture's pairing is `feedforward-only`;
# correct BOM stripping means compile succeeds and the construction phase
# rule still attaches via the pull import.
JSON=$(compile_with_fixture "$FIXTURES/bom-frontmatter")
CONSTRUCTION_HAS_PHASE=$(echo "$JSON" \
  | jq '[.[] | select(.phase=="construction")] | all(.rules_in_context | map(.scope) | contains(["phase"]))')
assert_eq "$CONSTRUCTION_HAS_PHASE" "true" \
  "BOM-prefixed frontmatter: parses correctly; phase rule attaches to all construction stages"

finish
