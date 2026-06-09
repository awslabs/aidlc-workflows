#!/bin/bash
# t49: Integration test — Bolt fork/merge for runtime-graph + parallel
# instances[] + failure-mode coverage (v0.5.0 MR 11).
#
# Drives full real-tool flows: aidlc-worktree create + aidlc-bolt start
# --worktree + sensor fire + aidlc-bolt complete --merge + aidlc-runtime
# compile. Uses the in-process tool surface (not Claude Code hooks), so
# sensor firing is invoked manually via aidlc-sensor.ts fire to simulate
# what the MR 10 PostToolUse hook would have done.
#
# Tier: L2 integration. Uses real tools end-to-end; no static audit fixtures.
#
# Cases (8 total):
#   1-3. End-to-end 3-Bolt batch with mid-stage sensor failure on `pay`:
#        all 3 complete; main runtime-graph has instances[auth, cart, pay]
#        all approved (sensors are advisory; SENSOR_FAILED ≠ Bolt failure);
#        SENSOR_FAILED row appears in main audit post-merge but NOT in
#        instances[].sensor_firings (per MR 11 contract — that array stays
#        [] until the parent populator that owns sensor attribution lands).
#   4. Bolt failure rollup: pay aborts mid-Bolt; instances[] reflects
#      [auth, cart] approved; pay absent (worktree discarded).
#   5. Idempotent re-merge: second `complete --merge` for same slug fails
#      cleanly via state-merge "already merged" before fragment-merge runs.
#   6. Audit-merge fails before fragment-merge: AIDLC_AUDIT_LOCK_RETRIES=1
#      + planted lock surfaces failure at audit-merge step; fragment file
#      remains in worktree (no fragment-merge); recovery via re-issue.
#   7. Fragment-merge fails after audit-merge succeeds (soft-gap closure):
#      simulate fragment-merge failure via chmod 0444 on the fragment
#      AFTER audit-merge has landed; assert BOLT_FAILED row appears with
#      reason fragment-merge-failed; subsequent compile against main
#      produces a coherent runtime-graph (the BOLT_FAILED at this position
#      doesn't corrupt instances[] because STATE_MERGED is already there
#      → instance scored "approved").
#   8. Determinism under failure mix: re-compile after the chaos still
#      produces byte-equivalent output (L11 holds even with BOLT_FAILED
#      sprinkled in).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 8

WORKTREE_TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"
BOLT_TOOL="$AIDLC_SRC/tools/aidlc-bolt.ts"
RUNTIME_TOOL="$AIDLC_SRC/tools/aidlc-runtime.ts"
AUDIT_TOOL="$AIDLC_SRC/tools/aidlc-audit.ts"

FIXTURES=()
trap '
	for f in "${FIXTURES[@]:-}"; do
		if [ -n "$f" ] && [ -d "$f" ]; then
			chmod -R u+w "$f" 2>/dev/null || true
			rm -rf "$f" 2>/dev/null || true
		fi
	done
' EXIT INT TERM

# Build a clean git-init'd project with seeded state + empty audit + the
# framework gitignore. Returns project root on stdout. Each project is
# independent; we don't reuse across cases to keep failure isolation tight.
make_proj() {
  local proj
  proj=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-t49-XXXXXX")
  proj=$(cd "$proj" && pwd -P)
  FIXTURES+=("$proj")
  (
    cd "$proj"
    git init -q
    git symbolic-ref HEAD refs/heads/main
    echo seed >README.md
    mkdir -p aidlc-docs
    cp "$REPO_ROOT/tests/fixtures/state-construction.md" aidlc-docs/aidlc-state.md
    : >aidlc-docs/audit.md
    cat >.gitignore <<'EOF'
aidlc-docs/audit.md
aidlc-docs/runtime-graph.json
aidlc-docs/.aidlc-recovery.md
aidlc-docs/.aidlc-hooks-health/
EOF
    git add -A
    git -c user.email=t@t -c user.name=t commit -qm init
  ) >/dev/null 2>&1
  # Seed WORKFLOW_STARTED + STAGE_STARTED for code-generation so the
  # compile populator has a window to detect parallel-Bolt rows in.
  bun "$AUDIT_TOOL" --project-dir "$proj" append WORKFLOW_STARTED \
    --field "Workflow ID=t49-${RANDOM}" --field "Scope=feature" --field "Intent=t49" >/dev/null 2>&1
  bun "$AUDIT_TOOL" --project-dir "$proj" append STAGE_STARTED \
    --field "Stage=code-generation" >/dev/null 2>&1
  echo "$proj"
}

# Helpers that cd into the project (assertNotSiblingWorktree at
# aidlc-worktree.ts:95-122 checks `git rev-parse --show-toplevel` against
# cwd, NOT against --project-dir; running from the test's cwd would
# trigger the sibling-worktree refusal).
wt_create() {
  (cd "$1" && bun "$WORKTREE_TOOL" --project-dir "$1" create --slug "$2" --base main 2>&1)
}
wt_discard() {
  (cd "$1" && bun "$WORKTREE_TOOL" --project-dir "$1" discard --slug "$2" 2>&1)
}
bolt_start() {
  (cd "$1" && bun "$BOLT_TOOL" --project-dir "$1" start \
    --name "$2" --batch 1 --walking-skeleton false --worktree --slug "$2" 2>&1)
}
bolt_complete() {
  (cd "$1" && bun "$BOLT_TOOL" --project-dir "$1" complete \
    --name "$2" --batch 1 --merge --slug "$2" 2>&1)
}
bolt_abort() {
  local proj="$1"
  local slug="$2"
  local discard="${3:-}"
  (cd "$proj" && bun "$BOLT_TOOL" --project-dir "$proj" abort \
    --name "$slug" --reason "test" --slug "$slug" $discard 2>&1)
}
runtime_compile() {
  (cd "$1" && bun "$RUNTIME_TOOL" --project-dir "$1" compile 2>&1)
}

frag_path() {
  echo "$1/.aidlc/worktrees/bolt-$2/aidlc-docs/runtime-graph.json"
}

graph_query() {
  bun -e "
		const fs = require('fs');
		const p = '$1/aidlc-docs/runtime-graph.json';
		if (!fs.existsSync(p)) { console.log('null'); process.exit(0); }
		const g = JSON.parse(fs.readFileSync(p, 'utf-8'));
		console.log(JSON.stringify($2));
	" 2>&1
}

# ===================================================================
# Cases 1-3 — End-to-end 3-Bolt batch with sensor failure on `pay`
# ===================================================================

PROJ=$(make_proj)
for slug in pay auth cart; do
  wt_create "$PROJ" "$slug" >/dev/null 2>&1
  bolt_start "$PROJ" "$slug" >/dev/null 2>&1
done

# Inside pay's worktree, simulate what the MR 10 hook + MR 9 dispatcher
# would have written to the worktree audit on a sensor failure: a
# SENSOR_FIRED row paired with a SENSOR_FAILED row. Direct-append is more
# deterministic than running a live sensor (which may pass/fail based on
# transient inputs); the goal here is to verify the audit-merge + compile
# pipeline propagates pre-existing SENSOR_* rows correctly, NOT to verify
# any individual sensor's predicate.
PAY_WT="$PROJ/.aidlc/worktrees/bolt-pay"
mkdir -p "$PAY_WT/aidlc-docs"
(cd "$PAY_WT" && bun "$AUDIT_TOOL" --project-dir "$PAY_WT" append SENSOR_FIRED \
  --field "Sensor" "required-sections" \
  --field "Stage" "code-generation" \
  --field "Output path" "aidlc-docs/some-output.md" \
  --field "Bolt slug" "pay" >/dev/null 2>&1) || true
(cd "$PAY_WT" && bun "$AUDIT_TOOL" --project-dir "$PAY_WT" append SENSOR_FAILED \
  --field "Sensor" "required-sections" \
  --field "Stage" "code-generation" \
  --field "Output path" "aidlc-docs/some-output.md" \
  --field "Detail path" "aidlc-docs/.aidlc-sensors/required-sections-fail.txt" \
  --field "Bolt slug" "pay" >/dev/null 2>&1) || true

# Complete all 3 Bolts in arbitrary order.
bolt_complete "$PROJ" "cart" >/dev/null 2>&1
bolt_complete "$PROJ" "pay" >/dev/null 2>&1
bolt_complete "$PROJ" "auth" >/dev/null 2>&1

runtime_compile "$PROJ" >/dev/null 2>&1 || true

# (1) instances[].length=3, alphabetical
INST_SLUGS=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.instances?.map(i=>i.bolt) ?? null")
if [ "$INST_SLUGS" = '["auth","cart","pay"]' ]; then
  ok "(1) 3-Bolt parallel batch: instances[].length=3, alphabetical-by-slug"
else
  not_ok "(1) instances ordering" "got: $INST_SLUGS"
fi

# (2) Sensors are advisory: SENSOR_FAILED in audit but all 3 instances
# still outcome:approved (sensor failure ≠ Bolt failure).
ALL_APPROVED=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.instances?.every(i=>i.outcome==='approved') ?? false")
SF_IN_MAIN=$(grep -c "Event\*\*: SENSOR_FAILED" "$PROJ/aidlc-docs/audit.md" 2>/dev/null || true)
SF_IN_MAIN=${SF_IN_MAIN:-0}
if [ "$ALL_APPROVED" = "true" ] && [ "$SF_IN_MAIN" -ge 1 ]; then
  ok "(2) Sensors advisory: SENSOR_FAILED in main audit ($SF_IN_MAIN row(s)) but all 3 instances outcome:approved"
else
  not_ok "(2) sensor advisory contract" "all_approved=$ALL_APPROVED sensor_failed_count=$SF_IN_MAIN"
fi

# (3) MR 11 contract: instances[].sensor_firings is [] even when audit has
# SENSOR_* rows whose Output path falls under the worktree.
SF_PER_INSTANCE_EMPTY=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.instances?.every(i=>Array.isArray(i.sensor_firings) && i.sensor_firings.length===0) ?? false")
if [ "$SF_PER_INSTANCE_EMPTY" = "true" ]; then
  ok "(3) MR 11 contract: instances[].sensor_firings:[] even with SENSOR_FAILED in main audit (forward-noted; per-instance attribution lands later)"
else
  not_ok "(3) per-instance sensor_firings contract" "$SF_PER_INSTANCE_EMPTY"
fi

# ===================================================================
# Case 4 — Bolt failure rollup: pay aborts mid-Bolt
# ===================================================================

PROJ=$(make_proj)
for slug in auth cart pay; do
  wt_create "$PROJ" "$slug" >/dev/null 2>&1
  bolt_start "$PROJ" "$slug" >/dev/null 2>&1
done
bolt_complete "$PROJ" "auth" >/dev/null 2>&1
bolt_complete "$PROJ" "cart" >/dev/null 2>&1
bolt_abort "$PROJ" "pay" "--discard" >/dev/null 2>&1

runtime_compile "$PROJ" >/dev/null 2>&1 || true

INST_SLUGS=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.instances?.map(i=>i.bolt) ?? null")
PARENT_OUTCOME=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.outcome")
# pay had STATE_FORKED + BOLT_FAILED but no STATE_MERGED — outcome:failed
# per the populator's rule (BOLT_FAILED for slug → "failed"). So instances
# should include all 3 with pay:failed and parent:failed.
PAY_OUT=$(graph_query "$PROJ" "g.stages.find(s=>s.stage_slug==='code-generation')?.instances?.find(i=>i.bolt==='pay')?.outcome")
if [ "$INST_SLUGS" = '["auth","cart","pay"]' ] && [ "$PARENT_OUTCOME" = "\"failed\"" ] && [ "$PAY_OUT" = "\"failed\"" ]; then
  ok "(4) Bolt failure rollup: pay BOLT_FAILED + abort --discard → instance pay:failed + parent:failed"
else
  not_ok "(4) Bolt failure rollup" "slugs=$INST_SLUGS parent=$PARENT_OUTCOME pay=$PAY_OUT"
fi

# ===================================================================
# Case 5 — Idempotent re-merge: second complete --merge errors at state-merge
# ===================================================================

PROJ=$(make_proj)
wt_create "$PROJ" "solo" >/dev/null 2>&1
bolt_start "$PROJ" "solo" >/dev/null 2>&1
bolt_complete "$PROJ" "solo" >/dev/null 2>&1            # first merge succeeds
SECOND_OUT=$(bolt_complete "$PROJ" "solo" 2>&1 || true) # second errors
if echo "$SECOND_OUT" | grep -q "already merged" &&
  echo "$SECOND_OUT" | grep -q "state-merge-failed"; then
  ok "(5) Idempotent re-merge: second complete --merge errors at state-merge with 'already merged' (fragment-merge never reached)"
else
  not_ok "(5) idempotent re-merge" "out: $SECOND_OUT"
fi

# ===================================================================
# Case 6 — Audit-merge fails before fragment-merge (lock-acquire failure)
# ===================================================================

PROJ=$(make_proj)
wt_create "$PROJ" "solo" >/dev/null 2>&1
bolt_start "$PROJ" "solo" >/dev/null 2>&1

# Compute the lock-dir path the same way aidlc-lib.ts:auditLockDir does:
# md5(projectDir) | head -8 hex chars, prefixed with `.aidlc-audit-`,
# under TMPDIR. The lock is a DIRECTORY (mkdirSync atomicity), not a file.
LOCK_HASH=$(echo -n "$PROJ" | bun -e "
	const c = require('crypto');
	const d = require('fs').readFileSync(0, 'utf-8');
	process.stdout.write(c.createHash('md5').update(d).digest('hex').slice(0, 8));
")
LOCK_DIR="${TMPDIR:-/tmp}/.aidlc-audit-${LOCK_HASH}.lock"
mkdir -p "$LOCK_DIR"

# Invoke complete --merge with retry budget=1. The first lock-needing tool
# in handleComplete is state-merge (line 328) — it'll retry once and fail.
# fragment-merge sits AFTER audit-merge in the chain so it never runs.
COMP_OUT=$(AIDLC_AUDIT_LOCK_RETRIES=1 bolt_complete "$PROJ" "solo" 2>&1 || true)
rmdir "$LOCK_DIR" 2>/dev/null || true

# Expect failure + fragment file still present.
WT_FRAG=$(frag_path "$PROJ" "solo")
if echo "$COMP_OUT" | grep -qE "(state-merge-failed|audit-merge-failed|audit-emit-failed|Failed to acquire audit lock)" && [ -f "$WT_FRAG" ]; then
  ok "(6) Lock-acquire failure: complete --merge errors before fragment-merge; fragment file still present (recovery: retry)"
else
  not_ok "(6) lock-acquire failure ordering" "out: $COMP_OUT fragment exists=$(test -f "$WT_FRAG" && echo Y || echo N)"
fi

# ===================================================================
# Case 7 — Fragment-merge fails after audit-merge succeeds (soft-gap)
# ===================================================================

PROJ=$(make_proj)
wt_create "$PROJ" "solo" >/dev/null 2>&1
bolt_start "$PROJ" "solo" >/dev/null 2>&1

# Make the fragment unwritable + replace with a directory so unlinkSync
# can't remove it. Replacing the path with a directory is the most reliable
# way to make unlinkSync fail (chmod alone doesn't always block unlink on
# macOS APFS when the parent dir is writable). Save fragment content first
# so we don't lose it.
WT_FRAG=$(frag_path "$PROJ" "solo")
mv "$WT_FRAG" "$WT_FRAG.bak"
mkdir "$WT_FRAG" # path is now a directory → unlinkSync fails with EISDIR

COMP_OUT=$(bolt_complete "$PROJ" "solo" 2>&1 || true)

# Audit-merge should have succeeded BEFORE fragment-merge tried; the
# audit row sequence in main should be:
#   BOLT_COMPLETED → STATE_MERGED → AUDIT_MERGED → BOLT_FAILED (reason: fragment-merge-failed)
HAS_AUDIT_MERGED=$(grep -c "Event\*\*: AUDIT_MERGED" "$PROJ/aidlc-docs/audit.md" 2>/dev/null || true)
HAS_AUDIT_MERGED=${HAS_AUDIT_MERGED:-0}
HAS_FRAGMENT_FAILED=$(grep -B 5 "fragment-merge-failed" "$PROJ/aidlc-docs/audit.md" 2>/dev/null | grep -c "Event\*\*: BOLT_FAILED" 2>/dev/null || true)
HAS_FRAGMENT_FAILED=${HAS_FRAGMENT_FAILED:-0}
if echo "$COMP_OUT" | grep -q "fragment-merge-failed" &&
  [ "$HAS_AUDIT_MERGED" -ge 1 ] && [ "$HAS_FRAGMENT_FAILED" -ge 1 ]; then
  # Cleanup the directory-as-fragment so subsequent compile + cleanup work.
  rm -rf "$WT_FRAG"
  mv "$WT_FRAG.bak" "$WT_FRAG" 2>/dev/null || true
  ok "(7) Soft-gap closure: fragment-merge fails after audit-merge succeeds → BOLT_COMPLETED→STATE_MERGED→AUDIT_MERGED→BOLT_FAILED partial-success signature"
else
  not_ok "(7) fragment-merge-fails-after-audit-merge" "out: $COMP_OUT audit_merged=$HAS_AUDIT_MERGED fragment_failed=$HAS_FRAGMENT_FAILED"
  rm -rf "$WT_FRAG" 2>/dev/null
  mv "$WT_FRAG.bak" "$WT_FRAG" 2>/dev/null || true
fi

# ===================================================================
# Case 8 — Determinism: subsequent compile produces byte-equivalent output
# ===================================================================

# Re-use case 7's project (already mutated). Fragment has been restored;
# simulate the implicit defense-in-depth cleanup by removing it (mirrors
# what `aidlc-worktree merge` would do via `git worktree remove`).
rm -f "$WT_FRAG" 2>/dev/null
runtime_compile "$PROJ" >/dev/null 2>&1 || true
SHA1=$(shasum -a 256 "$PROJ/aidlc-docs/runtime-graph.json" 2>/dev/null | awk '{print $1}')
runtime_compile "$PROJ" >/dev/null 2>&1 || true
SHA2=$(shasum -a 256 "$PROJ/aidlc-docs/runtime-graph.json" 2>/dev/null | awk '{print $1}')
if [ -n "$SHA1" ] && [ "$SHA1" = "$SHA2" ]; then
  ok "(8) Determinism (L11): re-compile after BOLT_FAILED + recovery still produces byte-equivalent runtime-graph.json"
else
  not_ok "(8) determinism under failure mix" "sha1=$SHA1 sha2=$SHA2"
fi
