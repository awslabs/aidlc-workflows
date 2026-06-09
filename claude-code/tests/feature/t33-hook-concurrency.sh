#!/bin/bash
# t33: Test audit-logger lock contention under parallel writes
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

HOOK="$AIDLC_SRC/hooks/aidlc-audit-logger.ts"

plan 8

# --- Setup: create a test project with audit.md ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"

# Count initial entries
INITIAL_ENTRIES=$(grep -c "ARTIFACT_CREATED" "$PROJ/aidlc-docs/audit.md" || true)

# --- Launch 5 parallel audit-logger invocations ---
for i in 1 2 3 4 5; do
  echo "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJ/aidlc-docs/artifact-${i}.md\"}}" | \
    CLAUDE_PROJECT_DIR="$PROJ" bun "$HOOK" 2>/dev/null &
done
wait

# Count entries after parallel writes
FINAL_ENTRIES=$(grep -c "ARTIFACT_CREATED" "$PROJ/aidlc-docs/audit.md" || true)
NEW_ENTRIES=$((FINAL_ENTRIES - INITIAL_ENTRIES))

# 1. All 5 entries appear (no lost writes)
assert_eq "$NEW_ENTRIES" "5" "all 5 parallel writes recorded (no lost writes)"

# 2. Each artifact file referenced
for i in 1 2 3 4 5; do
  assert_grep "$PROJ/aidlc-docs/audit.md" "artifact-${i}.md" "entry for artifact-${i}.md present"
done

# We need to recount for the remaining assertions
# 3. No interleaved/corrupted entries — each "ARTIFACT_CREATED" block has a "---" closer
# Count complete blocks: header followed eventually by ---
BLOCK_COUNT=$(awk '/^ARTIFACT_CREATED/{n++} END{print n}' "$PROJ/aidlc-docs/audit.md")
SEPARATOR_COUNT=$(grep -c "^---$" "$PROJ/aidlc-docs/audit.md" || true)
# Each block should have its own --- separator (at least as many separators as new blocks)
if [ "$SEPARATOR_COUNT" -ge "$FINAL_ENTRIES" ]; then
  ok "no interleaved/corrupted entries (separators >= entries)"
else
  not_ok "no interleaved/corrupted entries" "separators=$SEPARATOR_COUNT, entries=$FINAL_ENTRIES"
fi

# 4. Lock directory cleaned up
LOCK_HASH=$(printf '%s' "$PROJ" | md5sum | cut -c1-8)
LOCK_DIR="${TMPDIR:-/tmp}/.aidlc-audit-${LOCK_HASH}.lock"
if [ ! -d "$LOCK_DIR" ]; then
  ok "lock directory cleaned up after completion"
else
  not_ok "lock directory cleaned up after completion" "lock dir still exists: $LOCK_DIR"
  rmdir "$LOCK_DIR" 2>/dev/null || true
fi

cleanup_test_project "$PROJ"

finish
