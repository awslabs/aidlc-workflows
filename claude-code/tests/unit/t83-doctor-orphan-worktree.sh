#!/bin/bash
# t83: Unit tests for v0.4.0 MR 15 doctor reconciliation checks (16 tests).
#
# Covers Checks 1, 3, 4, 6 of MR 15's doctor extensions — the
# orphan-reconciliation family (worktree, state, audit) plus the
# MERGE_DISPATCH advisory. Sibling t84 covers Check 2 (stale branches);
# sibling t85 covers Check 5 (practices staleness).
#
# Slug convention: `--slug <slug>` (e.g. `foo`) names the bare slug; the
# worktree directory is `bolt-<slug>` (e.g. `bolt-foo`); the branch is
# `bolt-<slug>`; main state's `Bolt Refs` stores bare slugs (e.g. `[foo]`).
# Audit blocks may carry either the bare slug or the prefixed `bolt-foo`
# depending on the emitter — t83 fixtures emit bare slugs to match the
# orchestrator-driven path.
#
# Tests:
#   1. Empty `.aidlc/worktrees/` — fail-clean per issue 75 line 215
#   2. Active fork (slug in Bolt Refs + dir exists) — passes orphan check
#   3. Cleanup-orphan (WORKTREE_MERGED + dir persists) — flagged "cleanup-orphan"
#   4. Unmatched orphan (dir exists, no Bolt Refs, no audit row) — flagged "unmatched"
#   5. Orphan state file (slug not in Bolt Refs, no WORKTREE_DISCARDED) — flagged
#   6. Orphan state paired with WORKTREE_DISCARDED — NOT flagged (legit pre-discard)
#   7. Orphan AUDIT_FORKED-without-disk-state — flagged sub-case (a)
#   8. Orphan-delta drift (AUDIT_FORKED, no AUDIT_MERGED, no active, no discard)
#   9. PRACTICES_OVERRIDE Reason=write-failure-* without follow-up AFFIRMED
#  10. PRACTICES_OVERRIDE Reason=bolt-plan-marker-conflict — NOT flagged
#  11. MERGE_DISPATCH_INVOKED orphan past timeout window — advisory pass=true
#
# Regression tests for the post-implementation review fixes:
#  12. Merged-and-cleaned Bolt does NOT flag as AUDIT_FORKED-without-disk
#       (BLOCKER fix: terminal short-circuit runs before disk-existence check)
#  13. Multi-INVOKED pair-matching — 2 INVOKED + 1 RETURNED for same slug
#       reports 1 orphan, NOT 0 (MAJOR fix: each terminal consumed once)
#  14. PRACTICES_OVERRIDE write-failure with ms-precision PRACTICES_AFFIRMED
#       follow-up correctly reconciles via Date.parse (MAJOR fix: not lex
#       string compare — '...123Z' < '...Z' lexicographically)
#  15. Preserved-by-abort sub-classification — slug in Bolt Refs + BOLT_FAILED
#       Reason: aborted reports as separate count, not just "active fork"
#       (MAJOR fix: plan-v3.1 §187 surface)
#  16. Unknown PRACTICES_OVERRIDE Reason value tracked in advisory count
#       (MINOR fix: future Reason variants don't fall through silently)
#
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 16

# Helper: append an audit block with separator.
append_audit() {
  local proj="$1"
  shift
  local body="$*"
  cat >> "$proj/aidlc-docs/audit.md" <<EOF

$body

---
EOF
}

# --- Test 1: Fail-clean on empty `.aidlc/worktrees/` ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Orphan worktrees: 0 observed" && echo "$out" | grep -q "Orphan state files: 0 observed" && echo "$out" | grep -q "Orphan audit: 0 observed"; then
  ok "fail-clean on no-worktrees: all three orphan checks pass with 0 observed"
else
  not_ok "fail-clean on no-worktrees: all three orphan checks pass with 0 observed" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 2: Active fork (slug in Bolt Refs) — not orphan ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
sed_i 's/^- \*\*Bolt Refs\*\*:.*$/- **Bolt Refs**: [activeslug]/' "$PROJ/aidlc-docs/aidlc-state.md"
mkdir -p "$PROJ/.aidlc/worktrees/bolt-activeslug/aidlc-docs"
echo "# stub state" > "$PROJ/.aidlc/worktrees/bolt-activeslug/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Orphan worktrees: 0 \(1 active fork\)" && echo "$out" | grep -qE "Orphan state files: 0 \(1 active\)"; then
  ok "active fork (slug in Bolt Refs) does not flag as orphan"
else
  not_ok "active fork (slug in Bolt Refs) does not flag as orphan" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 3: Cleanup-orphan (WORKTREE_MERGED + dir persists) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
mkdir -p "$PROJ/.aidlc/worktrees/bolt-cleanuptest"
append_audit "$PROJ" "## Worktree Merged
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: WORKTREE_MERGED
**Bolt slug**: cleanuptest
**Worktree path**: /tmp/bolt-cleanuptest
**Target branch**: main
**Strategy**: squash"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "cleanup-orphan" && echo "$out" | grep -q "cleanuptest"; then
  ok "cleanup-orphan classification (WORKTREE_MERGED + dir persists)"
else
  not_ok "cleanup-orphan classification (WORKTREE_MERGED + dir persists)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Unmatched orphan (dir exists, no Bolt Refs, no audit row) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
mkdir -p "$PROJ/.aidlc/worktrees/bolt-orphanunmatched"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "unmatched" && echo "$out" | grep -q "orphanunmatched"; then
  ok "unmatched orphan classification (no Bolt Refs, no audit row)"
else
  not_ok "unmatched orphan classification (no Bolt Refs, no audit row)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 5: Orphan state file (state present, no Bolt Refs, no DISCARDED) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
mkdir -p "$PROJ/.aidlc/worktrees/bolt-orphanstate/aidlc-docs"
echo "# state" > "$PROJ/.aidlc/worktrees/bolt-orphanstate/aidlc-docs/aidlc-state.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Orphan state files: 1 drift" && echo "$out" | grep -q "orphanstate"; then
  ok "orphan state file flagged when slug not in Bolt Refs and no DISCARDED row"
else
  not_ok "orphan state file flagged when slug not in Bolt Refs and no DISCARDED row" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 6: Orphan state file paired with WORKTREE_DISCARDED — NOT flagged ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
mkdir -p "$PROJ/.aidlc/worktrees/bolt-discardedstate/aidlc-docs"
echo "# state" > "$PROJ/.aidlc/worktrees/bolt-discardedstate/aidlc-docs/aidlc-state.md"
append_audit "$PROJ" "## Worktree Discarded
**Timestamp**: 2026-05-19T11:00:00Z
**Event**: WORKTREE_DISCARDED
**Bolt slug**: discardedstate
**Worktree path**: /tmp/bolt-discardedstate
**Reason**: user-discard"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Orphan state files: 0 \(1 active\)"; then
  ok "orphan state paired with WORKTREE_DISCARDED is not flagged (legit pre-discard)"
else
  not_ok "orphan state paired with WORKTREE_DISCARDED is not flagged (legit pre-discard)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 7: AUDIT_FORKED-without-disk-state — flagged sub-case (a) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# AUDIT_FORKED but no .aidlc/worktrees/bolt-noaudit/aidlc-docs/audit.md
append_audit "$PROJ" "## Audit Forked
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: AUDIT_FORKED
**Bolt slug**: noaudit
**Source Audit Hash**: dummy
**Fork Boundary**: 0"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "AUDIT_FORKED-without-disk" && echo "$out" | grep -q "noaudit"; then
  ok "AUDIT_FORKED-without-disk-state flagged (sub-case a)"
else
  not_ok "AUDIT_FORKED-without-disk-state flagged (sub-case a)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 8: Orphan-delta drift (AUDIT_FORKED, no AUDIT_MERGED, no DISCARDED) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# Disk audit present (passes sub-case a) but no AUDIT_MERGED and slug not in
# Bolt Refs and no WORKTREE_DISCARDED → sub-case (b).
mkdir -p "$PROJ/.aidlc/worktrees/bolt-deltatest/aidlc-docs"
echo "# wt audit" > "$PROJ/.aidlc/worktrees/bolt-deltatest/aidlc-docs/audit.md"
append_audit "$PROJ" "## Audit Forked
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: AUDIT_FORKED
**Bolt slug**: deltatest
**Source Audit Hash**: dummy
**Fork Boundary**: 0"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "orphan-delta" && echo "$out" | grep -q "deltatest"; then
  ok "orphan-delta drift flagged (sub-case b: no AUDIT_MERGED, no active, no discard)"
else
  not_ok "orphan-delta drift flagged (sub-case b: no AUDIT_MERGED, no active, no discard)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 9: PRACTICES_OVERRIDE write-failure without follow-up AFFIRMED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
append_audit "$PROJ" "## Practices Override
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: PRACTICES_OVERRIDE
**Reason**: write-failure-permission
**Failure detail**: chmod denied"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "PRACTICES_OVERRIDE write-failure" && echo "$out" | grep -q "without follow-up PRACTICES_AFFIRMED"; then
  ok "PRACTICES_OVERRIDE write-failure-* without follow-up AFFIRMED is flagged"
else
  not_ok "PRACTICES_OVERRIDE write-failure-* without follow-up AFFIRMED is flagged" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 10: PRACTICES_OVERRIDE bolt-plan-marker-conflict — NOT flagged ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
append_audit "$PROJ" "## Practices Override
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: PRACTICES_OVERRIDE
**Reason**: bolt-plan-marker-conflict
**Bolt slug**: foo
**Practices Stance**: always-skeleton
**Bolt-Plan Marker**: skeleton-off"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Orphan audit: 0( |\$)"; then
  ok "PRACTICES_OVERRIDE bolt-plan-marker-conflict is expected (not flagged)"
else
  not_ok "PRACTICES_OVERRIDE bolt-plan-marker-conflict is expected (not flagged)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 11: MERGE_DISPATCH_INVOKED orphan (advisory pass=true) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# Pre-2026 timestamp ensures it's well outside the 60s timeout window.
append_audit "$PROJ" "## Merge Dispatch Invoked
**Timestamp**: 2024-01-01T00:00:00Z
**Event**: MERGE_DISPATCH_INVOKED
**Bolt slug**: mergedispatchtest
**Practices excerpt**: trunk-based"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "MERGE_DISPATCH: 1 orphan INVOKED" && echo "$out" | grep -q "advisory"; then
  ok "MERGE_DISPATCH_INVOKED orphan is advisory (pass=true with advisory label)"
else
  not_ok "MERGE_DISPATCH_INVOKED orphan is advisory (pass=true with advisory label)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 12: Merged-and-cleaned Bolt does NOT flag as orphan ---
# Regression for BLOCKER fix: pre-fix Check 4(a) tested existsSync(wtAudit)
# before the AUDIT_MERGED short-circuit, so any historical AUDIT_FORKED whose
# worktree was cleaned up after a successful merge got pushed to orphan list
# forever. Fix: hoist the AUDIT_MERGED / WORKTREE_DISCARDED / boltRefs
# short-circuits ahead of the disk check.
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# Full merge cycle: AUDIT_FORKED + AUDIT_MERGED + WORKTREE_MERGED, dir gone.
append_audit "$PROJ" "## Audit Forked
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: AUDIT_FORKED
**Bolt slug**: cleanmerge
**Source Audit Hash**: dummy
**Fork Boundary**: 0"
append_audit "$PROJ" "## Audit Merged
**Timestamp**: 2026-05-19T11:00:00Z
**Event**: AUDIT_MERGED
**Bolt slug**: cleanmerge
**Entries Merged**: 5
**Source Audit Hash**: dummy
**Fork Boundary**: 0"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Orphan audit: 0 \(1 reconciled\)" && ! echo "$out" | grep -q "AUDIT_FORKED-without-disk"; then
  ok "merged-and-cleaned Bolt does not flag as orphan (BLOCKER regression)"
else
  not_ok "merged-and-cleaned Bolt does not flag as orphan (BLOCKER regression)" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 13: Multi-INVOKED pair-matching ---
# Regression for MAJOR fix: 2 INVOKED + 1 RETURNED for same slug must report
# 1 orphan (each terminal pairs with one preceding INVOKED), not 0.
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
append_audit "$PROJ" "## Merge Dispatch Invoked
**Timestamp**: 2024-01-01T00:00:00Z
**Event**: MERGE_DISPATCH_INVOKED
**Bolt slug**: pair
**Practices excerpt**: trunk-based"
append_audit "$PROJ" "## Merge Dispatch Invoked
**Timestamp**: 2024-01-01T00:01:00Z
**Event**: MERGE_DISPATCH_INVOKED
**Bolt slug**: pair
**Practices excerpt**: trunk-based"
append_audit "$PROJ" "## Merge Dispatch Returned
**Timestamp**: 2024-01-01T00:02:00Z
**Event**: MERGE_DISPATCH_RETURNED
**Bolt slug**: pair
**Strategy**: squash
**Target**: main
**Confidence**: 0.9
**Notes**: ok"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "MERGE_DISPATCH: 1 orphan INVOKED"; then
  ok "multi-INVOKED pair-matching: 2 INVOKED + 1 RETURNED reports 1 orphan"
else
  not_ok "multi-INVOKED pair-matching: 2 INVOKED + 1 RETURNED reports 1 orphan" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 14: PRACTICES_OVERRIDE ms-precision AFFIRMED reconciles ---
# Regression for MAJOR fix: pre-fix used a.timestamp > overrideTs as string
# compare on ISO 8601 — '...123Z' < '...Z' lexicographically (`.` 0x2E < `Z`
# 0x5A), so a millisecond-precision PRACTICES_AFFIRMED right after a
# seconds-precision write-failure-* OVERRIDE would flag as orphan. Fix:
# Date.parse() ms comparison.
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
append_audit "$PROJ" "## Practices Override
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: PRACTICES_OVERRIDE
**Reason**: write-failure-permission
**Failure detail**: chmod denied"
append_audit "$PROJ" "## Practices Affirmed
**Timestamp**: 2026-05-19T10:00:00.123Z
**Event**: PRACTICES_AFFIRMED
**Bolt slug**: foo
**Practices Stance**: trunk-based"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Orphan audit: 0 \(1 reconciled\)" && ! echo "$out" | grep -q "without follow-up"; then
  ok "ms-precision PRACTICES_AFFIRMED reconciles seconds-precision OVERRIDE"
else
  not_ok "ms-precision PRACTICES_AFFIRMED reconciles seconds-precision OVERRIDE" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 15: Preserved-by-abort sub-classification ---
# Regression for plan-v3.1 §187: slug in Bolt Refs + BOLT_FAILED Reason: aborted
# is multi-failure abort awaiting /aidlc --resume; report separately from
# active forks so doctor output distinguishes "in flight" from "awaiting resume".
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
sed_i 's/^- \*\*Bolt Refs\*\*:.*$/- **Bolt Refs**: [aborted, active]/' "$PROJ/aidlc-docs/aidlc-state.md"
mkdir -p "$PROJ/.aidlc/worktrees/bolt-aborted"
mkdir -p "$PROJ/.aidlc/worktrees/bolt-active"
append_audit "$PROJ" "## Bolt Failed
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: BOLT_FAILED
**Failed Bolt**: my-bolt
**Bolt slug**: aborted
**Error summary**: aborted: user halted at AUQ 1 of 2
**Reason**: aborted"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "preserved-by-abort" && echo "$out" | grep -q "active fork"; then
  ok "preserved-by-abort sub-classification distinguishes from active forks"
else
  not_ok "preserved-by-abort sub-classification distinguishes from active forks" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 16: Unknown PRACTICES_OVERRIDE Reason tracked in advisory ---
# Regression for MINOR fix: future Reason variants (neither write-failure-* nor
# bolt-plan-marker-conflict) used to fall through silently; now reported in the
# advisory count so v0.5.0+ reconciliation has a surface.
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
append_audit "$PROJ" "## Practices Override
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: PRACTICES_OVERRIDE
**Reason**: future-variant-not-yet-routed
**Some Field**: value"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "unknown Reason" && echo "$out" | grep -q "track for follow-up"; then
  ok "unknown PRACTICES_OVERRIDE Reason value surfaces as advisory"
else
  not_ok "unknown PRACTICES_OVERRIDE Reason value surfaces as advisory" "got:\n$out"
fi
cleanup_test_project "$PROJ"

finish
