#!/bin/bash
# t12 (worktree-tier): aidlc-bolt runtime-graph fragment fork/merge
# round-trip + parallel batch + abort-discard (v0.5.0 MR 11). 9
# assertions across three scenarios:
#
# (a) Single-Bolt round-trip — start --worktree creates fragment;
#     mid-Bolt orchestration leaves it on disk; complete --merge removes it
#     and the post-merge runtime-graph stays single-instance (no
#     instances[]) because <2 slugs per L5.
# (b) 3-Bolt parallel batch + deterministic merge ordering — issue 3
#     start --worktree calls for `pay`, `auth`, `cart` in non-alphabetical
#     order; complete --merge in arbitrary user order; main runtime-graph
#     post-merge has instances:[auth, cart, pay] alphabetical regardless.
#     All 3 fragments removed.
# (c) Abort-discard leaves no orphan fragments — abort --discard removes
#     the worktree directory and the fragment transitively (no manual
#     fragment-merge call needed); abort without --discard preserves
#     the worktree + fragment, and a subsequent complete --merge cleans up.
#
# Strategy: real-tool construction per t07 + t48 precedents. Each scenario
# spins up its own fixture via setup_worktree_fixture, seeds main state,
# and drives the full aidlc-worktree create + aidlc-bolt start --worktree
# + aidlc-bolt complete --merge surface.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/worktree-helpers.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 9

WORKTREE_TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"
BOLT_TOOL="$AIDLC_SRC/tools/aidlc-bolt.ts"
RUNTIME_TOOL="$AIDLC_SRC/tools/aidlc-runtime.ts"
STATE_TOOL="$AIDLC_SRC/tools/aidlc-state.ts"

FIXTURES=()
trap '
	for f in "${FIXTURES[@]:-}"; do
		if [ -n "$f" ] && [ -d "$f" ]; then
			chmod -R u+w "$f" 2>/dev/null || true
			cleanup_worktree_fixture "$f" || true
		fi
	done
' EXIT

# Spin up a fixture with: git repo, seeded main state in Construction
# (state-mid-ideation puts us mid-Construction so Bolt-start makes sense),
# empty audit, and the framework gitignore set so worktree create doesn't
# pull audit.md / runtime-graph.json into the worktree via git checkout.
make_bolt_fixture() {
  local fix
  fix=$(setup_worktree_fixture)
  FIXTURES+=("$fix")
  mkdir -p "$fix/aidlc-docs"
  # state-construction has the right phase/scope to allow Bolt operations.
  cp "$FIXTURES_DIR/state-construction.md" "$fix/aidlc-docs/aidlc-state.md"
  # Audit must be present (touched, can be empty).
  printf "# AI-DLC Audit Log\n" >"$fix/aidlc-docs/audit.md"
  # Match framework gitignore so worktree create doesn't byte-copy
  # audit.md / runtime-graph.json into the worktree via git checkout.
  cat >"$fix/.gitignore" <<'EOF'
aidlc-docs/audit.md
aidlc-docs/runtime-graph.json
aidlc-docs/.aidlc-recovery.md
aidlc-docs/.aidlc-hooks-health/
EOF
  (cd "$fix" && git add -A && git -c user.email=t@t -c user.name=t commit -q --amend --no-edit) || true
  echo "$fix"
}

bolt_start_worktree() {
  local proj="$1"
  local slug="$2"
  # aidlc-worktree create checks `git rev-parse --show-toplevel` against
  # cwd (assertNotSiblingWorktree at aidlc-worktree.ts:95-122), so we MUST
  # cd into the fixture before invoking. The helper runs in a subshell so
  # the parent test's cwd is preserved.
  (
    cd "$proj" &&
      bun "$WORKTREE_TOOL" --project-dir "$proj" create --slug "$slug" --base main >/dev/null 2>&1 &&
      bun "$BOLT_TOOL" --project-dir "$proj" start \
        --name "$slug" --batch 1 --walking-skeleton false \
        --worktree --slug "$slug" 2>&1
  )
}

bolt_complete_merge() {
  local proj="$1"
  local slug="$2"
  (
    cd "$proj" &&
      bun "$BOLT_TOOL" --project-dir "$proj" complete \
        --name "$slug" --batch 1 --merge --slug "$slug" 2>&1
  )
}

bolt_abort() {
  local proj="$1"
  local slug="$2"
  local discard="$3" # "" or "--discard"
  (
    cd "$proj" &&
      bun "$BOLT_TOOL" --project-dir "$proj" abort \
        --name "$slug" --reason "test" --slug "$slug" $discard 2>&1
  )
}

wt_fragment() {
  echo "$1/.aidlc/worktrees/bolt-$2/aidlc-docs/runtime-graph.json"
}

# ===================================================================
# Scenario (a) — Single-Bolt round-trip (3 assertions)
# ===================================================================

fixA=$(make_bolt_fixture)

# (a.1) start --worktree creates the fragment, byte-equal main (which is
# absent → empty graph fallback), success-JSON includes RUNTIME_GRAPH_FORKED.
START_OUT=$(bolt_start_worktree "$fixA" "solo")
WT_FRAG=$(wt_fragment "$fixA" "solo")
if echo "$START_OUT" | grep -q "RUNTIME_GRAPH_FORKED" && [ -f "$WT_FRAG" ]; then
  ok "(a.1) start --worktree: fragment exists + success-JSON includes RUNTIME_GRAPH_FORKED"
else
  not_ok "(a.1) single-Bolt start" "out='$START_OUT' fragment exists=$(test -f "$WT_FRAG" && echo Y || echo N)"
fi

# (a.2) complete --merge removes the fragment + success-JSON includes
# RUNTIME_GRAPH_MERGED.
COMP_OUT=$(bolt_complete_merge "$fixA" "solo")
if echo "$COMP_OUT" | grep -q "RUNTIME_GRAPH_MERGED" && [ ! -e "$WT_FRAG" ]; then
  ok "(a.2) complete --merge: fragment removed + success-JSON includes RUNTIME_GRAPH_MERGED"
else
  not_ok "(a.2) single-Bolt complete" "out='$COMP_OUT' fragment exists=$(test -e "$WT_FRAG" && echo Y || echo N)"
fi

# (a.3) Re-compile main runtime-graph; single-Bolt → no instances[].
# (No actual STAGE_STARTED / STAGE_COMPLETED in this fixture so the stage
# row may not even exist — the assertion is "if there's a code-generation
# row, it has no instances[]". Single-Bolt L5 path stays single-instance.)
# Pre-seed WORKFLOW_STARTED + STAGE_STARTED + STAGE_COMPLETED so compile
# has a stage row to inspect. (a.1) + (a.2) already ran the bolt-start +
# bolt-complete dance; the audit now contains the merged Bolt rows but no
# STAGE_* rows, so we synthesize them here. The Bolt's STATE_FORKED row
# pre-dates this STAGE_STARTED, so it falls outside the window AND the
# slugsInWindow.size < 2 check skips single-Bolt anyway.
bun "$AIDLC_SRC/tools/aidlc-audit.ts" --project-dir "$fixA" append WORKFLOW_STARTED \
  --field "Workflow ID=t12-1bolt" --field "Scope=feature" --field "Intent=t12 fixture" >/dev/null 2>&1
bun "$AIDLC_SRC/tools/aidlc-audit.ts" --project-dir "$fixA" append STAGE_STARTED \
  --field "Stage=code-generation" >/dev/null 2>&1
bun "$AIDLC_SRC/tools/aidlc-audit.ts" --project-dir "$fixA" append STAGE_COMPLETED \
  --field "Stage=code-generation" >/dev/null 2>&1
bun "$RUNTIME_TOOL" --project-dir "$fixA" compile >/dev/null 2>&1 || true
HAS_INSTANCES=$(bun -e "
	const fs = require('fs');
	const p = '$fixA/aidlc-docs/runtime-graph.json';
	if (!fs.existsSync(p)) { console.log('false'); process.exit(0); }
	const g = JSON.parse(fs.readFileSync(p, 'utf-8'));
	const cg = g.stages.find(s => s.stage_slug === 'code-generation');
	console.log(Boolean(cg && 'instances' in cg));
")
if [ "$HAS_INSTANCES" = "false" ]; then
  ok "(a.3) Single-Bolt compile: no instances[] on parent (L5 ≥2 threshold)"
else
  not_ok "(a.3) single-Bolt compile" "has_instances=$HAS_INSTANCES"
fi

# ===================================================================
# Scenario (b) — 3-Bolt parallel batch (3 assertions)
# ===================================================================

fixB=$(make_bolt_fixture)

# Inject WORKFLOW_STARTED + STAGE_STARTED for code-generation FIRST, so
# all subsequent STATE_FORKED rows from bolt-start fall WITHIN the stage's
# [started_at, now) window (in real flow these would have been emitted by
# aidlc-utility init + aidlc-state.ts approve before Bolts spawned).
bun "$AIDLC_SRC/tools/aidlc-audit.ts" --project-dir "$fixB" append WORKFLOW_STARTED \
  --field "Workflow ID=t12-3bolt" --field "Scope=feature" --field "Intent=t12 fixture" >/dev/null 2>&1
bun "$AIDLC_SRC/tools/aidlc-audit.ts" --project-dir "$fixB" append STAGE_STARTED \
  --field "Stage=code-generation" >/dev/null 2>&1

# Issue 3 start --worktree calls in non-alphabetical order: pay, auth, cart.
bolt_start_worktree "$fixB" "pay" >/dev/null 2>&1
bolt_start_worktree "$fixB" "auth" >/dev/null 2>&1
bolt_start_worktree "$fixB" "cart" >/dev/null 2>&1

# (b.1) All 3 fragments exist at their respective worktree paths.
F_PAY=$(wt_fragment "$fixB" "pay")
F_AUTH=$(wt_fragment "$fixB" "auth")
F_CART=$(wt_fragment "$fixB" "cart")
if [ -f "$F_PAY" ] && [ -f "$F_AUTH" ] && [ -f "$F_CART" ]; then
  ok "(b.1) 3-Bolt parallel: all fragments exist at <wt>/aidlc-docs/runtime-graph.json"
else
  not_ok "(b.1) 3-Bolt fragments" "pay=$(test -f "$F_PAY" && echo Y || echo N) auth=$(test -f "$F_AUTH" && echo Y || echo N) cart=$(test -f "$F_CART" && echo Y || echo N)"
fi

# Complete in arbitrary user order: cart, pay, auth.
bolt_complete_merge "$fixB" "cart" >/dev/null 2>&1
bolt_complete_merge "$fixB" "pay" >/dev/null 2>&1
bolt_complete_merge "$fixB" "auth" >/dev/null 2>&1

# (b.2) All 3 fragments removed post-merge.
if [ ! -e "$F_PAY" ] && [ ! -e "$F_AUTH" ] && [ ! -e "$F_CART" ]; then
  ok "(b.2) 3-Bolt complete --merge: all fragments removed"
else
  not_ok "(b.2) fragments removed" "pay=$(test -e "$F_PAY" && echo PRESENT || echo GONE) auth=$(test -e "$F_AUTH" && echo PRESENT || echo GONE) cart=$(test -e "$F_CART" && echo PRESENT || echo GONE)"
fi

# (b.3) Main runtime-graph compile shows instances[] alphabetical
# regardless of the user's merge order.
bun "$RUNTIME_TOOL" --project-dir "$fixB" compile >/dev/null 2>&1 || true
INST_SLUGS=$(bun -e "
	const fs = require('fs');
	const p = '$fixB/aidlc-docs/runtime-graph.json';
	if (!fs.existsSync(p)) { console.log('null'); process.exit(0); }
	const g = JSON.parse(fs.readFileSync(p, 'utf-8'));
	const cg = g.stages.find(s => s.stage_slug === 'code-generation');
	if (!cg || !cg.instances) { console.log('null'); process.exit(0); }
	console.log(JSON.stringify(cg.instances.map(i => i.bolt)));
")
if [ "$INST_SLUGS" = '["auth","cart","pay"]' ]; then
  ok "(b.3) 3-Bolt compile: instances[].bolt = [auth, cart, pay] (alphabetical, NOT merge order)"
else
  not_ok "(b.3) instances ordering" "got: $INST_SLUGS"
fi

# ===================================================================
# Scenario (c) — Abort-discard leaves no orphans (3 assertions)
# ===================================================================

fixC=$(make_bolt_fixture)

# (c.1) abort --discard: worktree dir gone + fragment gone transitively.
bolt_start_worktree "$fixC" "doomed" >/dev/null 2>&1
DOOMED_FRAG=$(wt_fragment "$fixC" "doomed")
DOOMED_DIR="$fixC/.aidlc/worktrees/bolt-doomed"
if [ ! -f "$DOOMED_FRAG" ]; then
  not_ok "(c.1) precondition — fragment must exist before abort"
else
  bolt_abort "$fixC" "doomed" "--discard" >/dev/null 2>&1
  if [ ! -e "$DOOMED_DIR" ] && [ ! -e "$DOOMED_FRAG" ]; then
    ok "(c.1) abort --discard: worktree gone + fragment gone transitively (no manual fragment-merge needed)"
  else
    not_ok "(c.1) abort --discard cleanup" "dir exists=$(test -e "$DOOMED_DIR" && echo Y || echo N) fragment exists=$(test -e "$DOOMED_FRAG" && echo Y || echo N)"
  fi
fi

# (c.2) abort without --discard: worktree + fragment preserved.
bolt_start_worktree "$fixC" "kept" >/dev/null 2>&1
KEPT_FRAG=$(wt_fragment "$fixC" "kept")
KEPT_DIR="$fixC/.aidlc/worktrees/bolt-kept"
bolt_abort "$fixC" "kept" "" >/dev/null 2>&1 # no --discard
if [ -e "$KEPT_DIR" ] && [ -f "$KEPT_FRAG" ]; then
  ok "(c.2) abort without --discard: worktree + fragment preserved (halt-and-ask default)"
else
  not_ok "(c.2) abort preservation" "dir=$(test -e "$KEPT_DIR" && echo Y || echo N) fragment=$(test -f "$KEPT_FRAG" && echo Y || echo N)"
fi

# (c.3) Manual aidlc-worktree discard cleans up the orphan fragment
# transitively via git worktree remove (defense-in-depth fallback when
# fragment-merge wasn't called).
(cd "$fixC" && bun "$WORKTREE_TOOL" --project-dir "$fixC" discard --slug kept >/dev/null 2>&1)
if [ ! -e "$KEPT_DIR" ] && [ ! -e "$KEPT_FRAG" ]; then
  ok "(c.3) manual aidlc-worktree discard: fragment removed transitively (defense-in-depth)"
else
  not_ok "(c.3) manual discard" "dir=$(test -e "$KEPT_DIR" && echo Y || echo N) fragment=$(test -e "$KEPT_FRAG" && echo Y || echo N)"
fi
