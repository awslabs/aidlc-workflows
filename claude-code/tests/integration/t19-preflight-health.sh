#!/bin/bash
# t19: Preflight health check — validates Claude CLI before integration tests
# Gates: if any assertion fails, downstream LLM tests should be skipped
# Requires: claude CLI
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

# Override timeout: preflight must fail fast (default is 1800s)
AIDLC_TEST_TIMEOUT=180

plan 4

# --- Critical assertions (bail on failure) ---

# Test 1: claude CLI on PATH
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI on PATH"
else
  not_ok "claude CLI on PATH"
  finish
fi

# Test 2: AWS credentials valid (Bedrock requires IAM auth)
if command -v aws >/dev/null 2>&1; then
  if timeout 10 aws sts get-caller-identity --query Account --output text < /dev/null >/dev/null 2>&1; then
    ok "AWS credentials valid"
  else
    not_ok "AWS credentials valid" "credentials expired/missing or credential_process hung — refresh AWS credentials"
    finish
  fi
else
  ok "AWS credentials valid # SKIP aws CLI not found"
fi

# Test 3: claude responds (exit 0)
PROJ=$(setup_integration_project)
HEALTH_START=$SECONDS
run_claude "$PROJ" "echo ok"
HEALTH_DURATION=$(( SECONDS - HEALTH_START ))

if [ "$CLAUDE_RC" -eq 0 ]; then
  ok "claude responds (exit 0)"
elif [ "$CLAUDE_RC" -eq 124 ] || [ "$CLAUDE_RC" -eq 137 ]; then
  not_ok "claude responds (exit 0)" "TIMEOUT after ${HEALTH_DURATION}s (exit $CLAUDE_RC) — claude hung during init; check awsAuthRefresh or credential_process in AWS config"
  cleanup_test_project "$PROJ"
  finish
else
  not_ok "claude responds (exit 0)" "exit code: $CLAUDE_RC"
  cleanup_test_project "$PROJ"
  finish
fi

# Test 4: response is non-empty
if [ -n "$CLAUDE_OUTPUT" ]; then
  ok "response is non-empty"
else
  not_ok "response is non-empty"
  cleanup_test_project "$PROJ"
  finish
fi

# --- Advisory diagnostics (TAP comments, don't affect exit code) ---

echo "# Advisory: response time ${HEALTH_DURATION}s"
if [ "$HEALTH_DURATION" -gt 30 ]; then
  echo "# WARNING: response took ${HEALTH_DURATION}s (>30s) — API may be degraded"
fi

# Advisory: skill loading check
run_claude "$PROJ" "/aidlc --help"
if grep -qi "AI-DLC" <<< "$CLAUDE_OUTPUT"; then
  echo "# Advisory: skill loading OK (/aidlc --help returned AI-DLC)"
else
  echo "# Advisory: skill loading DEGRADED (/aidlc --help did not return AI-DLC)"
fi

cleanup_test_project "$PROJ"
finish
