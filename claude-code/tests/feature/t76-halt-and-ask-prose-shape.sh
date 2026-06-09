#!/bin/bash
# t76: halt-and-ask prose-shape contract across the worktree-dispatch surfaces.
# Pins line-anchored assertions (NOT file-wide grep) so existing "preserved"
# matches in branching-strategies.md can't false-green the test. (7 tests)
#
# Engine-cutover note: the original SKILL.md half of this contract (the
# slug-derivation paragraph, the two worktree-dispatch carve-out subheadings,
# the "Inspecting a paused Bolt" paragraph, and the MR-13 prefix-hash +
# orphan-BOLT_STARTED italic carve-outs — formerly tests 1-5, 13-14) was RETIRED
# when the orchestrator was cut over to the engine forwarding loop. That per-Bolt
# worktree-dispatch + halt-and-ask prose moved into the engine (same family as
# the per-Bolt Steps t70 retired); the engine's directive stream is covered by
# the t118 corpus. The halt-and-ask PROSE-SHAPE contract still lives in the
# downstream surfaces this test pins:
#   1. stage-protocol.md — AUQ template with [path]/[branch_name],
#                          preservation phrase same-line as Skip/Abort
#   2. branching-strategies.md — preservation appended to dirty-tree bullet,
#                                cross-link to halt-and-ask block
#   3. aidlc-pipeline-deploy-agent.md — preservation appended to conflict bullet
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

plan 7

PROTO="$AIDLC_SRC/aidlc-common/protocols/stage-protocol.md"
BRANCH="$AIDLC_SRC/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md"
PDAGENT="$AIDLC_SRC/agents/aidlc-pipeline-deploy-agent.md"

# --- Tests 1-2: stage-protocol.md AUQ template has [path] and [branch_name] ---
# The new template interpolates [path] and [branch_name] in the question body
assert_grep "$PROTO" 'question.*\[path\].*\[branch_name\]' "stage-protocol.md AUQ question carries [path] and [branch_name]"
# Skip and Abort options keep "preserved" phrasing
assert_grep "$PROTO" 'Skip.*worktree preserved' "stage-protocol.md Skip option mentions worktree preserved"

# --- Test 3: stage-protocol.md Skip line same-line preservation phrase ---
# The bullet "- Skip:" should ALSO contain "Worktree at" on the same line
SKIP_LINE=$(grep -n "^- Skip:" "$PROTO" | head -1)
echo "$SKIP_LINE" | grep -q "Worktree at"
if [ "$?" -eq 0 ]; then
  ok "stage-protocol.md - Skip: line contains preservation phrase same-line"
else
  not_ok "stage-protocol.md - Skip: line contains preservation phrase same-line" "got: $SKIP_LINE"
fi

# --- Test 4: same for - Abort: ---
ABORT_LINE=$(grep -n "^- Abort:" "$PROTO" | head -1)
echo "$ABORT_LINE" | grep -q "Worktree at"
if [ "$?" -eq 0 ]; then
  ok "stage-protocol.md - Abort: line contains preservation phrase same-line"
else
  not_ok "stage-protocol.md - Abort: line contains preservation phrase same-line" "got: $ABORT_LINE"
fi

# --- Test 5: branching-strategies.md dirty-tree bullet has new phrase ---
DIRTY_LINE=$(grep -n "Dirty tree on merge" "$BRANCH" | head -1)
echo "$DIRTY_LINE" | grep -q "Worktree preserved on retry"
if [ "$?" -eq 0 ]; then
  ok "branching-strategies.md Dirty-tree bullet appends preservation phrase"
else
  not_ok "branching-strategies.md Dirty-tree bullet appends preservation phrase" "got: $DIRTY_LINE"
fi

# --- Test 6: branching-strategies.md cross-link to halt-and-ask block ---
assert_grep "$BRANCH" "stage-protocol\.md.*Halt-and-ask" "branching-strategies.md cross-links to stage-protocol halt-and-ask"

# --- Test 7: aidlc-pipeline-deploy-agent.md conflict bullet appended ---
PD_LINE=$(grep -n "On conflict envelopes" "$PDAGENT" | head -1)
echo "$PD_LINE" | grep -q "preserves the worktree"
if [ "$?" -eq 0 ]; then
  ok "aidlc-pipeline-deploy-agent.md conflict bullet appends preservation phrase"
else
  not_ok "aidlc-pipeline-deploy-agent.md conflict bullet appends preservation phrase" "got: $PD_LINE"
fi

finish
