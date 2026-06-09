#!/bin/bash
# t41: SKILL.md forwarding-loop contract + stage-graph data table (15 tests).
#
# ENGINE-CUTOVER REWRITE. This test formerly validated the prose orchestrator's
# flag-handling HANDLER STRUCTURE — that SKILL.md itself documented --stage /
# --phase / --scope / --depth / --test-strategy, the invalid-value error wording,
# the forward/backward/redo jump-direction computation, the mutual-exclusivity
# guard, the composable-flag-extraction section, and the init-jump block. At the
# cutover that ENTIRE dispatch surface moved into the deterministic orchestration
# engine (aidlc-orchestrate.ts): the engine resolves scope + flag precedence,
# computes jump direction via aidlc-jump.ts resolve, and emits the verbatim error
# directives. Those behaviours are now pinned by the engine's own tests —
# t114-orchestrate-next.sh (flags, precedence, mutual-exclusivity, --phase
# resolution, Unknown-scope error) and t118-engine-differential.sh (per-scope
# directives, the verbatim skip error, the no-state trio).
#
# So this test flips: instead of asserting the dispatch prose is PRESENT, it
# asserts the cutover's SKILL.md contract — the forwarding loop is present, flag
# handling is DELEGATED to the engine (the dispatch prose is gone), and the two
# human-readable data tables (scope-table + stage-graph) survive. A regression
# that re-grew prose dispatch in SKILL.md, or dropped the loop / the stage-graph
# table, reds this guard.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

plan 15

SKILL="$AIDLC_SRC/skills/aidlc/SKILL.md"

# --- Tests 1-4: the forwarding loop is present and consults the engine ---
assert_grep "$SKILL" 'aidlc-orchestrate' "SKILL.md forwarding loop invokes the orchestration engine"
assert_grep "$SKILL" 'aidlc-orchestrate.ts next' "SKILL.md loop calls the engine's next subcommand"
assert_grep "$SKILL" 'aidlc-orchestrate.ts report' "SKILL.md loop calls the engine's report subcommand"
assert_grep "$SKILL" 'directive' "SKILL.md loop acts on the engine's directive"

# --- Tests 5-9: the engine owns the flag-dispatch surface (prose is GONE) ---
# The verbatim error wording + handler sections that USED to live in SKILL.md are
# now the engine's; assert they are NOT re-grown as prose here. (Each behaviour
# is positively pinned in t114 / t118.)
assert_not_grep "$SKILL" 'Composable Flag Extraction' \
  "SKILL.md no longer carries the prose Composable Flag Extraction handler (engine owns flag parsing)"
assert_not_grep "$SKILL" 'FORWARD JUMP' \
  "SKILL.md no longer computes jump direction in prose (engine delegates to aidlc-jump resolve)"
assert_not_grep "$SKILL" 'Unknown depth' \
  "SKILL.md no longer carries the invalid-depth error wording (engine emits it)"
assert_not_grep "$SKILL" 'Unknown test strategy' \
  "SKILL.md no longer carries the invalid-test-strategy error wording (engine emits it)"
assert_not_grep "$SKILL" 'Cannot use --stage and --phase together' \
  "SKILL.md no longer carries the mutual-exclusivity error wording (engine emits it)"

# --- Test 10: the run-stage directive's mode/gate branch is documented ---
# The conductor still branches a run-stage on its gate (the §13 ritual seam);
# that intra-stage control flow stays in SKILL.md.
assert_grep "$SKILL" 'gate' "SKILL.md documents branching a run-stage on its gate"

# --- Tests 11-15: the stage-graph data table survives (5 representative slugs) ---
# The stage graph is human-readable DATA the engine mirrors from
# data/stage-graph.json — preserved through the cutover (like the scope-table).
# A --stage jump can target any of these; t32 cross-checks the full table.
for slug in intent-capture reverse-engineering code-generation \
  ci-pipeline observability-setup; do
  assert_grep "$SKILL" "$slug" "stage-graph table includes slug: $slug"
done

finish
