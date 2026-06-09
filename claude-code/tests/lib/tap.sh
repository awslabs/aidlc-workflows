#!/bin/bash
# Minimal TAP (Test Anything Protocol) assertion helpers
# Usage: source this file, call assertions, then call finish

TESTS_RUN=0
TESTS_FAILED=0
TESTS_PLANNED=0

plan() {
  TESTS_PLANNED=$1
  echo "1..$1"
}

ok() {
  local msg="$1"
  TESTS_RUN=$((TESTS_RUN + 1))
  echo "ok $TESTS_RUN - $msg"
}

not_ok() {
  local msg="$1"
  local detail="${2:-}"
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "not ok $TESTS_RUN - $msg"
  if [ -n "$detail" ]; then echo "#   $detail"; fi
}

assert_file_exists() {
  local path="$1"
  local msg="${2:-file exists: $path}"
  if [ -f "$path" ]; then
    ok "$msg"
  else
    not_ok "$msg" "file not found: $path"
  fi
}

assert_dir_exists() {
  local path="$1"
  local msg="${2:-directory exists: $path}"
  if [ -d "$path" ]; then
    ok "$msg"
  else
    not_ok "$msg" "directory not found: $path"
  fi
}

assert_executable() {
  local path="$1"
  local msg="${2:-executable: $path}"
  if [ -x "$path" ]; then
    ok "$msg"
  else
    not_ok "$msg" "not executable: $path"
  fi
}

assert_grep() {
  local file="$1"
  local pattern="$2"
  local msg="${3:-grep '$pattern' in $file}"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    ok "$msg"
  else
    not_ok "$msg" "pattern not found: $pattern"
  fi
}

assert_not_grep() {
  local file="$1"
  local pattern="$2"
  local msg="${3:-no '$pattern' in $file}"
  if ! grep -q "$pattern" "$file" 2>/dev/null; then
    ok "$msg"
  else
    not_ok "$msg" "pattern unexpectedly found: $pattern"
  fi
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local msg="${3:-expected '$expected'}"
  if [ "$actual" = "$expected" ]; then
    ok "$msg"
  else
    not_ok "$msg" "got '$actual', expected '$expected'"
  fi
}

assert_not_eq() {
  local actual="$1"
  local unexpected="$2"
  local msg="${3:-not equal to '$unexpected'}"
  if [ "$actual" != "$unexpected" ]; then
    ok "$msg"
  else
    not_ok "$msg" "got '$actual', expected anything else"
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="${3:-contains '$needle'}"
  if grep -qF -- "$needle" <<< "$haystack"; then
    ok "$msg"
  else
    not_ok "$msg" "needle '$needle' not found in: $haystack"
  fi
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local msg="${3:-does not contain '$needle'}"
  if ! grep -qF -- "$needle" <<< "$haystack"; then
    ok "$msg"
  else
    not_ok "$msg" "needle '$needle' unexpectedly found in: $haystack"
  fi
}

assert_match() {
  local string="$1" regex="$2" msg="${3:-matches '$regex'}"
  if grep -qE "$regex" <<< "$string"; then
    ok "$msg"
  else
    not_ok "$msg" "string did not match regex: $regex"
  fi
}

assert_file_not_exists() {
  local path="$1" msg="${2:-file does not exist: $path}"
  if [ ! -f "$path" ]; then
    ok "$msg"
  else
    not_ok "$msg" "file unexpectedly exists: $path"
  fi
}

assert_exit_code() {
  local expected="$1" msg="$2"; shift 2
  "$@" >/dev/null 2>&1
  local actual=$?
  if [ "$actual" -eq "$expected" ]; then
    ok "$msg"
  else
    not_ok "$msg" "expected exit $expected, got $actual"
  fi
}

assert_gt() {
  local actual="$1" threshold="$2" msg="${3:-$actual > $threshold}"
  if [ "$actual" -gt "$threshold" ]; then
    ok "$msg"
  else
    not_ok "$msg" "got $actual, expected > $threshold"
  fi
}

assert_lt() {
  local actual="$1" threshold="$2" msg="${3:-$actual < $threshold}"
  if [ "$actual" -lt "$threshold" ]; then
    ok "$msg"
  else
    not_ok "$msg" "got $actual, expected < $threshold"
  fi
}

assert_line_count() {
  local file="$1" pattern="$2" expected="$3" msg="${4:-$expected lines matching '$pattern'}"
  local actual
  actual=$(grep -c "$pattern" "$file" 2>/dev/null || true)
  if [ "$actual" -eq "$expected" ]; then
    ok "$msg"
  else
    not_ok "$msg" "got $actual lines, expected $expected"
  fi
}

assert_file_min_size() {
  local path="$1" min_bytes="$2"
  local msg="${3:-file >= $min_bytes bytes}"
  if [ -f "$path" ]; then
    local actual; actual=$(wc -c < "$path")
    [ "$actual" -ge "$min_bytes" ] && ok "$msg" || not_ok "$msg" "got $actual bytes"
  else
    not_ok "$msg" "file not found: $path"
  fi
}

skip() {
  local msg="$1"
  TESTS_RUN=$((TESTS_RUN + 1))
  echo "ok $TESTS_RUN - SKIP $msg"
}

finish() {
  # Plan drift guard — a test that planned N assertions but ran M<N has
  # either crashed mid-plan or skipped a case without a TAP SKIP line.
  # Either way the run lies about what it tested, so make it a hard
  # failure (exit non-zero). See #34 / #41 for the motivating bug class.
  local drift=0
  if [ "$TESTS_PLANNED" -gt 0 ] && [ "$TESTS_RUN" -ne "$TESTS_PLANNED" ]; then
    echo "not ok $((TESTS_RUN + 1)) - plan drift: planned $TESTS_PLANNED but ran $TESTS_RUN"
    drift=1
  fi
  echo ""
  echo "# Tests run: $TESTS_RUN"
  echo "# Tests failed: $TESTS_FAILED"
  if [ "$drift" -eq 1 ]; then
    echo "# PLAN DRIFT: planned $TESTS_PLANNED but ran $TESTS_RUN"
  fi
  exit $(( (TESTS_FAILED > 0 || drift > 0) ? 1 : 0 ))
}
