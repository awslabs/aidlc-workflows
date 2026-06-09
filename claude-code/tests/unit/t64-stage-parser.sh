#!/bin/bash
# t64: Unit tests for parseStageFrontmatter / emitStageFrontmatter (45 tests)
#
# Validates MR 7's stage-frontmatter parser and emitter in lib.ts. Runs
# bun -e snippets against inline YAML heredocs so we exercise the real
# runtime behaviour. Covers YAML parsing positive/negative cases,
# required-field presence guarantees, nested-object lists (consumes[]),
# round-trip symmetry (parse → emit → parse), colon-in-scalar quoting,
# schema integration against MR 5's validateStageFrontmatter, and
# reserved-key passthrough for all 5 v0.3.0 reserved keys.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

LIB="$AIDLC_SRC/tools/aidlc-lib.ts"
SCHEMA="$AIDLC_SRC/tools/aidlc-stage-schema.ts"

# ------------------------------------------------------------
# Parse the worked example from stage-definition.md:84-110 and print
# a field value for a given JS-expression path (`obj.slug`,
# `obj.consumes.length`, etc.).
# ------------------------------------------------------------
parse_field() {
  local yaml="$1"
  local expr="$2"
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    const obj = parseStageFrontmatter(\`$yaml\`);
    console.log($expr);
  " 2>/dev/null
}

# Run parse and catch thrown errors, echoing "OK" or "ERR:<message>".
parse_catching() {
  local yaml="$1"
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    try {
      parseStageFrontmatter(\`$yaml\`);
      console.log('OK');
    } catch (e) {
      console.log('ERR:' + e.message);
    }
  " 2>/dev/null
}

# Round-trip: parse → emit → parse, return EQ / NE by JSON-equality.
roundtrip() {
  local yaml="$1"
  bun -e "
    import { parseStageFrontmatter, emitStageFrontmatter } from '$LIB';
    const obj1 = parseStageFrontmatter(\`$yaml\`);
    const yaml2 = emitStageFrontmatter(obj1);
    const obj2 = parseStageFrontmatter(yaml2);
    console.log(JSON.stringify(obj1) === JSON.stringify(obj2) ? 'EQ' : 'NE');
  " 2>/dev/null
}

# Parse, then validate against MR 5's schema.
parse_and_validate() {
  local yaml="$1"
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    import { validateStageFrontmatter } from '$SCHEMA';
    const obj = parseStageFrontmatter(\`$yaml\`);
    const r = validateStageFrontmatter(obj);
    console.log(r.valid ? 'VALID' : 'INVALID:' + r.errors.join('|'));
  " 2>/dev/null
}

# Parsed JSON of the whole object, for field-level assertions that need
# to look at multiple paths.
parse_json() {
  local yaml="$1"
  bun -e "
    import { parseStageFrontmatter } from '$LIB';
    console.log(JSON.stringify(parseStageFrontmatter(\`$yaml\`)));
  " 2>/dev/null
}

# ------------------------------------------------------------
# Worked-example fixture (mirrors stage-definition.md:84-110).
# ------------------------------------------------------------
WORKED=$(cat <<'EOF'
---
slug: scope-definition
phase: ideation
execution: ALWAYS
condition: Always executes
lead_agent: aidlc-product-agent
support_agents:
  - aidlc-delivery-agent
mode: inline
produces:
  - scope-document
  - intent-backlog
consumes:
  - artifact: intent-statement
    required: true
  - artifact: feasibility-assessment
    required: false
requires_stage:
  - intent-capture
inputs: Intent statement
outputs: aidlc-docs/ideation/scope-definition/scope-document.md
---

# body
EOF
)

plan 45

# ============================================================
# Positive baseline (6 assertions)
# ============================================================

assert_eq "$(parse_field "$WORKED" "obj.slug")" "scope-definition" "worked example → slug"
assert_eq "$(parse_field "$WORKED" "obj.phase")" "ideation" "worked example → phase"
assert_eq "$(parse_field "$WORKED" "obj.execution")" "ALWAYS" "worked example → execution"
assert_eq "$(parse_field "$WORKED" "obj.produces.length")" "2" "worked example → produces length"
assert_eq "$(parse_field "$WORKED" "obj.consumes.length")" "2" "worked example → consumes length"
assert_eq "$(parse_field "$WORKED" "obj.consumes[0].required")" "true" "worked example → consumes[0].required is boolean true"

# ============================================================
# Missing frontmatter (1 assertion)
# ============================================================

assert_contains "$(parse_catching "no frontmatter here")" "missing YAML frontmatter" "missing --- throws clear error"

# ============================================================
# Malformed frontmatter (2 assertions)
# ============================================================

# Unclosed frontmatter — opens with --- but never closes.
UNCLOSED=$(cat <<'EOF'
---
slug: test
phase: ideation

# body with no closing delimiter
EOF
)
assert_contains "$(parse_catching "$UNCLOSED")" "missing YAML frontmatter" "unclosed frontmatter throws"

# Malformed consumes entry — line that's neither `- k: v` nor `  k: v`.
MALFORMED_CONSUMES=$(cat <<'EOF'
---
slug: test
consumes:
  - artifact: foo
    garbage line with no colon
    required: true
---
EOF
)
assert_contains "$(parse_catching "$MALFORMED_CONSUMES")" "Malformed consumes" "malformed consumes line throws"

# ============================================================
# Scalar parsing (5 assertions)
# ============================================================

SCALAR_FIX=$(cat <<'EOF'
---
slug: test
phase: ideation
condition: unquoted value with spaces
lead_agent: "aidlc-product-agent"
inputs: value with trailing space
outputs: "aidlc-docs/path/CONDITIONAL: file.md"
support_agents: []
produces: []
consumes: []
requires_stage: []
execution: ALWAYS
mode: inline
---
EOF
)

assert_eq "$(parse_field "$SCALAR_FIX" "obj.condition")" "unquoted value with spaces" "unquoted scalar with spaces"
assert_eq "$(parse_field "$SCALAR_FIX" "obj.lead_agent")" "aidlc-product-agent" "double-quoted scalar strips quotes"
assert_eq "$(parse_field "$SCALAR_FIX" "obj.outputs")" "aidlc-docs/path/CONDITIONAL: file.md" "scalar containing colon parses when quoted"

# Quoted "true" in a scalar field stays as string (not coerced to boolean).
QUOTED_TRUE=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: "true"
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$QUOTED_TRUE" "typeof obj.condition")" "string" "quoted \"true\" in scalar stays string type"
assert_eq "$(parse_field "$QUOTED_TRUE" "obj.condition")" "true" "quoted \"true\" scalar value"

# ============================================================
# List parsing (3 assertions)
# ============================================================

# Flow-form empty list.
FLOW_EMPTY=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes: []
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$FLOW_EMPTY" "obj.produces.length")" "0" "flow-form empty list → length 0"

# Populated list.
POP_LIST=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents:
  - a
  - b
  - c
produces: []
requires_stage: []
consumes: []
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$POP_LIST" "obj.support_agents.length")" "3" "populated list → length 3"

# Block form with no items — absent key (MR 3's listField returns []).
# Required-field presence: produces must still be present in the object.
ZERO_ITEMS=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
EOF
)
# produces absent from YAML → listField returns [], parser always assigns.
assert_eq "$(parse_field "$ZERO_ITEMS" "Array.isArray(obj.produces) + ':' + obj.produces.length")" "true:0" "absent required list → [] (empty array, present)"

# ============================================================
# Nested-object list (consumes[]) (4 assertions)
# ============================================================

SINGLE_CONSUME=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes:
  - artifact: one-artifact
    required: true
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$SINGLE_CONSUME" "obj.consumes[0].artifact")" "one-artifact" "single consumes[] entry → artifact"

MULTI_CONSUME=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes:
  - artifact: first
    required: true
  - artifact: second
    required: false
    conditional_on: brownfield
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$MULTI_CONSUME" "obj.consumes.length")" "2" "multi-entry consumes[]"
assert_eq "$(parse_field "$MULTI_CONSUME" "obj.consumes[1].conditional_on")" "brownfield" "conditional_on present"

# Trailing-no-newline edge case: consumes is the LAST frontmatter key, so
# the outer extractor strips the newline before the closing ---. Earlier
# regex dropped the final required: line; fix uses `(?:\r?\n|$)` on
# continuation lines.
TRAIL_NO_NL=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces: []
requires_stage: []
inputs: a
outputs: b
consumes:
  - artifact: foo
    required: true
  - artifact: bar
    required: false
---
EOF
)
assert_eq "$(parse_field "$TRAIL_NO_NL" "obj.consumes[1].required")" "false" "trailing-no-newline: last required: line captured"

# ============================================================
# Required-field presence guarantees (4 assertions)
# ============================================================
# When a required list field is absent from YAML, parser must still
# emit it as [] so MR 5's validator doesn't reject with
# "missing required field". Covers support_agents / produces /
# requires_stage / consumes.

ALL_ABSENT=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
inputs: a
outputs: b
---
EOF
)

assert_eq "$(parse_field "$ALL_ABSENT" "Array.isArray(obj.support_agents)")" "true" "support_agents absent → array []"
assert_eq "$(parse_field "$ALL_ABSENT" "Array.isArray(obj.produces)")" "true" "produces absent → array []"
assert_eq "$(parse_field "$ALL_ABSENT" "Array.isArray(obj.requires_stage)")" "true" "requires_stage absent → array []"
assert_eq "$(parse_field "$ALL_ABSENT" "Array.isArray(obj.consumes)")" "true" "consumes absent → array []"

# ============================================================
# Boolean coercion in consumes[].required (2 assertions)
# ============================================================

BOOL_TRUE=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes:
  - artifact: foo
    required: true
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$BOOL_TRUE" "typeof obj.consumes[0].required")" "boolean" "required: true → boolean type"

BOOL_FALSE=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
consumes:
  - artifact: foo
    required: false
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$BOOL_FALSE" "obj.consumes[0].required")" "false" "required: false → boolean false"

# ============================================================
# Optional for_each (2 assertions)
# ============================================================

FOR_EACH=$(cat <<'EOF'
---
slug: test
phase: construction
execution: ALWAYS
condition: x
lead_agent: aidlc-developer-agent
mode: inline
for_each: unit-of-work
support_agents: []
produces: []
requires_stage: []
consumes: []
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$FOR_EACH" "obj.for_each")" "unit-of-work" "for_each present → value"

# for_each absent from ALL_ABSENT fixture above; parser should leave it off.
assert_eq "$(parse_field "$ALL_ABSENT" "'for_each' in obj")" "false" "for_each absent → key not in object"

# ============================================================
# Round-trip (4 assertions)
# ============================================================

# Minimal valid — all required, no optional.
assert_eq "$(roundtrip "$ALL_ABSENT")" "EQ" "round-trip: minimal (no optional)"

# Full — for_each plus conditional_on.
FULL=$(cat <<'EOF'
---
slug: test
phase: construction
execution: CONDITIONAL
condition: x
lead_agent: aidlc-developer-agent
mode: subagent
for_each: unit-of-work
support_agents:
  - aidlc-quality-agent
produces:
  - code
consumes:
  - artifact: design
    required: true
    conditional_on: greenfield
requires_stage:
  - functional-design
inputs: a
outputs: b
---
EOF
)
assert_eq "$(roundtrip "$FULL")" "EQ" "round-trip: full (for_each + conditional_on)"

# Colon in scalar (emitter quotes, parser strips).
COLON_SCALAR=$(cat <<'EOF'
---
slug: test
phase: construction
execution: ALWAYS
condition: x
lead_agent: aidlc-developer-agent
support_agents: []
mode: inline
produces: []
consumes: []
requires_stage: []
inputs: some: prefix
outputs: "aidlc-docs/CONDITIONAL: file.md"
---
EOF
)
assert_eq "$(roundtrip "$COLON_SCALAR")" "EQ" "round-trip: colon in scalar"

# Empty lists everywhere.
assert_eq "$(roundtrip "$FLOW_EMPTY")" "EQ" "round-trip: empty lists"

# ============================================================
# Schema integration (2 assertions)
# ============================================================

assert_eq "$(parse_and_validate "$WORKED")" "VALID" "worked example: parse → validate = VALID"
assert_eq "$(parse_and_validate "$FULL")" "VALID" "full fixture: parse → validate = VALID"

# ============================================================
# Shape regressions (2 assertions)
# ============================================================
# Slug with uppercase should fail validation via the chain.

BAD_SLUG=$(cat <<'EOF'
---
slug: Test-Stage
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
EOF
)
assert_contains "$(parse_and_validate "$BAD_SLUG")" "slug must be kebab-case" "bad slug rejected via parse→validate chain"

# Non-kebab artifact name in consumes[].artifact.
BAD_ARTIFACT=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
consumes:
  - artifact: BadArtifact
    required: true
requires_stage: []
inputs: a
outputs: b
---
EOF
)
assert_contains "$(parse_and_validate "$BAD_ARTIFACT")" "must be kebab-case" "bad artifact name rejected via chain"

# ============================================================
# Reserved-key passthrough (5 assertions)
# ============================================================
# Parser must not strip reserved keys — validator rejects them with a
# specific reason. Cover all 5 keys.

reserved_passthrough() {
  local key="$1"
  local fix=$(cat <<EOF
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
$key: some-value
---
EOF
)
  parse_and_validate "$fix"
}

assert_contains "$(reserved_passthrough "when")" "when is reserved (fitness compiler); not active yet" "reserved: when"
assert_contains "$(reserved_passthrough "on_failure")" "on_failure is reserved (loop driver); not active yet" "reserved: on_failure"
assert_contains "$(reserved_passthrough "blocks_on")" "blocks_on is reserved (construction worktrees); not active yet" "reserved: blocks_on"
assert_contains "$(reserved_passthrough "timeout")" "timeout is reserved (sensor binding); not active yet" "reserved: timeout"
assert_contains "$(reserved_passthrough "retry")" "retry is reserved (loop driver); not active yet" "reserved: retry"

# ============================================================
# Adversarial edge cases (3 assertions)
# ============================================================
# Found in post-implementation adversarial review; fixes in the same MR.

# Non-string input throws a clear error (not an opaque "undefined is not
# an object" TypeError).
OUT=$(bun -e "
  import { parseStageFrontmatter } from '$LIB';
  try { parseStageFrontmatter(undefined); console.log('OK'); }
  catch (e) { console.log('ERR:' + e.message); }
" 2>/dev/null)
assert_contains "$OUT" "expected string" "non-string input → clean error"

# Blank line inside consumes[] — silently truncating the list would be a
# data-loss bug. Throw clearly instead.
BLANK_IN_CONSUMES=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: x
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
requires_stage: []
inputs: a
outputs: b
consumes:
  - artifact: foo
    required: true

  - artifact: bar
    required: false
---
EOF
)
assert_contains "$(parse_catching "$BLANK_IN_CONSUMES")" "Blank line not allowed" "blank line inside consumes[] throws"

# Empty-string scalar value (`condition: ""`) must reach the parsed
# object — dropping it would masquerade as "field missing" to the
# validator.
EMPTY_SCALAR=$(cat <<'EOF'
---
slug: test
phase: ideation
execution: ALWAYS
condition: ""
lead_agent: aidlc-product-agent
mode: inline
support_agents: []
produces: []
consumes: []
requires_stage: []
inputs: a
outputs: b
---
EOF
)
assert_eq "$(parse_field "$EMPTY_SCALAR" "'condition' in obj ? 'PRESENT' : 'MISSING'")" "PRESENT" "empty-string scalar value reaches object"

finish
