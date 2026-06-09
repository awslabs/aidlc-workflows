#!/bin/bash
# t28: Validates audit event types are in sync between aidlc-audit.ts and audit-format.md (7 tests)
# Pure bash — no bun or claude required (L1)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

AUDIT_TS="$AIDLC_SRC/tools/aidlc-audit.ts"
AUDIT_MD="$AIDLC_SRC/knowledge/aidlc-shared/audit-format.md"

plan 7

# --- Extract event types from aidlc-audit.ts (VALID_EVENT_TYPES set) ---
# Grab lines between "new Set([" and "]);" then extract quoted uppercase identifiers
TS_EVENTS=$(sed -n '/new Set(\[/,/\]);/p' "$AUDIT_TS" | grep -oE '"[A-Z_]+"' | tr -d '"' | sort -u)

# Test 1: TS extraction found events
TS_COUNT=$(echo "$TS_EVENTS" | wc -l | tr -d ' ')
assert_gt "$TS_COUNT" 0 "extracted $TS_COUNT event types from aidlc-audit.ts"

# --- Extract event types from audit-format.md (backtick-delimited in tables) ---
# Only look at lines within the Event Registry section, stop at Hook-Generated
MD_EVENTS=$(sed -n '/## Event Registry/,/## Hook-Generated/p' "$AUDIT_MD" | grep -oE '`[A-Z_]+`' | tr -d '`' | sort -u)

# Test 2: MD extraction found events
MD_COUNT=$(echo "$MD_EVENTS" | wc -l | tr -d ' ')
assert_gt "$MD_COUNT" 0 "extracted $MD_COUNT event types from audit-format.md"

# Test 3: Every event in aidlc-audit.ts exists in audit-format.md
MISSING_FROM_MD=""
for evt in $TS_EVENTS; do
  if ! echo "$MD_EVENTS" | grep -qx "$evt"; then
    MISSING_FROM_MD="$MISSING_FROM_MD $evt"
  fi
done
if [ -z "$MISSING_FROM_MD" ]; then
  ok "all TS events found in audit-format.md"
else
  not_ok "all TS events found in audit-format.md" "missing from MD:$MISSING_FROM_MD"
fi

# Test 4: Every event in audit-format.md exists in aidlc-audit.ts
MISSING_FROM_TS=""
for evt in $MD_EVENTS; do
  if ! echo "$TS_EVENTS" | grep -qx "$evt"; then
    MISSING_FROM_TS="$MISSING_FROM_TS $evt"
  fi
done
if [ -z "$MISSING_FROM_TS" ]; then
  ok "all MD events found in aidlc-audit.ts"
else
  not_ok "all MD events found in aidlc-audit.ts" "missing from TS:$MISSING_FROM_TS"
fi

# Test 5: EVENT_HEADINGS has entry for every VALID_EVENT_TYPES member
HEADINGS_BLOCK=$(sed -n '/EVENT_HEADINGS/,/};/p' "$AUDIT_TS")
MISSING_HEADINGS=""
for evt in $TS_EVENTS; do
  if ! echo "$HEADINGS_BLOCK" | grep -q "$evt"; then
    MISSING_HEADINGS="$MISSING_HEADINGS $evt"
  fi
done
if [ -z "$MISSING_HEADINGS" ]; then
  ok "EVENT_HEADINGS has entry for all VALID_EVENT_TYPES"
else
  not_ok "EVENT_HEADINGS has entry for all VALID_EVENT_TYPES" "missing headings:$MISSING_HEADINGS"
fi

# Test 6: Counts match
assert_eq "$TS_COUNT" "$MD_COUNT" "event count matches: TS=$TS_COUNT MD=$MD_COUNT"

# Test 7: Canonical count pinned to baseline (bump when events added)
assert_eq 67 "$TS_COUNT" "VALID_EVENT_TYPES.size === 67 (v0.6.0 Wave 4 MR 16: +SWARM_DEGRADED)"

finish
