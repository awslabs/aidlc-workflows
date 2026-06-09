#!/bin/bash
# t63: Unit tests for aidlc-graph.ts artifactsRegistry + artifacts CLI (14 tests)
#
# Exercises the derivation function (union of produces[] across stages,
# dedup, cache) and the CLI subcommand (sorted output, exit codes on
# unknown / missing subcommand). Uses fixture stage-graph JSONs via the
# AIDLC_STAGE_GRAPH env-var injection seam added to lib.ts:loadStageGraph()
# as part of MR 6.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

TOOL="$AIDLC_SRC/tools/aidlc-graph.ts"

# --- Fixtures — written to tmpfiles, injected via AIDLC_STAGE_GRAPH ---

FIXTURE_DIR=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf '$FIXTURE_DIR'" EXIT

# Empty array — no stages at all.
cat > "$FIXTURE_DIR/empty.json" <<'EOF'
[]
EOF

# Stages without any produces fields (simulates today's pre-MR-8 reality).
cat > "$FIXTURE_DIR/no-produces.json" <<'EOF'
[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline"},
  {"slug": "s2", "number": "1.2", "name": "S2", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline"}
]
EOF

# Single stage with produces.
cat > "$FIXTURE_DIR/single.json" <<'EOF'
[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["alpha", "beta"]}
]
EOF

# Multiple stages, disjoint produces — tests union.
cat > "$FIXTURE_DIR/union.json" <<'EOF'
[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["alpha", "beta"]},
  {"slug": "s2", "number": "1.2", "name": "S2", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["gamma"]}
]
EOF

# Multiple stages, overlapping produces — tests dedup.
cat > "$FIXTURE_DIR/dedup.json" <<'EOF'
[
  {"slug": "s1", "number": "1.1", "name": "S1", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["shared", "only-one"]},
  {"slug": "s2", "number": "1.2", "name": "S2", "phase": "ideation", "execution": "ALWAYS", "lead_agent": "x", "support_agents": [], "mode": "inline", "produces": ["shared", "only-two"]}
]
EOF

plan 14

# ============================================================
# Empty-graph behaviour (2 assertions)
# ============================================================

OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/empty.json" bun "$TOOL" artifacts 2>&1)
assert_eq "$OUT" "" "empty graph → no output"

OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/no-produces.json" bun "$TOOL" artifacts 2>&1)
assert_eq "$OUT" "" "stages without produces → no output"

# ============================================================
# Single-stage behaviour (1 assertion)
# ============================================================

OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/single.json" bun "$TOOL" artifacts 2>&1)
assert_eq "$OUT" $'alpha\nbeta' "single stage → sorted produces list"

# ============================================================
# Union across stages (1 assertion)
# ============================================================

OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/union.json" bun "$TOOL" artifacts 2>&1)
assert_eq "$OUT" $'alpha\nbeta\ngamma' "two stages → sorted union"

# ============================================================
# Dedup (1 assertion)
# ============================================================

OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/dedup.json" bun "$TOOL" artifacts 2>&1)
assert_eq "$OUT" $'only-one\nonly-two\nshared' "overlapping produces → dedup; shared appears once"

# ============================================================
# Cache returns same reference on repeat call (1 assertion)
# ============================================================

OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/union.json" bun -e "
  import { artifactsRegistry } from '$TOOL';
  const a = artifactsRegistry();
  const b = artifactsRegistry();
  console.log(a === b ? 'same-ref' : 'different-ref');
" 2>&1)
assert_eq "$OUT" "same-ref" "cache returns same reference on repeat call"

# ============================================================
# Real stage-graph.json post-MR-9 returns populated registry (1 assertion)
# ============================================================
#
# Pre-MR-8: empty (no stage carried `produces[]`).
# Post-MR-9: compile regenerates with full YAML data → ≥ 100 artifacts
# (MR 8 populated 118 distinct slugs across 31 stages).

OUT=$(bun "$TOOL" artifacts 2>&1)
LINES=$(echo "$OUT" | wc -l | tr -d ' ')
if [ -n "$OUT" ] && [ "$LINES" -ge 100 ]; then
  ok "real stage-graph.json (post-MR-9) → non-empty registry (${LINES} artifacts)"
else
  not_ok "real stage-graph.json (post-MR-9) → non-empty registry" "got ${LINES} lines: ${OUT:0:80}"
fi

# ============================================================
# CLI stdout shape (2 assertions)
# ============================================================

# Sorted output — fixture has produces in non-alphabetical order, output must be sorted.
OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/union.json" bun "$TOOL" artifacts 2>&1)
assert_eq "$OUT" $'alpha\nbeta\ngamma' "CLI output sorted alphabetically"

# One name per line — count lines should match set size.
LINES=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/dedup.json" bun "$TOOL" artifacts 2>&1 | wc -l | tr -d ' ')
assert_eq "$LINES" "3" "CLI prints one name per line"

# ============================================================
# CLI empty-data exits 0 cleanly (1 assertion)
# ============================================================

AIDLC_STAGE_GRAPH="$FIXTURE_DIR/empty.json" bun "$TOOL" artifacts >/dev/null 2>&1
assert_eq "$?" "0" "CLI exits 0 when registry is empty"

# ============================================================
# CLI unknown subcommand exits 1, mentions 'artifacts' (1 assertion)
# ============================================================

set +e
STDERR=$(bun "$TOOL" bogus 2>&1 >/dev/null)
RC=$?
set -e
if [ "$RC" = "1" ] && [[ "$STDERR" == *"artifacts"* ]]; then
  ok "unknown subcommand → exit 1, stderr mentions 'artifacts'"
else
  not_ok "unknown subcommand → exit 1, stderr mentions 'artifacts'" \
    "rc=$RC stderr=$STDERR"
fi

# ============================================================
# CLI no subcommand exits 1, mentions 'artifacts' (1 assertion)
# ============================================================

set +e
STDERR=$(bun "$TOOL" 2>&1 >/dev/null)
RC=$?
set -e
if [ "$RC" = "1" ] && [[ "$STDERR" == *"artifacts"* ]]; then
  ok "no subcommand → exit 1, stderr mentions 'artifacts'"
else
  not_ok "no subcommand → exit 1, stderr mentions 'artifacts'" \
    "rc=$RC stderr=$STDERR"
fi

# ============================================================
# Shape regression — every registry name matches MR 5's regex (2 assertions)
# ============================================================

# Every name from union.json must match /^[a-z][a-z0-9-]*$/
OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/union.json" bun "$TOOL" artifacts 2>&1)
BAD=$(echo "$OUT" | grep -vE '^[a-z][a-z0-9-]*$' || true)
assert_eq "$BAD" "" "union fixture names all match kebab-case regex"

# Same guard for dedup fixture
OUT=$(AIDLC_STAGE_GRAPH="$FIXTURE_DIR/dedup.json" bun "$TOOL" artifacts 2>&1)
BAD=$(echo "$OUT" | grep -vE '^[a-z][a-z0-9-]*$' || true)
assert_eq "$BAD" "" "dedup fixture names all match kebab-case regex"

finish
