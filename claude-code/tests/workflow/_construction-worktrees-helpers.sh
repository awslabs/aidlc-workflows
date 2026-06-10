#!/bin/bash
# Helpers for v0.4.0 milestone 13 workflow tests t60-t67 (construction-worktrees per scope).
#
# Each per-scope test (one per Construction-bearing scope) asserts the milestone 13
# orchestration contract holds for that scope without running a full `claude -p`
# end-to-end (which would add ~minutes per test to the workflow tier). The
# contract is:
#
#   1. scope-mapping.json has the expected `code-generation` execution mode
#      for the scope (skeleton-on scopes EXECUTE; bugfix/refactor/security-patch
#      EXECUTE but skip Inception-design stages; infra SKIPs entirely — not in
#      this test set).
#   2. Stub bolt-plan.md with N Bolts → SKILL.md per-Bolt loop is structurally
#      reachable for the scope (CONSTRUCTION region present, parallel-batch
#      block present, dispatch instrumentation prose present, halt-and-ask
#      prose present).
#   3. The `aidlc-bolt dispatch-event` subcommand runs cleanly inside an
#      initialized project for the scope — emits MERGE_DISPATCH_INVOKED audit
#      row at the right position in the per-Bolt audit sequence.
#   4. For skeleton-on scopes: SKILL.md walking-skeleton block respects the
#      practices fallback chain (assertions probe the U3 dynamic-stance prose).
#   5. For skeleton-off scopes: SKILL.md U3 prose names the scope as
#      skeleton-off in the fallback list.
#
# This avoids the multi-minute `claude -p` round-trip of the original workflow
# tests (t50 etc.) while still proving milestone 13's per-scope contract holds.

# Source guard — only meaningful when sourced from per-scope test files.
: "${AIDLC_SRC:?AIDLC_SRC must be set (source tests/lib/fixtures.sh first)}"

# Sets up an integration project AND runs `aidlc-utility init` for $1 (scope).
# Returns the project path on stdout. Prefer this over the bare
# setup_integration_project for milestone 13 workflow tests because we need
# aidlc-docs/aidlc-state.md to exist (the orchestrator and dispatch-event
# tools both probe that path).
setup_construction_project() {
  local scope="$1"
  local proj
  proj=$(setup_integration_project --with-greenfield-stub)
  bun "$AIDLC_SRC/tools/aidlc-utility.ts" init \
    --project-dir "$proj" --force --scope "$scope" >/dev/null 2>&1
  echo "$proj"
}

# Asserts the compiled scope-grid.json entry for $1 has the expected
# code-generation mode ("EXECUTE" or "SKIP"). milestone 12 retired scope-mapping.json;
# the grid (same {scope:{stages}} shape) is the transpose of the per-stage
# scopes: frontmatter and is the runtime source of truth.
assert_scope_codegen_mode() {
  local scope="$1"
  local expected="$2"
  local grid="$AIDLC_SRC/tools/data/scope-grid.json"
  local actual
  actual=$(bun -e "
    const m = require('$grid');
    const s = m['$scope'];
    if (!s) { console.log('MISSING'); process.exit(0); }
    console.log(s.stages['code-generation'] || 'UNDEFINED');
  ")
  if [ "$actual" = "$expected" ]; then
    ok "scope-grid.json: $scope code-generation = $expected"
  else
    not_ok "scope-grid.json: $scope code-generation should be $expected" "got: $actual"
  fi
}

# RETIRED (engine cutover): the SKILL.md CONSTRUCTION-Flow / parallel-batch /
# dispatch-instrumentation / halt-and-ask prose these helpers grepped was
# DELETED when the orchestrator was cut over to the engine forwarding loop
# (Wave 2). Per-Bolt dispatch routing is now an engine concern (run-stage today,
# future invoke-swarm), not SKILL.md dispatch prose — exactly the retirement the
# t70 rework documents for its own SKILL.md per-Bolt Steps. The SURVIVING
# behaviour still has coverage at its real home:
#   - dispatch / MERGE_DISPATCH_INVOKED: the deterministic tool aidlc-bolt.ts
#     dispatch-event — exercised below by assert_dispatch_event_runs_for_scope
#     (the one behavioural check that did NOT regress), plus the dedicated unit
#     tests t79-dispatch-event-validation / t33-tool-bolt.
#   - walking-skeleton / ladder / halt-and-ask / parallel-batch Bolt gates:
#     stage-protocol.md § "Construction Bolt gates", pinned by t47-construction-
#     bolts, t76-halt-and-ask-prose-shape, and the t09/t10/t11 worktree tests.
#   - HOLD-MERGE / Merge-Held invariant: aidlc-bolt.ts / aidlc-worktree.ts,
#     pinned by the dedicated t82-hold-merge-invariant unit test.
#   - practices fallback (extractMarkdownSection / PRACTICES_SECTION_EMPTY): now
#     tool-owned in aidlc-lib.ts / aidlc-state.ts and surfaced to the conductor
#     via the engine run-stage's rules_in_context, not a hand-run SKILL.md
#     preamble.
#   - skeleton-on/off stance: data in scope-mapping.json + the aidlc-org.md
#     Walking-Skeleton rule (greenfield scopes run the skeleton first), not
#     SKILL.md U3 prose; the per-scope codegen mode is still pinned by
#     assert_scope_codegen_mode below.
# The four prose-presence helpers (assert_construction_prose_intact,
# assert_practices_preamble_present, assert_hold_merge_invariant_present,
# assert_skill_skeleton_stance_for_scope) were therefore removed rather than
# re-pointed at SKILL.md — there is no SKILL.md prose left to anchor them to, and
# the behaviour they proxied is covered above.

# Asserts dispatch-event subcommand emits a MERGE_DISPATCH_INVOKED row
# inside an initialized project for $scope.
assert_dispatch_event_runs_for_scope() {
  local scope="$1"
  local proj="$2"
  local audit="$proj/aidlc-docs/audit.md"
  bun "$AIDLC_SRC/tools/aidlc-bolt.ts" dispatch-event \
    --event MERGE_DISPATCH_INVOKED \
    --slug "t-$scope-bolt-1" \
    --practices-excerpt "scope=$scope" \
    --project-dir "$proj" >/dev/null 2>&1
  if grep -q "MERGE_DISPATCH_INVOKED" "$audit" \
    && grep -q "Bolt slug.*t-$scope-bolt-1" "$audit"; then
    ok "dispatch-event MERGE_DISPATCH_INVOKED emits cleanly for scope=$scope"
  else
    not_ok "dispatch-event failed to emit for scope=$scope" "$(grep -c MERGE_ "$audit" || echo 0)"
  fi
}

# (assert_skill_skeleton_stance_for_scope, assert_practices_preamble_present,
#  and assert_hold_merge_invariant_present were RETIRED here — see the block
#  above assert_dispatch_event_runs_for_scope for why and where their behaviour
#  is now covered.)
