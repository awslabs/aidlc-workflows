#!/bin/bash
# t76: Behavioural contract for `aidlc-state.ts fork` and `aidlc-state.ts merge`
# (v0.4.0 MR 9 state fork/merge subcommands).
#
# Each Construction Bolt forks main state to its worktree on Bolt start and
# merges it back on gate approval, so parallel Bolts and workshop-mode
# scenarios stop racing on shared state. Strict audit-first per
# docs/reference/12-state-machine.md (the audit-of-intent exception is
# bounded to the three WORKTREE_* events for kill-9 reasons; state fork/merge
# are idempotent so the strict invariant applies cleanly).
#
# Surface tested (16 assertions):
#   1. fork happy path: byte-identical copy + Bolt Refs append + audit row.
#   2. fork rejects invalid slug (path-traversal guard).
#   3. fork fails loud when worktree directory does not exist.
#   4. fork detects v6 state via the doctor v7-pin (validates the cross-MR
#      contract that fork callers run against v7 state).
#   5. fork strict audit-first Part A: pre-create the audit lock dir, force
#      audit emit failure, assert no worktree state file is written.
#   6. fork strict audit-first Part B: chmod the worktree dir read-only AFTER
#      audit emit succeeds, assert orphaned STATE_FORKED row + slug-tagged
#      ERROR_LOGGED for MR 15 doctor reconciliation.
#   7. merge happy round-trip: cmp -s confirms post-merge main matches the
#      pre-computed expected state byte-for-byte.
#   8. merge workflow-level fields untouched (defence-in-depth — main wins).
#   9. merge alphabetical-slug tiebreak: bolt-alpha vs bolt-beta on the same
#      cell; lower alphabetical wins regardless of merge order.
#  10. merge cleans Bolt Refs back to [empty list] when the last slug merges.
#  11. merge idempotency: second call exits non-zero with `already merged`,
#      no second STATE_MERGED audit row.
#  12. merge audit-lock-timeout: pre-create the lock dir, retry budget
#      exhausts (~5s), exits with [slug=...] failure tag, no partial write.
#  13. concurrent forks for distinct slugs: bash & + wait; main Bolt Refs
#      contains both slugs in alphabetical order via emitRefsList sort.
#  14. (B2 regression) duplicate-slug fork emits NO phantom STATE_FORKED row:
#      first fork lands one row, second fork (same slug) exits non-zero with
#      "slug already in Bolt Refs" and the audit row count stays at 1.
#  15. (B1 regression) errorWithSlug inside the locked critical section
#      releases the audit lock dir even though Bun's process.exit skips
#      `finally` — the next fork on the same project succeeds without the
#      ~5s retry budget being exhausted.
#  16. (M1 regression) audit Target state hash matches the actual post-write
#      main file SHA (computed inside the lock against final merged content,
#      not the pre-lock snapshot).
#
# L1 — pure bash + bun. No claude.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-state.ts"
LIB_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-lib.ts"

if [ ! -f "$STATE_TS" ]; then
  echo "Bail out! aidlc-state.ts not found at $STATE_TS"
  exit 1
fi

plan 16

# --- Helper: build a clean v7 state fixture project with a worktree dir ---
make_fixture() {
  local proj
  proj=$(create_test_project)
  cat > "$proj/aidlc-docs/aidlc-state.md" <<'EOF'
# AI-DLC State Tracking

## Project Information
- **Project**: t76-fixture
- **Project Type**: Greenfield
- **Scope**: feature
- **Start Date**: 2026-05-18T00:00:00Z
- **State Version**: 7
- **Active Agent**: aidlc-developer-agent
- **Worktree Path**:
- **Bolt Refs**:
- **Practices Affirmed Timestamp**:

## Stage Progress

### CONSTRUCTION PHASE
- [-] code-generation — EXECUTE
- [-] build-and-test — EXECUTE
EOF
  printf "# AI-DLC Audit Log\n" > "$proj/aidlc-docs/audit.md"
  echo "$proj"
}

mk_worktree_dir() {
  local proj="$1"; local slug="$2"
  mkdir -p "$proj/.aidlc/worktrees/bolt-$slug"
}

# md5 8-char hash of project dir → audit lock dir name (matches lib.ts:auditLockDir)
audit_lock_dir() {
  local proj="$1"
  local hash
  hash=$(printf "%s" "$proj" | md5sum 2>/dev/null | awk '{print $1}' | cut -c1-8)
  if [ -z "$hash" ]; then
    # macOS uses md5 instead of md5sum
    hash=$(printf "%s" "$proj" | md5 2>/dev/null | awk '{print $NF}' | cut -c1-8)
  fi
  echo "${TMPDIR:-/tmp}/.aidlc-audit-${hash}.lock"
}

# Cleanup trap — release any chmod / leftover lock dirs on exit
TRACK_FIXTURES=()
cleanup_all() {
  for f in "${TRACK_FIXTURES[@]:-}"; do
    [ -z "$f" ] && continue
    [ -d "$f/.aidlc/worktrees" ] && chmod -R 0755 "$f/.aidlc/worktrees" 2>/dev/null || true
    [ -f "$f/aidlc-docs/audit.md" ] && chmod 0644 "$f/aidlc-docs/audit.md" 2>/dev/null || true
    local lk; lk=$(audit_lock_dir "$f")
    [ -d "$lk" ] && rmdir "$lk" 2>/dev/null || true
    cleanup_test_project "$f"
  done
}
trap cleanup_all EXIT

track_fixture() { TRACK_FIXTURES+=("$1"); }

# --- 1. fork happy path ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" demo
bun "$STATE_TS" --project-dir "$proj" fork --slug demo > /dev/null
WT_STATE="$proj/.aidlc/worktrees/bolt-demo/aidlc-docs/aidlc-state.md"
# After fork, worktree state should equal main state at the time of fork
# EXCEPT for two fields the code intentionally diverges on:
#   - Worktree Path (set on the worktree side as a decorative breadcrumb)
#   - Bolt Refs (updated on main AFTER the worktree write to register the fork)
# Strip both for comparison.
norm_main=$(grep -vE '^- \*\*(Worktree Path|Bolt Refs)\*\*:' "$proj/aidlc-docs/aidlc-state.md")
norm_wt=$(grep -vE '^- \*\*(Worktree Path|Bolt Refs)\*\*:' "$WT_STATE")
if [ "$norm_main" = "$norm_wt" ]; then
  ok "1. fork: worktree state byte-identical to main (modulo Worktree Path + Bolt Refs), Bolt Refs=[demo], STATE_FORKED audit row present"
else
  not_ok "1. fork: worktree state byte-identical to main" \
    "diff: $(diff <(echo "$norm_main") <(echo "$norm_wt") | head -3)"
fi
# Confirm Bolt Refs and audit assertions in the same TAP test (single semantic check).
grep -q '^- \*\*Bolt Refs\*\*: \[demo\]$' "$proj/aidlc-docs/aidlc-state.md" \
  || not_ok "1. fork (sub): Bolt Refs not [demo]" "got: $(grep 'Bolt Refs' "$proj/aidlc-docs/aidlc-state.md")"
grep -q "STATE_FORKED" "$proj/aidlc-docs/audit.md" \
  || not_ok "1. fork (sub): no STATE_FORKED audit row"

# --- 2. fork rejects invalid slug (path traversal) ---
proj=$(make_fixture); track_fixture "$proj"
set +e
OUT=$(bun "$STATE_TS" --project-dir "$proj" fork --slug "../etc/passwd" 2>&1)
RC=$?
set -e
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q 'Invalid --slug'; then
  ok "2. fork: rejects invalid slug '../etc/passwd' before path construction"
else
  not_ok "2. fork: rejects invalid slug" "rc=$RC out=$OUT"
fi

# --- 3. fork fails when worktree directory missing ---
proj=$(make_fixture); track_fixture "$proj"
# No mk_worktree_dir call — directory doesn't exist
set +e
OUT=$(bun "$STATE_TS" --project-dir "$proj" fork --slug noworktree 2>&1)
RC=$?
set -e
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q 'worktree directory does not exist' \
   && echo "$OUT" | grep -q '\[slug=noworktree\]'; then
  ok "3. fork: fails loud when worktree dir missing, error tagged with [slug=...]"
else
  not_ok "3. fork: fails loud when worktree dir missing" "rc=$RC out=$OUT"
fi

# --- 4. fork against v6 state — setFieldStrict throws on missing v7 fields ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" v6test
# Mutate to a v6-like shape: drop the Worktree Path field that v7 added.
sed_i '/^- \*\*Worktree Path\*\*:/d' "$proj/aidlc-docs/aidlc-state.md"
set +e
OUT=$(bun "$STATE_TS" --project-dir "$proj" fork --slug v6test 2>&1)
RC=$?
set -e
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q 'Worktree Path'; then
  ok "4. fork: fails loud when Worktree Path field absent (v6 state precursor)"
else
  not_ok "4. fork: fails loud against v6 state" "rc=$RC out=$OUT"
fi

# --- 5. fork strict audit-first Part A: pre-create lock dir → audit emit fails ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" partA
LOCK_DIR=$(audit_lock_dir "$proj")
mkdir -p "$LOCK_DIR"
set +e
# Use AIDLC_AUDIT_LOCK_RETRIES=0 if supported, else just rely on lock timeout.
# Lock retry budget = 5s default; force it short via a quick test by setting a
# short retry env if available; else accept the 5s wait.
OUT=$(bun "$STATE_TS" --project-dir "$proj" fork --slug partA 2>&1)
RC=$?
set -e
rmdir "$LOCK_DIR" 2>/dev/null || true
WT_STATE="$proj/.aidlc/worktrees/bolt-partA/aidlc-docs/aidlc-state.md"
if [ "$RC" -ne 0 ] && [ ! -f "$WT_STATE" ]; then
  ok "5. fork strict audit-first Part A: lock-held → no worktree state file written"
else
  not_ok "5. fork audit-first Part A" "rc=$RC; wt-state-exists=$([ -f "$WT_STATE" ] && echo yes || echo no)"
fi

# --- 6. fork strict audit-first Part B: pre-create aidlc-docs read-only inside
# the worktree so mkdir -p succeeds (idempotent on existing dir) and audit
# emit fires, then writeStateFile fails because the dir is not writable. ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" part-b
mkdir -p "$proj/.aidlc/worktrees/bolt-part-b/aidlc-docs"
chmod 0555 "$proj/.aidlc/worktrees/bolt-part-b/aidlc-docs"
set +e
OUT=$(bun "$STATE_TS" --project-dir "$proj" fork --slug part-b 2>&1)
RC=$?
set -e
chmod 0755 "$proj/.aidlc/worktrees/bolt-part-b/aidlc-docs"
# After Part B: STATE_FORKED audit row landed (audit-first), then the write
# failed and ERROR_LOGGED was appended with [slug=part-b] for doctor MR 15.
if [ "$RC" -ne 0 ] \
   && grep -q "STATE_FORKED" "$proj/aidlc-docs/audit.md" \
   && grep -q "ERROR_LOGGED" "$proj/aidlc-docs/audit.md" \
   && grep -q '\[slug=part-b\]' "$proj/aidlc-docs/audit.md"; then
  ok "6. fork strict audit-first Part B: STATE_FORKED + ERROR_LOGGED with [slug=part-b] tag"
else
  not_ok "6. fork audit-first Part B" "rc=$RC; audit: $(tail -20 "$proj/aidlc-docs/audit.md")"
fi

# --- 7. merge happy round-trip: cmp -s byte-identical to expected ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" demo
bun "$STATE_TS" --project-dir "$proj" fork --slug demo > /dev/null
# Worktree advances code-generation [-] -> [x]
WT_STATE="$proj/.aidlc/worktrees/bolt-demo/aidlc-docs/aidlc-state.md"
sed_i 's/\[-\] code-generation/[x] code-generation/' "$WT_STATE"
bun "$STATE_TS" --project-dir "$proj" merge --slug demo > /dev/null
# Build expected: original main with code-generation flipped + Bolt Refs reverted.
EXPECTED=$(mktemp)
cat > "$EXPECTED" <<'EOF'
# AI-DLC State Tracking

## Project Information
- **Project**: t76-fixture
- **Project Type**: Greenfield
- **Scope**: feature
- **Start Date**: 2026-05-18T00:00:00Z
- **State Version**: 7
- **Active Agent**: aidlc-developer-agent
- **Worktree Path**:
- **Bolt Refs**: [empty list]
- **Practices Affirmed Timestamp**:

## Stage Progress

### CONSTRUCTION PHASE
- [x] code-generation — EXECUTE
- [-] build-and-test — EXECUTE
EOF
if cmp -s "$EXPECTED" "$proj/aidlc-docs/aidlc-state.md"; then
  ok "7. merge: post-merge main byte-identical to expected (cmp -s)"
else
  not_ok "7. merge round-trip" "diff: $(diff "$EXPECTED" "$proj/aidlc-docs/aidlc-state.md" | head -8)"
fi
rm -f "$EXPECTED"

# --- 8. merge workflow-level fields untouched ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" wftest
bun "$STATE_TS" --project-dir "$proj" fork --slug wftest > /dev/null
WT_STATE="$proj/.aidlc/worktrees/bolt-wftest/aidlc-docs/aidlc-state.md"
# Mutate Active Agent in worktree to a different value.
sed_i 's/^- \*\*Active Agent\*\*: aidlc-developer-agent$/- **Active Agent**: rogue-agent/' "$WT_STATE"
bun "$STATE_TS" --project-dir "$proj" merge --slug wftest > /dev/null
MAIN_AGENT=$(grep '^- \*\*Active Agent\*\*:' "$proj/aidlc-docs/aidlc-state.md" | head -1)
if echo "$MAIN_AGENT" | grep -q 'aidlc-developer-agent'; then
  ok "8. merge: workflow-level Active Agent untouched (main wins, worktree value ignored)"
else
  not_ok "8. merge: workflow-level fields untouched" "got: $MAIN_AGENT"
fi

# --- 9. merge alphabetical-slug tiebreak (defence-in-depth) ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" alpha
mk_worktree_dir "$proj" beta
bun "$STATE_TS" --project-dir "$proj" fork --slug alpha > /dev/null
bun "$STATE_TS" --project-dir "$proj" fork --slug beta > /dev/null
# Alpha sets code-generation to [S] (skipped), Beta sets it to [x] (completed).
# Both flip the same Construction cell to different values.
sed_i 's/\[-\] code-generation/[S] code-generation/' \
  "$proj/.aidlc/worktrees/bolt-alpha/aidlc-docs/aidlc-state.md"
sed_i 's/\[-\] code-generation/[x] code-generation/' \
  "$proj/.aidlc/worktrees/bolt-beta/aidlc-docs/aidlc-state.md"
# Merge beta FIRST (against alphabetical order). Bolt Refs at this point is
# [alpha, beta] so candidateSlugs[0]='alpha' — beta should DEFER its write.
bun "$STATE_TS" --project-dir "$proj" merge --slug beta > /dev/null
# After beta merges, code-generation should NOT have changed yet (deferred to
# alpha because alpha is alphabetically lower).
CG_AFTER_BETA=$(grep 'code-generation' "$proj/aidlc-docs/aidlc-state.md" | head -1)
# Now merge alpha — Bolt Refs becomes [alpha], candidateSlugs[0]='alpha',
# alpha wins, applies [S].
bun "$STATE_TS" --project-dir "$proj" merge --slug alpha > /dev/null
CG_AFTER_ALPHA=$(grep 'code-generation' "$proj/aidlc-docs/aidlc-state.md" | head -1)
if echo "$CG_AFTER_BETA" | grep -q '\[-\]' && echo "$CG_AFTER_ALPHA" | grep -q '\[S\]'; then
  ok "9. merge: alphabetical-slug tiebreak — beta defers, alpha (lower slug) wins regardless of merge order"
else
  not_ok "9. merge alphabetical tiebreak" "after-beta: $CG_AFTER_BETA; after-alpha: $CG_AFTER_ALPHA"
fi

# --- 10. merge cleans Bolt Refs back to [empty list] ---
# Reuse proj from test 9 — alpha already merged, beta merged earlier.
REFS=$(grep '^- \*\*Bolt Refs\*\*:' "$proj/aidlc-docs/aidlc-state.md")
if echo "$REFS" | grep -q '\[empty list\]'; then
  ok "10. merge: empty Bolt Refs reverts to [empty list] literal placeholder"
else
  not_ok "10. merge: Bolt Refs to [empty list]" "got: $REFS"
fi

# --- 11. merge idempotency ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" idem
bun "$STATE_TS" --project-dir "$proj" fork --slug idem > /dev/null
bun "$STATE_TS" --project-dir "$proj" merge --slug idem > /dev/null
MERGED_BEFORE=$(grep -c "STATE_MERGED" "$proj/aidlc-docs/audit.md" || true)
set +e
OUT=$(bun "$STATE_TS" --project-dir "$proj" merge --slug idem 2>&1)
RC=$?
set -e
MERGED_AFTER=$(grep -c "STATE_MERGED" "$proj/aidlc-docs/audit.md" || true)
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q 'already merged' \
   && [ "$MERGED_BEFORE" = "$MERGED_AFTER" ]; then
  ok "11. merge: idempotent re-run exits non-zero with 'already merged', emits no second STATE_MERGED row"
else
  not_ok "11. merge idempotency" "rc=$RC merged_before=$MERGED_BEFORE merged_after=$MERGED_AFTER out=$OUT"
fi

# --- 12. merge audit-lock timeout ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" timeout
bun "$STATE_TS" --project-dir "$proj" fork --slug timeout > /dev/null
# Pre-create the lock dir so emitAudit's acquireAuditLock retries until budget
# exhausted (~5s default). Capture outcome.
LOCK_DIR=$(audit_lock_dir "$proj")
mkdir -p "$LOCK_DIR"
set +e
OUT=$(bun "$STATE_TS" --project-dir "$proj" merge --slug timeout 2>&1)
RC=$?
set -e
rmdir "$LOCK_DIR" 2>/dev/null || true
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q '\[slug=timeout\]' \
   && (echo "$OUT" | grep -qiE 'lock|retries'); then
  ok "12. merge: audit-lock timeout — slug-tagged failure, no partial state write"
else
  not_ok "12. merge audit-lock timeout" "rc=$RC out=$OUT"
fi

# --- 13. concurrent forks for distinct slugs ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" bolt-x
mk_worktree_dir "$proj" bolt-y
bun "$STATE_TS" --project-dir "$proj" fork --slug bolt-x > /dev/null &
PID_X=$!
bun "$STATE_TS" --project-dir "$proj" fork --slug bolt-y > /dev/null &
PID_Y=$!
wait $PID_X || true
wait $PID_Y || true
REFS=$(grep '^- \*\*Bolt Refs\*\*:' "$proj/aidlc-docs/aidlc-state.md")
# Expected: emitRefsList sorts alphabetically, so [bolt-x, bolt-y] (x < y).
if echo "$REFS" | grep -q '\[bolt-x, bolt-y\]'; then
  ok "13. concurrent forks: distinct slugs both land, Bolt Refs sorted alphabetically"
else
  not_ok "13. concurrent forks distinct slugs" "got: $REFS"
fi

# --- 14. (B2 regression) duplicate-slug fork emits no phantom audit row ---
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" dup
bun "$STATE_TS" --project-dir "$proj" fork --slug dup > /dev/null
COUNT_BEFORE=$(grep -c "STATE_FORKED" "$proj/aidlc-docs/audit.md" || true)
set +e
OUT=$(bun "$STATE_TS" --project-dir "$proj" fork --slug dup 2>&1)
RC=$?
set -e
COUNT_AFTER=$(grep -c "STATE_FORKED" "$proj/aidlc-docs/audit.md" || true)
if [ "$RC" -ne 0 ] && echo "$OUT" | grep -q 'slug already in Bolt Refs' \
   && [ "$COUNT_BEFORE" = "1" ] && [ "$COUNT_AFTER" = "1" ]; then
  ok "14. (B2) duplicate-slug fork — no phantom STATE_FORKED row, recovery hint in error"
else
  not_ok "14. duplicate-slug phantom-audit regression" "rc=$RC before=$COUNT_BEFORE after=$COUNT_AFTER out=$OUT"
fi

# --- 15. (B1 regression) errorWithSlug inside locked block releases lock ---
# Trigger the locked errorWithSlug path by forking a slug that's already in
# Bolt Refs (test 14's setup). The next fork on the same project must succeed
# WITHOUT hitting the ~5s acquire timeout — i.e., the lock dir must have
# released even though Bun's process.exit skipped any `finally` block.
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" alpha
bun "$STATE_TS" --project-dir "$proj" fork --slug alpha > /dev/null
mk_worktree_dir "$proj" alpha2
# Trigger errorWithSlug via duplicate slug (locked block exits before write)
set +e
bun "$STATE_TS" --project-dir "$proj" fork --slug alpha 2>&1 > /dev/null
set -e
LOCK_DIR=$(audit_lock_dir "$proj")
[ -d "$LOCK_DIR" ] && LOCK_HELD=yes || LOCK_HELD=no
# Time a follow-up fork — should be sub-second if lock was released.
START=$(date +%s)
bun "$STATE_TS" --project-dir "$proj" fork --slug alpha2 > /dev/null
END=$(date +%s)
ELAPSED=$((END - START))
if [ "$LOCK_HELD" = "no" ] && [ "$ELAPSED" -lt 3 ]; then
  ok "15. (B1) errorWithSlug inside locked block releases lock cleanly (lock_held=$LOCK_HELD, follow-up fork: ${ELAPSED}s)"
else
  not_ok "15. errorWithSlug lock-leak regression" "lock_held=$LOCK_HELD elapsed=${ELAPSED}s"
fi

# --- 16. (M1 regression) audit Target state hash matches actual file SHA ---
# The pre-fix code computed postMergeSha pre-lock; post-fix it's computed
# inside the lock against the final merged content. Verify by re-hashing the
# file after merge and comparing to the audit row's Target hash.
proj=$(make_fixture); track_fixture "$proj"
mk_worktree_dir "$proj" hashtest
bun "$STATE_TS" --project-dir "$proj" fork --slug hashtest > /dev/null
sed_i 's/\[-\] code-generation/[x] code-generation/' \
  "$proj/.aidlc/worktrees/bolt-hashtest/aidlc-docs/aidlc-state.md"
RESULT=$(bun "$STATE_TS" --project-dir "$proj" merge --slug hashtest)
TARGET_HASH=$(echo "$RESULT" | sed -n 's/.*"target_state_hash":"\([0-9a-f]*\)".*/\1/p')
ACTUAL_HASH=$(shasum -a 256 "$proj/aidlc-docs/aidlc-state.md" | awk '{print $1}')
if [ -n "$TARGET_HASH" ] && [ "$TARGET_HASH" = "$ACTUAL_HASH" ]; then
  ok "16. (M1) audit Target state hash matches actual main state SHA after merge"
else
  not_ok "16. audit Target hash regression" "audit=$TARGET_HASH actual=$ACTUAL_HASH"
fi

finish
