#!/usr/bin/env bash
# Bound setup and contract subprocesses by the combined job's work deadline.
set -euo pipefail

if [ "$#" -eq 0 ] || ! [[ "${CHECK_WORK_DEADLINE:-}" =~ ^[0-9]+$ ]]; then
  echo "::error::combined check requires a work deadline and a command" >&2
  exit 2
fi

remaining=$(( CHECK_WORK_DEADLINE - $(date +%s) ))
if [ "$remaining" -le 0 ]; then
  echo "::error::combined check budget exhausted before $1" >&2
  exit 1
fi

# GNU timeout owns the subprocess group, including package/typecheck children.
# The short TERM-to-KILL interval stays inside the separate cleanup reserve.
exec timeout --signal=TERM --kill-after=5s "${remaining}s" "$@"
