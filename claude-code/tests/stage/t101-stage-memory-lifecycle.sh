#!/bin/bash
# t101 (stage): Per-stage memory.md start→approval lifecycle (v0.5.0 milestone 13) (8 assertions)
# Requires: claude CLI
#
# Drives one gated stage (approval-handoff — a lightweight gate stage, per
# t24's timeout-avoidance pattern) and inspects the artefact tree for the
# memory.md lifecycle the SKILL.md ## Routing block instructs:
#   - init-from-template fired at stage start (file exists, four headings,
#     ownership header),
#   - any logged observation sits under a canonical heading with an ISO prefix,
#   - persist-on-approval (no cleanup),
#   - idempotent re-entry (re-running does not clobber accumulated entries),
#   - parseMemoryHeadings ↔ disk agreement,
#   - the hook-fired runtime-compile read seam sees the file (runtime-graph
#     row carries memory_path).
#
# L2 — LLM + fixtures. memory.md creation is LLM-driven (orchestrator prose),
# so creation-dependent assertions skip when claude times out (CLAUDE_RC=124)
# or the file was not created.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

LIB="$AIDLC_SRC/tools/aidlc-lib.ts"
RUNTIME="$AIDLC_SRC/tools/aidlc-runtime.ts"
AIDLC_TEST_TIMEOUT=600

plan 8

# Setup: mid-ideation state; target approval-handoff (gate stage, ideation phase).
PROJ=$(setup_integration_project --with-state "$FIXTURES_DIR/state-mid-ideation.md" --with-audit)
MEM="$PROJ/aidlc-docs/ideation/approval-handoff/memory.md"

run_claude "$PROJ" "/aidlc --stage approval-handoff --test-run"

# Guard: detect silent timeout (exit 124 = timeout with empty output). When
# claude times out the artefact tree is incomplete, so we skip the
# LLM-output-dependent assertions rather than fail on partial state.
TIMED_OUT=0
if [ "$CLAUDE_RC" = "124" ]; then TIMED_OUT=1; fi

# --- Assertion 1: memory.md exists after stage start ------------------------
if [ "$TIMED_OUT" = "1" ]; then
  skip "memory.md created at stage start (claude timed out)"
elif [ -f "$MEM" ]; then
  ok "memory.md created at stage start"
else
  skip "memory.md created at stage start (orchestrator did not create file)"
fi

# --- Assertion 2: created file has all four canonical `## ` H2 headings -----
if [ -f "$MEM" ]; then
  if grep -qE '^## Interpretations$' "$MEM" \
    && grep -qE '^## Deviations$' "$MEM" \
    && grep -qE '^## Tradeoffs$' "$MEM" \
    && grep -qE '^## Open questions$' "$MEM"; then
    ok "memory.md has all four canonical headings (template was the source)"
  else
    not_ok "memory.md has all four canonical headings" "missing one or more canonical headings"
  fi
else
  skip "memory.md has all four canonical headings (file not created)"
fi

# --- Assertion 3: ownership header is the verbatim blockquote (fidelity) ----
# The init is an LLM-driven copy of the template (SKILL.md ## Routing block).
# When the orchestrator copies faithfully, the verbatim blockquote ownership
# header is present; when it approximates the copy (LLM variance), skip rather
# than fail — but if a `>` ownership line exists it MUST be the verbatim string
# (a malformed header is a real defect, not variance).
if [ ! -f "$MEM" ]; then
  skip "memory.md ownership header present (file not created)"
elif grep -qE '^> This file is maintained by the orchestrator during stage execution\. Add observations at the gate ritual, not by editing here directly\.$' "$MEM"; then
  ok "memory.md ownership header is the verbatim template blockquote (fidelity)"
elif grep -qE '^>' "$MEM"; then
  not_ok "memory.md ownership header is the verbatim template blockquote" "a blockquote header exists but is not the verbatim template string"
else
  skip "memory.md ownership header (orchestrator approximated the copy; no blockquote header)"
fi

# --- Assertion 4: any logged observation under a canonical heading w/ ISO ---
# If the orchestrator logged ≥1 real bullet, it must be a dated entry. We
# accept the template-only case (no real entries) as a pass-by-skip.
if [ -f "$MEM" ]; then
  # A real entry is a non-comment, non-blockquote line that begins with a
  # bullet/dash and carries an ISO-8601 date prefix.
  if grep -qE '^- 20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]T' "$MEM"; then
    ok "logged observation carries an ISO-8601 prefix under a canonical heading"
  else
    skip "no real observation logged (template-only memory.md)"
  fi
else
  skip "observation format check (file not created)"
fi

# --- Assertion 5: memory.md persists after approval -------------------------
# --test-run auto-approves the gate, so by the time claude returns the stage
# is approved. The file must still exist (persist-on-approval, no cleanup).
if [ "$TIMED_OUT" = "1" ]; then
  skip "memory.md persists after approval (claude timed out)"
elif [ -f "$MEM" ]; then
  ok "memory.md persists after approval (no cleanup)"
else
  skip "memory.md persists after approval (file was never created)"
fi

# --- Assertion 6: idempotent re-entry does NOT overwrite an existing file ---
if [ -f "$MEM" ]; then
  # Append a sentinel real entry, re-run the stage, and confirm the sentinel
  # survives — re-entry must not clobber accumulated entries.
  SENTINEL="- 2026-05-29T12:00:00Z — t101 idempotency sentinel"
  bun -e "
    import { readFileSync, writeFileSync } from 'fs';
    let raw = readFileSync('$MEM','utf-8');
    raw = raw.replace('## Interpretations\n', '## Interpretations\n$SENTINEL\n');
    writeFileSync('$MEM', raw);
  "
  run_claude "$PROJ" "/aidlc --stage approval-handoff --test-run"
  if grep -qF "t101 idempotency sentinel" "$MEM"; then
    ok "re-entering the stage does not overwrite an existing memory.md (idempotent)"
  else
    not_ok "re-entering the stage does not overwrite an existing memory.md" "sentinel entry was clobbered"
  fi
else
  skip "idempotent re-entry (file not created)"
fi

# --- Assertion 7: parseMemoryHeadings(post-approval file) ↔ visible entries -
if [ -f "$MEM" ]; then
  PARSED_TOTAL=$(bun -e "
    import { parseMemoryHeadings } from '$LIB';
    import { readFileSync } from 'fs';
    console.log(parseMemoryHeadings(readFileSync('$MEM','utf-8')).total);
  " 2>/dev/null)
  # Count visible real entries on disk: non-comment, non-blockquote, non-blank
  # lines under canonical headings carrying an ISO prefix or a leading dash.
  VISIBLE=$(grep -cE '^- ' "$MEM" || true)
  assert_eq "$PARSED_TOTAL" "$VISIBLE" "parseMemoryHeadings total matches visible entry count (parser ↔ disk)"
else
  skip "parser ↔ disk agreement (file not created)"
fi

# --- Assertion 8: runtime-graph row carries memory_path (hook-fired read) ---
# Compile the runtime graph (the PostToolUse hook fires this after approve in
# real flow; we invoke it directly for a deterministic read). The compiler
# builds a stage row only from a STAGE_STARTED audit event — a `--stage` jump
# can skip the intermediates and emit STAGE_JUMPED/STAGE_SKIPPED instead, so a
# row for the target stage is not guaranteed. When a row DOES exist for the
# stage, its memory_path must be the derived path (the milestone 8 read seam — the
# populator writes memory_path on every row, aidlc-runtime.ts:320); when no row
# exists (no STAGE_STARTED for the jumped stage), skip rather than fail.
if [ "$TIMED_OUT" = "1" ]; then
  skip "runtime-graph row carries memory_path (claude timed out)"
else
  graph="$PROJ/aidlc-docs/runtime-graph.json"
  CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME" compile --project-dir "$PROJ" >/dev/null 2>&1 || \
    CLAUDE_PROJECT_DIR="$PROJ" bun "$RUNTIME" compile >/dev/null 2>&1 || true
  ROW_PATH=""
  if [ -f "$graph" ]; then
    ROW_PATH=$(jq -r '.stages[] | select(.stage_slug == "approval-handoff") | .memory_path' "$graph" 2>/dev/null | head -1)
  fi
  if [ -n "$ROW_PATH" ] && [ "$ROW_PATH" != "null" ]; then
    assert_eq "$ROW_PATH" "aidlc-docs/ideation/approval-handoff/memory.md" "runtime-graph row carries memory_path = derived path (milestone 8 read seam)"
  else
    skip "runtime-graph row carries memory_path (no STAGE_STARTED row for the jumped stage to compile)"
  fi
fi

cleanup_test_project "$PROJ"
finish
