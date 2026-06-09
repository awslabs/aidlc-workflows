#!/bin/bash
# t48: Drift test for audit event taxonomy — doc vs code.
#
# Enforces consistency between docs/reference/12-state-machine.md's emitter
# registry and the actual emission call sites in the codebase. Four checks:
#
#   1. Forward:  every (event, emitter) row in the doc must have a matching
#                call site in the declared emitter file.
#   2. Reverse:  every emission call site in the codebase must be in the
#                doc's registry (or attributed to a listed emitter).
#   3. Tertiary: deleted events (JUMP_AUTO_STOPPED, JUMP_COMPLETED, the four
#                auto-events, WORKFLOW_PAUSED/RESUMED) must not appear as
#                emission call sites anywhere in source.
#   4. Pairing:  handler functions that set specific checkbox states must
#                emit the paired audit events in the same function body.
#
# L1 — pure bash + grep + awk. No bun, no claude.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

DOC="$REPO_ROOT/docs/reference/12-state-machine.md"
TOOLS_DIR="$AIDLC_SRC/tools"
HOOKS_DIR="$AIDLC_SRC/hooks"

plan 16

# --- Helper: strip line-comment content so a commented emission does not pass ---
# Removes //-prefixed lines and lines that begin with * (JSDoc block comments).
# Does NOT handle /* ... */ block comments spanning multiple lines — block-
# commented emissions are rare and tertiary catches them explicitly.
decommented() {
  grep -vE '^[[:space:]]*(//|\*)' "$1"
}

# --- Helper: assert an emission call site exists for (event, file) ---
# Returns 0 if found, 1 if not. Operates on the decommented view so commented-
# out emissions do not count.
has_emission() {
  local event="$1" file="$2"
  local live
  live=$(decommented "$file")
  # Pattern 1: emitter helper call with the event as its string-literal arg,
  # all on one line (the common case).
  if echo "$live" | grep -qE "(emitAudit|appendAuditEntry|appendAuditEntryUnlocked|appendAuditEvent)\([^)]*\"$event\""; then
    return 0
  fi
  # Pattern 2: conditional/ternary assign used by audit-logger.ts.
  if echo "$live" | grep -qE "eventType = [^;]*\"$event\""; then
    return 0
  fi
  # Pattern 3: multi-line helper where the event literal sits on its own line.
  # Constrained to lines that look like `  "EVENT"[ optional comment ],` so
  # random quoted occurrences elsewhere don't pass.
  if echo "$live" | grep -qE "^[[:space:]]+\"$event\"[[:space:]]*(/\*[^*]*\*/)?[[:space:]]*,"; then
    return 0
  fi
  return 1
}

# --- Fixture sanity ---
assert_file_exists "$DOC" "state-machine doc exists"

# --- Extract the emitter registry from the doc ---
# The registry lives under ## Audit event taxonomy, split into per-category
# tables. Each row is `| \`EVENT\` | \`path\`, \`path\` | notes |`.
# Reserved events use a different shape: `| \`EVENT\` | Reserved ... |`
# which we treat as "declared but not emitted".
REGISTRY=$(awk '/^## Audit event taxonomy/,/^## Audit-first atomicity/' "$DOC" | \
           grep -E '^\| `[A-Z_]+`')

if [ -z "$REGISTRY" ]; then
  not_ok "emitter registry extraction" \
    "awk '/^## Audit event taxonomy/,/^## Audit-first atomicity/' returned empty — section headers renamed?"
  finish
fi

# Expected count derives from the source of truth — VALID_EVENT_TYPES in
# aidlc-audit.ts. Avoids a stale hard-coded count silently hiding drift.
REGISTRY_COUNT=$(echo "$REGISTRY" | wc -l | tr -d ' ')
TS_COUNT=$(sed -n '/new Set(\[/,/\]);/p' "$TOOLS_DIR/aidlc-audit.ts" | \
           grep -cE '"[A-Z_]+"')
assert_eq "$REGISTRY_COUNT" "$TS_COUNT" \
  "emitter registry row count matches VALID_EVENT_TYPES (doc=$REGISTRY_COUNT ts=$TS_COUNT)"

# --- CHECK 1: Forward — every (event, emitter) row has a matching call site ---
#
# For each row whose 2nd column is backtick-delimited file paths, grep the
# declared emitter for `"EVENT"` inside an emitter call (emitAudit,
# appendAuditEntry, or appendAuditEvent). Reserved rows skipped.
FORWARD_FAILURES=""
FORWARD_CHECKED=0

while IFS= read -r row; do
  # Extract the event name (first backticked token)
  event=$(echo "$row" | grep -oE '`[A-Z_]+`' | head -1 | tr -d '`')
  # Extract the 2nd column
  col2=$(echo "$row" | awk -F'\\|' '{print $3}')
  # Skip Reserved entries — they're declared-but-not-emitted by design
  if echo "$col2" | grep -qi "Reserved"; then
    continue
  fi
  # Extract all backtick-delimited file paths from column 2
  emitters=$(echo "$col2" | grep -oE '`[a-z/_.-]+\.ts`' | tr -d '`')
  if [ -z "$emitters" ]; then
    FORWARD_FAILURES="$FORWARD_FAILURES\n  $event: no emitter listed"
    continue
  fi
  for emitter_rel in $emitters; do
    # Paths in the doc are relative to .claude/ (e.g. tools/aidlc-state.ts)
    emitter_abs="$AIDLC_SRC/$emitter_rel"
    if [ ! -f "$emitter_abs" ]; then
      FORWARD_FAILURES="$FORWARD_FAILURES\n  $event → $emitter_rel: file not found"
      continue
    fi
    # has_emission operates on a decommented view of the file so commented-out
    # emissions (`// emitAudit(..., "EVENT", ...)`) don't falsely pass.
    if has_emission "$event" "$emitter_abs"; then
      FORWARD_CHECKED=$((FORWARD_CHECKED + 1))
    else
      # Include a grep hint so the human sees where to look / what's missing
      hint=$(grep -n "\"$event\"" "$emitter_abs" | head -1 || true)
      if [ -n "$hint" ]; then
        FORWARD_FAILURES="$FORWARD_FAILURES\n  $event in $emitter_rel: event name appears at $emitter_rel:${hint%%:*} but not inside an emission call (commented out?)"
      else
        FORWARD_FAILURES="$FORWARD_FAILURES\n  $event declared in $emitter_rel but no emission call site found"
      fi
    fi
  done
done <<< "$REGISTRY"

if [ -z "$FORWARD_FAILURES" ]; then
  ok "forward: every doc (event, emitter) row has a matching call site ($FORWARD_CHECKED checks)"
else
  not_ok "forward: doc row without matching call site" "$(echo -e "$FORWARD_FAILURES")"
fi

# --- CHECK 2: Reverse — every emission call site is in the doc registry ---
#
# Walk every .ts file under tools/ and hooks/, scan decommented content for
# emission patterns, collect the event names. Decommented view ensures a
# commented-out emission doesn't "prove" the event is documented.
ALL_EMISSIONS=""
for f in "$TOOLS_DIR"/*.ts "$HOOKS_DIR"/*.ts; do
  [ -f "$f" ] || continue
  # Pattern 1: direct emission helper call with a string literal.
  # `|| true` keeps us past pipefail when the file has no emission sites
  # (e.g. aidlc-audit.ts itself, which only declares VALID_EVENT_TYPES).
  p1=$(decommented "$f" | grep -oE '(emitAudit|appendAuditEntry|appendAuditEntryUnlocked|appendAuditEvent)\([^)]*"[A-Z_]+"' 2>/dev/null | \
       grep -oE '"[A-Z_]+"' | tr -d '"' || true)
  # Pattern 2: eventType = "EVENT" or eventType = <expr> "EVENT" (ternary)
  p2=$(decommented "$f" | grep -oE 'eventType = [^;]*"[A-Z_]+"' 2>/dev/null | \
       grep -oE '"[A-Z_]+"' | tr -d '"' || true)
  # Pattern 3: multi-line emission call — helper name on one line, event
  # literal on a following line before the closing `)`. Uses awk to track a
  # pending emission-call state until either the literal is found or the
  # paren closes. Catches:
  #   appendAuditEntry(
  #     "EVENT",
  #     { ... }
  #   );
  # without falsely matching "EVENT" strings elsewhere.
  p3=$(decommented "$f" | awk '
    /(emitAudit|appendAuditEntry|appendAuditEntryUnlocked|appendAuditEvent)\(/ && !/\)/ { inside=1; next }
    inside && /"[A-Z_]+"/ {
      match($0, /"[A-Z_]+"/)
      if (RLENGTH > 0) {
        s = substr($0, RSTART+1, RLENGTH-2)
        print s
        inside = 0
      }
    }
    inside && /\)/ { inside = 0 }
  ' 2>/dev/null || true)
  ALL_EMISSIONS=$(printf '%s\n%s\n%s\n%s\n' "$ALL_EMISSIONS" "$p1" "$p2" "$p3")
done
ALL_EMISSIONS=$(echo "$ALL_EMISSIONS" | sort -u | grep -v '^$' || true)

# Extract ONLY the first backticked token per row (the event name column).
# Later columns can mention deleted events in notes — those must not be
# counted as registered events.
REGISTRY_EVENTS=$(echo "$REGISTRY" | awk -F'`' '{print $2}' | grep -E '^[A-Z_]+$' | sort -u)

REVERSE_FAILURES=""
for event in $ALL_EMISSIONS; do
  if ! echo "$REGISTRY_EVENTS" | grep -qx "$event"; then
    # Add source location hint
    hint=$(grep -rn "\"$event\"" "$TOOLS_DIR"/*.ts "$HOOKS_DIR"/*.ts 2>/dev/null | head -1)
    REVERSE_FAILURES="$REVERSE_FAILURES\n  $event emitted but not in doc: ${hint%%:*}:${hint#*:*:}"
  fi
done

if [ -z "$REVERSE_FAILURES" ]; then
  REVERSE_COUNT=$(echo "$ALL_EMISSIONS" | wc -l | tr -d ' ')
  ok "reverse: every source emission site is in the doc ($REVERSE_COUNT distinct events)"
else
  not_ok "reverse: emission site not in doc" "$(echo -e "$REVERSE_FAILURES")"
fi

# --- CHECK 3: Tertiary — deleted events must not appear as emission sites ---
DELETED_EVENTS="JUMP_AUTO_STOPPED GATE_AUTO_APPROVED QUESTION_AUTO_ANSWERED OPTION_AUTO_SELECTED ACTION_AUTO_CONFIRMED JUMP_COMPLETED WORKFLOW_PAUSED WORKFLOW_RESUMED"

TERTIARY_FAILURES=""
for event in $DELETED_EVENTS; do
  # Look for emission call sites — apply decommented() to stay consistent with
  # forward/reverse policy. A JSDoc-commented `* appendAuditEvent(..., "EVENT", ...)`
  # is dead code and should not count as "resurrected".
  resurrected=false
  for f in "$TOOLS_DIR"/*.ts "$HOOKS_DIR"/*.ts; do
    [ -f "$f" ] || continue
    if decommented "$f" | grep -qE "(emitAudit|appendAuditEntry|appendAuditEntryUnlocked|appendAuditEvent)\([^)]*\"$event\""; then
      resurrected=true
      break
    fi
  done
  if $resurrected; then
    TERTIARY_FAILURES="$TERTIARY_FAILURES\n  $event has an emission call site in source (deleted event resurrected)"
  fi
  # Also check it's not in VALID_EVENT_TYPES (decommented view).
  if decommented "$TOOLS_DIR/aidlc-audit.ts" | grep -q "\"$event\""; then
    TERTIARY_FAILURES="$TERTIARY_FAILURES\n  $event reinstated in VALID_EVENT_TYPES (should be deleted)"
  fi
done

if [ -z "$TERTIARY_FAILURES" ]; then
  ok "tertiary: deleted events have no emission call sites and are not in VALID_EVENT_TYPES"
else
  not_ok "tertiary: deleted event resurrected" "$(echo -e "$TERTIARY_FAILURES")"
fi

# --- CHECK 4: Pairing invariants ---
#
# Certain handler functions MUST emit specific event pairs in the same function
# body. If a future refactor splits one side out, the audit trail breaks.
# We do a grep-based proximity check: within each handler's body (from the
# function signature to the next `^function ` line), all required events must
# appear.

STATE_TS="$TOOLS_DIR/aidlc-state.ts"
UTIL_TS="$TOOLS_DIR/aidlc-utility.ts"

# Extract a function body by name. Accepts:
#   function <name>(...)
#   export function <name>(...)
#   async function <name>(...)
#   const <name> = (...) =>
#   const <name> = async (...) =>
# Body runs until the next top-level function / const-arrow declaration.
# Returns empty string if the function isn't found — caller must check.
function_body() {
  local name="$1"
  local file="$2"
  awk -v n="$name" '
    $0 ~ "^(export +)?(async +)?function " n "\\(" { inside=1; next }
    $0 ~ "^(export +)?const " n " = (async +)?\\(" { inside=1; next }
    inside && /^(export +)?(async +)?function [A-Za-z]+\(/ { exit }
    inside && /^(export +)?const [A-Za-z]+ = (async +)?\(/ { exit }
    inside { print }
  ' "$file"
}

# Verify a handler exists AND its body contains an emitted (not commented,
# not bare-string) instance of every listed event. Disambiguates three
# failure modes:
#   - handler not found (renamed? moved? deleted?)
#   - handler found but event literal absent
#   - handler found, event literal present but only as a non-emission string
#
# Usage: check_pairing <handler-fn> <file> <EVENT_1> [EVENT_2 ...]
check_pairing() {
  local handler="$1" file="$2"; shift 2
  local label="pairing: $handler emits $(echo "$@" | tr ' ' '+')"
  local body
  body=$(function_body "$handler" "$file")

  if [ -z "$body" ]; then
    not_ok "$label" "handler $handler not found in $(basename "$file") (renamed or deleted?)"
    return
  fi

  # Decomment the body before checking (rejects commented-out emissions).
  local body_live
  body_live=$(echo "$body" | grep -vE '^[[:space:]]*(//|\*)')

  local missing=""
  for event in "$@"; do
    # Event must appear inside an emission helper call, not as a free string
    if echo "$body_live" | grep -qE "(emitAudit|appendAuditEntry|appendAuditEntryUnlocked|appendAuditEvent)\(([^)]|$)*\"$event\"" || \
       echo "$body_live" | grep -qE "eventType = [^;]*\"$event\"" || \
       echo "$body_live" | grep -qE "^[[:space:]]+\"$event\"[[:space:]]*,"; then
      continue
    fi
    missing="$missing $event"
  done

  if [ -z "$missing" ]; then
    ok "$label"
  else
    not_ok "$label" "missing emission(s) in $handler body:$missing"
  fi
}

check_pairing handleApprove         "$STATE_TS" GATE_APPROVED STAGE_COMPLETED
check_pairing handleReject          "$STATE_TS" GATE_REJECTED STAGE_REVISING
check_pairing handleGateStart       "$STATE_TS" STAGE_AWAITING_APPROVAL
check_pairing handleRevise          "$STATE_TS" STAGE_AWAITING_APPROVAL
check_pairing handleSkip            "$STATE_TS" STAGE_SKIPPED
check_pairing handleCompleteWorkflow "$STATE_TS" PHASE_COMPLETED PHASE_VERIFIED WORKFLOW_COMPLETED
check_pairing handleAdvance         "$STATE_TS" STAGE_STARTED
check_pairing handleReuseArtifact   "$STATE_TS" ARTIFACT_REUSED
check_pairing handleInit            "$UTIL_TS"  WORKFLOW_STARTED PHASE_STARTED STAGE_STARTED

# --- CHECK 5: MD ↔ MD consistency between the two event catalogs ---
#
# t28 enforces TS (VALID_EVENT_TYPES) ↔ audit-format.md; t48 forward/reverse
# enforce TS ↔ 12-state-machine.md. Neither closes the triangle: audit-format
# and 12-state-machine could disagree while both individually pass. This check
# closes the gap by comparing the two catalog sets directly.
AUDIT_FORMAT="$AIDLC_SRC/knowledge/aidlc-shared/audit-format.md"
AF_EVENTS=$(sed -n '/## Event Registry/,/## Hook-Generated/p' "$AUDIT_FORMAT" | \
            grep -oE '`[A-Z_]+`' | tr -d '`' | sort -u)
SM_EVENTS=$(echo "$REGISTRY_EVENTS")

ONLY_IN_AF=$(comm -23 <(echo "$AF_EVENTS") <(echo "$SM_EVENTS"))
ONLY_IN_SM=$(comm -13 <(echo "$AF_EVENTS") <(echo "$SM_EVENTS"))

if [ -z "$ONLY_IN_AF" ] && [ -z "$ONLY_IN_SM" ]; then
  ok "md-md: audit-format.md and 12-state-machine.md agree on event set"
else
  detail=""
  [ -n "$ONLY_IN_AF" ] && detail="$detail\n  only in audit-format.md: $(echo "$ONLY_IN_AF" | tr '\n' ' ')"
  [ -n "$ONLY_IN_SM" ] && detail="$detail\n  only in 12-state-machine.md: $(echo "$ONLY_IN_SM" | tr '\n' ' ')"
  not_ok "md-md: audit-format.md and 12-state-machine.md event sets differ" "$(echo -e "$detail")"
fi

# --- Bonus: forbidden patterns in docs/prose ---
# The doc forbids `bun .claude/tools/aidlc-audit.ts append <EVENT>` as a prose
# instruction. Confirm none remain in SKILL.md or stage-protocol.md.
PROSE_APPENDS=$(grep -rnE "bun .*aidlc-audit\.ts append [A-Z_]+" \
                "$AIDLC_SRC/skills/aidlc/" 2>/dev/null | \
                grep -vE "(reserved for the future recovery workflow|never hand-write|(see §4|Canonical state transitions))" || true)

if [ -z "$PROSE_APPENDS" ]; then
  ok "no prose aidlc-audit.ts append calls in SKILL.md or stage-protocol.md"
else
  not_ok "forbidden prose append call found" "$PROSE_APPENDS"
fi

finish
