#!/bin/bash
# Test fixtures: temp project creation/teardown
# Usage: source this file, then use create_test_project / cleanup_test_project

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AIDLC_SRC="$REPO_ROOT/dist/claude/.claude"
FIXTURES_DIR="$SCRIPT_DIR/../fixtures"

# Verbose logging: sequence counter for claude output logs
AIDLC_CLAUDE_LOG_SEQ=0

# Unset AIDLC-related env vars that a developer may have exported in their
# shell or that a previous test case may have leaked. Tests must run with a
# known-clean env so fixture-defined defaults aren't shadowed.
reset_aidlc_env() {
  unset AWS_AIDLC_DEFAULT_SCOPE
}

create_test_project() {
  local proj
  proj=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-test-XXXXXX")
  mkdir -p "$proj/aidlc-docs"
  # On Windows (Git Bash / MSYS), mktemp returns POSIX paths like /tmp/foo,
  # but native Windows Bun cannot resolve those. Use cygpath -m (mixed mode)
  # to produce absolute Windows paths with forward slashes (e.g.
  # "C:/Users/.../aidlc-test-X") — these are understood by both Git Bash
  # utilities and native Windows Bun, and round-trip safely through JSON.
  if command -v cygpath >/dev/null 2>&1; then
    proj=$(cygpath -m "$proj")
  fi
  echo "$proj"
}

# Portable in-place sed. BSD sed (macOS) needs `-i ''`; GNU sed (Linux, Git Bash
# on Windows) needs `-i` with no argument. Using a tempfile avoids the difference.
# Usage: sed_i "<sed-expression>" <file>
sed_i() {
  local expr="$1"
  local file="$2"
  local tmp="${file}.sedtmp"
  sed "$expr" "$file" > "$tmp" && mv "$tmp" "$file"
}

seed_state_file() {
  local proj="$1"
  local fixture_path="$2"
  mkdir -p "$proj/aidlc-docs"
  cp "$fixture_path" "$proj/aidlc-docs/aidlc-state.md"
}

seed_audit_file() {
  local proj="$1"
  mkdir -p "$proj/aidlc-docs"
  cp "$FIXTURES_DIR/audit-sample.md" "$proj/aidlc-docs/audit.md"
}

cleanup_test_project() {
  local proj="$1"
  if [ -n "$proj" ] && [ -d "$proj" ]; then rm -rf "$proj"; fi
}

# Run claude -p inside a test project, handling nested-session detection.
# Usage: run_claude "$proj" "/aidlc --status" [extra_args...]
#
# Sets two globals that callers are expected to read after the call:
#
#   CLAUDE_OUTPUT   Everything claude wrote to stdout (may be empty if the
#                   call was killed before any output was produced).
#
#   CLAUDE_RC       Exit code of the claude subprocess. Conventions:
#                     0    — claude completed normally
#                     124  — the surrounding `timeout` wrapper killed claude
#                            because the call exceeded AIDLC_TEST_TIMEOUT.
#                            This is the GNU timeout exit convention. Tests
#                            that assert on state written by claude should
#                            skip when CLAUDE_RC == 124, because the state
#                            file is likely incomplete.
#                     other — claude exited with an error of its own.
#
# AIDLC_TEST_TIMEOUT (env var, seconds) controls the wall-clock cap. Default
# is 1800s (30min). Individual tests override it at the top of the file for
# stage-specific expectations.
run_claude() {
  local proj="$1"; shift
  local prompt="$1"; shift
  local tmo="${AIDLC_TEST_TIMEOUT:-1800}"
  # Unset CLAUDECODE to allow running inside an existing Claude Code session.
  # This is the documented bypass for the nested-session guard.
  set +e
  local tmpout_claude
  tmpout_claude=$(mktemp "${TMPDIR:-/tmp}/aidlc-claude-XXXXXX")

  if [ "$tmo" -gt 0 ] 2>/dev/null; then
    (cd "$proj" && env -u CLAUDECODE timeout --kill-after=10 "$tmo" claude -p "$prompt" "$@" < /dev/null 2>&1) > "$tmpout_claude" &
  else
    (cd "$proj" && env -u CLAUDECODE claude -p "$prompt" "$@" < /dev/null 2>&1) > "$tmpout_claude" &
  fi
  local pid=$!
  # Heartbeat: print '.' every 30s to keep CI alive
  while kill -0 "$pid" 2>/dev/null; do
    sleep 30 && printf '.' >&2
  done
  wait "$pid"
  CLAUDE_RC=$?
  CLAUDE_OUTPUT=$(cat "$tmpout_claude")
  rm -f "$tmpout_claude"
  set -e

  # Write claude output to log directory when verbose
  if [ "${AIDLC_TEST_VERBOSE:-}" = "true" ] && [ -n "${AIDLC_TEST_LOG_DIR:-}" ]; then
    local seq_padded
    seq_padded=$(printf "%03d" "$AIDLC_CLAUDE_LOG_SEQ")
    AIDLC_CLAUDE_LOG_SEQ=$((AIDLC_CLAUDE_LOG_SEQ + 1))
    local test_name="${AIDLC_TEST_NAME:-unknown}"
    local log_file="$AIDLC_TEST_LOG_DIR/${test_name}-claude-${seq_padded}.log"
    {
      echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "Prompt: $prompt"
      echo "Extra args: $*"
      echo "Exit code: $CLAUDE_RC"
      echo "Project: $proj"
      echo ""
      echo "--- Output ---"
      echo "$CLAUDE_OUTPUT"
    } > "$log_file"
  fi
}

# Scaffold a test project with .claude/ copied from source and hooks made executable.
# Usage: setup_integration_project [--with-state FIXTURE] [--with-audit]
# Prints the project path.
setup_integration_project() {
  local proj
  proj=$(create_test_project)
  cp -r "$AIDLC_SRC" "$proj/.claude"
  chmod +x "$proj/.claude/hooks/"*.sh 2>/dev/null
  while [ $# -gt 0 ]; do
    case "$1" in
      --with-state)  seed_state_file "$proj" "$2"; shift 2 ;;
      --with-audit)  seed_audit_file "$proj"; shift ;;
      --no-aidlc-docs) rm -rf "$proj/aidlc-docs"; shift ;;
      --strip-env-scope)
        # Remove AWS_AIDLC_DEFAULT_SCOPE from the copied .claude/settings.json so
        # the test's shell export is authoritative. Claude Code's settings.json
        # `env` block otherwise overrides shell env for the Claude subprocess.
        if [ -f "$proj/.claude/settings.json" ]; then
          sed_i '/"AWS_AIDLC_DEFAULT_SCOPE":/d' "$proj/.claude/settings.json"
        fi
        shift ;;
      --with-greenfield-stub) cp -r "$FIXTURES_DIR/greenfield-todo/." "$proj/"; shift ;;
      --with-brownfield-stub) cp -r "$FIXTURES_DIR/brownfield-todo/." "$proj/"; shift ;;
      --with-re-artifacts)
        mkdir -p "$proj/aidlc-docs/inception/reverse-engineering"
        cp "$FIXTURES_DIR/re-artifacts/"*.md "$proj/aidlc-docs/inception/reverse-engineering/"
        shift ;;
      --with-inception-artifacts)
        mkdir -p "$proj/aidlc-docs/inception/requirements-analysis"
        mkdir -p "$proj/aidlc-docs/inception/application-design"
        mkdir -p "$proj/aidlc-docs/inception/units-generation"
        cp "$FIXTURES_DIR/inception-artifacts/requirements.md" \
           "$proj/aidlc-docs/inception/requirements-analysis/"
        cp "$FIXTURES_DIR/inception-artifacts/components.md" \
           "$FIXTURES_DIR/inception-artifacts/component-methods.md" \
           "$FIXTURES_DIR/inception-artifacts/services.md" \
           "$FIXTURES_DIR/inception-artifacts/component-dependency.md" \
           "$proj/aidlc-docs/inception/application-design/"
        cp "$FIXTURES_DIR/inception-artifacts/unit-of-work.md" \
           "$FIXTURES_DIR/inception-artifacts/unit-of-work-story-map.md" \
           "$proj/aidlc-docs/inception/units-generation/"
        shift ;;
      --with-construction-artifacts)
        mkdir -p "$proj/aidlc-docs/construction/todo-core/functional-design"
        cp "$FIXTURES_DIR/construction-artifacts/functional-design.md" \
           "$proj/aidlc-docs/construction/todo-core/functional-design/"
        shift ;;
      *) shift ;;
    esac
  done
  echo "$proj"
}
