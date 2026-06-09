#!/bin/bash
# t116: Unit tests for aidlc-orchestrate.ts directive artifact path resolution
# (closes review Major C). The engine's run-stage directive builder resolves the
# graph node's artifact VOCABULARY NAMES (produces = bare names; consumes =
# {artifact, required, conditional_on} objects) into canonical aidlc-docs/...
# paths at emit time, and drops conditional_on consumes-entries against the
# workflow's Project Type. produces resolve under the directive's own stage (the
# node IS the producer); consumes resolve under their PRODUCING stage (a consumed
# artifact lives in the dir of the one stage that produces it —
# 16-artifact-vocabulary.md:20-24, 44-48 — not the consuming stage's dir).
# Per-unit Construction stages (for_each: unit-of-work) inject a {unit-name}
# segment, applied to whichever stage OWNS the file.
#
# Drives the run-stage directive builder via the Branch-10 happy path: seed a
# fixture, pivot its Current Stage to the target slug + mark it in-flight ([-]),
# then call bare `bun aidlc-orchestrate.ts next` — which emits a run-stage for the
# current in-flight stage with produces/consumes resolved. (This test used to
# reach the builder through `next --stage <slug>`, but at the engine cutover a
# WITH-STATE jump became a `print` naming `aidlc-jump.ts execute` — a mutation the
# conductor runs — NOT a run-stage, so it no longer carries produces/consumes.
# The path-resolution behaviour under test is unchanged; only the vehicle moved to
# the happy path. The jump-emits-print contract itself is pinned by
# t114/t117/t118.) The seeded fixture's scope MUST be one where the target stage
# EXECUTEs — feature scope does for application-design/functional-design/
# code-generation (verify: `bun aidlc-state.ts lookup stages-in-scope feature`).
# Project Type drives the conditional_on consumes filter and is read from the
# fixture:
#   brownfield = state-brownfield-feature.md (:5 Brownfield, :6 feature)
#   greenfield = state-construction.md       (:5 Greenfield, :6 feature)
# Table-driven, mirrors t19-tool-jump.sh; unit tier, no LLM. (13 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
TOOL="$AIDLC_SRC/tools/aidlc-orchestrate.ts"

# Check bun is available
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

# Emit a run-stage directive for a named stage against a seeded state fixture,
# returning the validated JSON on stdout. Pivots Current Stage to the target slug
# and marks that stage's checkbox in-flight ([-]) so a bare `next` (Branch-10
# happy path) emits the run-stage for it — see the header for why this no longer
# goes through `next --stage` (jumps now emit a print, not a run-stage).
emit_for() {
  local fixture="$1" slug="$2" proj state
  proj=$(create_test_project)
  seed_state_file "$proj" "$FIXTURES_DIR/$fixture"
  state="$proj/aidlc-docs/aidlc-state.md"
  # Pivot Current Stage to the target, and mark the target's checkbox in-flight
  # (matches any current state: [ ]/[x]/[-]/[S]/etc.) so Branch 10 runs it.
  sed -i.bak "s/^- \*\*Current Stage\*\*:.*/- **Current Stage**: $slug/" "$state"
  sed -i.bak "s/^- \[.\] $slug — EXECUTE/- [-] $slug — EXECUTE/" "$state"
  rm -f "$state.bak"
  bun "$TOOL" next --project-dir "$proj" 2>&1
  cleanup_test_project "$proj"
}

# Extract a single field's JSON-array entries one-per-line via python (no jq
# dependency in the test env). Usage: json_array "$OUT" consumes
json_array() {
  python3 -c 'import json,sys
d=json.load(sys.stdin)
print("\n".join(d[sys.argv[1]]))' "$2" <<< "$1"
}

# Count entries in a directive string-array field.
json_count() {
  python3 -c 'import json,sys
d=json.load(sys.stdin)
print(len(d[sys.argv[1]]))' "$2" <<< "$1"
}

plan 13

# --- Brownfield application-design: produces resolve to the non-per-unit shape
#     aidlc-docs/inception/application-design/<name>.md. The fixture is feature
#     scope (application-design EXECUTEs) AND Brownfield (keeps conditional_on:
#     brownfield consumes), so the jump resolves to a run-stage, not a skip error. ---
BF=$(emit_for "state-brownfield-feature.md" "application-design")

# Test 1: a bare produces name resolves to the canonical non-per-unit path.
PRODUCES=$(json_array "$BF" produces)
assert_contains "$PRODUCES" "aidlc-docs/inception/application-design/components.md" \
  "produces 'components' → aidlc-docs/inception/application-design/components.md"

# Test 2: another produces name resolves under the same stage dir.
assert_contains "$PRODUCES" "aidlc-docs/inception/application-design/decisions.md" \
  "produces 'decisions' → aidlc-docs/inception/application-design/decisions.md"

# Test 3: the full produces set resolves (5 names: components, component-methods,
# services, component-dependency, decisions) — every name maps to a path.
PRODUCES_N=$(json_count "$BF" produces)
assert_eq "$PRODUCES_N" "5" "application-design resolves all 5 produces to paths"

# Test 4: conditional_on:brownfield consume 'architecture' is PRESENT for a
# Brownfield project and resolves UNDER ITS PRODUCER. 'architecture' is produced
# by reverse-engineering, so the canonical consume path is
# aidlc-docs/inception/reverse-engineering/architecture.md — NOT the consuming
# application-design stage's dir. (A consumed artifact lives under the stage that
# produces it: 16-artifact-vocabulary.md:20-24, 44-48.)
CONSUMES_BF=$(json_array "$BF" consumes)
assert_contains "$CONSUMES_BF" "aidlc-docs/inception/reverse-engineering/architecture.md" \
  "brownfield consume 'architecture' resolves to its producer reverse-engineering, not application-design"

# Test 5: the second conditional_on:brownfield consume 'component-inventory' is
# PRESENT for Brownfield and ALSO resolves under its producer reverse-engineering.
assert_contains "$CONSUMES_BF" "aidlc-docs/inception/reverse-engineering/component-inventory.md" \
  "brownfield consume 'component-inventory' resolves to its producer reverse-engineering"

# --- Greenfield application-design: the brownfield-conditional consumes DROP ---
GF=$(emit_for "state-construction.md" "application-design")
CONSUMES_GF=$(json_array "$GF" consumes)

# Test 6: 'architecture' (conditional_on:brownfield) is DROPPED for greenfield.
assert_not_contains "$CONSUMES_GF" "architecture.md" \
  "greenfield drops conditional_on:brownfield consume 'architecture'"

# Test 7: 'component-inventory' (conditional_on:brownfield) is DROPPED for greenfield.
assert_not_contains "$CONSUMES_GF" "component-inventory.md" \
  "greenfield drops conditional_on:brownfield consume 'component-inventory'"

# Test 8: a non-conditional produces name still resolves for greenfield — the
# filter only touches conditional_on consumes-entries, not produces.
PRODUCES_GF=$(json_array "$GF" produces)
assert_contains "$PRODUCES_GF" "aidlc-docs/inception/application-design/components.md" \
  "greenfield produces 'components' still resolves (filter is consumes-only)"

# --- Per-unit Construction stages (for_each: unit-of-work) inject {unit-name} ---
# Test 9: functional-design (per-unit) resolves a produces name to the per-unit
# shape aidlc-docs/construction/{unit-name}/functional-design/<name>.md.
FD=$(emit_for "state-construction.md" "functional-design")
PRODUCES_FD=$(json_array "$FD" produces)
assert_contains "$PRODUCES_FD" "aidlc-docs/construction/{unit-name}/functional-design/business-logic-model.md" \
  "per-unit functional-design injects {unit-name}: construction/{unit-name}/functional-design/business-logic-model.md"

# Test 10: code-generation (per-unit) also resolves under construction/{unit-name}/.
CG=$(emit_for "state-construction.md" "code-generation")
PRODUCES_CG=$(json_array "$CG" produces)
assert_contains "$PRODUCES_CG" "aidlc-docs/construction/{unit-name}/code-generation/" \
  "per-unit code-generation resolves under construction/{unit-name}/code-generation/"

# Test 11 (negative): a non-per-unit stage (application-design) does NOT get the
# construction/{unit-name}/ prefix — its produces stay under inception/.
assert_not_contains "$PRODUCES" "construction/{unit-name}/" \
  "non-per-unit application-design does NOT get the construction/{unit-name}/ prefix"

# Test 12: the NON-conditional required consume 'requirements' also resolves
# under its producer (requirements-analysis), proving producer-keying applies to
# every consume, not just the conditional ones.
assert_contains "$CONSUMES_BF" "aidlc-docs/inception/requirements-analysis/requirements.md" \
  "consume 'requirements' resolves to its producer requirements-analysis, not application-design"

# Test 13 (the property the original test failed to guard): a consume resolves to
# a DIFFERENT stage's directory than the consuming stage. Every brownfield consume
# of application-design is produced by some OTHER stage, so NONE may resolve under
# application-design's own directory. (Catches a regression to the old self-keyed
# bug where consumes were wrongly rooted at the consuming stage.)
assert_not_contains "$CONSUMES_BF" "aidlc-docs/inception/application-design/" \
  "no application-design consume resolves under its own dir — each lives under its producer"

finish
