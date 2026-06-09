#!/bin/bash
# t103 (unit, L1): doctor rule-drift + paired-coverage primitives (v0.5.0 MR 14).
#
# Surface tested (the deterministic-tool half of T2 — doctor surfaces
# structurally, the orchestrator-LLM judges semantically):
#   - parseRuleHeadings (private in aidlc-graph.ts, surfaced via
#     RuleFile.headings): splits `## <heading>` bodies; skips fenced,
#     blockquote, single-line AND multi-line HTML comment lines.
#   - loadRules().headings is the read seam — bodies come from the same
#     `raw` loadRules() reads under rulesDir() (honours AIDLC_RULES_DIR),
#     never a second filesystem read from the relative .path.
#   - pairing consumer + validation: loadRules() surfaces
#     frontmatter.pairing; validateRuleFrontmatter rejects bad shapes
#     (pairing ships at aidlc-rule-schema.ts:29 — MR 14 CONSUMES it).
#   - Rule-drift detection: same-`##`-heading overlap between org's
#     populated headings and team/project(-learnings) files → candidate
#     pairs. Only populated org headings count (Testing Posture, not the
#     empty Forbidden/Mandated/Corrections).
#   - Paired-coverage: per rule with frontmatter.pairing, strip the
#     `aidlc-` prefix and match against sensors_applicable[].id from
#     loadGraph(); feedforward-only counts in X.
#
# Drift/coverage logic is exercised by driving the real `doctor` against
# fixtures (loadRules/loadGraph read AIDLC_RULES_DIR/AIDLC_STAGE_GRAPH);
# the primitive cases drive loadRules/parseRuleHeadings directly via bun -e.
#
# 15 cases; case 2 carries 2 assertions (2a/2b) and case 3 carries 4
# (3a–3d), so the TAP plan is 19 assertions total.
#
# L1 — pure bash + bun.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AIDLC_SRC="$REPO_ROOT/dist/claude/.claude"
GRAPH_TS="$AIDLC_SRC/tools/aidlc-graph.ts"
RULE_SCHEMA_TS="$AIDLC_SRC/tools/aidlc-rule-schema.ts"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"
SEED_GRAPH="$AIDLC_SRC/tools/data/stage-graph.json"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 19

# ---------------------------------------------------------------------------
# Case 1 — pairing consumer: loadRules() surfaces frontmatter.pairing
# ---------------------------------------------------------------------------
RD1=$(mktemp -d -t aidlc-t103-c1.XXXXXX)
cat > "$RD1/aidlc-org.md" <<'EOF'
---
pairing: aidlc-foo
---

# Org rule
EOF
OUT=$(AIDLC_RULES_DIR="$RD1" bun -e '
import { loadRules } from "'"$GRAPH_TS"'";
const r = loadRules().find(x => x.scope === "org");
console.log(r.frontmatter.pairing);
' 2>&1 | tail -1)
assert_eq "$OUT" "aidlc-foo" "case 1: loadRules() surfaces frontmatter.pairing"
rm -rf "$RD1"

# ---------------------------------------------------------------------------
# Case 2 — pairing validation: feedforward-only accepted; bogus rejected loud
# ---------------------------------------------------------------------------
GOOD=$(bun -e '
import { validateRuleFrontmatter } from "'"$RULE_SCHEMA_TS"'";
validateRuleFrontmatter({ pairing: "feedforward-only" }, "x");
console.log("ok");
' 2>&1 | tail -1)
assert_eq "$GOOD" "ok" "case 2a: feedforward-only passes validation"

set +e
BAD=$(bun -e '
import { validateRuleFrontmatter } from "'"$RULE_SCHEMA_TS"'";
validateRuleFrontmatter({ pairing: "bogus" }, "x");
' 2>&1)
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  ok "case 2b: bogus pairing rejected loud"
else
  not_ok "case 2b: bogus pairing rejected loud" "validate did not throw"
fi

# ---------------------------------------------------------------------------
# Case 3 — parseRuleHeadings: splits A/B; skips fenced + blockquote + single-line comment
# ---------------------------------------------------------------------------
RD3=$(mktemp -d -t aidlc-t103-c3.XXXXXX)
cat > "$RD3/aidlc-org.md" <<'EOF'
# Org

## A

Body of A.

> a blockquote line
<!-- a single-line comment -->

```
fenced content under A
```

## B

Body of B.
EOF
OUT=$(AIDLC_RULES_DIR="$RD3" bun -e '
import { loadRules } from "'"$GRAPH_TS"'";
const r = loadRules().find(x => x.scope === "org");
const a = r.headings.get("A") ?? "";
const b = r.headings.get("B") ?? "";
console.log("HASA=" + (a.includes("Body of A") ? "1" : "0"));
console.log("HASB=" + (b.includes("Body of B") ? "1" : "0"));
console.log("NOFENCE=" + (a.includes("fenced content") ? "0" : "1"));
console.log("NOQUOTE=" + (a.includes("blockquote") ? "0" : "1"));
console.log("NOCOMMENT=" + (a.includes("single-line comment") ? "0" : "1"));
' 2>&1)
assert_contains "$OUT" "HASA=1" "case 3a: ## A body captured"
assert_contains "$OUT" "HASB=1" "case 3b: ## B body captured"
assert_contains "$OUT" "NOFENCE=1" "case 3c: fenced content excluded"
# NOQUOTE + NOCOMMENT folded into one assertion to fit the planned count.
if echo "$OUT" | grep -q "NOQUOTE=1" && echo "$OUT" | grep -q "NOCOMMENT=1"; then
  ok "case 3d: blockquote + single-line comment lines excluded"
else
  not_ok "case 3d: blockquote + single-line comment lines excluded" "got:\n$OUT"
fi
rm -rf "$RD3"

# ---------------------------------------------------------------------------
# Case 4 — parseRuleHeadings MULTI-line comment: heading whose only body is a
# multi-line <!-- ... --> block reads as EMPTY (mirrors org ## Corrections).
# ---------------------------------------------------------------------------
RD4=$(mktemp -d -t aidlc-t103-c4.XXXXXX)
cat > "$RD4/aidlc-org.md" <<'EOF'
# Org

## Corrections

<!-- Self-learning loop appends here. -->
<!-- Use aidlc-team.md to record team-wide overrides; aidlc-project.md
     to record project-specific deviations. The loaders merge org -> team
     -> project at session start. -->
EOF
OUT=$(AIDLC_RULES_DIR="$RD4" bun -e '
import { loadRules } from "'"$GRAPH_TS"'";
const r = loadRules().find(x => x.scope === "org");
const c = (r.headings.get("Corrections") ?? "").trim();
console.log("EMPTY=" + (c === "" ? "1" : "0"));
' 2>&1)
assert_contains "$OUT" "EMPTY=1" "case 4: multi-line-comment-only heading reads as empty"
rm -rf "$RD4"

# ---------------------------------------------------------------------------
# Case 5 — loadRules().headings populated from the fixture under AIDLC_RULES_DIR
# (proves doctor reads fixture bodies, not the shipped rules — the read seam).
# ---------------------------------------------------------------------------
RD5=$(mktemp -d -t aidlc-t103-c5.XXXXXX)
cat > "$RD5/aidlc-org.md" <<'EOF'
# Org

## Testing Posture

A unique fixture sentence that does not appear in shipped rules.
EOF
OUT=$(AIDLC_RULES_DIR="$RD5" bun -e '
import { loadRules } from "'"$GRAPH_TS"'";
const r = loadRules().find(x => x.scope === "org");
const tp = r.headings.get("Testing Posture") ?? "";
console.log(tp.includes("unique fixture sentence") ? "FIXTURE=1" : "FIXTURE=0");
' 2>&1)
assert_contains "$OUT" "FIXTURE=1" "case 5: .headings populated from AIDLC_RULES_DIR fixture"
rm -rf "$RD5"

# ---------------------------------------------------------------------------
# Drift + coverage detection cases drive the real doctor against fixtures.
# Helper: run doctor against a rules fixture (+ optional stage-graph) and
# echo stdout. Doctor exits 1 only on pre-existing check failures; the
# bun process is its own; `|| true` absorbs the exit code.
# ---------------------------------------------------------------------------
run_doctor() {
  local rules_dir="$1"
  local stage_graph="${2:-$SEED_GRAPH}"
  local proj
  proj=$(mktemp -d -t aidlc-t103-proj.XXXXXX)
  mkdir -p "$proj/aidlc-docs"
  AIDLC_RULES_DIR="$rules_dir" AIDLC_STAGE_GRAPH="$stage_graph" \
    bun "$UTIL" doctor --project-dir "$proj" 2>&1 || true
  rm -rf "$proj"
}

# ---------------------------------------------------------------------------
# Case 6 — Drift detect: org ## Testing Posture non-empty + team-learnings
# ## Testing Posture non-empty → 1 candidate pair.
# ---------------------------------------------------------------------------
RD6=$(mktemp -d -t aidlc-t103-c6.XXXXXX)
cat > "$RD6/aidlc-org.md" <<'EOF'
# Org

## Testing Posture

We require 80% line coverage on every Bolt.
EOF
cat > "$RD6/aidlc-team-learnings.md" <<'EOF'
# Team Learnings

## Testing Posture

This team skips the coverage floor on spike branches.
EOF
OUT=$(run_doctor "$RD6")
if echo "$OUT" | grep -q "Rule drift: 1 team/project rule(s) overlap org policy" \
   && echo "$OUT" | grep -q "aidlc-team-learnings.md" \
   && echo "$OUT" | grep -q "Testing Posture"; then
  ok "case 6: org+team-learnings ## Testing Posture overlap → 1 candidate"
else
  not_ok "case 6: org+team-learnings ## Testing Posture overlap → 1 candidate" "got:\n$OUT"
fi
rm -rf "$RD6"

# ---------------------------------------------------------------------------
# Case 7 — Drift detect: org heading empty (Forbidden single-line / Corrections
# multi-line comment) → no overlap even if team has content.
# ---------------------------------------------------------------------------
RD7=$(mktemp -d -t aidlc-t103-c7.XXXXXX)
cat > "$RD7/aidlc-org.md" <<'EOF'
# Org

## Forbidden

<!-- Things agents must never do -->

## Corrections

<!-- Self-learning loop appends here. -->
<!-- multi-line comment continues
     across more than one line. -->
EOF
cat > "$RD7/aidlc-team.md" <<'EOF'
# Team

## Forbidden

Never push directly to main.

## Corrections

Always squash-merge.
EOF
OUT=$(run_doctor "$RD7")
if echo "$OUT" | grep -q "Rule drift: no team/project rule overlaps org policy"; then
  ok "case 7: empty org headings produce no overlap (N=0)"
else
  not_ok "case 7: empty org headings produce no overlap (N=0)" "got:\n$OUT"
fi
rm -rf "$RD7"

# ---------------------------------------------------------------------------
# Case 8 — Drift detect: team heading present but org lacks it entirely → no overlap.
# ---------------------------------------------------------------------------
RD8=$(mktemp -d -t aidlc-t103-c8.XXXXXX)
cat > "$RD8/aidlc-org.md" <<'EOF'
# Org

## Way of Working

We use trunk-based development.
EOF
cat > "$RD8/aidlc-team.md" <<'EOF'
# Team

## Code Style

We prefer tabs over spaces.
EOF
OUT=$(run_doctor "$RD8")
if echo "$OUT" | grep -q "Rule drift: no team/project rule overlaps org policy"; then
  ok "case 8: team heading absent from org → no overlap"
else
  not_ok "case 8: team heading absent from org → no overlap" "got:\n$OUT"
fi
rm -rf "$RD8"

# ---------------------------------------------------------------------------
# Case 9 — Drift detect: *-learnings.md participates (maps to team/project scope).
# ---------------------------------------------------------------------------
RD9=$(mktemp -d -t aidlc-t103-c9.XXXXXX)
cat > "$RD9/aidlc-org.md" <<'EOF'
# Org

## Deployment

We deploy on merge to staging.
EOF
cat > "$RD9/aidlc-project-learnings.md" <<'EOF'
# Project Learnings

## Deployment

This project deploys only on a manual tag.
EOF
OUT=$(run_doctor "$RD9")
if echo "$OUT" | grep -q "Rule drift: 1 team/project rule(s) overlap org policy" \
   && echo "$OUT" | grep -q "aidlc-project-learnings.md"; then
  ok "case 9: project-learnings.md participates in the drift walk"
else
  not_ok "case 9: project-learnings.md participates in the drift walk" "got:\n$OUT"
fi
rm -rf "$RD9"

# ---------------------------------------------------------------------------
# Paired-coverage helper graphs. The fixture stage-graph carries a sensor in
# sensors_applicable; the seed graph already has `required-sections`.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Case 10 — Paired-coverage: rule pairing: aidlc-required-sections, sensor
# present in a node → paired (P=1).
# ---------------------------------------------------------------------------
RD10=$(mktemp -d -t aidlc-t103-c10.XXXXXX)
cat > "$RD10/aidlc-org.md" <<'EOF'
---
pairing: aidlc-required-sections
---

# Org rule with a sensor binding
EOF
OUT=$(run_doctor "$RD10")
if echo "$OUT" | grep -q "Paired sensor coverage: 1/1 guardrails paired (0 feedforward-only)"; then
  ok "case 10: aidlc-required-sections resolves → 1/1 paired"
else
  not_ok "case 10: aidlc-required-sections resolves → 1/1 paired" "got:\n$OUT"
fi
rm -rf "$RD10"

# ---------------------------------------------------------------------------
# Case 11 — Paired-coverage: rule pairing: aidlc-ghost with no stage binding →
# unpaired listed.
# ---------------------------------------------------------------------------
RD11=$(mktemp -d -t aidlc-t103-c11.XXXXXX)
cat > "$RD11/aidlc-org.md" <<'EOF'
---
pairing: aidlc-ghost
---

# Org rule binding a non-existent sensor
EOF
OUT=$(run_doctor "$RD11")
if echo "$OUT" | grep -q "Paired sensor coverage: 0/1 guardrails paired (0 feedforward-only)" \
   && echo "$OUT" | grep -q "unpaired:" \
   && echo "$OUT" | grep -q "aidlc-ghost (no stage binds it)"; then
  ok "case 11: aidlc-ghost unpaired → 0/1 + unpaired detail"
else
  not_ok "case 11: aidlc-ghost unpaired → 0/1 + unpaired detail" "got:\n$OUT"
fi
rm -rf "$RD11"

# ---------------------------------------------------------------------------
# Case 12 — Paired-coverage: pairing: feedforward-only → counts in X, never P/U.
# ---------------------------------------------------------------------------
RD12=$(mktemp -d -t aidlc-t103-c12.XXXXXX)
cat > "$RD12/aidlc-org.md" <<'EOF'
---
pairing: aidlc-required-sections
---

# Org rule with a sensor binding
EOF
cat > "$RD12/aidlc-team.md" <<'EOF'
---
pairing: feedforward-only
---

# Team rule that needs no sensor
EOF
OUT=$(run_doctor "$RD12")
if echo "$OUT" | grep -q "Paired sensor coverage: 1/1 guardrails paired (1 feedforward-only)"; then
  ok "case 12: feedforward-only counts in X, not in the M-X denominator"
else
  not_ok "case 12: feedforward-only counts in X, not in the M-X denominator" "got:\n$OUT"
fi
rm -rf "$RD12"

# ---------------------------------------------------------------------------
# Case 13 — Prefix-strip: pairing: aidlc-required-sections matches bare
# `required-sections` manifest id. (Same fixture shape as case 10; this case
# pins the strip explicitly by confirming the aidlc- prefixed rule resolves
# against the bare id present in sensors_applicable.)
# ---------------------------------------------------------------------------
RD13=$(mktemp -d -t aidlc-t103-c13.XXXXXX)
cat > "$RD13/aidlc-org.md" <<'EOF'
---
pairing: aidlc-upstream-coverage
---

# Org rule binding the upstream-coverage sensor by aidlc- prefixed name
EOF
OUT=$(run_doctor "$RD13")
if echo "$OUT" | grep -q "Paired sensor coverage: 1/1 guardrails paired (0 feedforward-only)"; then
  ok "case 13: aidlc-upstream-coverage strips to bare id and resolves"
else
  not_ok "case 13: aidlc-upstream-coverage strips to bare id and resolves" "got:\n$OUT"
fi
rm -rf "$RD13"

# ---------------------------------------------------------------------------
# Case 14 — Zero state: no rules with pairing → "no sensor-bound rules
# (0 feedforward-only)".
# ---------------------------------------------------------------------------
RD14=$(mktemp -d -t aidlc-t103-c14.XXXXXX)
cat > "$RD14/aidlc-org.md" <<'EOF'
# Org rule, no pairing
EOF
OUT=$(run_doctor "$RD14")
if echo "$OUT" | grep -q "Paired sensor coverage: no sensor-bound rules (0 feedforward-only)"; then
  ok "case 14: no pairing rules → M-X=0 branch label"
else
  not_ok "case 14: no pairing rules → M-X=0 branch label" "got:\n$OUT"
fi
rm -rf "$RD14"

# ---------------------------------------------------------------------------
# Case 15 — Determinism: two runs over the same fixture → byte-identical
# drift+coverage label lines.
# ---------------------------------------------------------------------------
RD15=$(mktemp -d -t aidlc-t103-c15.XXXXXX)
cat > "$RD15/aidlc-org.md" <<'EOF'
---
pairing: aidlc-required-sections
---

# Org

## Testing Posture

We require 80% line coverage.
EOF
cat > "$RD15/aidlc-team-learnings.md" <<'EOF'
# Team Learnings

## Testing Posture

This team waives the floor on spikes.
EOF
A=$(run_doctor "$RD15" | grep -E "Rule drift:|Paired sensor coverage:")
B=$(run_doctor "$RD15" | grep -E "Rule drift:|Paired sensor coverage:")
if [ "$A" = "$B" ] && [ -n "$A" ]; then
  ok "case 15: drift+coverage labels are byte-identical across runs"
else
  not_ok "case 15: drift+coverage labels are byte-identical across runs" "A=[$A] B=[$B]"
fi
rm -rf "$RD15"

finish
