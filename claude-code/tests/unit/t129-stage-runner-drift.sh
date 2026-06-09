#!/bin/bash
# t129: stage-runner drift guard (v0.6.0 Wave 3 MR 14). The set of
# `skills/aidlc-<stage>/` runner dirs must be EXACTLY the RUNNABLE compiled
# stage-slug list (the 29 non-initialization stages) — no stage missing its
# runner, no orphan runner for a stage the graph dropped. The bootstrap
# initialization stages ship no per-stage runner (no standalone --single
# meaning); the init phase is packaged as the single /aidlc-init wrapper.
# The 29 runners are GENERATED from the compiled graph (aidlc-runner-gen.ts), so
# without this guard a stage added to the graph would silently ship without a
# runner (or a removed stage would leave a stale runner). Built on the
# set-equality drift-guard discipline of t28 (audit-event sync), t60 (scope
# derivation), and `compile --check` — a deterministic two-source equality check,
# not an LLM judgement.
#
# Asserts: (1) the shipped tree is in sync (the generator's `check` exits 0 and
# the set-equality holds in a pure-bash cross-check independent of the tool);
# (2) the guard CATCHES a missing runner (delete one → check exits 1, names it);
# (3) the guard CATCHES an orphan runner (add a bogus one → check exits 1, names
# it); (4) regenerating restores sync. (7 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
GRAPH="$AIDLC_SRC/tools/aidlc-graph.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 7

# --- Test 1: the SHIPPED runner set == the RUNNABLE compiled stage-slug set ---
# Independent cross-check of the tool: derive the runnable compiled slug set from
# stage-graph.json and the on-disk runner set from skills/aidlc-<slug>/, then
# assert set-equality without trusting aidlc-runner-gen.ts. The bootstrap
# INITIALIZATION stages are EXCLUDED — they have no standalone --single meaning,
# so the generator ships no per-init-stage runner; the whole init phase is
# packaged as the single /aidlc-init wrapper instead (see aidlc-runner-gen.ts
# isRunnableStage + the v0.6.0 Wave-3 CHANGELOG note).
COMPILED=$(bun -e '
  const fs = require("fs");
  const g = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  console.log(g.filter(s => s.phase !== "initialization").map(s => s.slug).sort().join("\n"));
' "$AIDLC_SRC/tools/data/stage-graph.json")

ON_DISK=$(for d in "$AIDLC_SRC/skills"/aidlc-*/; do
  [ -f "$d/SKILL.md" ] || continue
  base=$(basename "$d")
  slug=${base#aidlc-}
  # Keep only dirs whose slug is a RUNNABLE compiled stage slug (excludes the
  # base skills aidlc-replay/-session-cost/-outcomes-pack, the scope-runners, and
  # aidlc-init — none of those are per-stage runners).
  if echo "$COMPILED" | grep -qx "$slug"; then echo "$slug"; fi
done | sort)

assert_eq "$ON_DISK" "$COMPILED" "shipped skills/aidlc-<stage>/ set == compiled stage-slug list"

# --- Test 2: the count is the expected 29 (one per RUNNABLE stage) ---
# 32 compiled stages minus the 3 bootstrap initialization stages
# (workspace-scaffold, workspace-detection, state-init) = 29 stage-runners.
N=$(echo "$COMPILED" | grep -c .)
assert_eq "$N" "29" "the compiled graph has 29 runnable (non-init) stages (one runner each)"

# --- Test 3: the generator's own `check` agrees on the shipped tree ---
set +e
CHECK_OUT=$(bun "$AIDLC_SRC/tools/aidlc-runner-gen.ts" check 2>&1)
CHECK_RC=$?
set -e
if [ $CHECK_RC -eq 0 ]; then
  ok "aidlc-runner-gen check exits 0 on the shipped (in-sync) tree"
else
  not_ok "aidlc-runner-gen check exits 0 on the shipped (in-sync) tree" "rc=$CHECK_RC out=$CHECK_OUT"
fi

# --- Tests 4-5: the guard CATCHES a missing runner (sandbox) ---
# Operate on a sandbox copy of .claude/ so the shipped tree is never mutated.
PROJ=$(setup_integration_project --no-aidlc-docs)
GEN_SANDBOX="$PROJ/.claude/tools/aidlc-runner-gen.ts"
# Pick a stage and delete its runner dir.
VICTIM="aidlc-code-generation"
rm -rf "$PROJ/.claude/skills/$VICTIM"
set +e
MISS_OUT=$(bun "$GEN_SANDBOX" check 2>&1)
MISS_RC=$?
set -e
assert_eq "$MISS_RC" "1" "check exits 1 when a runner is missing"
assert_contains "$MISS_OUT" "MISSING" "check names the missing runner (drift surfaced, not silent)"

# --- Test 6: the guard CATCHES an orphan runner ---
# Restore the missing one, then add a runner for a slug not in the graph.
bun "$GEN_SANDBOX" write >/dev/null 2>&1
# The orphan carries the runner signature (`--stage <slug> --single`) — a
# realistic orphan is a stage-runner left behind after its stage was removed from
# the graph.
mkdir -p "$PROJ/.claude/skills/aidlc-not-a-real-stage"
cat > "$PROJ/.claude/skills/aidlc-not-a-real-stage/SKILL.md" <<'EOF'
---
name: aidlc-not-a-real-stage
description: orphan runner for a stage that does not exist in the graph
---
# orphan

Drives `bun .claude/tools/aidlc-orchestrate.ts next --stage not-a-real-stage --single`.
EOF
set +e
ORPH_OUT=$(bun "$GEN_SANDBOX" check 2>&1)
ORPH_RC=$?
set -e
if [ $ORPH_RC -eq 1 ] && echo "$ORPH_OUT" | grep -q "ORPHAN"; then
  ok "check exits 1 and names an orphan runner (stage dropped from graph)"
else
  not_ok "check exits 1 and names an orphan runner" "rc=$ORPH_RC out=$ORPH_OUT"
fi

# --- Test 7: removing the orphan + regenerating restores sync ---
rm -rf "$PROJ/.claude/skills/aidlc-not-a-real-stage"
bun "$GEN_SANDBOX" write >/dev/null 2>&1
set +e
OK_OUT=$(bun "$GEN_SANDBOX" check 2>&1)
OK_RC=$?
set -e
if [ $OK_RC -eq 0 ]; then
  ok "check returns to exit 0 once the runner set matches the compiled list again"
else
  not_ok "check returns to exit 0 once the runner set matches the compiled list again" "rc=$OK_RC out=$OK_OUT"
fi
cleanup_test_project "$PROJ"

finish
