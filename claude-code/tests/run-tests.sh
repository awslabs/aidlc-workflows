#!/bin/bash
# Master test runner for AI-DLC testing harness
# Usage: bash tests/run-tests.sh [TIER...] [PROFILE...] [OPTIONS]
set -uo pipefail
trap 'printf "\nInterrupted.\n"; exit 130' INT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

show_usage() {
  cat <<'USAGE'
Usage: bash tests/run-tests.sh [TIER...] [PROFILE...] [OPTIONS]

TIER FLAGS (combinable, each selects exactly its tier):
  --smoke         Structural validation (files exist, permissions, settings)
  --unit          Single-component isolation (hooks, frontmatter, knowledge)
  --feature       Cross-component contracts (scope mapping, protocol, I/O chains)
  --integration   CLI utilities via claude (--init, --doctor, --status, jumps)
  --stage         Individual stage tests with stub fixtures
  --workflow      Full multi-stage --test-run workflows (bugfix, POC, jumps)
  --worktree      Worktree primitive tests (git worktree add/remove + helpers)
  --tui           Rendered end-to-end tests through the real terminal UI
                  (tmux on macOS/Linux, node-pty under node on Windows).
                  Capability-gated: SKIPs with a reason where the terminal
                  substrate or claude CLI is absent. The token-spending tests
                  need AIDLC_TUI_LIVE=1; the capability preflight always runs.

PROFILE FLAGS (shortcuts — map to test pyramid layers):
  (default)       L1: smoke + unit + feature              [no LLM, ~30s]
  --ci            L2: + integration + stage                [claude CLI]
  --release       L3: + workflow + tui                     [claude CLI + tmux]
  --all           Same as --release

OUTPUT MODIFIERS (combinable with any tier/profile):
  --verbose       Write per-test logs to tests/logs/
  --debug         Implies --verbose; adds .trace.log files with bash -x
  --filter PAT    Only run tests whose filename matches extended regex PAT
  --parallel N    Run up to N test files concurrently within a tier (alias: -P N).
                  Default: 1 (serial). Smoke and unit tiers always run serially.
                  Recommended range: 1-8. See docs/reference/09-testing.md.

  -h, --help      Show this help and exit

EXAMPLES:
  bash tests/run-tests.sh                        # L1 default (seconds)
  bash tests/run-tests.sh --ci                   # L1+L2 for CI (minutes)
  bash tests/run-tests.sh --release              # All layers (hours)
  bash tests/run-tests.sh --stage --debug        # Stage tests only with traces
  bash tests/run-tests.sh --smoke --workflow     # Specific tiers
  bash tests/run-tests.sh --all --debug          # Everything with traces
  bash tests/run-tests.sh --integration --filter "t25|t26" --debug
  bash tests/run-tests.sh --all --parallel 4     # 4-way parallel for LLM tiers
USAGE
}

RUN_SMOKE=false
RUN_UNIT=false
RUN_FEATURE=false
RUN_INTEGRATION=false
RUN_WORKFLOW=false
RUN_STAGE=false
RUN_WORKTREE=false
RUN_TUI=false
VERBOSE=false
DEBUG=false
FILTER=""
LOG_DIR=""
PARALLEL=1

TIER_SELECTED=false

while [ $# -gt 0 ]; do
  case "$1" in
    --smoke)       RUN_SMOKE=true; TIER_SELECTED=true ;;
    --unit)        RUN_UNIT=true; TIER_SELECTED=true ;;
    --feature)     RUN_FEATURE=true; TIER_SELECTED=true ;;
    --integration) RUN_INTEGRATION=true; TIER_SELECTED=true ;;
    --workflow)    RUN_WORKFLOW=true; TIER_SELECTED=true ;;
    --stage)       RUN_STAGE=true; TIER_SELECTED=true ;;
    --worktree)    RUN_WORKTREE=true; TIER_SELECTED=true ;;
    --tui)         RUN_TUI=true; TIER_SELECTED=true ;;
    --ci)          RUN_SMOKE=true; RUN_UNIT=true; RUN_FEATURE=true; RUN_INTEGRATION=true; RUN_STAGE=true; RUN_WORKTREE=true; TIER_SELECTED=true ;;
    --release)     RUN_SMOKE=true; RUN_UNIT=true; RUN_FEATURE=true; RUN_INTEGRATION=true; RUN_STAGE=true; RUN_WORKFLOW=true; RUN_WORKTREE=true; RUN_TUI=true; TIER_SELECTED=true ;;
    --all)         RUN_SMOKE=true; RUN_UNIT=true; RUN_FEATURE=true; RUN_INTEGRATION=true; RUN_STAGE=true; RUN_WORKFLOW=true; RUN_WORKTREE=true; RUN_TUI=true; TIER_SELECTED=true ;;
    --verbose)     VERBOSE=true ;;
    --debug)       DEBUG=true; VERBOSE=true ;;
    --filter)      FILTER="$2"; shift ;;
    --parallel|-P)
      PARALLEL="${2:-}"
      if ! [[ "$PARALLEL" =~ ^[1-9][0-9]*$ ]]; then
        echo "ERROR: --parallel requires a positive integer (got: '${PARALLEL:-<missing>}')" >&2
        exit 2
      fi
      shift
      ;;
    -h|--help)     show_usage; exit 0 ;;
    *) echo "Unknown flag: $1"; echo ""; show_usage; exit 1 ;;
  esac
  shift
done

# Default to L1 (smoke + unit + feature) when no tier/profile flag was given
if [ "$TIER_SELECTED" = false ]; then
  RUN_SMOKE=true
  RUN_UNIT=true
  RUN_FEATURE=true
fi

# Set up verbose logging directory
if [ "$VERBOSE" = true ]; then
  LOG_DIR="$SCRIPT_DIR/logs/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  mkdir -p "$LOG_DIR"
  LOG_DIR="$(cd "$LOG_DIR" && pwd)"
  export AIDLC_TEST_VERBOSE=true
  export AIDLC_TEST_LOG_DIR="$LOG_DIR"
  echo "Verbose mode: logging to $LOG_DIR"
else
  # Even in non-verbose mode, workers need a private scratch dir for per-file
  # .meta sidecars so the parent can aggregate results after `wait`.
  LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-run-tests.XXXXXX")
  trap 'rm -rf "$LOG_DIR"' EXIT
fi

# Create the per-file results dir used by run_test_file (workers) and
# aggregate_tier_results (parent). Empty between tiers.
RESULTS_DIR="$LOG_DIR/_results"
mkdir -p "$RESULTS_DIR"

# Set up debug tracing — per-test trace files live alongside the per-test logs.
# No combined trace file: parallelism would interleave writes, and
# `cat $LOG_DIR/*.trace.log` reproduces the combined view on demand.
if [ "$DEBUG" = true ]; then
  export AIDLC_TEST_DEBUG=true
  echo "Debug traces: $LOG_DIR/*.trace.log"
fi

# Ensure bun is in PATH (may be installed in $HOME/.bun/bin)
if [ -d "$HOME/.bun/bin" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Check jq availability (required by hook unit tests and feature tests)
if [ "$RUN_UNIT" = true ] || [ "$RUN_FEATURE" = true ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required for unit/feature tests. Install via: apt-get install jq"
    exit 1
  fi
fi

# Source env vars from project settings.json (provider config: Bedrock, etc.)
PROJECT_SETTINGS="$SCRIPT_DIR/../.claude/settings.json"
if [ -f "$PROJECT_SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  eval "$(jq -r '.env // {} | to_entries[] | "export \(.key)=\(.value | @sh)"' "$PROJECT_SETTINGS")"
fi

# Check claude CLI availability for LLM-dependent tiers
NEEDS_LLM=false
if [ "$RUN_INTEGRATION" = true ] || [ "$RUN_WORKFLOW" = true ] || [ "$RUN_STAGE" = true ]; then
  NEEDS_LLM=true
  if ! command -v claude >/dev/null 2>&1; then
    echo "WARNING: claude CLI not found — integration/stage/workflow tests will be skipped"
    RUN_INTEGRATION=false
    RUN_STAGE=false
    RUN_WORKFLOW=false
    NEEDS_LLM=false
  fi
fi

# Check timeout availability (GNU coreutils; not shipped on macOS)
if [ "$NEEDS_LLM" = true ]; then
  if ! command -v timeout >/dev/null 2>&1; then
    echo "ERROR: timeout (GNU coreutils) required for LLM tests"
    echo "  Linux:  sudo yum install coreutils   # or apt-get install coreutils"
    echo "  macOS:  brew install coreutils && add gnubin to PATH (see docs/reference/11-contributing.md)"
    exit 1
  fi
fi

TOTAL_FILES=0
FAILED_FILES=0
TOTAL_TESTS=0
TOTAL_FAILED=0

# Per-file results for summary (populated by run_test_file)
declare -a RESULT_NAMES=()
declare -a RESULT_STATUSES=()
declare -a RESULT_TESTS=()
declare -a RESULT_FAILED=()
declare -a RESULT_DURATIONS=()

# run_test_file — worker-safe. Writes a sidecar .meta per file to $RESULTS_DIR
# and a per-test .log / .trace.log to $LOG_DIR. Does NOT mutate parent globals,
# so it is safe to background with `&`. Aggregation happens after `wait` in
# aggregate_tier_results.
#
# Args: $1 = test file path; $2 = parallel_mode (0 | 1, default 0).
#
# When parallel_mode=1, TAP output is buffered to a tempfile and flushed as a
# single contiguous block under a directory-mutex, so concurrent workers can't
# interleave lines on the terminal. Per-file .log and .meta sidecars are
# unaffected — they've always been written after the test finishes.
#
# When parallel_mode=0, output streams live through `tee` (same as always) so
# long serial tests show progress line-by-line.
run_test_file() {
  local file="$1"
  local parallel_mode="${2:-0}"
  local name
  name=$(basename "$file")

  if [ -n "$FILTER" ] && ! echo "$name" | grep -qE "$FILTER"; then
    return 0
  fi

  export AIDLC_TEST_NAME="$name"

  # START marker streams live in both modes. Under --parallel, seeing several
  # STARTs land before the first DONE is the visible signal that workers are
  # running concurrently.
  echo ""
  echo "=== START $name ==="

  local start_seconds=$SECONDS
  local tmpout
  tmpout=$(mktemp "${TMPDIR:-/tmp}/aidlc-run-tests-out.XXXXXX")
  local rc
  if [ "$parallel_mode" = "1" ]; then
    # Buffer silently to the tempfile — no live stream. The block gets flushed
    # to stdout under the directory-mutex below.
    if [ "$DEBUG" = true ]; then
      local trace_file="$LOG_DIR/${name}.trace.log"
      bash -x "$file" >"$tmpout" 2>"$trace_file"
      rc=$?
    else
      bash "$file" >"$tmpout" 2>&1
      rc=$?
    fi
  else
    # Serial: live-stream through tee.
    if [ "$DEBUG" = true ]; then
      local trace_file="$LOG_DIR/${name}.trace.log"
      bash -x "$file" 2>"$trace_file" | tee "$tmpout"
      rc=${PIPESTATUS[0]}
    else
      bash "$file" 2>&1 | tee "$tmpout"
      rc=${PIPESTATUS[0]}
    fi
  fi
  local output
  output=$(cat "$tmpout")
  local duration=$(( SECONDS - start_seconds ))

  # Extract test counts from TAP output
  local file_tests file_failed
  file_tests=$(echo "$output" | grep -cE "^ok|^not ok" || true)
  file_failed=$(echo "$output" | grep -cE "^not ok" || true)

  local status
  if [ "$rc" -ne 0 ]; then
    status="FAIL"
  else
    status="PASS"
  fi

  # Flush body + status banner + DONE marker. In parallel mode, take a
  # directory-mutex (`mkdir` is atomic on POSIX, works on macOS bash 3.2 —
  # no `flock` needed) so the full block prints contiguously. In serial
  # mode the body already streamed via tee, so we only print the banner
  # and DONE.
  if [ "$parallel_mode" = "1" ]; then
    local lock_dir="$LOG_DIR/.stdout.lock"
    while ! mkdir "$lock_dir" 2>/dev/null; do sleep 0.05; done
    cat "$tmpout"
    if [ "$rc" -ne 0 ]; then
      echo "--- FAIL: $name ($file_failed failures) ---"
    else
      echo "--- PASS: $name ---"
    fi
    echo "=== DONE $name ($status) ==="
    rmdir "$lock_dir" 2>/dev/null || true
  else
    if [ "$rc" -ne 0 ]; then
      echo "--- FAIL: $name ($file_failed failures) ---"
    else
      echo "--- PASS: $name ---"
    fi
    echo "=== DONE $name ($status) ==="
  fi
  rm -f "$tmpout"

  # Write per-file sidecar for parent aggregation. Atomic mv ensures the
  # parent never reads a half-written file.
  local meta_tmp="$RESULTS_DIR/.${name}.meta.$$"
  {
    echo "NAME=$name"
    echo "STATUS=$status"
    echo "TESTS=$file_tests"
    echo "FAILED=$file_failed"
    echo "DURATION=$duration"
    echo "RC=$rc"
  } > "$meta_tmp"
  mv "$meta_tmp" "$RESULTS_DIR/${name}.meta"

  # Write per-test log when verbose
  if [ "$VERBOSE" = true ]; then
    local log_file="$LOG_DIR/${name}.log"
    {
      echo "Test: $name"
      echo "File: $file"
      echo "Status: $status"
      echo "Assertions: $file_tests (failed: $file_failed)"
      echo "Duration: ${duration}s"
      echo "Exit code: $rc"
      echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo ""
      echo "--- Output ---"
      echo "$output"
    } > "$log_file"
    if [ "$status" = "FAIL" ]; then
      echo "" >> "$log_file"
      echo "--- Not-ok lines ---" >> "$log_file"
      echo "$output" | grep -E "^not ok" >> "$log_file" || true
    fi
  fi
}

# run_bun_test_file — worker-safe sibling of run_test_file for bun `.test.ts`
# files. Runs `bun test <file> --reporter=junit`, then normalizes the JUnit XML
# into the SAME 6-line .meta sidecar via the glue tool, so
# aggregate_tier_results stays agnostic to how a file ran. Does NOT mutate
# parent globals — safe to background with `&`. Mirrors run_test_file's
# parallel/serial stdout discipline (the $LOG_DIR/.stdout.lock mutex).
#
# NAME = file basename minus the `.test.ts` suffix (mirrors how the bash branch
# names a .meta per FILE). --bun-rc passes bun's REAL exit code into the glue —
# the only signal that turns an import/collection crash (nonzero rc, no XML)
# into STATUS=FAIL instead of a vacuous PASS.
#
# Args: $1 = test file path; $2 = parallel_mode (0 | 1, default 0).
run_bun_test_file() {
  local file="$1"
  local parallel_mode="${2:-0}"
  local base name
  base=$(basename "$file")
  name="${base%.test.ts}"

  if [ -n "$FILTER" ] && ! echo "$base" | grep -qE "$FILTER"; then
    return 0
  fi

  export AIDLC_TEST_NAME="$base"

  echo ""
  echo "=== START $base ==="

  local start_seconds=$SECONDS
  local tmpout junit_xml
  tmpout=$(mktemp "${TMPDIR:-/tmp}/aidlc-run-tests-out.XXXXXX")
  junit_xml=$(mktemp "${TMPDIR:-/tmp}/aidlc-run-tests-junit.XXXXXX.xml")

  # Run bun and CAPTURE its exit code on the very next line, before any other
  # command can reset $?. bun has no bash -x equivalent; --debug still captures
  # the run output for the per-test log.
  local bun_rc
  bun test "$file" --reporter=junit --reporter-outfile="$junit_xml" >"$tmpout" 2>&1
  bun_rc=$?

  # Normalize the JUnit XML into the .meta the parent aggregates. The glue is
  # the authority on STATUS/TESTS/FAILED; --bun-rc is mandatory so a crash that
  # produced no XML still maps to STATUS=FAIL.
  bun "$SCRIPT_DIR/lib/bun-junit-to-meta.ts" \
    --xml "$junit_xml" \
    --out "$RESULTS_DIR/${name}.meta" \
    --name "$name" \
    --bun-rc "$bun_rc" >>"$tmpout" 2>&1 || true

  local output
  output=$(cat "$tmpout")

  local status
  if [ "$bun_rc" -ne 0 ]; then
    status="FAIL"
  else
    status="PASS"
  fi

  # Flush body + banner + DONE marker under the directory-mutex in parallel
  # mode (mirrors run_test_file exactly), or directly in serial mode.
  if [ "$parallel_mode" = "1" ]; then
    local lock_dir="$LOG_DIR/.stdout.lock"
    while ! mkdir "$lock_dir" 2>/dev/null; do sleep 0.05; done
    cat "$tmpout"
    if [ "$bun_rc" -ne 0 ]; then
      echo "--- FAIL: $base ---"
    else
      echo "--- PASS: $base ---"
    fi
    echo "=== DONE $base ($status) ==="
    rmdir "$lock_dir" 2>/dev/null || true
  else
    cat "$tmpout"
    if [ "$bun_rc" -ne 0 ]; then
      echo "--- FAIL: $base ---"
    else
      echo "--- PASS: $base ---"
    fi
    echo "=== DONE $base ($status) ==="
  fi
  rm -f "$tmpout" "$junit_xml"

  # Write per-test log when verbose (mirrors run_test_file's .log shape).
  if [ "$VERBOSE" = true ]; then
    local log_file="$LOG_DIR/${base}.log"
    {
      echo "Test: $base"
      echo "File: $file"
      echo "Status: $status"
      echo "Exit code: $bun_rc"
      echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo ""
      echo "--- Output ---"
      echo "$output"
    } > "$log_file"
  fi
}

# run_one_file — dispatch a single test file to the right worker by extension,
# in the given parallel_mode (0 = serial/foreground, 1 = parallel/buffered).
# Unifies the two historical discovery passes (the bash `t*.sh` loop and the
# separate bun `.test.ts` pass) into one call site, so a tier walks its files
# ONCE.
# Args: $1 = file path; $2 = parallel_mode (0 | 1, default 0).
run_one_file() {
  local f="$1"
  local parallel_mode="${2:-0}"
  case "$f" in
    *.test.ts) run_bun_test_file "$f" "$parallel_mode" ;;
    *)         run_test_file "$f" "$parallel_mode" ;;
  esac
}

is_legacy_serial_file() {
  case "$1" in
    # Legacy bash name cannot gain a *.serial.* tag in milestone 0; it mutates/checks
    # graph fixtures and must not overlap neighbouring feature files under -P.
    t66-graph-library.sh) return 0 ;;
    *) return 1 ;;
  esac
}

# run_files_partitioned — the shared two-phase scheduler used by BOTH run_tier
# and the integration special-case loop. Collects the tier's files (both
# `t*.sh` and `*.test.ts`) and splits them into two partitions:
#
#   PHASE 1 (serial / exclusive): every file that is tier-pinned-serial OR whose
#   basename matches `*.serial.*`. Run one at a time in the FOREGROUND so a
#   serial file never overlaps anything — not another serial file, not a
#   parallel one (phase 2 has not started yet).
#
#   PHASE 2 (parallel): the rest, fanned out with the existing `jobs -rp | wc -l`
#   slot gate at $effective_parallel. When effective_parallel == 1 these also
#   run serially in the foreground (same as the legacy `-eq 1` branch).
#
# Tier-pinned serial-ness is computed here from the dir name (mirrors the case
# stmt in run_tier): smoke|unit|worktree force ALL files into phase 1, leaving
# phase 2 empty — provably identical to the old whole-tier-serial behaviour.
# For non-pinned tiers with no `*.serial.*` file, phase 1 is empty and phase 2
# runs everything in parallel — identical to today.
#
# Both phases write .meta into the SAME $RESULTS_DIR. The caller owns the single
# `wait` + lock cleanup + aggregate_tier_results that follows.
#
# Args: $1 = tier dir (relative to $SCRIPT_DIR); $2 = effective_parallel.
# Optional $3.. = extra glob-relative basenames to EXCLUDE (e.g. the integration
# preflight file, which the caller already ran).
run_files_partitioned() {
  local dir="$1"
  local effective_parallel="$2"
  shift 2
  local exclude
  local tier_pinned_serial=false
  case "$dir" in
    smoke|unit|worktree) tier_pinned_serial=true ;;
  esac

  # Collect the tier's files once: both bash TAP and bun .test.ts. The
  # [ -f "$f" ] guard skips the literal-glob passthrough when a pattern matches
  # nothing (e.g. a dir with no .test.ts).
  local f base skip
  local -a serial_files=()
  local -a parallel_files=()
  for f in "$SCRIPT_DIR/$dir"/t*.sh "$SCRIPT_DIR/$dir"/*.test.ts; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    # Honor caller-supplied exclusions (matched against basename).
    skip=false
    for exclude in "$@"; do
      [ "$base" = "$exclude" ] && skip=true && break
    done
    [ "$skip" = true ] && continue
    # Partition: tier-pinned serial OR *.serial.* tag OR known legacy serial
    # bash file => phase 1.
    if [ "$tier_pinned_serial" = true ] || [[ "$base" == *.serial.* ]] || is_legacy_serial_file "$base"; then
      serial_files+=("$f")
    else
      parallel_files+=("$f")
    fi
  done

  # PHASE 1 — serial partition. Foreground, one at a time, exclusive. Runs
  # before any parallel fan-out so a serial file never overlaps anything.
  for f in ${serial_files[@]+"${serial_files[@]}"}; do
    run_one_file "$f" 0
  done

  # PHASE 2 — parallel partition. Honor effective_parallel; at 1 this is a
  # foreground serial loop (matches the legacy `-eq 1` branch exactly).
  for f in ${parallel_files[@]+"${parallel_files[@]}"}; do
    if [ "$effective_parallel" -eq 1 ]; then
      run_one_file "$f" 0
    else
      run_one_file "$f" 1 &
      while [ "$(jobs -rp | wc -l)" -ge "$effective_parallel" ]; do
        sleep 0.2
      done
    fi
  done
}

# aggregate_tier_results — called after `wait` at the end of a tier. Reads all
# .meta sidecars in $RESULTS_DIR, pushes into RESULT_* arrays, increments
# totals, then clears the dir for the next tier.
aggregate_tier_results() {
  # Sort by name so parallel runs produce a deterministic summary order.
  # Read the sorted list via process substitution — simpler and avoids the
  # bash 3.2 + `set -u` quirk where `"${arr[@]}"` errors on empty arrays.
  local meta
  while IFS= read -r meta; do
    [ -z "$meta" ] && continue
    local NAME="" STATUS="" TESTS=0 FAILED=0 DURATION=0 RC=0
    # shellcheck disable=SC1090
    source "$meta"
    TOTAL_FILES=$((TOTAL_FILES + 1))
    TOTAL_TESTS=$((TOTAL_TESTS + TESTS))
    TOTAL_FAILED=$((TOTAL_FAILED + FAILED))
    if [ "$STATUS" = "FAIL" ]; then
      FAILED_FILES=$((FAILED_FILES + 1))
    fi
    RESULT_NAMES+=("$NAME")
    RESULT_STATUSES+=("$STATUS")
    RESULT_TESTS+=("$TESTS")
    RESULT_FAILED+=("$FAILED")
    RESULT_DURATIONS+=("$DURATION")
  done < <(find "$RESULTS_DIR" -maxdepth 1 -name "*.meta" -type f 2>/dev/null | sort)

  # Clear for next tier
  find "$RESULTS_DIR" -maxdepth 1 -name "*.meta" -type f -delete 2>/dev/null || true
}

# run_tier — orchestrates a tier. Smoke and unit always run serially; other
# tiers honor $PARALLEL. macOS ships bash 3.2 which lacks `wait -n`, so the
# slot gate uses a short sleep poll on `jobs -rp`. Overhead is negligible
# against minute-long `claude -p` calls.
run_tier() {
  local dir="$1"
  local label="$2"
  local effective_parallel="$PARALLEL"
  case "$dir" in
    # Worktree tests fork temp git repos and add child worktrees inside
    # them. Parallel callers each get their own mktemp dir (no path
    # collisions), but interleaved git registry mutations have not been
    # exercised under load yet. Pin to serial until a future PR adds
    # enough worktree tests to make parallelism worth proving safe.
    smoke|unit|worktree) effective_parallel=1 ;;
  esac
  echo ""
  if [ "$effective_parallel" -gt 1 ]; then
    echo "## $label (parallel=$effective_parallel)"
  else
    echo "## $label"
  fi
  # Two-phase partition: serial files (tier-pinned OR *.serial.*) run first,
  # exclusive, in the foreground; the rest fan out at $effective_parallel. Both
  # phases write .meta to $RESULTS_DIR for the shared wait + aggregate below.
  run_files_partitioned "$dir" "$effective_parallel"
  wait
  # Clear any stale stdout-flush mutex (worker killed mid-flush would leak it).
  rmdir "$LOG_DIR/.stdout.lock" 2>/dev/null || true
  aggregate_tier_results
}

echo "AI-DLC Testing Harness"
echo "======================"

# Smoke tier
if [ "$RUN_SMOKE" = true ]; then
  run_tier "smoke" "Smoke Tests (structural)"
fi

# Fail-fast: if smoke had failures, abort before slower tiers
if [ "$RUN_SMOKE" = true ] && [ "$FAILED_FILES" -gt 0 ]; then
  echo ""
  echo "SMOKE FAILURES DETECTED — aborting before unit/feature tiers"
  echo ""
  echo "=============================="
  echo "SUMMARY"
  echo "=============================="
  echo "Test files: $TOTAL_FILES"
  echo "Failed files: $FAILED_FILES"
  echo "Total assertions: $TOTAL_TESTS"
  echo "Failed assertions: $TOTAL_FAILED"
  if [ "$VERBOSE" = true ] && [ -n "$LOG_DIR" ]; then
    echo "Log directory: ${LOG_DIR#"$SCRIPT_DIR"/}"
  fi
  echo "=============================="
  echo "RESULT: FAIL"
  exit "$FAILED_FILES"
fi

# Unit tier
if [ "$RUN_UNIT" = true ]; then
  run_tier "unit" "Unit Tests (single-component isolation)"
fi

# Feature tier
if [ "$RUN_FEATURE" = true ]; then
  run_tier "feature" "Feature Tests (cross-component correctness)"
fi

# Preflight gate: runs before ANY LLM-dependent tier (integration, stage,
# workflow). Always serial — it's a single file and later tiers depend on it.
if [ "$NEEDS_LLM" = true ]; then
  PREFLIGHT="$SCRIPT_DIR/integration/t19-preflight-health.sh"
  if [ -f "$PREFLIGHT" ]; then
    echo ""
    echo "## Preflight Health Check (Claude CLI validation)"
    run_test_file "$PREFLIGHT"
    aggregate_tier_results

    # Check if preflight passed
    PREFLIGHT_PASSED=true
    for i in "${!RESULT_NAMES[@]}"; do
      if [[ "${RESULT_NAMES[$i]}" == *"preflight"* ]] && [ "${RESULT_STATUSES[$i]}" = "FAIL" ]; then
        PREFLIGHT_PASSED=false
        break
      fi
    done

    if [ "$PREFLIGHT_PASSED" = false ]; then
      echo ""
      echo "PREFLIGHT FAILURE — skipping all LLM-dependent tests"
      echo "  Fix: ensure claude CLI is authenticated and API is responsive"
      RUN_INTEGRATION=false
      RUN_STAGE=false
      RUN_WORKFLOW=false
    fi
  fi
fi

# Integration tier (preflight already ran above; excluded from the glob below)
if [ "$RUN_INTEGRATION" = true ]; then
  echo ""
  if [ "$PARALLEL" -gt 1 ]; then
    echo "## Integration Tests (Claude CLI end-to-end) (parallel=$PARALLEL)"
  else
    echo "## Integration Tests (Claude CLI end-to-end)"
  fi
  # Same two-phase partitioner as run_tier, excluding the preflight file the
  # gate above already ran. Serial files (tier-pinned — integration is not
  # pinned — OR *.serial.*) run first/exclusive; the rest fan out at $PARALLEL.
  run_files_partitioned "integration" "$PARALLEL" "t19-preflight-health.sh"
  wait
  rmdir "$LOG_DIR/.stdout.lock" 2>/dev/null || true
  aggregate_tier_results
fi

# Stage tier
if [ "$RUN_STAGE" = true ]; then
  run_tier "stage" "Stage Tests (individual stages with stubs)"
fi

# Workflow tier
if [ "$RUN_WORKFLOW" = true ]; then
  run_tier "workflow" "Workflow Tests (multi-stage --test-run)"
fi

# Worktree tier — no LLM dependency, runs after preflight gate so it executes
# even when claude CLI is unavailable.
if [ "$RUN_WORKTREE" = true ]; then
  run_tier "worktree" "Worktree Tests (primitive helpers)"
fi

# TUI tier (rendered end-to-end) — runs LAST, after the workflow tier. Gated by
# its OWN capability preflight (t-tui-preflight), modelled on the t19 integration
# gate above: the preflight runs FIRST (it is `*.serial.*` and proves the
# terminal substrate works), and if it FAILS LOUD (substrate present-but-broken)
# the tier's remaining files are skipped. A clean ABSENT substrate reports as a
# bun:test skip — STATUS=PASS (skips don't fail a file) — so the tier still runs
# and its other files self-skip with a reason. The token-spending tests
# (t-tui-workshop) gate further on AIDLC_TUI_LIVE=1. This tier does NOT ride the
# claude-CLI NEEDS_LLM gate: the preflight spends no tokens and needs no claude,
# so it always renders the capability verdict; the claude-dependent files
# self-skip on a missing CLI.
if [ "$RUN_TUI" = true ]; then
  TUI_PREFLIGHT="$SCRIPT_DIR/tui/t-tui-preflight.serial.tui.test.ts"
  echo ""
  if [ "$PARALLEL" -gt 1 ]; then
    echo "## TUI Tests (rendered E2E) (parallel=$PARALLEL)"
  else
    echo "## TUI Tests (rendered E2E)"
  fi
  if [ -f "$TUI_PREFLIGHT" ]; then
    # Run the capability preflight first (serial, foreground), then aggregate so
    # its .meta lands in RESULT_* before the gate check.
    run_one_file "$TUI_PREFLIGHT" 0
    aggregate_tier_results

    TUI_PREFLIGHT_OK=true
    for i in "${!RESULT_NAMES[@]}"; do
      if [[ "${RESULT_NAMES[$i]}" == *"preflight"* ]] && [ "${RESULT_STATUSES[$i]}" = "FAIL" ]; then
        TUI_PREFLIGHT_OK=false
        break
      fi
    done

    if [ "$TUI_PREFLIGHT_OK" = false ]; then
      echo ""
      echo "TUI PREFLIGHT FAILURE — skipping remaining TUI tests"
      echo "  The terminal substrate is present but broken (e.g. node-pty under"
      echo "  bun on Windows, microsoft/node-pty #748; or tmux capture empty)."
    else
      # Run the tier's remaining files via the same two-phase partitioner the
      # integration tier uses, excluding the preflight already run above.
      run_files_partitioned "tui" "$PARALLEL" "t-tui-preflight.serial.tui.test.ts"
      wait
      rmdir "$LOG_DIR/.stdout.lock" 2>/dev/null || true
      aggregate_tier_results
    fi
  else
    echo "  (no tui preflight file found; skipping tier)"
  fi
fi

# Write verbose summary and failures files
if [ "$VERBOSE" = true ] && [ -n "$LOG_DIR" ]; then
  # Build tiers-run string
  tiers_run=""
  [ "$RUN_SMOKE" = true ] && tiers_run="${tiers_run}smoke "
  [ "$RUN_UNIT" = true ] && tiers_run="${tiers_run}unit "
  [ "$RUN_FEATURE" = true ] && tiers_run="${tiers_run}feature "
  [ "$RUN_INTEGRATION" = true ] && tiers_run="${tiers_run}integration "
  [ "$RUN_STAGE" = true ] && tiers_run="${tiers_run}stage "
  [ "$RUN_WORKFLOW" = true ] && tiers_run="${tiers_run}workflow "
  [ "$RUN_WORKTREE" = true ] && tiers_run="${tiers_run}worktree "
  [ "$RUN_TUI" = true ] && tiers_run="${tiers_run}tui "
  tiers_run="${tiers_run% }"

  # summary.txt
  {
    echo "AI-DLC Test Run Summary"
    echo "======================"
    echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Tiers: $tiers_run"
    if [ "$DEBUG" = true ]; then
      echo "Mode: debug (bash -x)"
    fi
    echo ""
    echo "Per-file results:"
    printf "  %-40s %-6s %10s %10s %10s\n" "File" "Status" "Assertions" "Failed" "Duration"
    printf "  %-40s %-6s %10s %10s %10s\n" "----" "------" "----------" "------" "--------"
    for i in "${!RESULT_NAMES[@]}"; do
      printf "  %-40s %-6s %10s %10s %9ss\n" \
        "${RESULT_NAMES[$i]}" "${RESULT_STATUSES[$i]}" "${RESULT_TESTS[$i]}" "${RESULT_FAILED[$i]}" "${RESULT_DURATIONS[$i]}"
    done
    echo ""
    echo "Totals:"
    echo "  Test files: $TOTAL_FILES"
    echo "  Failed files: $FAILED_FILES"
    echo "  Total assertions: $TOTAL_TESTS"
    echo "  Failed assertions: $TOTAL_FAILED"
    if [ "$FAILED_FILES" -gt 0 ]; then
      echo "  Result: FAIL"
    else
      echo "  Result: PASS"
    fi
  } > "$LOG_DIR/summary.txt"

  # failures.txt
  {
    if [ "$FAILED_FILES" -gt 0 ]; then
      for i in "${!RESULT_NAMES[@]}"; do
        if [ "${RESULT_STATUSES[$i]}" = "FAIL" ]; then
          echo "FAIL: ${RESULT_NAMES[$i]} (${RESULT_FAILED[$i]} failed assertions)"
          local_log="$LOG_DIR/${RESULT_NAMES[$i]}.log"
          if [ -f "$local_log" ]; then
            grep -E "^not ok" "$local_log" | sed 's/^/  /' || true
          fi
          echo ""
        fi
      done
    fi
  } > "$LOG_DIR/failures.txt"
fi

# Summary
echo ""
echo "=============================="
echo "SUMMARY"
echo "=============================="
echo "Test files: $TOTAL_FILES"
echo "Failed files: $FAILED_FILES"
echo "Total assertions: $TOTAL_TESTS"
echo "Failed assertions: $TOTAL_FAILED"
if [ "$VERBOSE" = true ] && [ -n "$LOG_DIR" ]; then
  echo "Log directory: ${LOG_DIR#"$SCRIPT_DIR"/}"
fi
echo "=============================="

if [ "$FAILED_FILES" -gt 0 ]; then
  echo "RESULT: FAIL"
else
  echo "RESULT: PASS"
fi

exit "$FAILED_FILES"
