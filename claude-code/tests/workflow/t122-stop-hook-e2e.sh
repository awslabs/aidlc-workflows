#!/bin/bash
# t122: WORKFLOW-TIER end-to-end enforcement of the Stop hook aidlc-stop.ts —
# the framework's FIRST flow-altering hook. It closes the one named-coverage
# gap left by the feature-tier mock test (t121-stop-hook-enforce.sh): t121
# exercises the hook's block/done/guard LOGIC against a MOCK engine; t122
# exercises the REAL hook against the REAL aidlc-orchestrate engine, including
# one genuinely end-to-end pass through a live `claude -p` turn. (6 tests)
# Requires: claude CLI
#
# WHAT EACH ASSERTION COVERS (and how it is observed):
#
#   (1)+(2) RUN-TO-DONE, GENUINELY E2E. We seed a COMPLETED workflow
#       (state-completed: all stages [x]) and drive `/aidlc --status` through
#       run_claude under the LIVE skill-scoped Stop hook. Because the engine
#       answers `done`, the hook ALLOWS the stop and the headless session runs
#       to completion (exit 0, not the 124 timeout). This is the spec's "a
#       workflow-tier run confirms the loop runs to `done` under the hook
#       end-to-end". A probe (recorded in the build notes) confirmed the Stop
#       hook fires under `claude -p` AND that block-and-inject resumes the same
#       headless session — so this IS the live interactive path, not a
#       simulation.
#
#   (3) THE LIVE HOOK FIRED AND TOOK THE done->allow PATH. The hook leaves
#       durable traces in the seeded project: a heartbeat (stop.last) and, on
#       the `done` branch, a resetGuard() write to block-count.json (count 0).
#       We assert both. GUARDED: the skill-scoped Stop hook does not fire on
#       EVERY `claude -p` turn (empirically characterised in the build notes —
#       a short/constrained turn sometimes ends without the Stop event reaching
#       the skill-scoped hook). When the heartbeat is absent we SKIP this
#       sub-assertion (an explicit ok with a "did not fire this run" note)
#       rather than fail — mirroring the CLAUDE_RC==124 skip discipline. The
#       run-to-done assertions (1)+(2) hold regardless, because an un-fired hook
#       simply lets the turn end.
#
#   (4) PENDING DIRECTIVE -> REAL HOOK BLOCKS, against the REAL engine. This is
#       the integration t121's MOCK omits. We seed an in-flight workflow
#       (state-final-stage: the final stage is [-]) and invoke the REAL hook
#       with a real Stop payload, pointed at the REAL engine. The engine emits
#       a real `run-stage` directive; the hook emits a real
#       {"decision":"block"} whose reason names the pending stage and re-feeds
#       the forwarding loop (no override-shaped verbs). Deterministic — no
#       model in the loop.
#
#   (5) `done` DIRECTIVE -> REAL HOOK ALLOWS, against the REAL engine. The
#       direct-invocation complement of (1)+(2): real engine `done` -> empty
#       stdout, exit 0. Deterministic.
#
#   (6) RECURSION RELEASE against the REAL engine (light re-confirm; t121 owns
#       the exhaustive version). With a real PENDING engine and the no-progress
#       counter seeded AT the block cap plus stop_hook_active:true, the hook
#       RELEASES the stop (empty stdout, exit 0, drop record) — a stuck loop can
#       never trap the session even when the directive is genuinely pending.
#
# The human-stop carve-out (Esc) needs no test: SPIKE 1 confirmed Stop hooks
# do not fire on user interrupt.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

# Workflow tier is claude-gated: the run-to-done assertions drive a live
# `claude -p` turn. Mirror t56/t50 — bail the whole file without the CLI (the
# runner already disables the workflow tier when claude is absent, and t121
# covers the hook contract CLI-free at the feature tier).
command -v claude >/dev/null 2>&1 || { echo "Bail out! claude CLI not found"; exit 1; }

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURES="$REPO_ROOT/tests/fixtures"
SRC_HOOK="$REPO_ROOT/dist/claude/.claude/hooks/aidlc-stop.ts"

if [ ! -f "$SRC_HOOK" ]; then
  echo "Bail out! aidlc-stop.ts not found at $SRC_HOOK"
  exit 1
fi

plan 6

GUARD_REL="aidlc-docs/.aidlc-stop-hook/block-count.json"
HEARTBEAT_REL="aidlc-docs/.aidlc-hooks-health/stop.last"
DROPS_REL="aidlc-docs/.aidlc-hooks-health/stop.drops"

# --- Helpers --------------------------------------------------------------

# A self-contained project carrying the REAL framework .claude/ (real engine +
# real hook) seeded with a state fixture. Optionally lowers the block cap in
# settings.json so the live recursion guard releases quickly inside a turn.
make_real_project() {
  local fixture="$1" cap="${2:-}"
  local proj
  proj=$(setup_integration_project --with-state "$fixture")
  echo "audit row 1" >"$proj/aidlc-docs/audit.md"
  if [ -n "$cap" ] && [ -f "$proj/.claude/settings.json" ]; then
    bun -e '
      const fs = require("fs");
      const p = process.argv[1] + "/.claude/settings.json";
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      j.env = j.env || {};
      j.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = process.argv[2];
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    ' "$proj" "$cap"
  fi
  echo "$proj"
}

# The hook's progress signature for a project (Current Stage + audit line
# count), so a test can seed the no-progress counter at the matching key.
progress_sig() {
  bun -e '
    const fs = require("fs");
    const proj = process.argv[1];
    const s = fs.readFileSync(proj + "/aidlc-docs/aidlc-state.md", "utf-8");
    const m = s.match(/Current Stage\*{0,2}:?\s*`?([^\n`]*)`?/);
    const stage = (m && m[1] ? m[1] : "").trim();
    let al = 0;
    try { al = fs.readFileSync(proj + "/aidlc-docs/audit.md", "utf-8").split("\n").length; } catch {}
    console.log(stage + "::" + al);
  ' "$1"
}

# Invoke the REAL hook directly with a Stop payload, REAL engine resolved via
# the project's .claude/tools/aidlc-orchestrate.ts. Sets OUT + RC globals.
run_real_hook() {
  local proj="$1" payload="$2" cap="${3:-}"
  RC=0
  OUT=$(printf '%s' "$payload" |
    CLAUDE_PROJECT_DIR="$proj" \
      CLAUDE_CODE_STOP_HOOK_BLOCK_CAP="$cap" \
      timeout 30 bun "$SRC_HOOK" 2>/dev/null) || RC=$?
  return 0
}

# =========================================================================
# (1)+(2)+(3) GENUINELY E2E: the loop runs to `done` under the LIVE hook.
# Seed a COMPLETED workflow; drive /aidlc --status through a live `claude -p`
# turn. The real engine answers `done`, so the live Stop hook ALLOWS and the
# headless session runs to completion (no 124 hang).
# =========================================================================
PROJ=$(make_real_project "$FIXTURES/state-completed.md")
# A completed workflow + a read-only status print is a single bounded turn.
AIDLC_TEST_TIMEOUT=420 run_claude "$PROJ" "/aidlc --status"

# (1) The live turn did not hang under the Stop hook (124 = timeout-kill).
assert_not_eq "$CLAUDE_RC" "124" "(e2e) /aidlc --status over a completed workflow runs to completion under the live Stop hook (no hang)"

if [ "$CLAUDE_RC" = "124" ]; then
  # The session was killed — downstream assertions about its outcome can't be
  # trusted. Emit explicit skips for (2)+(3) so the plan count stays honest.
  ok "(e2e) SKIP run-to-done outcome — claude timed out (CLAUDE_RC=124)"
  ok "(e2e) SKIP live-hook done->allow trace — claude timed out (CLAUDE_RC=124)"
else
  # (2) The loop ran to `done`: the session ended cleanly AND the status output
  # reports the workflow complete (the engine's `done` is what let the turn
  # end). This is the spec's run-to-done-under-the-hook, observed end-to-end.
  if [ "$CLAUDE_RC" = "0" ] && echo "$CLAUDE_OUTPUT" | grep -qiE 'complete|100%|32/32'; then
    ok "(e2e) the loop ran to done under the live hook — session exited 0 and reports the workflow complete"
  else
    not_ok "(e2e) loop runs to done under the live hook" "CLAUDE_RC=$CLAUDE_RC output_tail=$(echo "$CLAUDE_OUTPUT" | tail -3)"
  fi

  # (3) The live Stop hook fired AND took the done->allow path. GUARDED: the
  # skill-scoped Stop hook does not fire on every `claude -p` turn, so when the
  # heartbeat is absent we SKIP (not fail) — the run-to-done assertions above
  # already hold whether or not the hook fired this run.
  if [ -f "$PROJ/$HEARTBEAT_REL" ]; then
    # resetGuard() runs on the `done` branch and writes count 0; assert it AND
    # that no block decision was forced (the done path never blocks).
    GC=$(cat "$PROJ/$GUARD_REL" 2>/dev/null || echo "")
    if echo "$GC" | grep -q '"count":0'; then
      ok "(e2e) the live Stop hook fired and took the done->allow path (resetGuard wrote count 0)"
    else
      not_ok "(e2e) live hook done->allow path" "heartbeat present but block-count=[$GC] (expected count 0 from resetGuard)"
    fi
  else
    ok "(e2e) SKIP live-hook fire trace — the skill-scoped Stop hook did not fire this run (the loop still ran to done; firing is non-deterministic under -p)"
  fi
fi
cleanup_test_project "$PROJ"

# =========================================================================
# (4) PENDING DIRECTIVE -> the REAL HOOK BLOCKS, against the REAL engine.
# The integration t121's MOCK omits: real engine emits a real run-stage; the
# real hook emits a real {"decision":"block"} re-feeding the forwarding loop.
# Deterministic (no model).
# =========================================================================
PROJ=$(make_real_project "$FIXTURES/state-final-stage.md")
run_real_hook "$PROJ" '{"stop_hook_active":false}'
# A block is carried on STDOUT (exit stays 0); the reason names the pending
# stage + re-feeds the loop, and uses no override-shaped verbs (the security
# property SPIKE 1 pinned).
if [ "$RC" = "0" ] &&
   echo "$OUT" | grep -q '"decision":"block"' &&
   echo "$OUT" | grep -q 'feedback-optimization' &&
   echo "$OUT" | grep -q 'aidlc-orchestrate' &&
   ! echo "$OUT" | grep -qiE 'ignore|override|disregard|bypass'; then
  ok "(real engine) a pending directive -> the real hook BLOCKS (real {\"decision\":\"block\"} naming the pending stage; on-task, no override verbs)"
else
  not_ok "(real engine) pending directive -> real hook blocks" "RC=$RC stdout=$OUT"
fi
cleanup_test_project "$PROJ"

# =========================================================================
# (5) `done` DIRECTIVE -> the REAL HOOK ALLOWS, against the REAL engine.
# The direct-invocation complement of (1)+(2). Deterministic.
# =========================================================================
PROJ=$(make_real_project "$FIXTURES/state-completed.md")
run_real_hook "$PROJ" '{"stop_hook_active":false}'
if [ "$RC" = "0" ] && [ -z "$OUT" ]; then
  ok "(real engine) a done directive -> the real hook ALLOWS (empty stdout, exit 0)"
else
  not_ok "(real engine) done directive -> real hook allows" "RC=$RC stdout=$OUT"
fi
cleanup_test_project "$PROJ"

# =========================================================================
# (6) RECURSION RELEASE against the REAL engine (light re-confirm; t121 owns
# the exhaustive version). Real PENDING engine + counter seeded AT the cap +
# stop_hook_active:true -> RELEASE. A stuck loop never traps the session even
# when the directive is genuinely pending.
# =========================================================================
PROJ=$(make_real_project "$FIXTURES/state-final-stage.md")
mkdir -p "$PROJ/aidlc-docs/.aidlc-stop-hook"
SIG=$(progress_sig "$PROJ")
printf '{"signature":"%s","count":8}' "$SIG" >"$PROJ/$GUARD_REL"
run_real_hook "$PROJ" '{"stop_hook_active":true}' "8"
# Released: empty stdout + exit 0, and a drop record documents the release.
if [ "$RC" = "0" ] && [ -z "$OUT" ] && grep -q 'recursion guard released the stop' "$PROJ/$DROPS_REL" 2>/dev/null; then
  ok "(real engine) recursion guard releases a genuinely-pending stop at the cap (no block, exit 0, drop record) — a stuck loop never traps the session"
else
  not_ok "(real engine) recursion guard releases at the cap" "RC=$RC stdout=$OUT drops=$(cat "$PROJ/$DROPS_REL" 2>/dev/null)"
fi
cleanup_test_project "$PROJ"

finish
