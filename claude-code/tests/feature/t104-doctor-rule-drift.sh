#!/bin/bash
# t104 (feature, L2): real `/aidlc --doctor` rule-drift row rendering (v0.5.0 MR 14).
#
# Drives the real doctor (bun aidlc-utility.ts doctor --project-dir) against
# AIDLC_RULES_DIR fixtures and asserts on stdout. Proves the deterministic-
# tool half of T2 end-to-end: doctor surfaces same-`##`-heading overlap
# between org's populated headings and team/project(-learnings) files as an
# advisory `✓` row, quoting the org sentence inline. The contradiction
# verdict is the orchestrator-LLM's at observation time — doctor never blocks.
#
# Fixtures use the POPULATED org heading `## Testing Posture` (NOT the empty
# ## Forbidden/## Mandated/## Corrections), so the overlap is real (§0.12b).
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

# Run doctor against a rules fixture; echo stdout. `|| true` absorbs the
# exit code from pre-existing checks (the bare temp project fails hook/
# settings checks — irrelevant to the advisory drift row).
run_doctor() {
  local rules_dir="$1"
  local proj
  proj=$(mktemp -d -t aidlc-t104-proj.XXXXXX)
  mkdir -p "$proj/aidlc-docs"
  AIDLC_RULES_DIR="$rules_dir" AIDLC_STAGE_GRAPH="$SEED_GRAPH" \
    bun "$UTIL" doctor --project-dir "$proj" 2>&1 || true
  rm -rf "$proj"
}

# ---------------------------------------------------------------------------
# N=1 drift fixture: org ## Testing Posture + team-learnings ## Testing
# Posture with contradicting content.
# ---------------------------------------------------------------------------
RD=$(mktemp -d -t aidlc-t104-drift.XXXXXX)
cat > "$RD/aidlc-org.md" <<'EOF'
# Org

## Testing Posture

We require 80% line coverage on every Bolt before merge.
EOF
cat > "$RD/aidlc-team-learnings.md" <<'EOF'
# Team Learnings

## Testing Posture

This team skips the coverage floor on spike branches.
EOF
OUT=$(run_doctor "$RD")

# Case 1 — drift row renders with N=1 + the literal headline.
assert_contains "$OUT" \
  "Rule drift: 1 team/project rule(s) overlap org policy (review for contradiction)" \
  "case 1: drift headline renders with N=1"

# Case 2 — detail carries file + ## Testing Posture + the quoted org sentence.
if echo "$OUT" | grep -q "aidlc-team-learnings.md" \
   && echo "$OUT" | grep -q "Testing Posture" \
   && echo "$OUT" | grep -q "We require 80% line coverage on every Bolt before merge."; then
  ok "case 2: detail carries file + heading + quoted org sentence"
else
  not_ok "case 2: detail carries file + heading + quoted org sentence" "got:\n$OUT"
fi

# Case 3 — drift row is `✓` (advisory pass) — does NOT push failed.
DRIFT_LINE=$(echo "$OUT" | grep "Rule drift:" || true)
if echo "$DRIFT_LINE" | grep -q "^✓"; then
  ok "case 3: drift row prefixed ✓ (advisory pass)"
else
  not_ok "case 3: drift row prefixed ✓ (advisory pass)" "got:\n$DRIFT_LINE"
fi
rm -rf "$RD"

# ---------------------------------------------------------------------------
# Case 4 — N=0 fixture (no overlap) → quiet headline, ✓.
# ---------------------------------------------------------------------------
RD0=$(mktemp -d -t aidlc-t104-noverlap.XXXXXX)
cat > "$RD0/aidlc-org.md" <<'EOF'
# Org

## Way of Working

We use trunk-based development.
EOF
cat > "$RD0/aidlc-team.md" <<'EOF'
# Team

## Code Style

We prefer tabs.
EOF
OUT0=$(run_doctor "$RD0")
QUIET=$(echo "$OUT0" | grep "Rule drift:" || true)
if echo "$QUIET" | grep -q "Rule drift: no team/project rule overlaps org policy" \
   && echo "$QUIET" | grep -q "^✓"; then
  ok "case 4: N=0 fixture → quiet '✓ no overlap' render"
else
  not_ok "case 4: N=0 fixture → quiet '✓ no overlap' render" "got:\n$QUIET"
fi
rm -rf "$RD0"

# ---------------------------------------------------------------------------
# Case 5 — Org-absent fixture → informational pass, no crash.
# ---------------------------------------------------------------------------
RDA=$(mktemp -d -t aidlc-t104-noorg.XXXXXX)
cat > "$RDA/aidlc-team.md" <<'EOF'
# Team

## Testing Posture

A team-only posture with no org to compare against.
EOF
OUTA=$(run_doctor "$RDA")
if echo "$OUTA" | grep -q "Rule drift: org rules absent (informational)"; then
  ok "case 5: org-absent fixture → informational pass"
else
  not_ok "case 5: org-absent fixture → informational pass" "got:\n$OUTA"
fi
rm -rf "$RDA"

# ---------------------------------------------------------------------------
# Case 6 — Fixture isolation: the fixture's ## Testing Posture (not the
# shipped rules') drives N=1. Proves AIDLC_RULES_DIR + the .headings read
# seam are honoured end-to-end — a sentence that exists only in the fixture
# is what gets quoted.
# ---------------------------------------------------------------------------
RDI=$(mktemp -d -t aidlc-t104-iso.XXXXXX)
cat > "$RDI/aidlc-org.md" <<'EOF'
# Org

## Testing Posture

UNIQUEFIXTURETOKEN must appear in the quoted drift detail.
EOF
cat > "$RDI/aidlc-project.md" <<'EOF'
# Project

## Testing Posture

This project overrides the posture.
EOF
OUTI=$(run_doctor "$RDI")
if echo "$OUTI" | grep -q "UNIQUEFIXTURETOKEN" \
   && echo "$OUTI" | grep -q "Rule drift: 1 team/project rule(s) overlap org policy"; then
  ok "case 6: fixture isolation — fixture's posture drives N=1 (read seam honoured)"
else
  not_ok "case 6: fixture isolation — fixture's posture drives N=1 (read seam honoured)" "got:\n$OUTI"
fi
rm -rf "$RDI"

finish
