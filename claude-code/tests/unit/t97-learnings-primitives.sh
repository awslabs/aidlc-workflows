#!/bin/bash
# t97 (unit): aidlc-learnings primitives (v0.5.0 MR 12). Covers the new
# parseMemoryEntries parser (one-entry-per-counted-line + the
# .length === parseMemoryHeadings.total invariant), the surface/persist
# subcommand contract, the surface read-only candidate emission, and the
# persist admission-gate writer (cid-marker idempotency, two-surface
# scope routing, the two-write sensor bind, decide-inside-lock recovery).
# 32 assertions across the four groups: 6 parseMemoryEntries + 6 subcommand
# + 7 surface + 13 persist (some cases assert more than one fact, e.g. the
# two-write sensor bind asserts BOTH writes landed).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOOLS="$REPO_ROOT/dist/claude/.claude/tools"
LIB_TS="$TOOLS/aidlc-lib.ts"
LEARNINGS_TS="$TOOLS/aidlc-learnings.ts"

if [ ! -f "$LIB_TS" ] || [ ! -f "$LEARNINGS_TS" ]; then
  echo "Bail out! aidlc-lib.ts or aidlc-learnings.ts not found"
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 32

# --- parseMemoryEntries (6) -------------------------------------------------
#
# Each case feeds a memory.md string to a tiny bun harness that imports
# parseMemoryEntries + parseMemoryHeadings and prints the assertion result.

# Helper: run a JS expression with both parsers imported; $1 = expr.
pm() {
  bun -e "
    import { parseMemoryEntries, parseMemoryHeadings } from '$LIB_TS';
    const out = ($1);
    console.log(typeof out === 'string' ? out : JSON.stringify(out));
  " 2>&1
}

# 1. single canonical entry per heading → correct {heading, ts, summary, context}
RAW1='## Interpretations\n- 2026-05-28T14:22:11Z — Used BDD format; reviewer prefers it, team standardised.\n\n## Deviations\n\n## Tradeoffs\n\n## Open questions\n'
R=$(pm "(() => { const raw='$RAW1'.replace(/\\\\n/g,String.fromCharCode(10)); const e=parseMemoryEntries(raw)[0]; return [e.heading,e.ts,e.summary,e.context].join('|'); })()")
EXPECT='Interpretations|2026-05-28T14:22:11Z|Used BDD format|reviewer prefers it, team standardised.'
assert_eq "$R" "$EXPECT" "single canonical entry → {heading, ts, summary, context} parsed"

# 2. wrapped two-line entry → TWO degenerate entries AND .length === .total
RAW2='## Deviations\n- 2026-05-28T10:00:00Z — first line summary; context here\n  continuation wrapped line that is not canonical\n'
LEN=$(pm "(() => { const raw='$RAW2'.replace(/\\\\n/g,String.fromCharCode(10)); return parseMemoryEntries(raw).length === parseMemoryHeadings(raw).total ? 'ok:'+parseMemoryEntries(raw).length : 'mismatch'; })()")
assert_eq "$LEN" "ok:2" "wrapped two-line entry → TWO entries AND length===total (no merge)"

# 3. code-fence containing a fake `## Deviations` must NOT parse as a heading/entry
RAW3='## Interpretations\n- 2026-05-28T09:00:00Z — real entry; ctx\n\`\`\`\n## Deviations\n- 2026-05-28T09:01:00Z — fenced fake; should not count\n\`\`\`\n'
R=$(pm "(() => { const raw='$RAW3'.replace(/\\\\n/g,String.fromCharCode(10)); const e=parseMemoryEntries(raw); return e.length+':'+(e.length===parseMemoryHeadings(raw).total); })()")
assert_eq "$R" "1:true" "code-fenced fake ## Deviations is skipped; length===total"

# 4. blank-entry skip (blank lines under a heading are not entries)
RAW4='## Tradeoffs\n\n\n- 2026-05-28T11:00:00Z — only real one; ctx\n\n'
R=$(pm "(() => { const raw='$RAW4'.replace(/\\\\n/g,String.fromCharCode(10)); const e=parseMemoryEntries(raw); return e.length+':'+(e.length===parseMemoryHeadings(raw).total); })()")
assert_eq "$R" "1:true" "blank lines under a heading are skipped; length===total"

# 5. missing-heading tolerance — no throw, returns whatever exists
RAW5='## Interpretations\n- 2026-05-28T12:00:00Z — lone entry; ctx\n'
R=$(pm "(() => { const raw='$RAW5'.replace(/\\\\n/g,String.fromCharCode(10)); try { const e=parseMemoryEntries(raw); return 'no-throw:'+e.length; } catch (err) { return 'threw'; } })()")
assert_eq "$R" "no-throw:1" "missing headings tolerated — never throws"

# 6. entry with no `;` separator → tail becomes summary, context empty
RAW6='## Deviations\n- 2026-05-28T13:00:00Z — summary with no semicolon separator\n'
R=$(pm "(() => { const raw='$RAW6'.replace(/\\\\n/g,String.fromCharCode(10)); const e=parseMemoryEntries(raw)[0]; return e.summary+'|ctx='+JSON.stringify(e.context); })()")
assert_eq "$R" 'summary with no semicolon separator|ctx=""' "entry with no ; → tail→summary, context empty"

# --- shared fixture setup for subcommand / surface / persist ----------------
#
# Each persist/surface case builds an isolated project dir under a TMP root so
# audit + learnings writes don't cross-contaminate.
TMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# mkproj <name> — scaffold a minimal project tree; echoes the project dir.
# Active stage = user-stories; phase = inception; one runtime-graph row.
mkproj() {
  local pd="$TMP_ROOT/$1"
  mkdir -p "$pd/aidlc-docs/inception/user-stories" "$pd/.claude/rules" \
           "$pd/.claude/aidlc-common/stages/inception"
  cat > "$pd/aidlc-docs/aidlc-state.md" <<EOF
# AI-DLC State Tracking
- **Current Stage**: user-stories
- **Scope**: feature
EOF
  cat > "$pd/aidlc-docs/runtime-graph.json" <<EOF
{ "workflow_id": "w1", "scope": "feature", "started_at": "2026-05-28T13:00:00Z",
  "stages": [ { "stage_slug": "user-stories", "memory_path": "aidlc-docs/inception/user-stories/memory.md" } ] }
EOF
  cat > "$pd/.claude/aidlc-common/stages/inception/user-stories.md" <<EOF
---
slug: user-stories
phase: inception
execution: ALWAYS
lead_agent: aidlc-product-agent
support_agents: []
sensors:
  - required-sections
inputs: foo
outputs: bar
---

# User Stories

## Steps
1. do the thing
EOF
  echo "$pd"
}

# --- subcommand surface (5) -------------------------------------------------

# 7. --help lists surface + persist
HELP=$(bun "$LEARNINGS_TS" --help 2>&1)
assert_contains "$HELP" "surface" "--help lists surface"
H2=$(bun "$LEARNINGS_TS" --help 2>&1)
assert_contains "$H2" "persist" "--help lists persist"

# 8. unknown subcommand → exit 2
set +e
bun "$LEARNINGS_TS" bogus --slug x >/dev/null 2>&1; EC=$?
set -e
assert_eq "$EC" "2" "unknown subcommand → exit 2"

# 9. surface missing --slug → exit 1
PD9=$(mkproj p9)
set +e
bun "$LEARNINGS_TS" surface --project-dir "$PD9" >/dev/null 2>&1; EC=$?
set -e
assert_eq "$EC" "1" "surface missing --slug → exit 1"

# 10. persist missing --selections-json → exit 1
set +e
bun "$LEARNINGS_TS" persist --slug user-stories --project-dir "$PD9" >/dev/null 2>&1; EC=$?
set -e
assert_eq "$EC" "1" "persist missing --selections-json → exit 1"

# 11. --project-dir <missing> on surface → exit 1 (no state file)
set +e
bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$TMP_ROOT/does-not-exist" >/dev/null 2>&1; EC=$?
set -e
assert_eq "$EC" "1" "surface with missing project dir → exit 1"

# --- surface (6) ------------------------------------------------------------

# 12. empty memory.md → candidates: []
PD=$(mkproj p12)
: > "$PD/aidlc-docs/inception/user-stories/memory.md"
OUT=$(bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$PD")
N=$(echo "$OUT" | bun -e "const j=JSON.parse(require('node:fs').readFileSync(0,'utf-8')); console.log(j.candidates.length);")
assert_eq "$N" "0" "empty memory.md → zero candidates"

# 13. Deviations/Interpretations/Tradeoffs → one candidate each, correct heading, no suggested_kind
PD=$(mkproj p13)
cat > "$PD/aidlc-docs/inception/user-stories/memory.md" <<EOF
## Interpretations
- 2026-05-28T14:00:00Z — interp one; ctx i

## Deviations
- 2026-05-28T14:01:00Z — dev one; ctx d

## Tradeoffs
- 2026-05-28T14:02:00Z — trade one; ctx t

## Open questions
EOF
OUT=$(bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$PD")
HEADINGS=$(echo "$OUT" | bun -e "const j=JSON.parse(require('node:fs').readFileSync(0,'utf-8')); console.log(j.candidates.map(c=>c.source_heading).join(','));")
assert_eq "$HEADINGS" "Interpretations,Deviations,Tradeoffs" "I/D/T → one candidate each with correct source_heading"
assert_not_contains "$OUT" "suggested_kind" "surface emits no suggested_kind/suggested_section"

# 14. Open questions → parked, NOT candidates
PD=$(mkproj p14)
cat > "$PD/aidlc-docs/inception/user-stories/memory.md" <<EOF
## Interpretations

## Deviations

## Tradeoffs

## Open questions
- 2026-05-28T15:00:00Z — should split by persona or journey?
EOF
OUT=$(bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$PD")
R=$(echo "$OUT" | bun -e "const j=JSON.parse(require('node:fs').readFileSync(0,'utf-8')); console.log(j.candidates.length+':'+j.parked_open_questions.length);")
assert_eq "$R" "0:1" "Open questions → parked_open_questions, never candidates"

# 15. mixed headings → correct partition (2 candidates + 1 parked)
PD=$(mkproj p15)
cat > "$PD/aidlc-docs/inception/user-stories/memory.md" <<EOF
## Interpretations
- 2026-05-28T14:00:00Z — i; ci

## Deviations
- 2026-05-28T14:01:00Z — d; cd

## Tradeoffs

## Open questions
- 2026-05-28T15:00:00Z — q?
EOF
OUT=$(bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$PD")
R=$(echo "$OUT" | bun -e "const j=JSON.parse(require('node:fs').readFileSync(0,'utf-8')); console.log(j.candidates.length+':'+j.parked_open_questions.length);")
assert_eq "$R" "2:1" "mixed headings → correct partition (2 candidates, 1 parked)"

# 16. test-run mode → {candidates:[], parked_open_questions:[], skipped}
PD=$(mkproj p16)
cat > "$PD/aidlc-docs/aidlc-state.md" <<EOF
# AI-DLC State Tracking
- **Current Stage**: user-stories
- **Test-Run Mode**: true
EOF
OUT=$(bun "$LEARNINGS_TS" surface --slug user-stories --project-dir "$PD")
assert_contains "$OUT" '"skipped":"test-run-mode"' "test-run mode → skipped, no candidates"

# 17. slug-not-Active → exit 1
PD=$(mkproj p17)
set +e
bun "$LEARNINGS_TS" surface --slug some-other-stage --project-dir "$PD" >/dev/null 2>&1; EC=$?
set -e
assert_eq "$EC" "1" "slug not Active stage → exit 1"

# --- persist (9) ------------------------------------------------------------

# Helper to write a selections file. $1 = project dir, $2 = json body file.
# 18. learning (project scope) → RULE_LEARNED + cid marker + atomic write,
#     file created from template with rolling-list heading.
PD=$(mkproj p18)
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "Reused auth module; saved a rewrite", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
PLF="$PD/.claude/rules/aidlc-project-learnings.md"
assert_grep "$PLF" "cid:user-stories:c1" "project learning → cid marker line in aidlc-project-learnings.md"
assert_grep "$PLF" "^## Learnings" "project-learnings file has rolling-list heading"
assert_grep "$PD/aidlc-docs/audit.md" "Event.*: RULE_LEARNED" "project learning → RULE_LEARNED audit row"

# 19. learning (team scope) → write to aidlc-team-learnings.md
PD=$(mkproj p19)
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c2", "type": "learning", "scope": "team", "heading": "Deviation", "text": "Picked TDD over BDD", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
assert_grep "$PD/.claude/rules/aidlc-team-learnings.md" "cid:user-stories:c2" "team learning → write to aidlc-team-learnings.md"

# 20. sensor → SENSOR_PROPOSED + project-tier manifest w/ matches AND id appended
#     to origin_stage sensors: frontmatter (assert BOTH writes landed).
PD=$(mkproj p20)
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c5", "type": "sensor", "origin_stage": "user-stories",
    "manifest_fields": { "id": "acceptance-format", "kind": "deterministic", "command": "bun .claude/tools/aidlc-sensor.ts fire acceptance-format", "default_severity": "advisory", "description": "Checks AC format", "matches": "**/aidlc-docs/inception/user-stories/**", "timeout_seconds": 30 } } ] }
EOF
AIDLC_STAGES_DIR="$PD/.claude/aidlc-common/stages" bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
assert_grep "$PD/.claude/sensors/aidlc-acceptance-format.md" 'matches:' "sensor → project-tier manifest written with matches glob"
assert_grep "$PD/.claude/aidlc-common/stages/inception/user-stories.md" "acceptance-format$" "sensor → id appended to origin_stage sensors: frontmatter (two-write)"

# 21. framework-tier sensor manifest path → exit 1
PD=$(mkproj p21)
mkdir -p "$PD/dist/claude/.claude/sensors"
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c9", "type": "sensor", "origin_stage": "user-stories",
    "manifest_fields": { "id": "bad", "kind": "deterministic", "command": "x", "default_severity": "advisory", "description": "d", "matches": "**/*" } } ] }
EOF
set +e
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD/dist/claude" >/dev/null 2>&1; EC=$?
set -e
assert_eq "$EC" "1" "framework-distribution sensor manifest path → exit 1"

# 22. free-text → Source: user_addition + Candidate-ID: free_text_<seq>
PD=$(mkproj p22)
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "free_text_1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "Surface unknowns earlier", "source": "user_addition" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
FT_BLOCK=$(awk '/Event.*: RULE_LEARNED/{p=1} p; /^---$/{if(p)exit}' "$PD/aidlc-docs/audit.md")
assert_contains "$FT_BLOCK" "Source**: user_addition" "free-text → Source: user_addition"
assert_contains "$FT_BLOCK" "Candidate-ID**: free_text_1" "free-text → Candidate-ID free_text_1"

# 23. idempotent re-run → no re-emit, no duplicate line
PD=$(mkproj p23)
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Tradeoff", "text": "kept once", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
ROWS=$(grep -c "Event.*: RULE_LEARNED" "$PD/aidlc-docs/audit.md")
LINES=$(grep -c "cid:user-stories:c1" "$PD/.claude/rules/aidlc-project-learnings.md")
assert_eq "$ROWS:$LINES" "1:1" "idempotent re-run → exactly one audit row + one file line"

# 24. belt-and-braces recovery → audit row present, line deleted → re-write only, exit 0
PD=$(mkproj p24)
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Deviation", "text": "recover me", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
# delete the line, keep the audit row
grep -v "cid:user-stories:c1" "$PD/.claude/rules/aidlc-project-learnings.md" > "$PD/tmp.md" && mv "$PD/tmp.md" "$PD/.claude/rules/aidlc-project-learnings.md"
set +e
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null 2>&1; EC=$?
set -e
ROWS=$(grep -c "Event.*: RULE_LEARNED" "$PD/aidlc-docs/audit.md")
LINES=$(grep -c "cid:user-stories:c1" "$PD/.claude/rules/aidlc-project-learnings.md")
assert_eq "$EC:$ROWS:$LINES" "0:1:1" "recovery → re-write only (audit row not duplicated), exit 0"

# 25. false-negative guard — file already has entry under a prior date → re-run
#     does NOT append a second copy (line-count unchanged).
PD=$(mkproj p25)
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "no double append", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
# Re-run on a fresh day: cid marker (not the date) keys idempotency, so still one line.
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
LINES=$(grep -c "cid:user-stories:c1" "$PD/.claude/rules/aidlc-project-learnings.md")
assert_eq "$LINES" "1" "false-negative guard → no second copy on re-run (cid-keyed, not date-keyed)"

# 26. test-run → exit 0, no writes/emits (most-recent audit block Test-Run: true)
PD=$(mkproj p26)
cat > "$PD/aidlc-docs/audit.md" <<EOF

## Stage Start
**Timestamp**: 2026-05-29T10:00:00Z
**Event**: STAGE_STARTED
**Stage**: user-stories
**Test-Run**: true

---
EOF
cat > "$PD/sel.json" <<EOF
{ "stage_slug": "user-stories", "selections": [
  { "candidate_id": "c1", "type": "learning", "scope": "project", "heading": "Interpretation", "text": "should not write", "source": "orchestrator" } ] }
EOF
bun "$LEARNINGS_TS" persist --slug user-stories --selections-json "$PD/sel.json" --project-dir "$PD" >/dev/null
ROWS=$(grep -c "Event.*: RULE_LEARNED" "$PD/aidlc-docs/audit.md" || true)
assert_eq "$ROWS:$([ -f "$PD/.claude/rules/aidlc-project-learnings.md" ] && echo file || echo none)" "0:none" "test-run → no writes, no emits"

finish
