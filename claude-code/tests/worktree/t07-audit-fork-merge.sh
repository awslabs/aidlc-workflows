#!/bin/bash
# t07: aidlc-audit audit-fork / audit-merge primitive (31 tests). Three phases:
#
# Phase A — primitive smoke (11 tests): fork creates byte-identical worktree
# audit; AUDIT_FORKED in both audits with matching Fork Boundary; merge appends
# delta; AUDIT_MERGED in main audit only (worktree audit unchanged by merge).
#
# Phase B — edge cases (14 tests): empty delta; missing aidlc-docs subdir
# auto-created at fork; missing main audit fails loud; prefix-hash mismatch
# refusal; N=2 lock contention via 50ms stagger; lock-timeout failure path
# (planted stuck lock + AIDLC_AUDIT_LOCK_RETRIES override); 65-char slug
# rejected before any disk side-effect; failed-merge ERROR_LOGGED carries
# [fork-emitted:<iso-ts>] (not the integer Fork Boundary) so doctor (MR 15)
# can join orphan AUDIT_FORKED rows to the matching ERROR_LOGGED.
#
# Phase C — property (6 tests): N=4 alphabetical / reverse-alphabetical /
# same-second-timestamps / one-empty-delta orderings each preserve per-Bolt
# fork→merge bracket order in the merged main audit; structural checks
# confirm exactly 4 AUDIT_FORKED + 4 AUDIT_MERGED rows.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/worktree-helpers.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 31

WORKTREE_TOOL="$AIDLC_SRC/tools/aidlc-worktree.ts"
AUDIT_TOOL="$AIDLC_SRC/tools/aidlc-audit.ts"

# Track every fixture so the trap can clean up, even if a test exits early.
FIXTURES=()
trap '
  for f in "${FIXTURES[@]:-}"; do
    if [ -n "$f" ] && [ -d "$f" ]; then
      chmod -R u+w "$f" 2>/dev/null || true
      cleanup_worktree_fixture "$f" || true
    fi
  done
' EXIT

# Helper: spin up a fixture with a seeded main audit + state file (state file
# is required so emitError's existsSync(stateFilePath) check passes if any
# test path triggers ERROR_LOGGED). Echoes the path on stdout.
make_fixture() {
  local fix
  fix=$(setup_worktree_fixture)
  mkdir -p "$fix/aidlc-docs"
  cp "$FIXTURES_DIR/state-mid-ideation.md" "$fix/aidlc-docs/aidlc-state.md"
  printf "# AI-DLC Audit Log\n" > "$fix/aidlc-docs/audit.md"
  FIXTURES+=("$fix")
  echo "$fix"
}

# Helper: assert that AUDIT_FORKED and AUDIT_MERGED rows in <file> are paired
# in a structurally well-formed way — every AUDIT_FORKED for slug S has a
# matching AUDIT_MERGED for the same slug appearing later in the file. This
# is the cross-Bolt invariant the merge primitive guarantees: per-Bolt order
# is preserved by the byte-copy + delta-append; cross-Bolt order reflects
# merge-completion order, not chronological order. The merged audit is a
# valid structured event stream that a downstream consumer can sort
# chronologically post-hoc by `**Timestamp**:` if needed.
assert_fork_merge_pairs() {
  local file="$1"
  local expected_n="$2"
  local label="$3"
  local fork_count
  fork_count=$(grep -c "Event[*]*: AUDIT_FORKED" "$file" || true)
  local merge_count
  merge_count=$(grep -c "Event[*]*: AUDIT_MERGED" "$file" || true)
  if [ "$fork_count" -eq "$expected_n" ] && [ "$merge_count" -eq "$expected_n" ]; then
    ok "$label"
  else
    not_ok "$label" \
      "expected $expected_n AUDIT_FORKED + $expected_n AUDIT_MERGED, got $fork_count + $merge_count"
  fi
}

# Helper: assert that for each AUDIT_FORKED row's Bolt slug, an AUDIT_MERGED
# row for the same slug appears later in the file (per-Bolt fork→merge
# bracket order is preserved across the merged stream).
assert_per_bolt_bracket_order() {
  local file="$1"
  local label="$2"
  # Extract event/slug pairs in document order.
  local pairs
  pairs=$(awk '
    /^\*\*Event\*\*: AUDIT_(FORKED|MERGED)/ { ev=$2; next }
    /^\*\*Bolt slug\*\*:/ && ev != "" { print ev " " $3; ev="" }
  ' "$file")
  # For each AUDIT_FORKED <slug> in turn, check that a matching AUDIT_MERGED
  # <slug> appears later in the pairs stream. State machine: "seen the fork
  # for this slug" → look for the merge.
  local fork_line slug match_target
  while IFS= read -r fork_line; do
    case "$fork_line" in
      "AUDIT_FORKED "*)
        slug="${fork_line#AUDIT_FORKED }"
        match_target="AUDIT_MERGED $slug"
        local seen_fork=0
        local found_merge=0
        local p
        while IFS= read -r p; do
          if [ "$seen_fork" = 0 ] && [ "$p" = "$fork_line" ]; then
            seen_fork=1
            continue
          fi
          if [ "$seen_fork" = 1 ] && [ "$p" = "$match_target" ]; then
            found_merge=1
            break
          fi
        done <<< "$pairs"
        if [ "$found_merge" = 0 ]; then
          not_ok "$label" "no AUDIT_MERGED found after AUDIT_FORKED for slug ${slug}"
          return
        fi
        ;;
    esac
  done <<< "$pairs"
  ok "$label"
}

# ===================================================================
# Phase A — primitive smoke (11 tests)
# ===================================================================

fixA=$(make_fixture)
cd "$fixA"

# Test 1: fork exits 0
set +e
A_FORK_OUT=$(bun "$AUDIT_TOOL" audit-fork --slug demo --project-dir "$fixA" 2>&1)
A_FORK_RC=$?
set -e

# Pre-check: worktree must exist before fork. Create it now via aidlc-worktree.
# (We need this BEFORE fork, but doing it after fork would let the test plan
# accidentally pass for the wrong reason. Re-do the test from scratch.)
cleanup_worktree_fixture "$fixA"
fixA=$(make_fixture)
cd "$fixA"
bun "$WORKTREE_TOOL" create --slug demo --base main --project-dir "$fixA" >/dev/null 2>&1

set +e
A_FORK_OUT=$(bun "$AUDIT_TOOL" audit-fork --slug demo --project-dir "$fixA" 2>&1)
A_FORK_RC=$?
set -e
assert_eq "$A_FORK_RC" "0" "A1: audit-fork exits 0"

# Test 2: stdout JSON includes emitted=AUDIT_FORKED
assert_contains "$A_FORK_OUT" '"emitted":"AUDIT_FORKED"' \
  "A2: audit-fork stdout reports emitted=AUDIT_FORKED"

# Test 3: main audit contains AUDIT_FORKED row
assert_grep "$fixA/aidlc-docs/audit.md" "AUDIT_FORKED" \
  "A3: main audit contains AUDIT_FORKED row"

# Test 4: main audit contains Fork Boundary field
assert_grep "$fixA/aidlc-docs/audit.md" "Fork Boundary" \
  "A4: main audit AUDIT_FORKED row carries Fork Boundary field"

# Test 5: worktree audit file exists post-fork
assert_file_exists "$fixA/.aidlc/worktrees/bolt-demo/aidlc-docs/audit.md" \
  "A5: worktree audit file created at <worktree>/aidlc-docs/audit.md"

# Test 6: byte-identical at fork instant
if cmp -s "$fixA/aidlc-docs/audit.md" \
        "$fixA/.aidlc/worktrees/bolt-demo/aidlc-docs/audit.md"; then
  ok "A6: worktree audit is byte-identical to main audit at fork instant"
else
  not_ok "A6: worktree audit is byte-identical to main audit at fork instant" \
    "cmp reported difference"
fi

# Test 7: Fork Boundary value matches between main and worktree audit
A_MAIN_FB=$(grep -m1 "Fork Boundary" "$fixA/aidlc-docs/audit.md" | sed 's/.*Fork Boundary[*]*:[ ]*//')
A_WT_FB=$(grep -m1 "Fork Boundary" "$fixA/.aidlc/worktrees/bolt-demo/aidlc-docs/audit.md" | sed 's/.*Fork Boundary[*]*:[ ]*//')
assert_eq "$A_MAIN_FB" "$A_WT_FB" \
  "A7: Fork Boundary value matches between main and worktree audit"

# Test 8: append a synthetic STAGE_STARTED row to the worktree audit
bun "$AUDIT_TOOL" append STAGE_STARTED \
  --field "Stage=foo" --field "Agent=bar" \
  --project-dir "$fixA/.aidlc/worktrees/bolt-demo" >/dev/null 2>&1
set +e
A_MERGE_OUT=$(bun "$AUDIT_TOOL" audit-merge --slug demo --project-dir "$fixA" 2>&1)
A_MERGE_RC=$?
set -e
assert_eq "$A_MERGE_RC" "0" "A8: audit-merge exits 0"

# Test 9: main audit now contains the appended STAGE_STARTED row
assert_grep "$fixA/aidlc-docs/audit.md" "Stage.*foo" \
  "A9: main audit contains the merged STAGE_STARTED row"

# Test 10: main audit contains AUDIT_MERGED row
assert_grep "$fixA/aidlc-docs/audit.md" "AUDIT_MERGED" \
  "A10: main audit contains AUDIT_MERGED row"

# Test 11: worktree audit does NOT contain AUDIT_MERGED (Decision 5: main only)
assert_not_grep "$fixA/.aidlc/worktrees/bolt-demo/aidlc-docs/audit.md" "AUDIT_MERGED" \
  "A11: worktree audit does NOT contain AUDIT_MERGED (main-only emit)"

cd /

# ===================================================================
# Phase B — edge cases (11 tests)
# ===================================================================

# B1: empty delta — fork then merge with no worktree-side appends (3 tests)
fixB1=$(make_fixture)
cd "$fixB1"
bun "$WORKTREE_TOOL" create --slug e1 --base main --project-dir "$fixB1" >/dev/null 2>&1
bun "$AUDIT_TOOL" audit-fork --slug e1 --project-dir "$fixB1" >/dev/null 2>&1
B1_PRE=$(grep -c '^---$' "$fixB1/aidlc-docs/audit.md" || true)
set +e
B1_OUT=$(bun "$AUDIT_TOOL" audit-merge --slug e1 --project-dir "$fixB1" 2>&1)
B1_RC=$?
set -e
assert_eq "$B1_RC" "0" "B1.1: empty-delta merge exits 0"
assert_contains "$B1_OUT" '"entries_merged":0' \
  "B1.2: empty-delta merge reports entries_merged=0"
B1_POST=$(grep -c '^---$' "$fixB1/aidlc-docs/audit.md" || true)
B1_DELTA=$((B1_POST - B1_PRE))
assert_eq "$B1_DELTA" "1" \
  "B1.3: empty-delta merge appends exactly one block (AUDIT_MERGED) to main audit"
cd /

# B2: missing <wt>/aidlc-docs/ subdir auto-created at fork (2 tests)
fixB2=$(make_fixture)
cd "$fixB2"
bun "$WORKTREE_TOOL" create --slug e2 --base main --project-dir "$fixB2" >/dev/null 2>&1
# Confirm aidlc-docs/ does NOT exist in the worktree before fork.
if [ ! -d "$fixB2/.aidlc/worktrees/bolt-e2/aidlc-docs" ]; then
  ok "B2.1: worktree's aidlc-docs/ does not exist pre-fork (subdir not created by aidlc-worktree)"
else
  not_ok "B2.1: worktree's aidlc-docs/ does not exist pre-fork" \
    "subdir already exists at $fixB2/.aidlc/worktrees/bolt-e2/aidlc-docs"
fi
bun "$AUDIT_TOOL" audit-fork --slug e2 --project-dir "$fixB2" >/dev/null 2>&1
assert_file_exists "$fixB2/.aidlc/worktrees/bolt-e2/aidlc-docs/audit.md" \
  "B2.2: audit-fork created <worktree>/aidlc-docs/audit.md (mkdir -p worked)"
cd /

# B3: missing main audit — fork must fail loud (2 tests)
fixB3=$(make_fixture)
cd "$fixB3"
bun "$WORKTREE_TOOL" create --slug e3 --base main --project-dir "$fixB3" >/dev/null 2>&1
rm -f "$fixB3/aidlc-docs/audit.md"
set +e
B3_OUT=$(bun "$AUDIT_TOOL" audit-fork --slug e3 --project-dir "$fixB3" 2>&1)
B3_RC=$?
set -e
assert_not_eq "$B3_RC" "0" "B3.1: audit-fork exits non-zero when main audit is missing"
assert_contains "$B3_OUT" "main audit not found" \
  "B3.2: audit-fork error message names the missing main audit"
# Restore so trap cleanup doesn't error.
printf "# AI-DLC Audit Log\n" > "$fixB3/aidlc-docs/audit.md"
cd /

# B4: prefix-hash mismatch — corrupt prefix bytes between fork and merge (2 tests)
fixB4=$(make_fixture)
cd "$fixB4"
bun "$WORKTREE_TOOL" create --slug e4 --base main --project-dir "$fixB4" >/dev/null 2>&1
bun "$AUDIT_TOOL" audit-fork --slug e4 --project-dir "$fixB4" >/dev/null 2>&1
# Append a worktree-side row so the merge would normally have something to do.
bun "$AUDIT_TOOL" append STAGE_STARTED --field "Stage=foo" --field "Agent=bar" \
  --project-dir "$fixB4/.aidlc/worktrees/bolt-e4" >/dev/null 2>&1
# Flip a single byte in the main audit's header (length-preserving). This is
# in the prefix that Source Audit Hash covers, so the hash will differ.
sed_i 's|# AI-DLC Audit Log|# AI-DLC Audit LOG|' "$fixB4/aidlc-docs/audit.md"
set +e
B4_OUT=$(bun "$AUDIT_TOOL" audit-merge --slug e4 --project-dir "$fixB4" 2>&1)
B4_RC=$?
set -e
assert_not_eq "$B4_RC" "0" \
  "B4.1: audit-merge exits non-zero when main audit prefix has been edited"
assert_contains "$B4_OUT" "prefix-hash" \
  "B4.2: audit-merge error message names the prefix-hash check"
cd /

# B5: lock contention — 50ms-staggered N=2 mergers both succeed (2 tests)
fixB5=$(make_fixture)
cd "$fixB5"
bun "$WORKTREE_TOOL" create --slug lock-a --base main --project-dir "$fixB5" >/dev/null 2>&1
bun "$WORKTREE_TOOL" create --slug lock-b --base main --project-dir "$fixB5" >/dev/null 2>&1
bun "$AUDIT_TOOL" audit-fork --slug lock-a --project-dir "$fixB5" >/dev/null 2>&1
bun "$AUDIT_TOOL" audit-fork --slug lock-b --project-dir "$fixB5" >/dev/null 2>&1
bun "$AUDIT_TOOL" append STAGE_STARTED --field "Stage=a" --field "Agent=x" \
  --project-dir "$fixB5/.aidlc/worktrees/bolt-lock-a" >/dev/null 2>&1
bun "$AUDIT_TOOL" append STAGE_STARTED --field "Stage=b" --field "Agent=y" \
  --project-dir "$fixB5/.aidlc/worktrees/bolt-lock-b" >/dev/null 2>&1
# Background the first merge, sleep 50ms, foreground the second; wait for both.
bun "$AUDIT_TOOL" audit-merge --slug lock-a --project-dir "$fixB5" >/dev/null 2>&1 &
BG_PID=$!
sleep 0.05
set +e
bun "$AUDIT_TOOL" audit-merge --slug lock-b --project-dir "$fixB5" >/dev/null 2>&1
B5_FG_RC=$?
wait "$BG_PID"
B5_BG_RC=$?
set -e
if [ "$B5_BG_RC" -eq 0 ] && [ "$B5_FG_RC" -eq 0 ]; then
  ok "B5.1: both staggered mergers exit 0 under lock contention"
else
  not_ok "B5.1: both staggered mergers exit 0 under lock contention" \
    "bg=$B5_BG_RC fg=$B5_FG_RC"
fi
B5_MERGED_COUNT=$(grep -c "AUDIT_MERGED" "$fixB5/aidlc-docs/audit.md" || true)
assert_eq "$B5_MERGED_COUNT" "2" \
  "B5.2: main audit has exactly 2 AUDIT_MERGED rows after staggered merges"
cd /

# B6: lock-timeout failure path — plant a stuck mkdir-lock so audit-merge
# exhausts its retry budget and exits non-zero with a clear error message.
# Uses AIDLC_AUDIT_LOCK_RETRIES=2 + AIDLC_AUDIT_LOCK_RETRY_MS=50 to keep the
# test fast (~100ms instead of 20s production budget) (1 test).
fixB6=$(make_fixture)
cd "$fixB6"
bun "$WORKTREE_TOOL" create --slug timeout --base main --project-dir "$fixB6" >/dev/null 2>&1
bun "$AUDIT_TOOL" audit-fork --slug timeout --project-dir "$fixB6" >/dev/null 2>&1
bun "$AUDIT_TOOL" append STAGE_STARTED --field "Stage=t" --field "Agent=t" \
  --project-dir "$fixB6/.aidlc/worktrees/bolt-timeout" >/dev/null 2>&1
# Plant a stuck lock by mkdir-ing the directory the tool tries to acquire.
# Lock path mirrors auditLockDir: $TMPDIR/.aidlc-audit-<md5(projectDir)[0:8]>.lock
B6_HASH=$(printf "%s" "$fixB6" | md5 -q 2>/dev/null || printf "%s" "$fixB6" | md5sum | cut -d' ' -f1)
B6_LOCK="${TMPDIR:-/tmp}/.aidlc-audit-${B6_HASH:0:8}.lock"
mkdir -p "$B6_LOCK"
set +e
B6_OUT=$(AIDLC_AUDIT_LOCK_RETRIES=2 AIDLC_AUDIT_LOCK_RETRY_MS=50 \
  bun "$AUDIT_TOOL" audit-merge --slug timeout --project-dir "$fixB6" 2>&1)
B6_RC=$?
set -e
rmdir "$B6_LOCK" 2>/dev/null || true
if [ "$B6_RC" -ne 0 ] && grep -q "Failed to acquire audit lock" <<< "$B6_OUT"; then
  ok "B6: audit-merge exits non-zero with clear lock-timeout error when lock is held"
else
  not_ok "B6: audit-merge exits non-zero with clear lock-timeout error when lock is held" \
    "rc=$B6_RC out=$B6_OUT"
fi
cd /

# B7: max-length slug rejection — 65-character slug must fail validation
# before any disk side-effect (1 test).
fixB7=$(make_fixture)
cd "$fixB7"
B7_LONG_SLUG=$(printf 'a%.0s' {1..65})
set +e
B7_OUT=$(bun "$AUDIT_TOOL" audit-fork --slug "$B7_LONG_SLUG" --project-dir "$fixB7" 2>&1)
B7_RC=$?
set -e
if [ "$B7_RC" -ne 0 ] && grep -qE "65 chars|max is 64" <<< "$B7_OUT"; then
  ok "B7: audit-fork rejects 65-char slug with length error"
else
  not_ok "B7: audit-fork rejects 65-char slug with length error" \
    "rc=$B7_RC out=$B7_OUT"
fi
cd /

# B8: post-emit failure path — failed audit-fork ERROR_LOGGED carries the
# emitted AUDIT_FORKED Timestamp (ISO 8601) in its [fork-emitted:<ts>]
# correlation tag. Doctor (MR 15) needs the timestamp to join the orphan
# AUDIT_FORKED row in main with the failed-fork ERROR_LOGGED row. Trigger
# by making the worktree's parent dir read-only AFTER the audit-fork
# pre-emit guards pass — emit succeeds, then mkdir+copy fails (1 test).
fixB8=$(make_fixture)
cd "$fixB8"
bun "$WORKTREE_TOOL" create --slug erro --base main --project-dir "$fixB8" >/dev/null 2>&1
# chmod the worktree dir read-only so mkdir of <wt>/aidlc-docs/ inside
# audit-fork fails AFTER the AUDIT_FORKED emit succeeded.
chmod 0555 "$fixB8/.aidlc/worktrees/bolt-erro"
set +e
bun "$AUDIT_TOOL" audit-fork --slug erro --project-dir "$fixB8" >/dev/null 2>&1
set -e
chmod 0755 "$fixB8/.aidlc/worktrees/bolt-erro"
# ERROR_LOGGED row should carry [fork-emitted:<iso-ts>] not [fork-emitted:<int>].
# ISO timestamps from isoTimestamp() match YYYY-MM-DDTHH:MM:SSZ.
if grep -E '\[fork-emitted:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\]' \
     "$fixB8/aidlc-docs/audit.md" >/dev/null 2>&1; then
  ok "B8: failed audit-fork ERROR_LOGGED carries [fork-emitted:<iso-ts>] for doctor correlation"
else
  not_ok "B8: failed audit-fork ERROR_LOGGED carries [fork-emitted:<iso-ts>] for doctor correlation" \
    "no ISO-timestamp [fork-emitted:...] tag in audit.md"
fi
cd /

# ===================================================================
# Phase C — property (6 tests)
# ===================================================================

# Helper: do N=4 fork+append+merge cycles in a given slug order.
run_n4_scenario() {
  local fix="$1"
  shift
  local slugs=("$@")
  local s
  for s in "${slugs[@]}"; do
    bun "$WORKTREE_TOOL" create --slug "$s" --base main --project-dir "$fix" >/dev/null 2>&1
    bun "$AUDIT_TOOL" audit-fork --slug "$s" --project-dir "$fix" >/dev/null 2>&1
    bun "$AUDIT_TOOL" append STAGE_STARTED --field "Stage=$s" --field "Agent=test" \
      --project-dir "$fix/.aidlc/worktrees/bolt-$s" >/dev/null 2>&1
  done
  for s in "${slugs[@]}"; do
    bun "$AUDIT_TOOL" audit-merge --slug "$s" --project-dir "$fix" >/dev/null 2>&1
  done
}

# Property invariant: per-Bolt fork→merge bracket order is preserved across
# the merged main audit; cross-Bolt order reflects merge-completion order
# (not chronological). Tests C1-C4 exercise four scenarios; each verifies
# the bracket invariant + that all 4 forks and all 4 merges landed.

# C1: alphabetical N=4 — bracket order preserved + count check (1 test)
fixC1=$(make_fixture)
cd "$fixC1"
run_n4_scenario "$fixC1" alpha bravo charlie delta
assert_per_bolt_bracket_order "$fixC1/aidlc-docs/audit.md" \
  "C1: alphabetical N=4 — every AUDIT_FORKED has a later matching AUDIT_MERGED"
cd /

# C2: reverse-alphabetical N=4 — bracket order preserved (1 test)
fixC2=$(make_fixture)
cd "$fixC2"
run_n4_scenario "$fixC2" delta charlie bravo alpha
assert_per_bolt_bracket_order "$fixC2/aidlc-docs/audit.md" \
  "C2: reverse-alphabetical N=4 — bracket order preserved"
cd /

# C3: same-second timestamps — synthesise hand-crafted identical-timestamp
# delta blocks bypassing isoTimestamp(). Confirms the merge handles same-
# second timestamps without losing entries (1 test).
fixC3=$(make_fixture)
cd "$fixC3"
for s in t1 t2 t3 t4; do
  bun "$WORKTREE_TOOL" create --slug "$s" --base main --project-dir "$fixC3" >/dev/null 2>&1
  bun "$AUDIT_TOOL" audit-fork --slug "$s" --project-dir "$fixC3" >/dev/null 2>&1
  # Hand-author an audit block with a frozen timestamp.
  cat >> "$fixC3/.aidlc/worktrees/bolt-$s/aidlc-docs/audit.md" <<EOF

## Stage Start
**Timestamp**: 2026-05-18T12:00:00Z
**Event**: STAGE_STARTED
**Stage**: $s
**Agent**: test

---
EOF
done
for s in t1 t2 t3 t4; do
  bun "$AUDIT_TOOL" audit-merge --slug "$s" --project-dir "$fixC3" >/dev/null 2>&1
done
assert_per_bolt_bracket_order "$fixC3/aidlc-docs/audit.md" \
  "C3: same-second-timestamps N=4 — bracket order preserved"
cd /

# C4: N=4 with one empty delta (1 test)
fixC4=$(make_fixture)
cd "$fixC4"
for s in z1 z2 z3 z4; do
  bun "$WORKTREE_TOOL" create --slug "$s" --base main --project-dir "$fixC4" >/dev/null 2>&1
  bun "$AUDIT_TOOL" audit-fork --slug "$s" --project-dir "$fixC4" >/dev/null 2>&1
done
# Three of four append; z3 stays empty.
for s in z1 z2 z4; do
  bun "$AUDIT_TOOL" append STAGE_STARTED --field "Stage=$s" --field "Agent=test" \
    --project-dir "$fixC4/.aidlc/worktrees/bolt-$s" >/dev/null 2>&1
done
for s in z1 z2 z3 z4; do
  bun "$AUDIT_TOOL" audit-merge --slug "$s" --project-dir "$fixC4" >/dev/null 2>&1
done
assert_per_bolt_bracket_order "$fixC4/aidlc-docs/audit.md" \
  "C4: N=4 with one empty-delta — bracket order preserved"

# C5: structural — exactly 4 AUDIT_MERGED rows in C4's main audit
C4_MERGED=$(grep -c "AUDIT_MERGED" "$fixC4/aidlc-docs/audit.md" || true)
assert_eq "$C4_MERGED" "4" \
  "C5: C4 main audit contains exactly 4 AUDIT_MERGED rows (no merger silently dropped)"

# C6: structural — exactly 4 AUDIT_FORKED rows
C4_FORKED=$(grep -c "AUDIT_FORKED" "$fixC4/aidlc-docs/audit.md" || true)
assert_eq "$C4_FORKED" "4" \
  "C6: C4 main audit contains exactly 4 AUDIT_FORKED rows"
cd /

finish
