#!/bin/bash
# t06: smoke — distributable CLAUDE.md describes post-Wave-1 layout (6 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

CLAUDE_MD="$SCRIPT_DIR/../../dist/claude/.claude/CLAUDE.md"

plan 6

# Test 1: file exists. If it doesn't, tests 2-6 cannot meaningfully run —
# `grep -q PATTERN /missing/file` returns non-zero, which the negative
# branches would otherwise treat as "pattern not found = ok" and silently
# vacuously-pass. SKIP the rest with explicit TAP SKIP markers so the
# failure mode reads honestly.
if [ -f "$CLAUDE_MD" ]; then
  ok "distributable CLAUDE.md exists"
else
  not_ok "distributable CLAUDE.md exists" "file not found: $CLAUDE_MD"
  skip "CLAUDE.md describes flat .claude/rules/ layout (file missing)"
  skip "CLAUDE.md does not reference removed .claude/practices/ path (file missing)"
  skip "CLAUDE.md does not reference legacy aidlc-knowledge/ parent (file missing)"
  skip "CLAUDE.md mentions .claude/sensors/ surface (file missing)"
  skip "CLAUDE.md mentions aidlc-org rule file (file missing)"
  finish
  exit
fi

# Test 2: no nested rules/aidlc/guardrails/ path (flattened in MR 2)
if grep -q "\.claude/rules/aidlc/guardrails" "$CLAUDE_MD"; then
  not_ok "CLAUDE.md must not reference legacy nested rules path"
else
  ok "CLAUDE.md describes flat .claude/rules/ layout"
fi

# Test 3: no .claude/practices/ references (merged into rules in MR 2)
if grep -q "\.claude/practices" "$CLAUDE_MD"; then
  not_ok "CLAUDE.md must not reference removed .claude/practices/ path"
else
  ok "CLAUDE.md does not reference removed .claude/practices/ path"
fi

# Test 4: no aidlc-knowledge/ parent (renamed to knowledge/ in MR 2)
if grep -q "\.claude/aidlc-knowledge" "$CLAUDE_MD"; then
  not_ok "CLAUDE.md must not reference legacy aidlc-knowledge/ parent"
else
  ok "CLAUDE.md does not reference legacy aidlc-knowledge/ parent"
fi

# Test 5: mentions sensors/ as a user-visible surface (new in v0.5.0)
if grep -q "\.claude/sensors" "$CLAUDE_MD"; then
  ok "CLAUDE.md mentions .claude/sensors/ surface"
else
  not_ok "CLAUDE.md must mention .claude/sensors/ (new in v0.5.0)"
fi

# Test 6: positive anchor — at least one new flat-rules filename appears.
# Without this, a future regression that deletes the entire Rules bullet
# would still pass tests 2-5 (no legacy paths, sensors line still mentioned).
# This locks in the post-Wave-1 rule layout without locking in exact prose.
if grep -q "aidlc-org" "$CLAUDE_MD"; then
  ok "CLAUDE.md mentions aidlc-org rule file"
else
  not_ok "CLAUDE.md must mention at least one new rule filename (aidlc-org)"
fi

finish
