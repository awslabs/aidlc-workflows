#!/bin/bash
# t113: Unit tests for aidlc-directive.ts — the Directive schema + validator (30 tests)
#
# Validates the Directive discriminated union over the 8 engine-emitted kinds
# (run-stage, dispatch-subagent, invoke-swarm, present-gate, ask, print, error,
# done) and the runtime validator. The module is imported via `bun -e` so we
# exercise runtime behaviour, not just grep over source. Mirrors
# t62-stage-schema.sh. Unit tier — no LLM, no state.
#
# v0.6.0 Wave 2 MR 9 extends the gate field to `boolean | "unresolved"` (the
# classify-round-trip sentinel) and adds the optional `conductor_persona` string
# (decision D-E, engine-delivered on the first run-stage); the four assertions in
# the "classify-round-trip" block below pin both — the sentinel is accepted while
# any other gate-string is rejected, and conductor_persona must be a string when
# present.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SCHEMA="$AIDLC_SRC/tools/aidlc-directive.ts"

# Well-formed fixtures, one per kind. Inline JS object expressions so each case
# can spread + mutate. run-stage mirrors the vision §6 example directive.
RUN_STAGE='{
  kind: "run-stage",
  stage: "application-design",
  phase: "inception",
  lead_agent: "aidlc-architect-agent",
  support_agents: ["aidlc-aws-platform-agent", "aidlc-design-agent"],
  mode: "inline",
  gate: true,
  memory_path: "aidlc-docs/inception/application-design/memory.md",
  consumes: ["aidlc-docs/inception/requirements/requirements.md"],
  produces: ["aidlc-docs/inception/application-design/decisions.md"],
  rules_in_context: ["aidlc-org.md", "aidlc-team.md"],
  sensors_applicable: ["required-sections"],
  stage_file: ".claude/aidlc-common/stages/inception/application-design.md"
}'

DISPATCH_SUBAGENT='{
  kind: "dispatch-subagent",
  stage: "code-generation",
  phase: "construction",
  lead_agent: "aidlc-developer-agent",
  support_agents: ["aidlc-quality-agent"],
  mode: "subagent",
  gate: false,
  memory_path: "aidlc-docs/construction/auth/code-generation/memory.md",
  consumes: ["aidlc-docs/construction/auth/functional-design/functional-design.md"],
  produces: ["aidlc-docs/construction/auth/code-generation/code-manifest.md"],
  rules_in_context: ["aidlc-org.md"],
  sensors_applicable: ["linter"],
  stage_file: ".claude/aidlc-common/stages/construction/code-generation.md",
  worker: "code-generation"
}'

INVOKE_SWARM='{ kind: "invoke-swarm", units: ["auth", "billing"] }'
PRESENT_GATE='{ kind: "present-gate", stage: "application-design", phase: "inception", memory_path: "aidlc-docs/inception/application-design/memory.md" }'
ASK='{ kind: "ask", question: "Resume from the last checkpoint, or start fresh?" }'
PRINT='{ kind: "print", message: "AIDLC framework version 0.0.0" }'
ERROR='{ kind: "error", message: "Unknown scope" }'
DONE='{ kind: "done", reason: "Workflow complete." }'

# Helper: run validator against an inline JS fixture expression, echo "VALID"
# or pipe-joined errors. All bun -e calls import the same schema.
run_validator() {
  local fixture="$1"
  bun -e "
    import { validateDirective } from '$SCHEMA';
    const r = validateDirective($fixture);
    console.log(r.valid ? 'VALID' : 'INVALID:' + r.errors.join('|'));
  " 2>/dev/null
}

plan 30

# ============================================================
# Positive baseline — a well-formed directive of each kind (8 assertions)
# ============================================================

assert_eq "$(run_validator "$RUN_STAGE")" "VALID" "run-stage well-formed → VALID"
assert_eq "$(run_validator "$DISPATCH_SUBAGENT")" "VALID" "dispatch-subagent well-formed → VALID"
assert_eq "$(run_validator "$INVOKE_SWARM")" "VALID" "invoke-swarm well-formed → VALID"
assert_eq "$(run_validator "$PRESENT_GATE")" "VALID" "present-gate well-formed → VALID"
assert_eq "$(run_validator "$ASK")" "VALID" "ask well-formed → VALID"
assert_eq "$(run_validator "$PRINT")" "VALID" "print well-formed → VALID"
assert_eq "$(run_validator "$ERROR")" "VALID" "error well-formed → VALID"
assert_eq "$(run_validator "$DONE")" "VALID" "done well-formed → VALID"

# ============================================================
# Positive returns the parsed directive as data (1 assertion)
# ============================================================

OUT=$(bun -e "
  import { validateDirective } from '$SCHEMA';
  const r = validateDirective($RUN_STAGE);
  console.log(r.valid ? 'kind=' + r.data.kind : 'INVALID');
" 2>/dev/null)
assert_eq "$OUT" "kind=run-stage" "valid run-stage → data.kind returned"

# ============================================================
# Per-kind missing required field — names the field + kind (8 assertions)
# ============================================================

OUT=$(run_validator "(()=>{ const d = $RUN_STAGE; delete d.lead_agent; return d; })()")
assert_contains "$OUT" "run-stage: missing required field: lead_agent" "run-stage missing lead_agent → error"

OUT=$(run_validator "(()=>{ const d = $DISPATCH_SUBAGENT; delete d.worker; return d; })()")
assert_contains "$OUT" "dispatch-subagent: missing required field: worker" "dispatch-subagent missing worker → error"

OUT=$(run_validator "(()=>{ const d = $INVOKE_SWARM; delete d.units; return d; })()")
assert_contains "$OUT" "invoke-swarm: missing required field: units" "invoke-swarm missing units → error"

OUT=$(run_validator "(()=>{ const d = $PRESENT_GATE; delete d.memory_path; return d; })()")
assert_contains "$OUT" "present-gate: missing required field: memory_path" "present-gate missing memory_path → error"

OUT=$(run_validator "(()=>{ const d = $ASK; delete d.question; return d; })()")
assert_contains "$OUT" "ask: missing required field: question" "ask missing question → error"

OUT=$(run_validator "(()=>{ const d = $PRINT; delete d.message; return d; })()")
assert_contains "$OUT" "print: missing required field: message" "print missing message → error"

OUT=$(run_validator "(()=>{ const d = $ERROR; delete d.message; return d; })()")
assert_contains "$OUT" "error: missing required field: message" "error missing message → error"

OUT=$(run_validator "(()=>{ const d = $DONE; delete d.reason; return d; })()")
assert_contains "$OUT" "done: missing required field: reason" "done missing reason → error"

# ============================================================
# Unknown kind (1 assertion)
# ============================================================

OUT=$(run_validator '{ kind: "frobnicate", message: "x" }')
assert_contains "$OUT" 'unknown kind: "frobnicate"' "unknown kind → specific error"

# ============================================================
# Unknown key on a valid run-stage (1 assertion)
# ============================================================

OUT=$(run_validator "{...$RUN_STAGE, bogus: 'x'}")
assert_contains "$OUT" "run-stage: unknown key: bogus" "unknown key on run-stage → error"

# ============================================================
# Type mismatches (3 assertions)
# ============================================================

OUT=$(run_validator "{...$RUN_STAGE, gate: 'yes'}")
assert_contains "$OUT" 'run-stage: gate must be boolean or "unresolved", got string' "run-stage gate 'yes' → boolean-or-sentinel type error"

OUT=$(run_validator "{...$RUN_STAGE, support_agents: 'x'}")
assert_contains "$OUT" "run-stage: support_agents must be array, got string" "run-stage support_agents 'x' → array type error"

OUT=$(run_validator "{...$ASK, question: 42}")
assert_contains "$OUT" "ask: question must be string, got number" "ask question 42 → string type error"

# ============================================================
# The classify-round-trip gate sentinel + conductor_persona (4 assertions)
# ============================================================
# gate accepts the string sentinel "unresolved" (the skeleton case the conductor
# resolves), but rejects any OTHER string (a typo'd sentinel must surface loudly).
assert_eq "$(run_validator "{...$RUN_STAGE, gate: 'unresolved'}")" "VALID" \
  'run-stage gate:"unresolved" sentinel → VALID (classify round-trip)'
OUT=$(run_validator "{...$RUN_STAGE, gate: 'maybe'}")
assert_contains "$OUT" 'run-stage: gate must be boolean or "unresolved", got string' \
  'run-stage gate:"maybe" (non-sentinel string) → rejected'
# conductor_persona is an OPTIONAL string (D-E delivery on the first run-stage):
# present-and-string is VALID; present-and-non-string is rejected.
assert_eq "$(run_validator "{...$RUN_STAGE, conductor_persona: '# Persona'}")" "VALID" \
  "run-stage conductor_persona string → VALID (D-E first-next delivery)"
OUT=$(run_validator "{...$RUN_STAGE, conductor_persona: 42}")
assert_contains "$OUT" "run-stage: conductor_persona must be string, got number" \
  "run-stage conductor_persona non-string → rejected"

# ============================================================
# mode enum miss on run-stage (1 assertion)
# ============================================================

OUT=$(run_validator "{...$RUN_STAGE, mode: 'hologram'}")
assert_contains "$OUT" "run-stage: mode must be one of" "run-stage mode enum miss → error"

# ============================================================
# Shape failures — non-object inputs (3 assertions)
# ============================================================

assert_contains "$(run_validator "null")" "expected object, got null" "null → shape error"
assert_contains "$(run_validator "[]")" "expected object, got array" "array → shape error"
assert_contains "$(run_validator '"x"')" "expected object, got string" "string → shape error"

finish
