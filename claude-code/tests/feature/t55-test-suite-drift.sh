#!/bin/bash
# t55: Drift test for test-suite metadata — plan N vs header (N tests) vs README.
#
# Every test file encodes its assertion count in three places and they used to
# drift independently. This guard asserts they agree, and that the README
# registry is a bidirectional reflection of what exists on disk. Seven checks:
#
#   1. Header drift:   if a file's header has (N tests) / (N assertions), it
#                      must equal the file's `plan N`.
#   2. README drift:   if a file appears in tests/README.md, its (N tests)
#                      there must equal its `plan N`.
#   3. README coverage: every discovered test file has a README row, and
#                      every README row points to a file that exists.
#   4. Allowlist:      every entry in DYNAMIC_PLAN_ALLOWLIST exists on disk
#                      and still has a non-literal plan argument.
#   5. 09-testing.md drift: if a test's row in docs/reference/09-testing.md
#                      has (N tests|assertions), it must equal the row in
#                      tests/README.md. Caught 24 stale rows in MR 13 — this
#                      assertion exists to prevent the drift from returning.
#   6. Path drift:     scans dist/claude/.claude/, tests/, and docs/
#                      for stale path strings (`aidlc-knowledge/`,
#                      `.claude/practices/`, `rules/aidlc/`,
#                      `aidlc-docs/.sensors/`) and stale
#                      release-version markers in framework code (`v0.X.0`,
#                      `MR <N>`, `ROADMAP.md:<line>`, `(Inception N.N)`).
#                      One-time cleanup pass is recorded as zero hits;
#                      regressions surface as a loud failure.
#   7. Legacy-root drift: scans the same roots for the bare literal
#                      `aidlc-claude-code` (the pre-v0.6.0-MR-0 distributable
#                      root, relocated to dist/claude/). Permanent successor to
#                      MR 0's one-time zero-residual grep; carves out t55/t06
#                      and t112's migration-narrating prose + registry rows.
#
# L1 — pure bash + grep + awk. No bun, no claude.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

TESTS_DIR="$SCRIPT_DIR/.."
README="$TESTS_DIR/README.md"
TIERS=(smoke unit feature integration stage workflow worktree)

# Files whose `plan` is a computed expression, not a literal integer. Each
# one counts something discovered at runtime, so a fixed number would lie.
# Keep the comment explaining the expression — if a reader sees this list
# and wonders why a file is here, the answer should be one grep away.
DYNAMIC_PLAN_ALLOWLIST=(
  "unit/t15-knowledge-file-inventory.sh"           # plan = 11 + 11 + 6 + TOTAL_FILES
  "unit/t26-delivery-agent-timeline-guardrail.sh"  # plan = ${#FILES[@]}
  "feature/t32-stage-graph-consistency.sh"         # plan = ROW_COUNT*4 + FILE_COUNT
)

if [ ! -f "$README" ]; then
  echo "Bail out! tests/README.md not found at $README"
  exit 1
fi

plan 7

# docs/reference/09-testing.md carries a parallel test-registry table that
# describes each tier. It's not canonical — tests/README.md owns the counts —
# but readers of the reference chapter expect it to agree. Check 5 closes the
# drift gap that MR 13 found (24 stale rows).
TESTING_DOC="$TESTS_DIR/../docs/reference/09-testing.md"

# --- Helper: extract the plan argument from a test file ---
# Returns the literal integer, "DYNAMIC" for any expression/variable, or
# empty string if no `plan` line exists. Anchors on `^plan ` (after optional
# leading whitespace) to avoid false matches in comments or prose.
extract_plan_n() {
  local file="$1" line arg
  line=$(grep -m1 -E '^[[:space:]]*plan[[:space:]]+' "$file" 2>/dev/null || true)
  [ -z "$line" ] && { echo ""; return; }
  arg=$(echo "$line" | sed -E 's/^[[:space:]]*plan[[:space:]]+//; s/[[:space:]]*#.*$//')
  # Strip one layer of surrounding quotes (single or double)
  arg="${arg%\"}"; arg="${arg#\"}"
  arg="${arg%\'}"; arg="${arg#\'}"
  if [[ "$arg" =~ ^[0-9]+$ ]]; then
    echo "$arg"
  else
    echo "DYNAMIC"
  fi
}

# --- Helper: extract (N tests) or (N assertions) from the file header ---
# Searches the first 10 lines. Stage tests use "(N assertions, M turns)"; both
# forms count. Returns empty if no header count is present.
extract_header_n() {
  local file="$1"
  head -n 10 "$file" 2>/dev/null \
    | grep -oE '\(([0-9]+) (tests|assertions)\)' \
    | head -1 \
    | grep -oE '[0-9]+' \
    || true
}

# --- Parse tests/README.md once into parallel arrays ---
# Bash 3.2 (macOS) has no associative arrays; parallel arrays keyed by index
# work on every platform. Key by full "tier/filename.sh" — bare test IDs
# collide (t04, t19, t52 each appear in two tiers).
README_PATHS=()
README_COUNTS=()
while IFS= read -r line; do
  # Test rows start with `| tNN `; skip headers, separators, and prose
  [[ "$line" =~ ^\|[[:space:]]*t[0-9] ]] || continue
  # Column 2 holds a backticked path: `| tNN | \`tier/tNN-name.sh\` | desc |`
  file=$(echo "$line" | awk -F'`' '{print $2}')
  [ -z "$file" ] && continue
  # Column 4 (awk's 4th field splitting on |) holds the description. Take the
  # last (N tests|assertions) match — when a description has multiple
  # parenthesised counts ("31 stages ... (93 tests: 3 per stage)"), the last
  # one is the canonical total.
  desc=$(echo "$line" | awk -F'\\|' '{print $4}')
  n=$(echo "$desc" | grep -oE '\(([0-9]+) (tests|assertions)\)' | tail -1 | grep -oE '[0-9]+' || true)
  README_PATHS+=("$file")
  README_COUNTS+=("${n:-NONE}")
done < "$README"

lookup_readme_n() {
  local needle="$1" i
  for i in "${!README_PATHS[@]}"; do
    if [ "${README_PATHS[$i]}" = "$needle" ]; then
      echo "${README_COUNTS[$i]}"
      return
    fi
  done
  echo ""
}

is_allowlisted() {
  local needle="$1" entry
  for entry in "${DYNAMIC_PLAN_ALLOWLIST[@]}"; do
    [ "$entry" = "$needle" ] && return 0
  done
  return 1
}

# --- Walk every test file in the six tier directories ---
HEADER_FAILURES=""
README_DRIFT_FAILURES=""
MISSING_FROM_README=""
DISCOVERED=""

for tier in "${TIERS[@]}"; do
  tier_dir="$TESTS_DIR/$tier"
  [ -d "$tier_dir" ] || continue
  for f in "$tier_dir"/t*.sh; do
    [ -f "$f" ] || continue
    rel="$tier/$(basename "$f")"
    DISCOVERED+="$rel"$'\n'

    plan_n=$(extract_plan_n "$f")
    header_n=$(extract_header_n "$f")
    readme_n=$(lookup_readme_n "$rel")

    # Check 3a: every file must appear in the README (orphans are checked
    # separately below). Applies to allowlisted files too.
    if [ -z "$readme_n" ]; then
      MISSING_FROM_README+="  $rel"$'\n'
    fi

    # Allowlisted files skip the numeric equality checks — the guard's
    # assertion 4 handles their own plan-shape invariant.
    if is_allowlisted "$rel"; then
      continue
    fi

    # Check 1: header drift (only when both sides have a literal to compare).
    if [ -n "$header_n" ] && [ -n "$plan_n" ] && [ "$plan_n" != "DYNAMIC" ]; then
      if [ "$plan_n" != "$header_n" ]; then
        HEADER_FAILURES+="  $rel: plan=$plan_n header=$header_n"$'\n'
      fi
    fi

    # Check 2: README drift (only when the file is listed and plan is literal).
    if [ -n "$readme_n" ] && [ "$readme_n" != "NONE" ] \
       && [ -n "$plan_n" ] && [ "$plan_n" != "DYNAMIC" ]; then
      if [ "$plan_n" != "$readme_n" ]; then
        README_DRIFT_FAILURES+="  $rel: plan=$plan_n readme=$readme_n"$'\n'
      fi
    fi
  done
done

# Check 3b: every README row must point to a file that actually exists.
# Guard the iteration — bash 3.2 on macOS errors on empty-array expansion under set -u.
ORPHAN_README_ROWS=""
if [ "${#README_PATHS[@]}" -gt 0 ]; then
  for path in "${README_PATHS[@]}"; do
    if ! grep -qxF "$path" <<< "$DISCOVERED"; then
      ORPHAN_README_ROWS+="  $path (listed in README but not found on disk)"$'\n'
    fi
  done
fi

# Check 4: the dynamic-plan allowlist itself must stay honest.
ALLOWLIST_FAILURES=""
for entry in "${DYNAMIC_PLAN_ALLOWLIST[@]}"; do
  full_path="$TESTS_DIR/$entry"
  if [ ! -f "$full_path" ]; then
    ALLOWLIST_FAILURES+="  $entry: file not found (renamed or deleted?)"$'\n'
    continue
  fi
  plan_kind=$(extract_plan_n "$full_path")
  if [ "$plan_kind" != "DYNAMIC" ]; then
    ALLOWLIST_FAILURES+="  $entry: plan is now literal ($plan_kind) — remove from allowlist"$'\n'
  fi
done

# --- Emit the four assertions ---

if [ -z "$HEADER_FAILURES" ]; then
  ok "every test's header (N tests) matches its plan N"
else
  not_ok "header drift — file header (N tests) does not match plan N" \
    "$(echo -e "\n$HEADER_FAILURES")"
fi

if [ -z "$README_DRIFT_FAILURES" ]; then
  ok "every test's tests/README.md (N tests) matches its plan N"
else
  not_ok "README drift — tests/README.md (N tests) does not match plan N" \
    "$(echo -e "\n$README_DRIFT_FAILURES")"
fi

if [ -z "$MISSING_FROM_README" ] && [ -z "$ORPHAN_README_ROWS" ]; then
  ok "tests/README.md is a bidirectional reflection of tests/ on disk"
else
  combined=""
  [ -n "$MISSING_FROM_README" ] && combined+="files missing from README:"$'\n'"$MISSING_FROM_README"
  [ -n "$ORPHAN_README_ROWS" ] && combined+="orphan README rows (file not on disk):"$'\n'"$ORPHAN_README_ROWS"
  not_ok "README coverage — tests/ on disk does not match README registry" \
    "$(echo -e "\n$combined")"
fi

if [ -z "$ALLOWLIST_FAILURES" ]; then
  ok "DYNAMIC_PLAN_ALLOWLIST is valid — every entry exists and has a non-literal plan"
else
  not_ok "allowlist rot — DYNAMIC_PLAN_ALLOWLIST contains stale entries" \
    "$(echo -e "\n$ALLOWLIST_FAILURES")"
fi

# Check 5: 09-testing.md (N tests) column must match tests/README.md. Only rows
# with a literal (N tests|assertions) are compared; rows that omit the count or
# carry dynamic-plan prose are skipped.
TESTING_DOC_DRIFT=""
if [ -f "$TESTING_DOC" ]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^\|[[:space:]]*t[0-9] ]] || continue
    doc_path=$(echo "$line" | grep -oE 'tests/[a-z]+/t[0-9]+[a-zA-Z-]*\.sh' | head -1 || true)
    [ -z "$doc_path" ] && continue
    doc_n=$(echo "$line" | grep -oE '\(([0-9]+) (tests|assertions)\)' | tail -1 | grep -oE '[0-9]+' || true)
    [ -z "$doc_n" ] && continue
    short_path="${doc_path#tests/}"
    readme_n=$(lookup_readme_n "$short_path")
    if [ -n "$readme_n" ] && [ "$readme_n" != "NONE" ] && [ "$doc_n" != "$readme_n" ]; then
      TESTING_DOC_DRIFT+="  $short_path: 09-testing.md=$doc_n readme=$readme_n"$'\n'
    fi
  done < "$TESTING_DOC"
fi

if [ -z "$TESTING_DOC_DRIFT" ]; then
  ok "docs/reference/09-testing.md (N tests) matches tests/README.md"
else
  not_ok "09-testing.md drift — docs/reference/09-testing.md (N tests) does not match tests/README.md" \
    "$(echo -e "\n$TESTING_DOC_DRIFT")"
fi

# Check 6: path + version-marker drift sweep
# Scans the framework distributable, tests, and docs for stale strings that
# the structural reorg removed. Excludes CHANGELOG.md and ROADMAP.md (those
# are versioning surfaces) and archive/ (historical record).
PATH_DRIFT=""
# Carve-outs: t55 contains the patterns as its search regex (self-exclusion);
# t06 asserts on legacy strings as negative-match patterns to guard CLAUDE.md
# against regressing the post-Wave-1 layout. Both legitimately embed the
# strings the sweep otherwise rejects.
PATH_HITS=$(grep -rn 'aidlc-knowledge/\|\.claude/practices/\|rules/aidlc/\|practices/team\.md\|practices/org\.md\|practices/project\.md\|aidlc-docs/\.sensors/' \
  "$REPO_ROOT/dist/claude/.claude/" \
  "$REPO_ROOT/tests/" \
  "$REPO_ROOT/docs/" 2>/dev/null \
  | grep -v 'node_modules' \
  | grep -v 't55-test-suite-drift\.sh' \
  | grep -v 't06-claude-md-paths\.sh' \
  | grep -v 'tests/logs/' \
  || true)
if [ -n "$PATH_HITS" ]; then
  PATH_DRIFT+="stale path strings (aidlc-knowledge/, .claude/practices/, rules/aidlc/, practices/{team,org,project}.md, aidlc-docs/.sensors/):"$'\n'
  PATH_DRIFT+="$PATH_HITS"$'\n'
fi

# Version markers in framework code only. Carve-outs: aidlc-version.ts (its
# job is to declare a version), data/ (stage-graph.json's "number" fields
# are canonical identifiers), and the user-facing error message in
# aidlc-utility.ts that references ROADMAP for migration guidance. Sensor
# manifests under .claude/sensors/aidlc-* declare default-version-of-behaviour
# (e.g., "tsc by default for v0.5.0; multi-language detection deferred to
# v0.6.0+") — these are semantic content, not stale drift.
VERSION_HITS=$(grep -rn 'v0\.[0-9]\+\.[0-9]\+\|MR [0-9]\+\|ROADMAP\.md:[0-9]\|(Inception [0-9]\+\.[0-9]\+)\|(Construction [0-9]\+\.[0-9]\+)\|(Operation [0-9]\+\.[0-9]\+)' \
  "$REPO_ROOT/dist/claude/.claude/" 2>/dev/null \
  | grep -v 'aidlc-version\.ts' \
  | grep -v 'node_modules' \
  | grep -v '/data/' \
  | grep -v 'aidlc-utility\.ts.*Per ROADMAP' \
  | grep -v '/sensors/aidlc-' \
  || true)
if [ -n "$VERSION_HITS" ]; then
  PATH_DRIFT+="release-version markers in framework code:"$'\n'
  PATH_DRIFT+="$VERSION_HITS"$'\n'
fi

if [ -z "$PATH_DRIFT" ]; then
  ok "no stale path strings or version markers in framework code, tests, or docs"
else
  not_ok "path-and-version drift — stale references reintroduced" \
    "$(echo -e "\n$PATH_DRIFT")"
fi

# Check 7: legacy distributable-root drift (v0.6.0 MR 0).
# MR 0 relocated the framework aidlc-claude-code/ -> dist/claude/. This is the
# PERMANENT half of MR 0's double gate: the bare literal `aidlc-claude-code`
# must not reappear as a live path in the framework tree, tests, or docs.
# (The one-time completeness proof lived in tmp/; this is its committed
# successor so a future MR reintroducing the old root fails loudly.)
# Carve-outs — legitimate references to the move, NOT live paths:
#   t55 (this file, embeds the literal as its own search pattern + this comment);
#   t06 (asserts on legacy strings as negative-match CLAUDE.md guards);
#   t112 (the distribution-guard test + its two registry rows narrate the
#   aidlc-claude-code/ -> dist/claude/ migration in prose).
# CHANGELOG.md / ROADMAP.md (version+plan history) sit outside these scan roots.
LEGACY_ROOT_HITS=$(grep -rn 'aidlc-claude-code' \
  "$REPO_ROOT/dist/claude/.claude/" \
  "$REPO_ROOT/tests/" \
  "$REPO_ROOT/docs/" 2>/dev/null \
  | grep -v 'node_modules' \
  | grep -v 'tests/logs/' \
  | grep -v 't55-test-suite-drift\.sh' \
  | grep -v 't06-claude-md-paths\.sh' \
  | grep -v 't112-learnings-distribution-guard\.sh' \
  | grep -v 'tests/README\.md:.*| t112 ' \
  | grep -v '09-testing\.md:.*| t112 ' \
  || true)
if [ -z "$LEGACY_ROOT_HITS" ]; then
  ok "no stale aidlc-claude-code/ distributable-root references (post-v0.6.0-MR-0)"
else
  not_ok "legacy-root drift — aidlc-claude-code/ reintroduced after the dist/claude/ move" \
    "$(echo -e "\n$LEGACY_ROOT_HITS")"
fi

finish
