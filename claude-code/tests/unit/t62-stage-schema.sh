#!/bin/bash
# t62: Unit tests for stage-schema.ts (59 tests)
#
# Validates the stage-frontmatter schema module exports, field rules,
# enum constraints, reserved-key rejection, and optional dynamic agent
# lookup. The module is imported via `bun -e` so we exercise runtime
# behaviour, not just grep over source.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SCHEMA="$AIDLC_SRC/tools/aidlc-stage-schema.ts"

# Shared valid fixture — mirrors the scope-definition worked example at
# stage-definition.md:84-109. Inline JS object so we can mutate per-case.
# The FIXTURE literal is a JS expression, intentionally unquoted in bash.
FIXTURE='{
  slug: "scope-definition",
  phase: "ideation",
  execution: "ALWAYS",
  condition: "Always executes",
  lead_agent: "aidlc-product-agent",
  support_agents: ["aidlc-delivery-agent"],
  mode: "inline",
  produces: ["scope-document", "intent-backlog"],
  consumes: [
    { artifact: "intent-statement", required: true },
    { artifact: "feasibility-assessment", required: false }
  ],
  requires_stage: ["intent-capture"],
  inputs: "prose",
  outputs: "prose"
}'

# Helper: run validator against an inline JS fixture expression, echo
# "VALID" or pipe-joined errors. All bun -e calls import the same schema.
run_validator() {
  local fixture="$1"
  local ctx="${2:-undefined}"
  bun -e "
    import { validateStageFrontmatter } from '$SCHEMA';
    const r = validateStageFrontmatter($fixture, $ctx);
    console.log(r.valid ? 'VALID' : 'INVALID:' + r.errors.join('|'));
  " 2>/dev/null
}

plan 59

# ============================================================
# Positive baseline — the valid fixture (2 assertions)
# ============================================================

OUT=$(run_validator "$FIXTURE")
assert_eq "$OUT" "VALID" "valid fixture → VALID"

OUT=$(bun -e "
  import { validateStageFrontmatter } from '$SCHEMA';
  const r = validateStageFrontmatter($FIXTURE);
  if (r.valid) console.log('slug=' + r.data.slug);
  else console.log('INVALID');
" 2>/dev/null)
assert_eq "$OUT" "slug=scope-definition" "valid fixture → data.slug returned"

# ============================================================
# Shape failures — non-object inputs (5 assertions)
# ============================================================

OUT=$(run_validator "null")
assert_contains "$OUT" "expected object, got null" "null → shape error"

OUT=$(run_validator "undefined")
assert_contains "$OUT" "expected object, got undefined" "undefined → shape error"

OUT=$(run_validator "[]")
assert_contains "$OUT" "expected object, got array" "array → shape error"

OUT=$(run_validator '"string"')
assert_contains "$OUT" "expected object, got string" "string → shape error"

OUT=$(run_validator "42")
assert_contains "$OUT" "expected object, got number" "number → shape error"

# ============================================================
# Required fields missing — one per (12 assertions)
# ============================================================

for field in slug phase execution condition lead_agent support_agents mode produces consumes requires_stage inputs outputs; do
  OUT=$(bun -e "
    import { validateStageFrontmatter } from '$SCHEMA';
    const fx = $FIXTURE;
    delete fx.$field;
    const r = validateStageFrontmatter(fx);
    console.log(r.valid ? 'VALID' : r.errors.join('|'));
  " 2>/dev/null)
  if [[ "$OUT" == *"missing required field: $field"* ]]; then
    ok "missing $field → error names field"
  else
    not_ok "missing $field → error names field" "got: $OUT"
  fi
done

# ============================================================
# Type mismatches — 6 representative (6 assertions)
# ============================================================

OUT=$(run_validator "{...$FIXTURE, slug: 42}")
assert_contains "$OUT" "slug must be string" "slug: 42 → type error"

OUT=$(run_validator "{...$FIXTURE, support_agents: 'x'}")
assert_contains "$OUT" "support_agents must be array" "support_agents: 'x' → type error"

OUT=$(run_validator "{...$FIXTURE, consumes: {}}")
assert_contains "$OUT" "consumes must be array" "consumes: {} → type error"

OUT=$(run_validator "{...$FIXTURE, produces: 'x'}")
assert_contains "$OUT" "produces must be array" "produces: 'x' → type error"

OUT=$(run_validator "{...$FIXTURE, condition: 99}")
assert_contains "$OUT" "condition must be string" "condition: 99 → type error"

OUT=$(run_validator "{...$FIXTURE, requires_stage: 'x'}")
assert_contains "$OUT" "requires_stage must be array" "requires_stage: 'x' → type error"

# ============================================================
# Enum misses (4 assertions)
# ============================================================

OUT=$(run_validator "{...$FIXTURE, phase: 'bogus'}")
assert_contains "$OUT" "phase must be one of" "phase enum miss → error"

OUT=$(run_validator "{...$FIXTURE, execution: 'YES'}")
assert_contains "$OUT" "execution must be one of" "execution enum miss → error"

OUT=$(run_validator "{...$FIXTURE, mode: 'hologram'}")
assert_contains "$OUT" "mode must be one of" "mode enum miss → error"

OUT=$(run_validator "{...$FIXTURE, consumes: [{ artifact: 'x', required: true, conditional_on: 'maybe' }]}")
assert_contains "$OUT" "conditional_on must be one of" "conditional_on enum miss → error"

# ============================================================
# Enum positive — all 3 modes accepted (3 assertions)
# ============================================================

for m in inline subagent agent-team; do
  OUT=$(run_validator "{...$FIXTURE, mode: '$m'}")
  assert_eq "$OUT" "VALID" "mode=$m accepted"
done

# ============================================================
# Slug regex rejections (3 assertions)
# ============================================================

OUT=$(run_validator "{...$FIXTURE, slug: 'Bad Slug'}")
assert_contains "$OUT" "slug must be kebab-case" "slug 'Bad Slug' rejected"

OUT=$(run_validator "{...$FIXTURE, slug: 'has_underscore'}")
assert_contains "$OUT" "slug must be kebab-case" "slug 'has_underscore' rejected"

OUT=$(run_validator "{...$FIXTURE, slug: '-leading-dash'}")
assert_contains "$OUT" "slug must be kebab-case" "slug '-leading-dash' rejected"

# ============================================================
# Reserved keys — each produces a reserved-key error (5 assertions)
# ============================================================

OUT=$(run_validator "{...$FIXTURE, when: 'x'}")
assert_contains "$OUT" "when is reserved (fitness compiler); not active yet" "reserved: when"

OUT=$(run_validator "{...$FIXTURE, on_failure: 'x'}")
assert_contains "$OUT" "on_failure is reserved (loop driver); not active yet" "reserved: on_failure"

OUT=$(run_validator "{...$FIXTURE, blocks_on: 'x'}")
assert_contains "$OUT" "blocks_on is reserved (construction worktrees); not active yet" "reserved: blocks_on"

OUT=$(run_validator "{...$FIXTURE, timeout: 'x'}")
assert_contains "$OUT" "timeout is reserved (sensor binding); not active yet" "reserved: timeout"

OUT=$(run_validator "{...$FIXTURE, retry: 'x'}")
assert_contains "$OUT" "retry is reserved (loop driver); not active yet" "reserved: retry"

# ============================================================
# Unknown key (1 assertion)
# ============================================================

OUT=$(run_validator "{...$FIXTURE, foo: 'bar'}")
assert_contains "$OUT" "unknown key: foo" "unknown key rejected"

# ============================================================
# for_each optionality — absent/string/number (3 assertions)
# ============================================================

OUT=$(run_validator "$FIXTURE")
assert_eq "$OUT" "VALID" "for_each absent → valid"

OUT=$(run_validator "{...$FIXTURE, for_each: 'unit-of-work'}")
assert_eq "$OUT" "VALID" "for_each string → valid"

OUT=$(run_validator "{...$FIXTURE, for_each: 42}")
assert_contains "$OUT" "for_each must be string" "for_each number → error"

# ============================================================
# consumes[] shape (5 assertions)
# ============================================================

OUT=$(run_validator "{...$FIXTURE, consumes: [{ required: true }]}")
assert_contains "$OUT" "consumes[0].artifact missing" "consumes missing artifact"

OUT=$(run_validator "{...$FIXTURE, consumes: [{ artifact: 'x' }]}")
assert_contains "$OUT" "consumes[0].required missing" "consumes missing required"

OUT=$(run_validator "{...$FIXTURE, consumes: [{ artifact: 'x', required: 'yes' }]}")
assert_contains "$OUT" "consumes[0].required must be boolean" "consumes required wrong type"

OUT=$(run_validator "{...$FIXTURE, consumes: [{ artifact: 'x', required: true, conditional_on: 'always' }]}")
assert_contains "$OUT" "conditional_on must be one of" "consumes bad conditional_on"

OUT=$(run_validator "{...$FIXTURE, consumes: [{ artifact: 'x', required: true }]}")
assert_eq "$OUT" "VALID" "consumes unconditional (no conditional_on key) → valid"

# ============================================================
# conditional_on positive (2 assertions)
# ============================================================

OUT=$(run_validator "{...$FIXTURE, consumes: [{ artifact: 'x', required: true, conditional_on: 'brownfield' }]}")
assert_eq "$OUT" "VALID" "conditional_on: brownfield accepted"

OUT=$(run_validator "{...$FIXTURE, consumes: [{ artifact: 'x', required: true, conditional_on: 'greenfield' }]}")
assert_eq "$OUT" "VALID" "conditional_on: greenfield accepted"

# ============================================================
# Empty-array positives (2 assertions)
# ============================================================

OUT=$(run_validator "{...$FIXTURE, produces: [], consumes: [], requires_stage: [], support_agents: []}")
assert_eq "$OUT" "VALID" "all four array fields empty → valid"

OUT=$(run_validator "{...$FIXTURE, produces: []}")
assert_eq "$OUT" "VALID" "produces: [] alone → valid"

# ============================================================
# Dynamic agent lookup (3 assertions)
# ============================================================

OUT=$(bun -e "
  import { validateStageFrontmatter } from '$SCHEMA';
  const fx = {...$FIXTURE, lead_agent: 'ghost-agent'};
  const r = validateStageFrontmatter(fx, { agents: ['aidlc-product-agent', 'aidlc-delivery-agent'] });
  console.log(r.valid ? 'VALID' : r.errors.join('|'));
" 2>/dev/null)
assert_contains "$OUT" "lead_agent \"ghost-agent\" has no matching" "lead_agent not in ctx.agents → error"

OUT=$(bun -e "
  import { validateStageFrontmatter } from '$SCHEMA';
  const fx = {...$FIXTURE, support_agents: ['ghost-agent']};
  const r = validateStageFrontmatter(fx, { agents: ['aidlc-product-agent'] });
  console.log(r.valid ? 'VALID' : r.errors.join('|'));
" 2>/dev/null)
assert_contains "$OUT" "support_agents[0] \"ghost-agent\" has no matching" "support_agents[0] not in ctx.agents → error"

OUT=$(run_validator "{...$FIXTURE, lead_agent: 'ghost-agent'}")
assert_eq "$OUT" "VALID" "without ctx.agents → lead_agent not checked"

# ============================================================
# Error-field-name regression guard (3 assertions)
# ============================================================

OUT=$(bun -e "
  import { validateStageFrontmatter } from '$SCHEMA';
  const r = validateStageFrontmatter({});
  console.log(r.errors.find(e => e.includes('slug')) || 'NOPE');
" 2>/dev/null)
assert_contains "$OUT" "slug" "empty object error mentions slug"

OUT=$(bun -e "
  import { validateStageFrontmatter } from '$SCHEMA';
  const r = validateStageFrontmatter({...$FIXTURE, phase: 'bogus'});
  console.log(r.errors.find(e => e.includes('phase')) || 'NOPE');
" 2>/dev/null)
assert_contains "$OUT" "phase" "phase enum-miss error names phase"

OUT=$(bun -e "
  import { validateStageFrontmatter } from '$SCHEMA';
  const r = validateStageFrontmatter({...$FIXTURE, consumes: [{ required: true }]});
  console.log(r.errors.find(e => e.includes('consumes[0].artifact')) || 'NOPE');
" 2>/dev/null)
assert_contains "$OUT" "consumes[0].artifact" "consumes error path includes index + field"

finish
