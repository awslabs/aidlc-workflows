#!/bin/bash
# t119 (smoke): SKILL.md line budget — the Agent Skills 500-line ceiling (1 test).
#
# The orchestrator's SKILL.md must stay under the Agent Skills spec's 500-line
# limit. Before the cutover it ran 895 lines (≈1.8× over); the forwarding-loop
# rewrite brought it under by deleting all between-stage dispatch prose (now
# owned by the deterministic orchestration engine, aidlc-orchestrate.ts) and
# keeping only the loop protocol + the conductor's execution-quality prose.
#
# The pin is the 500 CEILING, deliberately — NOT the current ~230-line landing.
# A later increment of the orchestration framework collapses the body further
# (the persona prose extracts to a shared conductor file); pinning the actual
# count would make that future shrink falsely "regress" this guard. 500 is the
# hard contract; anything below it is healthy headroom.
#
# Mirrors the tap.sh + fixtures.sh harness used by the other smoke tests
# (e.g. t01-file-structure.sh).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"

plan 1

LINES=$(wc -l < "$SKILL" | tr -d ' ')
# assert_lt is strict-less-than; "< 501" is exactly "<= 500" for an integer
# line count, so this pins the 500-line ceiling.
assert_lt "$LINES" 501 \
  "SKILL.md is <= 500 lines (Agent Skills ceiling); measured $LINES"

finish
