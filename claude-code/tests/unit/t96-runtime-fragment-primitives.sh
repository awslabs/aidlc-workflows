#!/bin/bash
# t96 (unit): aidlc-runtime fragment-fork / fragment-merge primitives
# (v0.5.0 MR 11). 14 unit assertions covering every guard + happy/error path.
#
# Surface tested:
#   - fragment-fork happy path: byte-equal copy, JSON envelope shape,
#     source_runtime_graph_hash correctness, source_present: true.
#   - fragment-fork source-absent (G5 single-read fallback): writes empty
#     graph, source_present: false.
#   - fragment-fork one-shot guard: refuses to overwrite existing fragment.
#   - fragment-fork worktree-missing guard.
#   - fragment-fork slug validation: missing flag + invalid slug regex.
#   - fragment-merge happy path: unlinks fragment, JSON envelope shape.
#   - fragment-merge fragment-absent (idempotent): exit 0,
#     status: "fragment-absent".
#   - fragment-merge slug validation.
#   - fragment-merge worktree-missing → defensive fragment-absent.
#   - --help lists the two new subcommands.
#   - --project-dir flag plumbing (B1 prerequisite from MR 11 plan).
#
# Strategy: each test builds a self-contained project skeleton under
# tempdir, with a worktree directory + state.md byte-copy (mirrors what
# state-fork would have populated before fragment-fork ran in real flow).
# Cleanup trap removes every fixture even if a test exits early.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNTIME_TS="$REPO_ROOT/dist/claude/.claude/tools/aidlc-runtime.ts"
STATE_FIXTURE="$REPO_ROOT/tests/fixtures/state-construction.md"

if [ ! -f "$RUNTIME_TS" ]; then
  echo "Bail out! aidlc-runtime.ts not found at $RUNTIME_TS"
  exit 1
fi
if [ ! -f "$STATE_FIXTURE" ]; then
  echo "Bail out! state-construction.md fixture not found at $STATE_FIXTURE"
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "1..0 # SKIP bun not installed"
  exit 0
fi

plan 14

# --- Helpers --------------------------------------------------------------

FIXTURES=()
trap '
	for f in "${FIXTURES[@]:-}"; do
		if [ -n "$f" ] && [ -d "$f" ]; then
			rm -rf "$f" 2>/dev/null || true
		fi
	done
' EXIT INT TERM

# Build a project skeleton with main aidlc-state.md and (optionally) a
# pre-populated main runtime-graph.json + worktree dir for slug $1.
# Output: prints the project root path on stdout.
#
# Args:
#   $1 — slug to pre-create the worktree for (or empty string for none)
#   $2 — main_runtime_graph_content (or empty string to skip main)
make_project() {
  local slug="$1"
  local main_graph_content="$2"
  local proj
  proj=$(mktemp -d -t aidlc-t96-XXXXXX)
  FIXTURES+=("$proj")
  mkdir -p "$proj/aidlc-docs"
  cp "$STATE_FIXTURE" "$proj/aidlc-docs/aidlc-state.md"
  if [ -n "$main_graph_content" ]; then
    printf '%s' "$main_graph_content" >"$proj/aidlc-docs/runtime-graph.json"
  fi
  if [ -n "$slug" ]; then
    local wt="$proj/.aidlc/worktrees/bolt-$slug"
    mkdir -p "$wt/aidlc-docs"
    # state-fork byte-copies main state to worktree — simulate that.
    cp "$proj/aidlc-docs/aidlc-state.md" "$wt/aidlc-docs/aidlc-state.md"
  fi
  echo "$proj"
}

wt_fragment_path() {
  echo "$1/.aidlc/worktrees/bolt-$2/aidlc-docs/runtime-graph.json"
}

# Run aidlc-runtime fragment-* with --project-dir; capture stdout, stderr,
# exit code into globals so individual tests can assert on them.
run_runtime() {
  RUNTIME_OUT="$(bun "$RUNTIME_TS" --project-dir "$1" "${@:2}" 2>/tmp/t96-stderr.$$)"
  RUNTIME_RC=$?
  RUNTIME_ERR="$(cat /tmp/t96-stderr.$$)"
  rm -f /tmp/t96-stderr.$$
  return 0
}

# --- 1. fragment-fork happy path -----------------------------------------

GRAPH='{"workflow_id":"t96-1","scope":"feature","started_at":"2026-05-28T10:00:00Z","stages":[]}'
PROJ=$(make_project "auth" "$GRAPH")
WT_FRAG=$(wt_fragment_path "$PROJ" "auth")
EXPECTED_HASH=$(printf '%s' "$GRAPH" | shasum -a 256 | awk '{print $1}')

run_runtime "$PROJ" fragment-fork --slug auth || true
if [ "$RUNTIME_RC" = "0" ] && [ -f "$WT_FRAG" ] &&
  diff -q "$PROJ/aidlc-docs/runtime-graph.json" "$WT_FRAG" >/dev/null 2>&1 &&
  echo "$RUNTIME_OUT" | grep -q "\"status\":\"fragment-forked\"" &&
  echo "$RUNTIME_OUT" | grep -q "\"slug\":\"auth\"" &&
  echo "$RUNTIME_OUT" | grep -q "\"source_runtime_graph_hash\":\"$EXPECTED_HASH\"" &&
  echo "$RUNTIME_OUT" | grep -q "\"source_present\":true"; then
  ok "fragment-fork happy path: byte-equal copy + JSON envelope + matching hash + source_present:true"
else
  not_ok "fragment-fork happy path" "rc=$RUNTIME_RC out='$RUNTIME_OUT' err='$RUNTIME_ERR'"
fi

# --- 2. fragment-fork source-absent (no main runtime-graph) --------------

PROJ=$(make_project "cart" "") # no main graph
WT_FRAG=$(wt_fragment_path "$PROJ" "cart")
run_runtime "$PROJ" fragment-fork --slug cart || true
if [ "$RUNTIME_RC" = "0" ] && [ -f "$WT_FRAG" ] &&
  echo "$RUNTIME_OUT" | grep -q "\"status\":\"fragment-forked\"" &&
  echo "$RUNTIME_OUT" | grep -q "\"source_present\":false" &&
  grep -q '"stages": \[\]' "$WT_FRAG"; then
  ok "fragment-fork source-absent: writes empty graph, source_present:false"
else
  not_ok "fragment-fork source-absent" "rc=$RUNTIME_RC out='$RUNTIME_OUT' fragment exists=$(test -f "$WT_FRAG" && echo Y || echo N)"
fi

# --- 3. fragment-fork one-shot guard -------------------------------------

PROJ=$(make_project "auth" "$GRAPH")
run_runtime "$PROJ" fragment-fork --slug auth || true # first ok
WT_FRAG=$(wt_fragment_path "$PROJ" "auth")
PRE_HASH=$(shasum -a 256 "$WT_FRAG" | awk '{print $1}')
run_runtime "$PROJ" fragment-fork --slug auth || true # second errors
POST_HASH=$(shasum -a 256 "$WT_FRAG" | awk '{print $1}')
if [ "$RUNTIME_RC" != "0" ] &&
  echo "$RUNTIME_ERR" | grep -q "fragment already exists" &&
  echo "$RUNTIME_ERR" | grep -q "refusing to overwrite" &&
  [ "$PRE_HASH" = "$POST_HASH" ]; then
  ok "fragment-fork one-shot: second invocation errors + leaves existing fragment unchanged"
else
  not_ok "fragment-fork one-shot" "rc=$RUNTIME_RC err='$RUNTIME_ERR' pre=$PRE_HASH post=$POST_HASH"
fi

# --- 4. fragment-fork worktree-missing guard -----------------------------

PROJ=$(make_project "" "$GRAPH") # no worktree dir
run_runtime "$PROJ" fragment-fork --slug nonexistent || true
if [ "$RUNTIME_RC" != "0" ] &&
  echo "$RUNTIME_ERR" | grep -q "worktree directory not found" &&
  echo "$RUNTIME_ERR" | grep -q "run aidlc-worktree create first"; then
  ok "fragment-fork worktree-missing: errors with actionable message"
else
  not_ok "fragment-fork worktree-missing" "rc=$RUNTIME_RC err='$RUNTIME_ERR'"
fi

# --- 5. fragment-fork slug-validation: missing flag ----------------------

PROJ=$(make_project "auth" "$GRAPH")
run_runtime "$PROJ" fragment-fork || true
if [ "$RUNTIME_RC" != "0" ] && echo "$RUNTIME_ERR" | grep -q -- "--slug <slug> required"; then
  ok "fragment-fork slug-validation: --slug required"
else
  not_ok "fragment-fork --slug required" "rc=$RUNTIME_RC err='$RUNTIME_ERR'"
fi

# --- 6. fragment-fork slug-validation: invalid regex ---------------------

PROJ=$(make_project "auth" "$GRAPH")
run_runtime "$PROJ" fragment-fork --slug "BAD!" || true
if [ "$RUNTIME_RC" != "0" ] && echo "$RUNTIME_ERR" | grep -q "Invalid Bolt slug"; then
  ok "fragment-fork slug-validation: regex rejection (BOLT_SLUG_REGEX)"
else
  not_ok "fragment-fork slug regex" "rc=$RUNTIME_RC err='$RUNTIME_ERR'"
fi

# --- 7. fragment-merge happy path ----------------------------------------

PROJ=$(make_project "auth" "$GRAPH")
run_runtime "$PROJ" fragment-fork --slug auth || true # set up the fragment
WT_FRAG=$(wt_fragment_path "$PROJ" "auth")
PRE_HASH=$(shasum -a 256 "$WT_FRAG" | awk '{print $1}')
run_runtime "$PROJ" fragment-merge --slug auth || true
if [ "$RUNTIME_RC" = "0" ] && [ ! -e "$WT_FRAG" ] &&
  echo "$RUNTIME_OUT" | grep -q "\"status\":\"fragment-merged\"" &&
  echo "$RUNTIME_OUT" | grep -q "\"slug\":\"auth\"" &&
  echo "$RUNTIME_OUT" | grep -q "\"fragment_runtime_graph_hash\":\"$PRE_HASH\""; then
  ok "fragment-merge happy: unlinks fragment + JSON envelope + matching pre-unlink hash"
else
  not_ok "fragment-merge happy" "rc=$RUNTIME_RC out='$RUNTIME_OUT' fragment exists=$(test -e "$WT_FRAG" && echo Y || echo N)"
fi

# --- 8. fragment-merge fragment-absent (idempotent) ----------------------

PROJ=$(make_project "auth" "$GRAPH")
# Fragment never created (no fragment-fork). Worktree dir exists.
run_runtime "$PROJ" fragment-merge --slug auth || true
if [ "$RUNTIME_RC" = "0" ] &&
  echo "$RUNTIME_OUT" | grep -q "\"status\":\"fragment-absent\"" &&
  echo "$RUNTIME_OUT" | grep -q "\"slug\":\"auth\""; then
  ok "fragment-merge idempotent: status:fragment-absent + exit 0"
else
  not_ok "fragment-merge idempotent" "rc=$RUNTIME_RC out='$RUNTIME_OUT' err='$RUNTIME_ERR'"
fi

# --- 9. fragment-merge slug-validation: missing flag ---------------------

PROJ=$(make_project "auth" "$GRAPH")
run_runtime "$PROJ" fragment-merge || true
if [ "$RUNTIME_RC" != "0" ] && echo "$RUNTIME_ERR" | grep -q -- "--slug <slug> required"; then
  ok "fragment-merge slug-validation: --slug required"
else
  not_ok "fragment-merge --slug required" "rc=$RUNTIME_RC err='$RUNTIME_ERR'"
fi

# --- 10. fragment-merge slug-validation: invalid regex ------------------

PROJ=$(make_project "auth" "$GRAPH")
run_runtime "$PROJ" fragment-merge --slug "BAD!" || true
if [ "$RUNTIME_RC" != "0" ] && echo "$RUNTIME_ERR" | grep -q "Invalid Bolt slug"; then
  ok "fragment-merge slug-validation: regex rejection"
else
  not_ok "fragment-merge slug regex" "rc=$RUNTIME_RC err='$RUNTIME_ERR'"
fi

# --- 11. fragment-merge worktree-missing → defensive fragment-absent ----

PROJ=$(make_project "" "$GRAPH") # no worktree dir
run_runtime "$PROJ" fragment-merge --slug nonexistent || true
if [ "$RUNTIME_RC" = "0" ] &&
  echo "$RUNTIME_OUT" | grep -q "\"status\":\"fragment-absent\""; then
  ok "fragment-merge worktree-missing: defensive fragment-absent"
else
  not_ok "fragment-merge worktree-missing" "rc=$RUNTIME_RC out='$RUNTIME_OUT'"
fi

# --- 12. --help lists both new subcommands ------------------------------

HELP_OUT="$(bun "$RUNTIME_TS" --help 2>&1)"
if echo "$HELP_OUT" | grep -q "fragment-fork --slug" &&
  echo "$HELP_OUT" | grep -q "fragment-merge --slug" &&
  echo "$HELP_OUT" | grep -q "Called by aidlc-bolt"; then
  ok "--help lists fragment-fork + fragment-merge with their orchestration context"
else
  not_ok "--help listing" "$HELP_OUT"
fi

# --- 13. unknown subcommand error ---------------------------------------

UNKNOWN_OUT="$(bun "$RUNTIME_TS" frabglo 2>&1)" || true
if echo "$UNKNOWN_OUT" | grep -q "Unknown subcommand: frabglo"; then
  ok "unknown subcommand falls through to error path"
else
  not_ok "unknown subcommand" "$UNKNOWN_OUT"
fi

# --- 14. --project-dir plumbing (B1 from MR 11 plan) --------------------

# Verify the spawnSibling-style invocation order works:
#   bun aidlc-runtime.ts --project-dir <pd> fragment-fork --slug <slug>
# (--project-dir BEFORE the subcommand, mirroring spawnSibling at
# aidlc-bolt.ts:79-103)
PROJ=$(make_project "auth" "$GRAPH")
RAW_OUT="$(bun "$RUNTIME_TS" --project-dir "$PROJ" fragment-fork --slug auth 2>&1)"
RAW_RC=$?
WT_FRAG=$(wt_fragment_path "$PROJ" "auth")
if [ "$RAW_RC" = "0" ] && [ -f "$WT_FRAG" ] &&
  echo "$RAW_OUT" | grep -q "\"status\":\"fragment-forked\""; then
  ok "--project-dir plumbing: pre-strip works in spawnSibling-style invocation order (B1)"
else
  not_ok "--project-dir plumbing (B1)" "rc=$RAW_RC out='$RAW_OUT'"
fi
