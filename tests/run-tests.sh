#!/bin/bash
# POSIX compatibility wrapper for the native Bun/TypeScript test runner.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v bun >/dev/null 2>&1 && [ -d "$HOME/.bun/bin" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "ERROR: bun is required to run the AI-DLC test harness" >&2
  exit 127
fi

exec bun "$SCRIPT_DIR/run-tests.ts" "$@"
