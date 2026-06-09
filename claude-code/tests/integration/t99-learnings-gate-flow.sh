#!/bin/bash
# t99 (integration): §13 learning-gate end-to-end (v0.5.0 MR 12).
#
# Drives the real surface → simulated-AUQ-glue → persist round-trip against a
# real .claude/ copy + audit + memory.md + state. The conflict-check
# COMPARISON is the orchestrator-LLM's job (KNOWLEDGE) and never lives in the
# tool; Case 3b exercises it with a STUBBED verdict — the orchestrator's
# reject/escalate decision is modelled by what the test writes into the
# selections-json (persist receives only conflict-clear / user-escalated
# selections and never judges).
#
# Cases:
#   1  surface mixed-heading memory → persist project + team learnings + audit
#   2  test-run end-to-end → surface skipped, persist refuses, no ritual rows
#   3  sensor proposal → project-tier manifest + frontmatter bind + compile binds
#   3b admission conflict-check (stubbed) → reject path no-writes; escalate writes
#   4  idempotent re-run (same selections-json) → no-op
#   5  concurrent persist (same selections-json) → exactly one row + one line
#   6  recovery — audit row present, file line gone → re-write only, skip emit
#   +  glue assertion: label → candidate_id → selection-record mapping
#
# Tier: L2 integration. Deterministic — no claude CLI.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOOLS="$REPO_ROOT/dist/claude/.claude/tools"
LEARNINGS_TS="$TOOLS/aidlc-learnings.ts"
GRAPH_TS="$TOOLS/aidlc-graph.ts"
FIX="$SCRIPT_DIR/../fixtures/v05-mr12-learnings"

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 16

# mkproj — full .claude/ copy + state + runtime-graph for the user-stories
# stage. Echoes the project dir.
mkproj() {
  local pd
  pd=$(create_test_project)
  cp -r "$REPO_ROOT/dist/claude/.claude" "$pd/.claude"
  mkdir -p "$pd/aidlc-docs/inception/user-stories"
  cat > "$pd/aidlc-docs/aidlc-state.md" <<EOF
# AI-DLC State Tracking
- **Current Stage**: user-stories
- **Scope**: feature
EOF
  cat > "$pd/aidlc-docs/runtime-graph.json" <<EOF
{ "workflow_id": "w1", "scope": "feature", "started_at": "2026-05-28T13:00:00Z",
  "stages": [ { "stage_slug": "user-stories", "memory_path": "aidlc-docs/inception/user-stories/memory.md" } ] }
EOF
  echo "$pd"
}

# --- Case 1: surface mixed → persist project + team learnings + 2 audit rows -

PD=$(mkproj)
cp "$FIX/memory-mixed.md" "$PD/aidlc-docs/inception/user-stories/memory.md"

# surface → structured candidates + parked open questions
SURF=$(bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$PD")
NCAND=$(echo "$SURF" | bun -e "const j=JSON.parse(require('node:fs').readFileSync(0,'utf-8')); console.log(j.candidates.length+':'+j.parked_open_questions.length);")
assert_eq "$NCAND" "3:1" "Case 1: surface → 3 candidates (I/D/T) + 1 parked open question"

# Simulated AUQ glue: the orchestrator correlates kept labels back to
# candidate ids; here it keeps c1 (project) and c2 (widened to team).
cat > "$PD/sel1.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "Reused the existing auth module; saved a full rewrite", "source": "orchestrator" },
  { "candidate_id": "c2", "type": "learning", "scope": "team", "heading": "Deviation", "text": "Used Given/When/Then for AC; team standardised", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel1.json" --project-dir "$PD" >/dev/null
assert_grep "$PD/.claude/rules/aidlc-project-learnings.md" "cid:user-stories:c1" "Case 1: project pick lands in aidlc-project-learnings.md"
assert_grep "$PD/.claude/rules/aidlc-team-learnings.md" "cid:user-stories:c2" "Case 1: team-scoped pick lands in aidlc-team-learnings.md"
ROWS=$(grep -c "Event.*: RULE_LEARNED" "$PD/aidlc-docs/audit.md")
assert_eq "$ROWS" "2" "Case 1: two RULE_LEARNED audit rows"

# --- Case 2: test-run end-to-end → surface skipped + persist refuses ---------

PD=$(mkproj)
cp "$FIX/memory-mixed.md" "$PD/aidlc-docs/inception/user-stories/memory.md"
cat > "$PD/aidlc-docs/aidlc-state.md" <<EOF
# AI-DLC State Tracking
- **Current Stage**: user-stories
- **Test-Run Mode**: true
EOF
SURF=$(bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$PD")
assert_contains "$SURF" '"skipped":"test-run-mode"' "Case 2: surface skipped in test-run mode"
# Even if a selections-json is constructed, the most-recent audit block flags
# test-run, so persist refuses to write.
cat > "$PD/aidlc-docs/audit.md" <<EOF

## Stage Start
**Timestamp**: 2026-05-29T10:00:00Z
**Event**: STAGE_STARTED
**Stage**: user-stories
**Test-Run**: true

---
EOF
cat > "$PD/sel2.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "should not write", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel2.json" --project-dir "$PD" >/dev/null
assert_file_not_exists "$PD/.claude/rules/aidlc-project-learnings.md" "Case 2: persist refuses in test-run — no learnings file written"

# --- Case 3: sensor proposal → manifest + frontmatter bind → compile binds ---

PD=$(mkproj)
cat > "$PD/sel3.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c5", "type": "sensor", "origin_stage": "user-stories",
    "manifest_fields": { "id": "acceptance-format", "kind": "deterministic", "command": "bun .claude/tools/aidlc-sensor.ts fire acceptance-format", "default_severity": "advisory", "description": "Checks AC uses Given/When/Then", "matches": "**/aidlc-docs/inception/user-stories/**", "timeout_seconds": 30 } } ] }
EOF
AIDLC_STAGES_DIR="$PD/.claude/aidlc-common/stages" \
  bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel3.json" --project-dir "$PD" >/dev/null
# Manifest parses + all schema fields present.
MANIFEST="$PD/.claude/sensors/aidlc-acceptance-format.md"
PARSE=$(bun -e "import { parseSensorManifest } from '$TOOLS/aidlc-sensor-schema.ts'; const m=parseSensorManifest(require('node:fs').readFileSync('$MANIFEST','utf-8')); console.log(m.id+':'+m.matches);")
assert_eq "$PARSE" "acceptance-format:**/aidlc-docs/inception/user-stories/**" "Case 3: project-tier manifest parses via parseSensorManifest with matches glob"
# compile binds the new id into the originating stage's sensors_applicable.
cp "$TOOLS/data/stage-graph.json" "$PD/sg.json"
AIDLC_STAGES_DIR="$PD/.claude/aidlc-common/stages" AIDLC_SENSORS_DIR="$PD/.claude/sensors" AIDLC_STAGE_GRAPH="$PD/sg.json" \
  bun "$GRAPH_TS" compile --project-dir "$PD" >/dev/null 2>&1
BOUND=$(bun -e "const g=JSON.parse(require('node:fs').readFileSync('$PD/sg.json','utf-8')); const s=g.find(x=>x.slug==='user-stories'); console.log((s.sensors_applicable||[]).map(r=>r.id).includes('acceptance-format'));")
assert_eq "$BOUND" "true" "Case 3: next compile binds the id into user-stories sensors_applicable (two-write install)"
# SENSOR_PROPOSED row with Destinations: [<origin_stage>].
SP_BLOCK=$(awk '/Event.*: SENSOR_PROPOSED/{p=1} p; /^---$/{if(p)exit}' "$PD/aidlc-docs/audit.md")
assert_contains "$SP_BLOCK" 'Destinations**: ["user-stories"]' "Case 3: SENSOR_PROPOSED row carries Destinations array [user-stories]"

# --- Case 3b: admission conflict-check (STUBBED verdict) ---------------------
# A SINGLE dated learning whose text contradicts the org Way of Working
# (trunk-based / short-lived branches). The orchestrator-LLM compares it
# against aidlc-org.md's matching ## section (KNOWLEDGE; stubbed here).
#
# Reject verdict: the orchestrator does NOT place the candidate in the
# selections-json → persist writes nothing for it (no RULE_LEARNED, no line).
# Escalate verdict: the user escalates → the orchestrator DOES include it →
# persist writes it through.

PD=$(mkproj)
cp "$FIX/memory-mixed.md" "$PD/aidlc-docs/inception/user-stories/memory.md"
# Reject: empty selections (the conflicting candidate was dropped pre-write).
cat > "$PD/sel3b-reject.json" <<EOF
{ "stage_slug": "user-stories", "selections": [] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel3b-reject.json" --project-dir "$PD" >/dev/null
REJ_ROWS=$(grep -c "Event.*: RULE_LEARNED" "$PD/aidlc-docs/audit.md" 2>/dev/null || true)
assert_eq "${REJ_ROWS:-0}" "0" "Case 3b: rejected entry never reaches persist — no RULE_LEARNED row, no line"
# Escalate: the user escalates the same entry → it now reaches persist.
cat > "$PD/sel3b-escalate.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c_escalated", "type": "learning", "scope": "project", "heading": "Deviation", "text": "This project uses long-lived release branches despite the org trunk-based default", "source": "user_addition" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel3b-escalate.json" --project-dir "$PD" >/dev/null
assert_grep "$PD/.claude/rules/aidlc-project-learnings.md" "cid:user-stories:c_escalated" "Case 3b: user-escalated entry writes through to the learnings file"

# --- Case 4: idempotent re-run (same selections-json) → no-op ----------------

PD=$(mkproj)
cp "$FIX/memory-mixed.md" "$PD/aidlc-docs/inception/user-stories/memory.md"
cat > "$PD/sel4.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "kept once", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel4.json" --project-dir "$PD" >/dev/null
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel4.json" --project-dir "$PD" >/dev/null
ROWS=$(grep -c "Event.*: RULE_LEARNED" "$PD/aidlc-docs/audit.md")
LINES=$(grep -c "cid:user-stories:c1" "$PD/.claude/rules/aidlc-project-learnings.md")
assert_eq "$ROWS:$LINES" "1:1" "Case 4: idempotent re-run → exactly one audit row + one file line"

# --- Case 5: concurrent persist (same selections-json) → exactly one ---------

PD=$(mkproj)
cp "$FIX/memory-mixed.md" "$PD/aidlc-docs/inception/user-stories/memory.md"
cat > "$PD/sel5.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Tradeoff", "text": "race-safe write", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel5.json" --project-dir "$PD" >/dev/null 2>&1 &
P1=$!
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel5.json" --project-dir "$PD" >/dev/null 2>&1 &
P2=$!
wait "$P1" || true
wait "$P2" || true
ROWS=$(grep -c "Event.*: RULE_LEARNED" "$PD/aidlc-docs/audit.md")
LINES=$(grep -c "cid:user-stories:c1" "$PD/.claude/rules/aidlc-project-learnings.md")
assert_eq "$ROWS:$LINES" "1:1" "Case 5: concurrent persist serialises → exactly one row + one line"

# --- Case 6: recovery — audit row present, file line gone → re-write only ----

PD=$(mkproj)
cp "$FIX/memory-mixed.md" "$PD/aidlc-docs/inception/user-stories/memory.md"
cat > "$PD/sel6.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Deviation", "text": "recover me", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel6.json" --project-dir "$PD" >/dev/null
# Simulate crash-between-emit-and-write: delete the file line, keep the row.
grep -v "cid:user-stories:c1" "$PD/.claude/rules/aidlc-project-learnings.md" > "$PD/tmp.md" && mv "$PD/tmp.md" "$PD/.claude/rules/aidlc-project-learnings.md"
set +e
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel6.json" --project-dir "$PD" >/dev/null 2>&1; EC=$?
set -e
ROWS=$(grep -c "Event.*: RULE_LEARNED" "$PD/aidlc-docs/audit.md")
LINES=$(grep -c "cid:user-stories:c1" "$PD/.claude/rules/aidlc-project-learnings.md")
assert_eq "$EC:$ROWS:$LINES" "0:1:1" "Case 6: recovery re-writes the line, skips re-emit, exit 0"

# --- Glue assertion: label → candidate_id → selection-record mapping ---------
# The surface JSON exposes id + summary; the orchestrator renders one AUQ
# option per candidate (label = summary) and correlates the kept label back
# to its id to build the selection record. Verify the contract fields exist
# so two implementers can't build incompatible glue.
PD=$(mkproj)
cp "$FIX/memory-mixed.md" "$PD/aidlc-docs/inception/user-stories/memory.md"
SURF=$(bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$PD")
GLUE=$(echo "$SURF" | bun -e "
  const j=JSON.parse(require('node:fs').readFileSync(0,'utf-8'));
  const c=j.candidates[0];
  // label = summary (verbatim); id correlates back to a selection record.
  console.log([typeof c.id, typeof c.summary, c.source_heading, c.default_scope].join(':'));
")
assert_eq "$GLUE" "string:string:Interpretations:project" "Glue: candidate carries {id, summary, source_heading, default_scope} for label↔id correlation"

# --- §13 fossil sweep (seam §7 check 5 — t55 does NOT cover these) -----------
# After the §13 rewrite, stage-protocol.md §13 must carry ZERO sensor-protocol.md
# refs, ZERO applies_to refs, and ZERO pre-v3 "MR <N>" doctor-coverage refs.
# Extract the §13 span (## 13. Learnings Ritual → the next H2 or ---) and grep.
SP="$REPO_ROOT/dist/claude/.claude/aidlc-common/protocols/stage-protocol.md"
SECTION13=$(awk '/^## 13\. Learnings Ritual$/{p=1} p && /^### Artifact Re-use$/{exit} p' "$SP")
FOSSILS=$(echo "$SECTION13" | grep -nE 'sensor-protocol\.md|applies_to|MR 1[0-9]|MR 9|doctor coverage check' || true)
assert_eq "$FOSSILS" "" "§13 rewrite carries zero sensor-protocol.md / applies_to / pre-v3 MR-doctor fossils"

finish
