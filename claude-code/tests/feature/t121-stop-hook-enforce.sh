#!/bin/bash
# t121: Behavioural contract for the Stop hook `aidlc-stop.ts` — the
# framework's FIRST flow-altering hook. It enforces the interactive
# forwarding loop: on turn-end it runs the engine (`aidlc-orchestrate
# next`) and, if a directive is still pending, BLOCKS the stop and
# injects the next move back via `reason`; if the engine says `done`
# it ALLOWS the stop. Recursion is bounded so a stuck loop can never
# trap the session. (13 assertions.)
#
# Surface tested:
#   (a) Pending directive (run-stage) → stdout carries
#       {"decision":"block","reason":...} and the reason names the
#       pending work (the directive kind + the forwarding-loop steps).
#   (b) `done` directive → hook emits nothing and exits 0 (the
#       precedent non-blocking pattern); NO block.
#   (c) RECURSION GUARD (asserted hardest): with the no-progress
#       counter driven/seeded to the block-cap ceiling AND
#       stop_hook_active:true, the hook RELEASES the stop (no infinite
#       block). Also: progress (a stage pivot) RESETS the streak so a
#       healthy loop is never throttled.
#   (d) No-op outside AIDLC: no aidlc-state.md → exit 0, no block (a
#       non-AIDLC session is never trapped).
#   Plus: garbage stdin never crashes and never traps (fails open).
#
# Strategy mirrors t95: run the REAL hook from the framework tree, with
# CLAUDE_PROJECT_DIR pointed at a self-contained temp project carrying a
# MOCK `aidlc-orchestrate.ts` engine that emits a directive of the kind
# named by MOCK_KIND. This isolates the hook's block/done/guard logic
# from engine correctness (the engine has its own corpus in t114/t118).
#
# The human-stop carve-out (Esc) needs no test: SPIKE 1 confirmed Stop
# hooks do not fire on user interrupt, so an Esc can never be trapped.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_HOOKS="$REPO_ROOT/dist/claude/.claude/hooks"
HOOK_TS="$SRC_HOOKS/aidlc-stop.ts"

if [ ! -f "$HOOK_TS" ]; then
  echo "Bail out! aidlc-stop.ts not found at $HOOK_TS"
  exit 1
fi

plan 13

# --- Helpers --------------------------------------------------------------

# A self-contained project with a MOCK engine. The mock emits a directive
# whose `kind` is taken from MOCK_KIND (default run-stage); `done` carries
# the terminal shape. The hook spawns this mock via
# join(projectDir, ".claude/tools/aidlc-orchestrate.ts").
make_project() {
  local proj
  proj=$(mktemp -d -t aidlc-t121-XXXXXX)
  mkdir -p "$proj/.claude/tools" "$proj/aidlc-docs"
  cat >"$proj/.claude/tools/aidlc-orchestrate.ts" <<'EOF'
// t121 mock engine: emit one directive of kind=$MOCK_KIND.
const kind = process.env.MOCK_KIND ?? "run-stage";
if (kind === "done") {
  console.log(JSON.stringify({ kind: "done", reason: "Workflow complete." }));
} else if (kind === "__nonzero__") {
  // Simulate an engine that fails to answer (non-zero exit, no directive).
  process.stderr.write("mock engine failure\n");
  process.exit(1);
} else {
  console.log(JSON.stringify({ kind, stage: "requirements-analysis" }));
}
process.exit(0);
EOF
  echo "$proj"
}

# Seed an active workflow (mid-stage) so the hook reaches the engine call.
seed_active() {
  local proj="$1"
  local slug="${2:-requirements-analysis}"
  cat >"$proj/aidlc-docs/aidlc-state.md" <<EOF
- **Workflow**: feature
- **Scope**: feature
- **Current Stage**: $slug
EOF
  echo "audit row 1" >"$proj/aidlc-docs/audit.md"
}

# Run the hook. Args: proj, stdin-payload, mock-kind, [cap], [extra-env...]
# Captures stdout; returns the hook's exit code in RC (global).
run_hook() {
  local proj="$1" payload="$2" kind="${3:-run-stage}" cap="${4:-}"
  RC=0
  OUT=$(printf '%s' "$payload" |
    CLAUDE_PROJECT_DIR="$proj" \
      MOCK_KIND="$kind" \
      CLAUDE_CODE_STOP_HOOK_BLOCK_CAP="$cap" \
      timeout 20 bun "$HOOK_TS" 2>/dev/null) || RC=$?
  return 0
}

GUARD_FILE_REL="aidlc-docs/.aidlc-stop-hook/block-count.json"

# Compute the hook's progress signature for a project (Current Stage +
# audit line-count), so a test can seed the counter at the matching key.
progress_sig() {
  local proj="$1"
  bun -e '
    const fs = require("fs");
    const proj = process.argv[1];
    const s = fs.readFileSync(proj + "/aidlc-docs/aidlc-state.md", "utf-8");
    const m = s.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
    const stage = (m && m[1] ? m[1] : "").trim();
    let al = 0;
    try { al = fs.readFileSync(proj + "/aidlc-docs/audit.md", "utf-8").split("\n").length; } catch {}
    console.log(stage + "::" + al);
  ' "$proj"
}

# Read the persisted no-progress counter (or "MISSING").
guard_count() {
  local proj="$1"
  bun -e '
    const fs = require("fs");
    try { console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf-8")).count); }
    catch { console.log("MISSING"); }
  ' "$proj/$GUARD_FILE_REL"
}

# =========================================================================
# (a) Pending directive → BLOCK + re-fed via reason
# =========================================================================
PROJ=$(make_project)
seed_active "$PROJ" "requirements-analysis"
run_hook "$PROJ" '{"stop_hook_active":false}' "run-stage"
assert_eq "$RC" "0" "(a) hook exits 0 on a pending directive (block is via stdout, not exit code)"
if echo "$OUT" | grep -q '"decision":"block"'; then
  ok "(a) pending run-stage directive → stdout carries {\"decision\":\"block\"}"
else
  not_ok "(a) pending directive → decision:block" "stdout=$OUT"
fi
# The reason is an on-task continuation that names the pending work + the loop.
if echo "$OUT" | grep -q '"reason"' && echo "$OUT" | grep -q 'pending step' && echo "$OUT" | grep -q 'run-stage'; then
  ok "(a) reason names the pending work (a run-stage directive) as on-task continuation"
else
  not_ok "(a) reason names pending work" "stdout=$OUT"
fi
# Security property: the reason re-feeds the loop, it is NOT an override-shaped
# instruction (no 'ignore'/'override'/'disregard' style verbs).
if echo "$OUT" | grep -q 'aidlc-orchestrate' && ! echo "$OUT" | grep -qiE 'ignore|override|disregard|bypass'; then
  ok "(a) reason is a sanctioned continuation (re-feeds the loop; no override-shaped verbs)"
else
  not_ok "(a) reason is a sanctioned continuation" "stdout=$OUT"
fi
rm -rf "$PROJ"

# =========================================================================
# (b) `done` directive → stop ALLOWED (no block, exit 0)
# =========================================================================
PROJ=$(make_project)
seed_active "$PROJ" "requirements-analysis"
run_hook "$PROJ" '{"stop_hook_active":false}' "done"
assert_eq "$RC" "0" "(b) done directive → hook exits 0"
if [ -z "$OUT" ]; then
  ok "(b) done directive → hook emits nothing (stop allowed, no block)"
else
  not_ok "(b) done directive → empty stdout" "stdout=$OUT"
fi
rm -rf "$PROJ"

# =========================================================================
# (c) RECURSION GUARD — asserted hardest. The session must ALWAYS release.
# =========================================================================
# (c1) Seed the no-progress counter directly AT the default ceiling (8) with a
# matching signature, then invoke with stop_hook_active:true. The hook MUST
# release (allow the stop), never block — a stuck loop can never trap a turn.
PROJ=$(make_project)
seed_active "$PROJ" "requirements-analysis"
mkdir -p "$PROJ/aidlc-docs/.aidlc-stop-hook"
SIG=$(progress_sig "$PROJ")
printf '{"signature":"%s","count":8}' "$SIG" >"$PROJ/$GUARD_FILE_REL"
run_hook "$PROJ" '{"stop_hook_active":true}' "run-stage"   # default cap 8
assert_eq "$RC" "0" "(c1) recursion guard at ceiling → hook exits 0"
if [ -z "$OUT" ]; then
  ok "(c1) counter at default cap (8) + stop_hook_active:true → RELEASES (no block) — session NOT trapped"
else
  not_ok "(c1) recursion guard releases at ceiling" "stdout=$OUT (hook BLOCKED — session trapped!)"
fi

# (c2) Drive consecutive no-progress blocks to a low ceiling and prove the hook
# flips from BLOCK to ALLOW exactly at the cap, and STAYS released after.
rm -f "$PROJ/$GUARD_FILE_REL"
# cap=3, stop_hook_active false so the streak is driven purely by the unchanged
# signature (no report ran between invocations).
run_hook "$PROJ" '{"stop_hook_active":false}' "run-stage" "3"; B1="$OUT"
run_hook "$PROJ" '{"stop_hook_active":false}' "run-stage" "3"; B2="$OUT"
run_hook "$PROJ" '{"stop_hook_active":false}' "run-stage" "3"; B3="$OUT"
run_hook "$PROJ" '{"stop_hook_active":false}' "run-stage" "3"; B4="$OUT"
if echo "$B1" | grep -q block && echo "$B2" | grep -q block && [ -z "$B3" ] && [ -z "$B4" ]; then
  ok "(c2) no-progress streak (cap 3): block,block,RELEASE,RELEASE — flips at the cap and stays released"
else
  not_ok "(c2) no-progress streak flips at cap and stays released" "b1=$B1 b2=$B2 b3=$B3 b4=$B4"
fi
rm -rf "$PROJ"

# (c3) PROGRESS resets the streak — a healthy loop is never throttled even when
# stop_hook_active stays true. Block twice at stage-a (no progress), then pivot
# the stage + grow the audit (a report's effect): the counter resets to 1.
PROJ=$(make_project)
seed_active "$PROJ" "stage-a"
run_hook "$PROJ" '{"stop_hook_active":true}' "run-stage" "8"
run_hook "$PROJ" '{"stop_hook_active":true}' "run-stage" "8"
COUNT_BEFORE=$(guard_count "$PROJ")
# Simulate a report landing: Current Stage pivots, audit.md grows.
cat >"$PROJ/aidlc-docs/aidlc-state.md" <<EOF
- **Workflow**: feature
- **Scope**: feature
- **Current Stage**: stage-b
EOF
printf 'audit row 1\naudit row 2\n' >"$PROJ/aidlc-docs/audit.md"
run_hook "$PROJ" '{"stop_hook_active":true}' "run-stage" "8"
COUNT_AFTER=$(guard_count "$PROJ")
if [ "$COUNT_AFTER" = "1" ] && [ "$COUNT_BEFORE" != "1" ]; then
  ok "(c3) progress (stage pivot) RESETS the no-progress streak to 1 (${COUNT_BEFORE} -> ${COUNT_AFTER}) — healthy loop never throttled"
else
  not_ok "(c3) progress resets the streak" "count_before=$COUNT_BEFORE count_after=$COUNT_AFTER (expected !=1 then 1)"
fi
rm -rf "$PROJ"

# =========================================================================
# (d) No-op outside AIDLC — no state file → exit 0, no block
# =========================================================================
PROJ=$(make_project)   # NO seed_active → no aidlc-state.md
run_hook "$PROJ" '{"stop_hook_active":false}' "run-stage"
assert_eq "$RC" "0" "(d) no aidlc-state.md → hook exits 0"
if [ -z "$OUT" ]; then
  ok "(d) no active workflow → hook emits nothing (non-AIDLC session is never blocked)"
else
  not_ok "(d) no-op outside AIDLC" "stdout=$OUT"
fi
rm -rf "$PROJ"

# =========================================================================
# Robustness — garbage stdin must never crash and never trap (fails open).
# Empty stdin, malformed JSON, and an engine that fails to answer all ALLOW.
# =========================================================================
PROJ=$(make_project)
seed_active "$PROJ" "requirements-analysis"
ROBUST_OK=1
# malformed JSON with a done engine → allow (no crash)
run_hook "$PROJ" 'this is not json' "done";        [ "$RC" = "0" ] && [ -z "$OUT" ] || ROBUST_OK=0
# truncated JSON with a done engine → allow
run_hook "$PROJ" '{"stop_hook_active":' "done";     [ "$RC" = "0" ] && [ -z "$OUT" ] || ROBUST_OK=0
# engine returns non-zero / no directive → fail open (allow), even mid-stage
run_hook "$PROJ" '{"stop_hook_active":false}' "__nonzero__"; [ "$RC" = "0" ] && [ -z "$OUT" ] || ROBUST_OK=0
if [ "$ROBUST_OK" = "1" ]; then
  ok "garbage stdin + unparseable engine output fail OPEN (exit 0, no block) — never crash, never trap"
else
  not_ok "garbage stdin / engine failure fail open" "last RC=$RC OUT=$OUT"
fi
rm -rf "$PROJ"

finish
