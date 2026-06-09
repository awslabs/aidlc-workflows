#!/bin/bash
# t37: Unit tests for --doctor drift detection + graph-level checks (23 tests).
#
# State/audit drift (tests 1-4): handleDoctor reports drift if audit.md records
# WORKFLOW_COMPLETED but the state file's Status is not "Completed".
#
# Graph checks (tests 5-): structural invariants surfaced via the
# aidlc-graph.ts library (findCycles, validateScope, etc.). Fixture-based
# sad paths inject a broken graph via AIDLC_STAGE_GRAPH to verify doctor
# catches drift. Doctor exits 1 on any check failure — `|| true` absorbs
# the non-zero so the test harness keeps running.
#
# Tests:
#   1. Clean workflow (Status=Completed matches WORKFLOW_COMPLETED) — no drift
#   2. Injected drift (WORKFLOW_COMPLETED in audit, Status=Running in state) — drift reported
#   3. No audit + no state — drift check silently skipped
#   4. State exists, audit has no WORKFLOW_COMPLETED — no drift check fires
#   5. Cycle detection happy — "Cycle detection: 0 cycles" on real graph
#   6. Cycle detection sad — AIDLC_STAGE_GRAPH fixture with A→B→A loop, "cycle(s) found"
#   7. Orphan files happy — "graph entries all have files" on real graph
#   8. Orphan files sad — AIDLC_STAGE_GRAPH fixture with slug-no-file, "no file on disk"
#   9. Scope validation happy — "N scopes valid" + advisory count on real graph
#  10. Scope validation sad — AIDLC_STAGE_GRAPH fixture with orphan required consume, "scopes have errors"
#  11. Schema happy — "31/31 stages valid" on real graph
#       (Sad-path covered by t62 + t65; doctor wraps the same library.)
#  12. Graph refs happy — "N artifacts + edges resolved" on real graph
#  13. Graph refs sad — AIDLC_STAGE_GRAPH fixture with bogus requires_stage
#  14. Keyword overlap happy — "no conflicts" on real scope-mapping
#  15. Keyword overlap sad — AIDLC_SCOPE_MAPPING with two scopes sharing a keyword
#  16. Heartbeat advisory on fresh install — absent .aidlc-hooks-health/ passes
#       with a "not yet fired" label (not drift; the first workflow stage
#       populates it).
#  17. Full happy path: setup_integration_project (full .claude/ scaffold +
#       aidlc-docs) → doctor exits 0. Proves every check passes end-to-end
#       on a correctly-provisioned project, which the docs promise.
#
# v0.4.0 MR 15 lib + constants (tests 18-22):
#  18. findAllEvents shape contract — multi-match audit-walker returns blocks
#       in start-to-end order; respects optional slug filter; returns [] on
#       no match.
#  19. Tag-regex constants — SLUG_TAG_REGEX, FORK_EMITTED_TAG_REGEX,
#       MERGE_SUCCEEDED_TAG_REGEX exist on the lib.ts surface and capture
#       their respective tag bodies.
#  20. PRACTICES_STALENESS_DAYS constant exported from aidlc-utility.ts at 90.
#  21. MERGE_DISPATCH_TIMEOUT_SEC constant exported from aidlc-utility.ts at 60.
#  22. PRACTICES_SECTION_EMPTY recognised by audit-walker — findAllEvents on
#       an audit fixture containing the event returns the row.
#  23. CRLF audit-walker normalisation — findAllEvents on a Windows-line-ending
#       audit fixture parses every block (regression: pre-fix \n---\n split
#       missed CRLF separators and silently merged blocks).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
UTIL="$AIDLC_SRC/tools/aidlc-utility.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 23

# --- Test 1: Drift detected (WORKFLOW_COMPLETED + Status=Running) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
# state-mid-ideation.md has Status=In Progress — mutate to Running (canonical)
sed_i 's/^- \*\*Status\*\*:.*$/- **Status**: Running/' "$PROJ/aidlc-docs/aidlc-state.md"
# Inject a WORKFLOW_COMPLETED into audit
cat >> "$PROJ/aidlc-docs/audit.md" <<'EOF'

## Workflow Completion
**Timestamp**: 2026-05-03T00:00:00Z
**Event**: WORKFLOW_COMPLETED
**Scope**: feature

---
EOF
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "State/audit drift"; then
  ok "doctor detects WORKFLOW_COMPLETED + Status=Running drift"
else
  not_ok "doctor detects WORKFLOW_COMPLETED + Status=Running drift" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 2: No drift (Status=Completed matches) ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
sed_i 's/^- \*\*Status\*\*:.*$/- **Status**: Completed/' "$PROJ/aidlc-docs/aidlc-state.md"
cat >> "$PROJ/aidlc-docs/audit.md" <<'EOF'

## Workflow Completion
**Timestamp**: 2026-05-03T00:00:00Z
**Event**: WORKFLOW_COMPLETED
**Scope**: feature

---
EOF
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "State matches last audit event (no drift)"; then
  ok "doctor confirms no drift when state matches"
else
  not_ok "doctor confirms no drift when state matches" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 3: Drift check silent when audit has no WORKFLOW_COMPLETED ---
PROJ=$(create_test_project)
seed_audit_file "$PROJ"  # fixture has no WORKFLOW_COMPLETED
seed_state_file "$PROJ" "$REPO_ROOT/tests/fixtures/state-mid-ideation.md"
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "State/audit drift"; then
  not_ok "doctor does not fire drift check without WORKFLOW_COMPLETED" "drift reported when it shouldn't be"
else
  ok "doctor does not fire drift check without WORKFLOW_COMPLETED"
fi
cleanup_test_project "$PROJ"

# --- Test 4: Drift check gracefully skipped when no state or audit file ---
PROJ=$(create_test_project)
# No state, no audit
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "State matches last audit event (no drift)"; then
  not_ok "doctor silently skips drift check without files" "drift check fired without files"
else
  ok "doctor silently skips drift check when no state/audit present"
fi
cleanup_test_project "$PROJ"

# --- Test 5: Cycle detection happy — real graph on main has zero cycles ---
PROJ=$(create_test_project)
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Cycle detection: 0 cycles"; then
  ok "doctor reports zero cycles on real graph"
else
  not_ok "doctor reports zero cycles on real graph" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 6: Cycle detection sad — inject A→B→A via AIDLC_STAGE_GRAPH ---
PROJ=$(create_test_project)
FIXTURE_GRAPH=$(mktemp "${TMPDIR:-/tmp}/mr11-cycle-graph-XXXXXX.json")
trap "rm -f '$FIXTURE_GRAPH'" EXIT
cat > "$FIXTURE_GRAPH" <<'EOF'
[
  {
    "slug": "stage-a",
    "number": "0.1",
    "name": "Stage A",
    "phase": "initialization",
    "execution": "ALWAYS",
    "condition": "Always",
    "lead_agent": "orchestrator",
    "support_agents": [],
    "mode": "inline",
    "produces": [],
    "consumes": [],
    "requires_stage": ["stage-b"],
    "inputs": "",
    "outputs": ""
  },
  {
    "slug": "stage-b",
    "number": "0.2",
    "name": "Stage B",
    "phase": "initialization",
    "execution": "ALWAYS",
    "condition": "Always",
    "lead_agent": "orchestrator",
    "support_agents": [],
    "mode": "inline",
    "produces": [],
    "consumes": [],
    "requires_stage": ["stage-a"],
    "inputs": "",
    "outputs": ""
  }
]
EOF
out=$(AIDLC_STAGE_GRAPH="$FIXTURE_GRAPH" bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "cycle(s) found"; then
  ok "doctor detects injected cycle via AIDLC_STAGE_GRAPH fixture"
else
  not_ok "doctor detects injected cycle via AIDLC_STAGE_GRAPH fixture" "got:\n$out"
fi
rm -f "$FIXTURE_GRAPH"
trap - EXIT
cleanup_test_project "$PROJ"

# --- Test 7: Orphan files happy — every graph slug has a file ---
PROJ=$(create_test_project)
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "graph entries all have files"; then
  ok "doctor reports all graph slugs have files"
else
  not_ok "doctor reports all graph slugs have files" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 8: Orphan files sad — fixture graph with slug that has no .md file ---
PROJ=$(create_test_project)
FIXTURE_GRAPH=$(mktemp "${TMPDIR:-/tmp}/mr11-orphan-graph-XXXXXX.json")
trap "rm -f '$FIXTURE_GRAPH'" EXIT
cat > "$FIXTURE_GRAPH" <<'EOF'
[
  {
    "slug": "nonexistent-stage",
    "number": "0.9",
    "name": "Nonexistent Stage",
    "phase": "initialization",
    "execution": "ALWAYS",
    "condition": "Always",
    "lead_agent": "orchestrator",
    "support_agents": [],
    "mode": "inline",
    "produces": [],
    "consumes": [],
    "requires_stage": [],
    "inputs": "",
    "outputs": ""
  }
]
EOF
out=$(AIDLC_STAGE_GRAPH="$FIXTURE_GRAPH" bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "no file on disk"; then
  ok "doctor detects graph slug missing its .md file"
else
  not_ok "doctor detects graph slug missing its .md file" "got:\n$out"
fi
rm -f "$FIXTURE_GRAPH"
trap - EXIT
cleanup_test_project "$PROJ"

# --- Test 9: Scope validation happy — 9 scopes valid on real graph ---
PROJ=$(create_test_project)
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Scope validation: [0-9]+ scopes valid"; then
  ok "doctor reports all scopes valid"
else
  not_ok "doctor reports all scopes valid" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 10: Scope validation sad — orphan required consume in scope sub-DAG ---
PROJ=$(create_test_project)
FIXTURE_GRAPH=$(mktemp "${TMPDIR:-/tmp}/mr11-scope-graph-XXXXXX.json")
FIXTURE_MAPPING=$(mktemp "${TMPDIR:-/tmp}/mr11-scope-mapping-XXXXXX.json")
trap "rm -f '$FIXTURE_GRAPH' '$FIXTURE_MAPPING'" EXIT
cat > "$FIXTURE_GRAPH" <<'EOF'
[
  {
    "slug": "stage-broken",
    "number": "0.1",
    "name": "Broken Stage",
    "phase": "initialization",
    "execution": "ALWAYS",
    "condition": "Always",
    "lead_agent": "orchestrator",
    "support_agents": [],
    "mode": "inline",
    "produces": [],
    "consumes": [
      { "artifact": "no-producer-artifact", "required": true }
    ],
    "requires_stage": [],
    "inputs": "",
    "outputs": ""
  }
]
EOF
cat > "$FIXTURE_MAPPING" <<'EOF'
{
  "minimal": {
    "depth": "Minimal",
    "keywords": [],
    "description": "fixture",
    "stages": { "stage-broken": "EXECUTE" }
  }
}
EOF
out=$(AIDLC_STAGE_GRAPH="$FIXTURE_GRAPH" AIDLC_SCOPE_MAPPING="$FIXTURE_MAPPING" \
      bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "scopes have errors"; then
  ok "doctor detects scope with required-consume producer missing"
else
  not_ok "doctor detects scope with required-consume producer missing" "got:\n$out"
fi
rm -f "$FIXTURE_GRAPH" "$FIXTURE_MAPPING"
trap - EXIT
cleanup_test_project "$PROJ"

# --- Test 11: Schema happy — all 31 real stages validate ---
PROJ=$(create_test_project)
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Schema validation: [0-9]+/[0-9]+ stages valid"; then
  ok "doctor reports all stages schema-valid"
else
  not_ok "doctor reports all stages schema-valid" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# Schema sad-path would require AIDLC_STAGES_DIR env-seam (mutate disk). Per
# Decision 6 we declined to add that seam; schema validation's failure paths
# are covered by t62 (stage-schema unit tests) and t65 (real-stage round-trip).
# Doctor's schema check wraps the same library function; happy-path suffices.

# --- Test 12: Graph refs happy — all artifacts + edges resolve ---
PROJ=$(create_test_project)
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -qE "Graph references: [0-9]+ artifacts \+ edges resolved"; then
  ok "doctor reports all graph references resolve"
else
  not_ok "doctor reports all graph references resolve" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 13: Graph refs sad — fixture graph with bogus requires_stage slug ---
PROJ=$(create_test_project)
FIXTURE_GRAPH=$(mktemp "${TMPDIR:-/tmp}/mr11-refs-graph-XXXXXX.json")
trap "rm -f '$FIXTURE_GRAPH'" EXIT
cat > "$FIXTURE_GRAPH" <<'EOF'
[
  {
    "slug": "stage-a",
    "number": "0.1",
    "name": "Stage A",
    "phase": "initialization",
    "execution": "ALWAYS",
    "condition": "Always",
    "lead_agent": "orchestrator",
    "support_agents": [],
    "mode": "inline",
    "produces": [],
    "consumes": [],
    "requires_stage": ["does-not-exist"],
    "inputs": "",
    "outputs": ""
  }
]
EOF
out=$(AIDLC_STAGE_GRAPH="$FIXTURE_GRAPH" bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "broken reference"; then
  ok "doctor detects unknown requires_stage slug"
else
  not_ok "doctor detects unknown requires_stage slug" "got:\n$out"
fi
rm -f "$FIXTURE_GRAPH"
trap - EXIT
cleanup_test_project "$PROJ"

# --- Test 14: Keyword overlap happy — no conflicts on real scope-mapping ---
PROJ=$(create_test_project)
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Keyword overlap: no conflicts"; then
  ok "doctor reports no keyword conflicts"
else
  not_ok "doctor reports no keyword conflicts" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 15: Keyword overlap sad — two scopes sharing a keyword ---
PROJ=$(create_test_project)
FIXTURE_MAPPING=$(mktemp "${TMPDIR:-/tmp}/mr11-kw-mapping-XXXXXX.json")
trap "rm -f '$FIXTURE_MAPPING'" EXIT
cat > "$FIXTURE_MAPPING" <<'EOF'
{
  "scope-a": {
    "depth": "Minimal",
    "keywords": ["shared-kw"],
    "description": "fixture A",
    "stages": {}
  },
  "scope-b": {
    "depth": "Minimal",
    "keywords": ["shared-kw"],
    "description": "fixture B",
    "stages": {}
  }
}
EOF
out=$(AIDLC_SCOPE_MAPPING="$FIXTURE_MAPPING" bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Keyword overlap: [0-9]* conflict"; then
  ok "doctor detects keyword claimed by multiple scopes"
else
  not_ok "doctor detects keyword claimed by multiple scopes" "got:\n$out"
fi
rm -f "$FIXTURE_MAPPING"
trap - EXIT
cleanup_test_project "$PROJ"

# --- Test 16: Heartbeat advisory on fresh install (no .aidlc-hooks-health/) ---
# create_test_project makes aidlc-docs/ but no .aidlc-hooks-health/ — simulates
# the post-init pre-first-run state. Heartbeat should pass with an advisory
# "not yet fired" label, not fail as drift.
PROJ=$(create_test_project)
out=$(bun "$UTIL" doctor --project-dir "$PROJ" 2>&1 || true)
if echo "$out" | grep -q "Hook heartbeats: not yet fired"; then
  ok "doctor passes heartbeat with advisory on fresh install"
else
  not_ok "doctor passes heartbeat with advisory on fresh install" "got:\n$out"
fi
cleanup_test_project "$PROJ"

# --- Test 17: Full happy path — doctor exits 0 on scaffolded project ---
# setup_integration_project copies the full .claude/ tree and makes
# aidlc-docs/. With no stale audit + no missing hooks + fresh heartbeat
# state, every check should pass. Proves the onboarding flow in
# docs/guide/01-getting-started.md delivers exit 0.
PROJ=$(setup_integration_project)
bun "$UTIL" doctor --project-dir "$PROJ" > /dev/null 2>&1
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "doctor exits 0 on full-scaffold project (integration happy path)"
else
  not_ok "doctor exits 0 on full-scaffold project (integration happy path)" "exit code: $RC"
fi
cleanup_test_project "$PROJ"

# ---------------------------------------------------------------------------
# v0.4.0 MR 15 — lib.ts exports + threshold constants
# ---------------------------------------------------------------------------

LIB="$AIDLC_SRC/tools/aidlc-lib.ts"

# --- Test 18: findAllEvents shape contract ---
# Build an audit fixture with three blocks: two WORKTREE_CREATED for different
# slugs and one WORKTREE_MERGED. findAllEvents("WORKTREE_CREATED") returns 2
# in chronological order; with slug filter returns 1; on no-match returns [].
out=$(bun -e '
import { findAllEvents } from "'"$LIB"'";
const audit = `## Worktree Created
**Timestamp**: 2026-05-19T10:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-foo

---

## Worktree Created
**Timestamp**: 2026-05-19T11:00:00Z
**Event**: WORKTREE_CREATED
**Bolt slug**: bolt-bar

---

## Worktree Merged
**Timestamp**: 2026-05-19T12:00:00Z
**Event**: WORKTREE_MERGED
**Bolt slug**: bolt-foo

---
`;
const all = findAllEvents(audit, "WORKTREE_CREATED");
const filtered = findAllEvents(audit, "WORKTREE_CREATED", "bolt-foo");
const empty = findAllEvents(audit, "NEVER_EMITTED");
console.log(JSON.stringify({
  allLen: all.length,
  firstTs: all[0]?.timestamp,
  filteredLen: filtered.length,
  filteredSlug: filtered[0]?.block.includes("bolt-foo"),
  emptyLen: empty.length,
}));
' 2>&1 | tail -1)
if [ "$out" = '{"allLen":2,"firstTs":"2026-05-19T10:00:00Z","filteredLen":1,"filteredSlug":true,"emptyLen":0}' ]; then
  ok "findAllEvents shape: chronological + slug filter + empty-array on miss"
else
  not_ok "findAllEvents shape: chronological + slug filter + empty-array on miss" "got: $out"
fi

# --- Test 19: Tag-regex constants capture their tag bodies ---
out=$(bun -e '
import { SLUG_TAG_REGEX, FORK_EMITTED_TAG_REGEX, MERGE_SUCCEEDED_TAG_REGEX } from "'"$LIB"'";
const slug = "[slug=bolt-foo] details".match(SLUG_TAG_REGEX);
const fork = "[fork-emitted:2026-05-19T12:00:00Z] more".match(FORK_EMITTED_TAG_REGEX);
const merge = "[merge-succeeded:abc1234] cleanup failed".match(MERGE_SUCCEEDED_TAG_REGEX);
console.log(JSON.stringify({
  slug: slug?.[1],
  fork: fork?.[1],
  merge: merge?.[1],
}));
' 2>&1 | tail -1)
if [ "$out" = '{"slug":"bolt-foo","fork":"2026-05-19T12:00:00Z","merge":"abc1234"}' ]; then
  ok "Tag regex constants capture slug / fork-emitted / merge-succeeded tag bodies"
else
  not_ok "Tag regex constants capture slug / fork-emitted / merge-succeeded tag bodies" "got: $out"
fi

# --- Test 20: PRACTICES_STALENESS_DAYS = 90 ---
out=$(bun -e 'import { PRACTICES_STALENESS_DAYS } from "'"$AIDLC_SRC/tools/aidlc-utility.ts"'"; console.log(PRACTICES_STALENESS_DAYS);' 2>&1 | tail -1)
if [ "$out" = "90" ]; then
  ok "PRACTICES_STALENESS_DAYS pinned at 90"
else
  not_ok "PRACTICES_STALENESS_DAYS pinned at 90" "got: $out"
fi

# --- Test 21: MERGE_DISPATCH_TIMEOUT_SEC = 60 ---
out=$(bun -e 'import { MERGE_DISPATCH_TIMEOUT_SEC } from "'"$AIDLC_SRC/tools/aidlc-utility.ts"'"; console.log(MERGE_DISPATCH_TIMEOUT_SEC);' 2>&1 | tail -1)
if [ "$out" = "60" ]; then
  ok "MERGE_DISPATCH_TIMEOUT_SEC pinned at 60"
else
  not_ok "MERGE_DISPATCH_TIMEOUT_SEC pinned at 60" "got: $out"
fi

# --- Test 22: PRACTICES_SECTION_EMPTY recognised by audit-walker ---
# This event is advisory-only (emitted on practices layer-3 fallback); doctor
# doesn't reconcile it but the walker must recognise it so future v0.5.0+
# reconciliation can pick it up cleanly.
out=$(bun -e '
import { findAllEvents } from "'"$LIB"'";
const audit = `## Practices Section Empty
**Timestamp**: 2026-05-19T13:00:00Z
**Event**: PRACTICES_SECTION_EMPTY
**Section**: Walking Skeleton

---
`;
const matches = findAllEvents(audit, "PRACTICES_SECTION_EMPTY");
console.log(JSON.stringify({ len: matches.length, ts: matches[0]?.timestamp }));
' 2>&1 | tail -1)
if [ "$out" = '{"len":1,"ts":"2026-05-19T13:00:00Z"}' ]; then
  ok "PRACTICES_SECTION_EMPTY recognised by audit-walker"
else
  not_ok "PRACTICES_SECTION_EMPTY recognised by audit-walker" "got: $out"
fi

# --- Test 23: CRLF audit-walker normalisation ---
# Pre-fix `audit.split(/\n---\n/)` did not match \r\n---\r\n separators on
# Windows-edited audit files, silently masking every drift class. This
# regression test pins the \r?\n normalisation contract.
out=$(bun -e '
import { findAllEvents } from "'"$LIB"'";
const crlf =
  "## Worktree Created\r\n" +
  "**Timestamp**: 2026-05-19T10:00:00Z\r\n" +
  "**Event**: WORKTREE_CREATED\r\n" +
  "**Bolt slug**: foo\r\n\r\n" +
  "---\r\n\r\n" +
  "## Worktree Merged\r\n" +
  "**Timestamp**: 2026-05-19T11:00:00Z\r\n" +
  "**Event**: WORKTREE_MERGED\r\n" +
  "**Bolt slug**: foo\r\n\r\n" +
  "---\r\n";
const created = findAllEvents(crlf, "WORKTREE_CREATED");
const merged = findAllEvents(crlf, "WORKTREE_MERGED");
console.log(JSON.stringify({ created: created.length, merged: merged.length }));
' 2>&1 | tail -1)
if [ "$out" = '{"created":1,"merged":1}' ]; then
  ok "findAllEvents normalises CRLF audit files (regression for the BLOCKER fix)"
else
  not_ok "findAllEvents normalises CRLF audit files (regression for the BLOCKER fix)" "got: $out"
fi

finish
