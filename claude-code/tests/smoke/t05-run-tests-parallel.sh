#!/bin/bash
# t05: Smoke guard for the --parallel N flag on run-tests.sh.
#
# Covers the acceptance criteria from issue #53:
#   1. Invalid values exit cleanly with RC=2
#   2. --parallel 1 matches serial behavior
#   3. --parallel N on a capped tier (smoke) stays serial (no `(parallel=...)`
#      banner, no interleaved START/DONE)
#   4. --parallel N on an honoring tier (feature) tags the tier banner and
#      produces interleaved START lines
#   5. Summary assertion counts are identical across serial and parallel for
#      the same filter
#   6. Failure propagation — a planted failure under parallelism still yields
#      RESULT: FAIL and a non-zero exit
#   7. The _results sidecar dir ends the run empty (aggregated and cleared)
#
# Self-recursion guard: this test shells out to run-tests.sh, which would pick
# up this very file under --smoke. The guard below bails cleanly when we're
# running as a child of ourselves, turning the recursion into a no-op PASS.
set -euo pipefail
if [ "${AIDLC_T05_CHILD:-0}" = "1" ]; then
  # Running inside a recursive invocation — emit a minimal TAP plan and exit.
  echo "1..0 # SKIP t05 recursive child"
  exit 0
fi
export AIDLC_T05_CHILD=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

TESTS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$TESTS_ROOT/run-tests.sh"

plan 14

# ----- 1. Invalid values exit 2 with a clear message -----
for bad in 0 -1 abc; do
  out=$(bash "$RUNNER" --parallel "$bad" 2>&1 || true)
  rc=$(bash "$RUNNER" --parallel "$bad" >/dev/null 2>&1; echo $?)
  if [ "$rc" -eq 2 ] && echo "$out" | grep -qE "ERROR: --parallel requires a positive integer"; then
    ok "invalid --parallel $bad exits 2 with error message"
  else
    not_ok "invalid --parallel $bad exits 2 with error message" "rc=$rc out=$(echo "$out" | head -1)"
  fi
done

# --parallel with no argument consumes --verbose as the value → that's a
# non-numeric string, so it still errors with rc=2. Test that path separately.
rc=$(bash "$RUNNER" --parallel 2>/dev/null; echo $?)
if [ "$rc" -eq 2 ]; then
  ok "--parallel with no argument exits 2"
else
  not_ok "--parallel with no argument exits 2" "rc=$rc"
fi

# ----- 2. --parallel 1 matches serial behavior on smoke tier -----
serial_summary=$(bash "$RUNNER" --smoke 2>&1 | grep -E "^(Test files|Total assertions|Failed):")
p1_summary=$(bash "$RUNNER" --smoke --parallel 1 2>&1 | grep -E "^(Test files|Total assertions|Failed):")
if [ "$serial_summary" = "$p1_summary" ]; then
  ok "--parallel 1 summary matches serial (smoke tier)"
else
  not_ok "--parallel 1 summary matches serial (smoke tier)" \
    "serial: $(echo "$serial_summary" | tr '\n' '|')  p1: $(echo "$p1_summary" | tr '\n' '|')"
fi

# ----- 3. Smoke stays serial under --parallel 4 -----
smoke_banner=$(bash "$RUNNER" --smoke --parallel 4 2>&1 | grep -E "^## Smoke Tests" | head -1)
if echo "$smoke_banner" | grep -q "(parallel="; then
  not_ok "smoke tier banner omits '(parallel=N)' under --parallel 4" "got: $smoke_banner"
else
  ok "smoke tier banner omits '(parallel=N)' under --parallel 4"
fi

# ----- 4. Feature tier honors --parallel: banner tagged, interleaving observed -----
feat_out=$(bash "$RUNNER" --feature --parallel 4 --filter "t12|t30|t31|t32" 2>&1)
feat_banner=$(echo "$feat_out" | grep -E "^## Feature Tests" | head -1)
if echo "$feat_banner" | grep -q "(parallel=4)"; then
  ok "feature tier banner tagged '(parallel=4)'"
else
  not_ok "feature tier banner tagged '(parallel=4)'" "got: $feat_banner"
fi

# Interleaving: under --parallel 4 with 4 test files, at least two STARTs
# should appear before the first DONE.
first_done_line=$(echo "$feat_out" | grep -nE "=== (START|DONE)" | grep "DONE" | head -1 | cut -d: -f1 || echo 0)
starts_before_first_done=$(echo "$feat_out" | grep -nE "=== (START|DONE)" | awk -F: -v stop="$first_done_line" '$1 < stop && /START/ {n++} END {print n+0}')
if [ "$starts_before_first_done" -ge 2 ]; then
  ok "multiple tests started before first completed (interleaving observed)"
else
  not_ok "multiple tests started before first completed (interleaving observed)" \
    "only $starts_before_first_done START lines before first DONE"
fi

# ----- 5. Summary counts identical across --parallel 1 and --parallel 4 -----
serial_counts=$(bash "$RUNNER" --feature --filter "t12|t30|t31|t32" 2>&1 | grep -E "^(Test files|Total assertions|Failed (files|assertions)):" | sort)
parallel_counts=$(bash "$RUNNER" --feature --parallel 4 --filter "t12|t30|t31|t32" 2>&1 | grep -E "^(Test files|Total assertions|Failed (files|assertions)):" | sort)
if [ "$serial_counts" = "$parallel_counts" ]; then
  ok "summary counts identical between --parallel 1 and --parallel 4"
else
  not_ok "summary counts identical between --parallel 1 and --parallel 4" \
    "diff: $(diff <(echo "$serial_counts") <(echo "$parallel_counts") | head -4)"
fi

# ----- 6. Failure propagation under parallelism -----
PLANT="$TESTS_ROOT/feature/tZZ-planted-fail-t05.sh"
cat > "$PLANT" <<'PLANTED'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
plan 1
not_ok "planted failure for t05 propagation test" "expected"
finish
PLANTED
trap 'rm -f "$PLANT"' EXIT

# Run under --parallel 4 alongside a passing feature test
planted_out=$(bash "$RUNNER" --feature --filter "t12|tZZ-planted-fail-t05" --parallel 4 2>&1 || true)
planted_rc=$(bash "$RUNNER" --feature --filter "t12|tZZ-planted-fail-t05" --parallel 4 >/dev/null 2>&1; echo $?)
if echo "$planted_out" | grep -q "^RESULT: FAIL" && [ "$planted_rc" -ne 0 ]; then
  ok "planted failure propagates under --parallel 4 (RESULT: FAIL, non-zero exit)"
else
  not_ok "planted failure propagates under --parallel 4" "rc=$planted_rc result=$(echo "$planted_out" | grep ^RESULT)"
fi

rm -f "$PLANT"
trap - EXIT

# ----- 7. Worktree tier dispatches under --worktree -----
# v0.4.0 Wave 1 MR 3: new tier registers cleanly and the banner appears.
wt_out=$(bash "$RUNNER" --worktree --parallel 4 2>&1)
if echo "$wt_out" | grep -q "## Worktree Tests"; then
  ok "--worktree dispatches; banner printed"
else
  not_ok "--worktree dispatches; banner printed" "missing banner"
fi

# ----- 8. --worktree reports a positive test-file count -----
# The worktree tier grew from 1 file (t01-helpers) to 5 with v0.4.0 MR 7
# (t02-create, t03-merge, t04-discard-list-verify, t05-audit-first). The
# count is no longer pinned — assert > 0 so future MRs adding tests don't
# trip the smoke without losing the "tier dispatched and reported" check.
wt_count=$(echo "$wt_out" | grep -oE "^Test files: [0-9]+$" | grep -oE "[0-9]+$" || echo "")
if [ -n "$wt_count" ] && [ "$wt_count" -gt 0 ]; then
  ok "--worktree reports >0 test files (got $wt_count)"
else
  not_ok "--worktree reports >0 test files" "got: $(echo "$wt_out" | grep -E "^Test files")"
fi

# ----- 9. --ci profile dispatches the worktree tier -----
ci_out=$(bash "$RUNNER" --ci --filter "t01-helpers" 2>&1)
if echo "$ci_out" | grep -q "## Worktree Tests"; then
  ok "--ci dispatches worktree tier"
else
  not_ok "--ci dispatches worktree tier" "missing worktree banner under --ci"
fi

# ----- 10. _results sidecar dir ends the run empty (verbose mode, inspectable) -----
bash "$RUNNER" --smoke --parallel 2 --verbose >/dev/null 2>&1 || true
latest_log=$(find "$TESTS_ROOT/logs" -maxdepth 1 -type d -name "20*" 2>/dev/null | sort | tail -1)
if [ -n "$latest_log" ] && [ -d "$latest_log/_results" ]; then
  remaining=$(find "$latest_log/_results" -maxdepth 1 -name "*.meta" -type f | wc -l | tr -d ' ')
  if [ "$remaining" -eq 0 ]; then
    ok "_results sidecar dir contains no leftover .meta files after run"
  else
    not_ok "_results sidecar dir contains no leftover .meta files after run" "$remaining left"
  fi
else
  not_ok "_results sidecar dir contains no leftover .meta files after run" \
    "log dir or _results missing (latest=$latest_log)"
fi

finish
