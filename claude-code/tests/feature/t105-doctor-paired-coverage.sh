#!/bin/bash
# t105 (feature, L2): real `/aidlc --doctor` paired-coverage row + the
# GUARDRAIL_LOADED emit pin (v0.5.0 MR 14).
#
# Drives the real doctor against AIDLC_RULES_DIR fixtures and the seed
# stage-graph (whose sensors_applicable carries required-sections /
# upstream-coverage). Asserts the paired-coverage row label uses the
# P/(M-X) fraction (paired-over-sensor-needing), surfaces unpaired rules,
# renders as an advisory `✓`, and emits exactly one GUARDRAIL_LOADED audit
# row with the declared Scope/Path/Rule count fields.
#
# The label fraction is the plan's own contract (§2.3 / sanctioned
# deviation 3.10): P/(M-X), reconciling the amended card's contradictory
# N/M vs N-X/N. No cross-reference to the card forms — they are superseded.
#
# L2 — bash + bun.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AIDLC_SRC="$REPO_ROOT/dist/claude/.claude"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"
SEED_GRAPH="$AIDLC_SRC/tools/data/stage-graph.json"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 6

# Run doctor against a rules fixture in a fresh project dir; the project dir
# survives the call so the test can read aidlc-docs/audit.md. Returns the
# project dir path on stdout (caller cleans up). stdout of the run goes to
# the named OUTFILE.
PROJ=""
run_doctor() {
  local rules_dir="$1" outfile="$2"
  PROJ=$(mktemp -d -t aidlc-t105-proj.XXXXXX)
  mkdir -p "$PROJ/aidlc-docs"
  AIDLC_RULES_DIR="$rules_dir" AIDLC_STAGE_GRAPH="$SEED_GRAPH" \
    bun "$UTIL" doctor --project-dir "$PROJ" >"$outfile" 2>&1 || true
}

# ---------------------------------------------------------------------------
# Fixture: 2 sensor-bound rules (one resolves: aidlc-required-sections; one
# ghost: aidlc-ghost) + 1 feedforward-only. So M=3, X=1, needing=M-X=2,
# P=1 (required-sections resolves), U=1 (ghost). Label: 1/2, 1 feedforward.
# ---------------------------------------------------------------------------
RD=$(mktemp -d -t aidlc-t105-cov.XXXXXX)
cat > "$RD/aidlc-org.md" <<'EOF'
---
pairing: aidlc-required-sections
---

# Org rule bound to a real sensor
EOF
cat > "$RD/aidlc-team.md" <<'EOF'
---
pairing: aidlc-ghost
---

# Team rule bound to a non-existent sensor
EOF
cat > "$RD/aidlc-project.md" <<'EOF'
---
pairing: feedforward-only
---

# Project rule that needs no sensor
EOF
OUTF=$(mktemp -t aidlc-t105-out.XXXXXX)
run_doctor "$RD" "$OUTF"
OUT=$(cat "$OUTF")

# Case 1 — coverage row reads the exact P/(M-X) label.
assert_contains "$OUT" \
  "Paired sensor coverage: 1/2 guardrails paired (1 feedforward-only)" \
  "case 1: exact P/(M-X) label 1/2 (1 feedforward-only)"

# Case 2 — unpaired rule surfaces in the detail.
assert_contains "$OUT" \
  "unpaired: .claude/rules/aidlc-team.md → aidlc-ghost (no stage binds it)" \
  "case 2: unpaired ghost rule surfaces in detail"

# Case 3 — coverage row is `✓` (advisory).
COV_LINE=$(echo "$OUT" | grep "Paired sensor coverage:" || true)
if echo "$COV_LINE" | grep -q "^✓"; then
  ok "case 3: coverage row prefixed ✓ (advisory pass)"
else
  not_ok "case 3: coverage row prefixed ✓ (advisory pass)" "got:\n$COV_LINE"
fi

# Case 4 — GUARDRAIL_LOADED row appears in aidlc-docs/audit.md after the run.
AUDIT="$PROJ/aidlc-docs/audit.md"
if [ -f "$AUDIT" ] && grep -q "GUARDRAIL_LOADED" "$AUDIT" && grep -q "## Guardrail Loaded" "$AUDIT"; then
  ok "case 4: GUARDRAIL_LOADED row written to audit.md"
else
  not_ok "case 4: GUARDRAIL_LOADED row written to audit.md" "audit:\n$(cat "$AUDIT" 2>/dev/null)"
fi

# Case 5 — required fields present (Scope, Path, Rule count) on the row.
if grep -q "^\*\*Scope\*\*: all" "$AUDIT" \
   && grep -q "^\*\*Path\*\*: .claude/rules/" "$AUDIT" \
   && grep -q "^\*\*Rule count\*\*: 3" "$AUDIT"; then
  ok "case 5: GUARDRAIL_LOADED carries Scope/Path/Rule count fields"
else
  not_ok "case 5: GUARDRAIL_LOADED carries Scope/Path/Rule count fields" "audit:\n$(cat "$AUDIT" 2>/dev/null)"
fi
rm -rf "$RD" "$PROJ" "$OUTF"

# ---------------------------------------------------------------------------
# Case 6 — No-pairing fixture → "no sensor-bound rules (0 feedforward-only)"
# AND still emits GUARDRAIL_LOADED (the M-X=0 branch still emits).
# ---------------------------------------------------------------------------
RD0=$(mktemp -d -t aidlc-t105-nopair.XXXXXX)
cat > "$RD0/aidlc-org.md" <<'EOF'
# Org rule with no pairing
EOF
OUTF0=$(mktemp -t aidlc-t105-out0.XXXXXX)
run_doctor "$RD0" "$OUTF0"
OUT0=$(cat "$OUTF0")
AUDIT0="$PROJ/aidlc-docs/audit.md"
if echo "$OUT0" | grep -q "Paired sensor coverage: no sensor-bound rules (0 feedforward-only)" \
   && grep -q "GUARDRAIL_LOADED" "$AUDIT0"; then
  ok "case 6: M-X=0 branch label + still emits GUARDRAIL_LOADED"
else
  not_ok "case 6: M-X=0 branch label + still emits GUARDRAIL_LOADED" \
    "out:\n$OUT0\naudit:\n$(cat "$AUDIT0" 2>/dev/null)"
fi
rm -rf "$RD0" "$PROJ" "$OUTF0"

finish
