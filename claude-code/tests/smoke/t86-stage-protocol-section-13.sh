#!/bin/bash
# t86: Pin stage-protocol §13 (Learnings Ritual) prose + MEMORY_EMPTY registry placement
#      + the SKILL.md run-stage-gate-branch wiring that makes the orchestrator CALL
#        the §13 gate (surface/persist) — the seam no other test pins (7 tests)
# Pure bash + grep — no bun or claude required (L1)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

STAGE_PROTOCOL="$AIDLC_SRC/aidlc-common/protocols/stage-protocol.md"
AUDIT_TS="$AIDLC_SRC/tools/aidlc-audit.ts"
AUDIT_MD="$AIDLC_SRC/knowledge/aidlc-shared/audit-format.md"
STATE_MACHINE="$REPO_ROOT/docs/reference/12-state-machine.md"
SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"

plan 7

# --- Test 1: §13 heading present in stage-protocol.md ---
if grep -qE "^## 13\. Learnings Ritual$" "$STAGE_PROTOCOL"; then
  ok "stage-protocol.md contains '## 13. Learnings Ritual' heading"
else
  not_ok "stage-protocol.md missing '## 13. Learnings Ritual' heading" \
    "expected H2 '## 13. Learnings Ritual' in $STAGE_PROTOCOL"
fi

# --- Test 2: §13 documents the four canonical memory.md headings ---
# Each heading appears as a bolded list item (Interpretations / Deviations /
# Tradeoffs / Open questions). Pin all four — drift on any of them breaks
# MR 8's parseMemoryHeadings() and MR 12's destination-from-heading mapper.
missing=""
for h in "Interpretations" "Deviations" "Tradeoffs" "Open questions"; do
  if ! grep -qE "\\*\\*$h\\*\\*" "$STAGE_PROTOCOL"; then
    missing="$missing $h"
  fi
done
if [ -z "$missing" ]; then
  ok "§13 documents all four canonical memory.md headings"
else
  not_ok "§13 missing canonical headings:$missing" \
    "expected bolded **Interpretations**, **Deviations**, **Tradeoffs**, **Open questions**"
fi

# --- Test 3: §13 routes learnings + sensors via the pull-authoring model ---
# v0.5.0 MR 12 replaced the old applies_to routing model with the two-surface
# learnings files + the sensors: frontmatter pull-authoring bind. Pin the new
# canonical vocabulary: the two-surface destinations + the matches:/sensors:
# binding (the applies_to fossil is GONE — assert its absence too).
shapes_missing=""
for shape in "aidlc-project-learnings\.md" "aidlc-team-learnings\.md" "sensors: frontmatter" "matches:"; do
  if ! grep -qE "$shape" "$STAGE_PROTOCOL"; then
    shapes_missing="$shapes_missing '$shape'"
  fi
done
# The applies_to routing fossil must be fully gone from §13.
if grep -qE "applies_to" "$STAGE_PROTOCOL"; then
  shapes_missing="$shapes_missing 'applies_to-still-present'"
fi
if [ -z "$shapes_missing" ]; then
  ok "§13 routes via two-surface learnings + sensors: frontmatter bind (no applies_to fossil)"
else
  not_ok "§13 routing vocabulary drift:$shapes_missing" \
    "expected aidlc-{project,team}-learnings.md + sensors: frontmatter + matches:, and zero applies_to"
fi

# --- Test 4: MEMORY_EMPTY registered in three sources (TS, audit-format.md, 12-state-machine.md) ---
src_missing=""
grep -q '"MEMORY_EMPTY"' "$AUDIT_TS" || src_missing="$src_missing aidlc-audit.ts"
grep -q '`MEMORY_EMPTY`' "$AUDIT_MD" || src_missing="$src_missing audit-format.md"
grep -q '`MEMORY_EMPTY`' "$STATE_MACHINE" || src_missing="$src_missing 12-state-machine.md"
if [ -z "$src_missing" ]; then
  ok "MEMORY_EMPTY registered in all three sources (aidlc-audit.ts, audit-format.md, 12-state-machine.md)"
else
  not_ok "MEMORY_EMPTY missing from:$src_missing" \
    "MEMORY_EMPTY must appear in VALID_EVENT_TYPES + audit-format.md + 12-state-machine.md"
fi

# --- Test 5: 'Why stage files stay immutable' invariant present ---
# This subsection encodes the core architectural rule the learning loop relies
# on — without it, future contributors might edit stage files in §13 writes.
if grep -qE "^### Why stage files stay immutable$" "$STAGE_PROTOCOL"; then
  ok "§13 contains 'Why stage files stay immutable' invariant subsection"
else
  not_ok "§13 missing 'Why stage files stay immutable' invariant" \
    "expected H3 '### Why stage files stay immutable' in $STAGE_PROTOCOL"
fi

# --- Test 6: SKILL.md WIRES the §13 gate in the run-stage gate branch ---
# §13's prose protocol (tests 1-5) and the aidlc-learnings.ts tool (t97/t99) can
# both be perfect while the orchestrator never CALLS the gate. This pins the one
# place that makes it run: the gated run-stage path must invoke BOTH
# `aidlc-learnings.ts surface` and `persist`, and gate the call on test-run mode.
# Without this assertion, deleting SKILL.md's learnings step is a silent
# feature-death with zero other test failures.
#
# At the engine cutover the §13 wiring moved out of the old '## Stage Advancement'
# section (whose transition prose is now the engine's `report` job) into the
# forwarding loop's run-stage gate branch. We extract that '### Branching a
# run-stage on its gate' span (heading up to the next H2/H3) so the assertion
# tracks the wiring's new home; its intent is unchanged.
ADV=$(awk '/^### Branching a .run-stage. on its gate/{p=1;print;next} p && /^#{2,3} /{exit} p' "$SKILL")
adv_missing=""
echo "$ADV" | grep -qE 'aidlc-learnings\.ts surface'   || adv_missing="$adv_missing surface"
echo "$ADV" | grep -qE 'aidlc-learnings\.ts persist'   || adv_missing="$adv_missing persist"
echo "$ADV" | grep -qiE 'test-run mode|test-run'       || adv_missing="$adv_missing test-run-guard"
if [ -z "$adv_missing" ]; then
  ok "SKILL.md run-stage gate branch wires the §13 gate (surface + persist, test-run-guarded)"
else
  not_ok "SKILL.md run-stage gate branch missing §13 wiring:$adv_missing" \
    "expected the gated run-stage branch to call aidlc-learnings.ts surface AND persist, guarded by test-run mode"
fi

# --- Test 7: Test-Run block declares the §13 learnings ritual is SKIPPED ---
# The complement to test 6: under --test-run there is no human in the loop, so
# the gate must be explicitly declared skipped. Pins the contract that the
# skip is intentional (and the reason no workflow test exercises the gate).
if grep -qiE 'Learnings ritual.*Skipped|Skipped.*learnings' "$SKILL"; then
  ok "SKILL.md Test-Run block declares the §13 learnings ritual skipped under --test-run"
else
  not_ok "SKILL.md Test-Run block missing §13 skip declaration" \
    "expected a 'Learnings ritual (§13): Skipped …' line in the Test-Run Mode behavior block"
fi

finish
