#!/bin/bash
# t107: Structural + contract checks for the three read-only session skills
# (session-cost / replay / outcomes-pack).
#
# Surface tested:
#   - Each skill's SKILL.md exists at skills/aidlc-<slug>/SKILL.md.
#   - Frontmatter declares name, user-invocable: true, classification: read-only.
#   - Each skill sources its numbers from `aidlc-runtime.ts summary --json`
#     (the deterministic data plane — no LLM-side counting).
#   - The dropped token heuristic ("characters ÷ 4" / "chars ÷ 4") does NOT
#     reappear in any session skill — token estimation was deliberately cut.
#   - No session skill emits an audit event or advances workflow state
#     (read-only contract): no appendAuditEntry / aidlc-state.ts advance calls.
#   - session-cost and replay write no file (pure stdout); only
#     outcomes-pack names a report artefact (OUTCOMES.md).
#
# L1 — pure bash + grep. No fixtures; reads the shipped skill files.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

CLAUDE_DIR="$(cd "$SCRIPT_DIR/../../dist/claude/.claude" && pwd)"
SKILLS_DIR="$CLAUDE_DIR/skills"

COST="$SKILLS_DIR/aidlc-session-cost/SKILL.md"
REPLAY="$SKILLS_DIR/aidlc-replay/SKILL.md"
PACK="$SKILLS_DIR/aidlc-outcomes-pack/SKILL.md"

plan 24

# --- Existence (3) ---------------------------------------------------------
assert_file_exists "$COST"   "session-cost SKILL.md exists"
assert_file_exists "$REPLAY" "replay SKILL.md exists"
assert_file_exists "$PACK"   "outcomes-pack SKILL.md exists"

# --- Frontmatter: name (3) -------------------------------------------------
assert_grep "$COST"   '^name: aidlc-session-cost'   "session-cost declares name"
assert_grep "$REPLAY" '^name: aidlc-replay'         "replay declares name"
assert_grep "$PACK"   '^name: aidlc-outcomes-pack'  "outcomes-pack declares name"

# --- Frontmatter: user-invocable (3) ---------------------------------------
assert_grep "$COST"   '^user-invocable: true' "session-cost is user-invocable"
assert_grep "$REPLAY" '^user-invocable: true' "replay is user-invocable"
assert_grep "$PACK"   '^user-invocable: true' "outcomes-pack is user-invocable"

# --- Frontmatter: read-only classification (3) -----------------------------
assert_grep "$COST"   '^classification: read-only' "session-cost classified read-only"
assert_grep "$REPLAY" '^classification: read-only' "replay classified read-only"
assert_grep "$PACK"   '^classification: read-only' "outcomes-pack classified read-only"

# --- Data-plane sourcing: each calls summary --json (3) --------------------
assert_grep "$COST"   'aidlc-runtime.ts summary --json' "session-cost reads summary --json"
assert_grep "$REPLAY" 'aidlc-runtime.ts summary --json' "replay reads summary --json"
assert_grep "$PACK"   'aidlc-runtime.ts summary --json' "outcomes-pack reads summary --json"

# --- Dropped token heuristic must not reappear (3) -------------------------
# The old session-cost command estimated tokens via characters / 4. MR-C
# drops this. Guard against regression in every session skill.
assert_not_grep "$COST"   'characters ÷ 4\|chars ÷ 4\|characters / 4\|chars / 4' "session-cost drops the chars/4 token heuristic"
assert_not_grep "$REPLAY" 'characters ÷ 4\|chars ÷ 4\|characters / 4\|chars / 4' "replay carries no token heuristic"
assert_not_grep "$PACK"   'characters ÷ 4\|chars ÷ 4\|characters / 4\|chars / 4' "outcomes-pack carries no token heuristic"

# --- Read-only contract: no audit emit / no state advance (3) --------------
# Read-only skills must not append audit rows or advance the stage pointer.
assert_not_grep "$COST"   'appendAuditEntry\|aidlc-audit.ts\|aidlc-state.ts \(advance\|approve\|complete\)' "session-cost emits no audit / no state advance"
assert_not_grep "$REPLAY" 'appendAuditEntry\|aidlc-audit.ts\|aidlc-state.ts \(advance\|approve\|complete\)' "replay emits no audit / no state advance"
assert_not_grep "$PACK"   'appendAuditEntry\|aidlc-audit.ts\|aidlc-state.ts \(advance\|approve\|complete\)' "outcomes-pack emits no audit / no state advance"

# --- Write surface: only outcomes-pack writes a file (3) -------------------
# session-cost and replay are pure stdout; replay must NOT name a report
# file. outcomes-pack is the only skill that writes (OUTCOMES.md).
assert_not_grep "$COST"   'SESSION-REPLAY.md\|OUTCOMES.md' "session-cost names no report artefact"
assert_not_grep "$REPLAY" 'SESSION-REPLAY.md' "replay writes no SESSION-REPLAY.md (pure stdout)"
assert_grep     "$PACK"   'OUTCOMES.md' "outcomes-pack writes OUTCOMES.md"
