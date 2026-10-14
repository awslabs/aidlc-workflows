#!/usr/bin/env bash
# repro.sh — re-run the compiled-hook-dispatch investigation end to end.
# Run from the repository root:  bash evidence/devin-e2e-run/compiled-hook-dispatch-run/repro.sh [OUT]
# Writes all scratch state under OUT (default /tmp/aidlc-inv-repro), logs to $OUT/logs.
# Does not modify tracked files (dist/ and dist-release/ are gitignored build outputs).
set -euo pipefail

OUT=${1:-/tmp/aidlc-inv-repro}
REPO_ROOT=$(pwd)
if [ ! -f "$REPO_ROOT/scripts/package.ts" ] || [ ! -f "$REPO_ROOT/scripts/build-binaries.ts" ]; then
  echo "error: run this script from the repository root (scripts/package.ts not found)" >&2
  exit 1
fi
mkdir -p "$OUT/logs"
LOGS=$OUT/logs

PASS_COUNT=0
FAILURES=()
check() { # check <name> <"1"|"0">
  local name=$1 ok=$2
  if [ "$ok" = "1" ]; then PASS_COUNT=$((PASS_COUNT + 1)); else FAILURES+=("$name"); fi
}

ROWS=()
row() { ROWS+=("$1|$2|$3|$4"); }

echo "== step 0: package + build binaries (OUT=$OUT) =="
bun scripts/package.ts >"$LOGS/package.log" 2>&1
echo "package.ts exit: 0"
AIDLC_BUILD_OUT_DIR=$OUT/binaries bun scripts/build-binaries.ts >"$LOGS/build-binaries.log" 2>&1
echo "build-binaries.ts exit: 0"
BIN=$OUT/binaries/native/aidlc

# --- fixtures ---------------------------------------------------------------
mkfixture() { # mkfixture <dir> <source-tree>
  rm -rf "$1"
  mkdir -p "$1"
  cp -r "$REPO_ROOT/$2/." "$1/"
  git -C "$1" init -q
}
mkfixture "$OUT/p-a"  dist-release/devin
mkfixture "$OUT/p-b"  dist-release/devin
mkfixture "$OUT/p-d1" dist-release/devin
mkfixture "$OUT/s-c"  dist/devin
mkfixture "$OUT/s-d3" dist/devin

# --- helpers ----------------------------------------------------------------
RC=0
hh_dir() { echo "$1/aidlc/spaces/default/intents/.aidlc-engine/hooks-health"; }
marker() { echo "$1/.devin/.aidlc-session-start.local.json"; }

vs()      { echo "{\"hook_event_name\":\"PostCompaction\",\"cwd\":\"$1\",\"session_id\":\"inv-1\"}"; }
ss()      { echo "{\"hook_event_name\":\"SessionStart\",\"source\":\"startup\",\"cwd\":\"$1\",\"session_id\":\"inv-1\"}"; }
execok()  { echo "{\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$1\",\"session_id\":\"inv-1\",\"tool_name\":\"exec\",\"tool_input\":{\"command\":\"ls\"}}"; }
execbad() { echo "{\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$1\",\"session_id\":\"inv-1\",\"tool_name\":\"exec\",\"tool_input\":{\"command\":\"bun .devin/tools/aidlc-state.ts reject feasibility\"}}"; }
editp()   { echo "{\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$1\",\"session_id\":\"inv-1\",\"tool_name\":\"edit\",\"tool_input\":{\"file_path\":\"$1/README.md\",\"old_string\":\"a\",\"new_string\":\"b\"}}"; }
stopp()   { echo "{\"hook_event_name\":\"Stop\",\"cwd\":\"$1\",\"session_id\":\"inv-1\",\"stop_hook_active\":false}"; }

# run <name> <dir> <payload> <cmd...> — never fails; child exit code lands in RC
run() {
  local name=$1 dir=$2 payload=$3
  shift 3
  local rc=0
  printf '%s\n' "$payload" | (cd "$dir" && "$@") >"$LOGS/$name.out" 2>"$LOGS/$name.err" || rc=$?
  RC=$rc
}

contains() { grep -qF "$2" "$1"; }
isempty()  { [ ! -s "$1" ]; }
yesno()    { [ "$1" = "1" ] && echo 1 || echo 0; }

# === Case A — dispatcher grammar (p-a, VS payload) ===========================
echo "== case A =="
PA=$OUT/p-a

run a1 "$PA" "$(vs "$PA")" env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME \
  DEVIN_PROJECT_DIR="$PA" AIDLC_HARNESS_NAME=devin AIDLC_COMPILED_EXECUTABLE="$BIN" "$BIN" hook validate-state
a1_rc=$RC; a1_hb=no; [ -f "$(hh_dir "$PA")/validate-state.last" ] && a1_hb=yes
check "A1 exit==2" "$(yesno "$([ "$a1_rc" = "2" ] && echo 1 || echo 0)")"
check "A1 stderr 'unknown command'" "$(contains "$LOGS/a1.err" "unknown command 'hook'" && echo 1 || echo 0)"
rm -rf "$(hh_dir "$PA")"

run a2 "$PA" "$(vs "$PA")" env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME \
  DEVIN_PROJECT_DIR="$PA" AIDLC_HARNESS_NAME=devin AIDLC_COMPILED_EXECUTABLE="$BIN" "$BIN" engine hook validate-state
a2_rc=$RC; a2_hb=no; [ -f "$(hh_dir "$PA")/validate-state.last" ] && a2_hb=yes
check "A2 exit==0" "$(yesno "$([ "$a2_rc" = "0" ] && echo 1 || echo 0)")"
check "A2 heartbeat" "$(yesno "$([ "$a2_hb" = "yes" ] && echo 1 || echo 0)")"
rm -rf "$(hh_dir "$PA")"

run a3 "$PA" "$(vs "$PA")" env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME \
  DEVIN_PROJECT_DIR="$PA" AIDLC_HARNESS_NAME=copilot AIDLC_COMPILED_EXECUTABLE="$BIN" "$BIN" hook validate-state
a3_rc=$RC; a3_hb=no; [ -f "$(hh_dir "$PA")/validate-state.last" ] && a3_hb=yes
check "A3 exit==1 not-available" "$([ "$a3_rc" = "1" ] && contains "$LOGS/a3.err" "not available in this install" && echo 1 || echo 0)"
rm -rf "$(hh_dir "$PA")"

run a4 "$PA" "$(vs "$PA")" env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME \
  DEVIN_PROJECT_DIR="$PA" "$BIN" hook validate-state
a4_rc=$RC; a4_hb=no; [ -f "$(hh_dir "$PA")/validate-state.last" ] && a4_hb=yes
check "A4 exit==2" "$(yesno "$([ "$a4_rc" = "2" ] && echo 1 || echo 0)")"
check "A4 stderr 'unknown command'" "$(contains "$LOGS/a4.err" "unknown command 'hook'" && echo 1 || echo 0)"

row "A1 devin bare hook" "$a1_rc" "$a1_hb" "-"
row "A2 devin engine hook" "$a2_rc" "$a2_hb" "-"
row "A3 copilot bare hook" "$a3_rc" "$a3_hb" "-"
row "A4 no-env bare hook" "$a4_rc" "$a4_hb" "-"

# === Case B — fixed full chain (p-b) =========================================
echo "== case B =="
PB=$OUT/p-b
BENV=(env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME "DEVIN_PROJECT_DIR=$PB" "$BIN" engine adapter devin)

run b_vs   "$PB" "$(vs "$PB")"      "${BENV[@]}" validate-state;          b_vs_rc=$RC
run b_ss   "$PB" "$(ss "$PB")"      "${BENV[@]}" session-start;           b_ss_rc=$RC
run b_eok  "$PB" "$(execok "$PB")"  "${BENV[@]}" state-transition-guard;  b_eok_rc=$RC
run b_ebad "$PB" "$(execbad "$PB")" "${BENV[@]}" state-transition-guard;  b_ebad_rc=$RC
run b_pag  "$PB" "$(editp "$PB")"   "${BENV[@]}" plan-approval-guard;     b_pag_rc=$RC
run b_rf   "$PB" "$(editp "$PB")"   "${BENV[@]}" review-freeze;           b_rf_rc=$RC
run b_stop "$PB" "$(stopp "$PB")"   "${BENV[@]}" continue-workflow;       b_stop_rc=$RC

b_hb=no; [ -f "$(hh_dir "$PB")/validate-state.last" ] && [ -f "$(hh_dir "$PB")/continue-workflow.last" ] && b_hb=yes
b_mk=no; [ -f "$(marker "$PB")" ] && b_mk=yes
check "B exits (0 except EXEC_BAD=2)" \
  "$([ "$b_vs_rc" = 0 ] && [ "$b_ss_rc" = 0 ] && [ "$b_eok_rc" = 0 ] && [ "$b_pag_rc" = 0 ] && [ "$b_rf_rc" = 0 ] && [ "$b_stop_rc" = 0 ] && [ "$b_ebad_rc" = 2 ] && echo 1 || echo 0)"
check "B EXEC_BAD real guard msg" "$(contains "$LOGS/b_ebad.err" "Stage status cannot be changed" && echo 1 || echo 0)"
check "B heartbeats+marker" "$([ "$b_hb" = yes ] && [ "$b_mk" = yes ] && echo 1 || echo 0)"
row "B fixed chain (7 runs)" "${b_vs_rc}/${b_ss_rc}/${b_eok_rc}/${b_ebad_rc}/${b_pag_rc}/${b_rf_rc}/${b_stop_rc}" "$b_hb" "$b_mk"

# === Case C — old vs new adapter (s-c) =======================================
echo "== case C =="
SC=$OUT/s-c
cp "$SC/.devin/hooks/aidlc-devin-adapter.ts" "$SC/.devin/hooks/aidlc-devin-adapter-old.ts"
sed -i 's/\[executable, "engine", "hook", hook\]/[executable, "hook", hook]/g' "$SC/.devin/hooks/aidlc-devin-adapter-old.ts"
n_changed=$(diff "$SC/.devin/hooks/aidlc-devin-adapter.ts" "$SC/.devin/hooks/aidlc-devin-adapter-old.ts" | grep -c '^>' || true)
check "old-adapter diff == 2 lines" "$(yesno "$([ "$n_changed" = "2" ] && echo 1 || echo 0)")"

OENV=(env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME "DEVIN_PROJECT_DIR=$SC" \
      AIDLC_COMPILED_EXECUTABLE="$BIN" AIDLC_HARNESS_NAME=devin AIDLC_HARNESS_DIR=.devin \
      bun "$SC/.devin/hooks/aidlc-devin-adapter-old.ts")
NENV=(env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME "DEVIN_PROJECT_DIR=$SC" \
      AIDLC_COMPILED_EXECUTABLE="$BIN" AIDLC_HARNESS_NAME=devin AIDLC_HARNESS_DIR=.devin \
      bun "$SC/.devin/hooks/aidlc-devin-adapter.ts")

run c_old_vs   "$SC" "$(vs "$SC")"      "${OENV[@]}" validate-state;         co_vs_rc=$RC
run c_old_ss   "$SC" "$(ss "$SC")"      "${OENV[@]}" session-start;          co_ss_rc=$RC
run c_old_eok  "$SC" "$(execok "$SC")"  "${OENV[@]}" state-transition-guard; co_eok_rc=$RC
run c_old_ebad "$SC" "$(execbad "$SC")" "${OENV[@]}" state-transition-guard; co_ebad_rc=$RC
run c_old_pag  "$SC" "$(editp "$SC")"   "${OENV[@]}" plan-approval-guard;    co_pag_rc=$RC
run c_old_rf   "$SC" "$(editp "$SC")"   "${OENV[@]}" review-freeze;          co_rf_rc=$RC
run c_old_stop "$SC" "$(stopp "$SC")"   "${OENV[@]}" continue-workflow;      co_stop_rc=$RC

co_hb=no; [ -d "$(hh_dir "$SC")" ] && co_hb=yes
co_mk=no; [ -f "$(marker "$SC")" ] && co_mk=yes
check "C-old VS/SS silent 0" "$([ "$co_vs_rc" = 0 ] && [ "$co_ss_rc" = 0 ] && isempty "$LOGS/c_old_vs.err" && isempty "$LOGS/c_old_ss.err" && echo 1 || echo 0)"
check "C-old guards 2 + 'unknown command'" \
  "$([ "$co_eok_rc" = 2 ] && [ "$co_ebad_rc" = 2 ] && [ "$co_pag_rc" = 2 ] && [ "$co_rf_rc" = 2 ] \
     && contains "$LOGS/c_old_eok.err" "unknown command 'hook'" \
     && contains "$LOGS/c_old_ebad.err" "unknown command 'hook'" \
     && contains "$LOGS/c_old_pag.err" "unknown command 'hook'" \
     && contains "$LOGS/c_old_rf.err" "unknown command 'hook'" && echo 1 || echo 0)"
check "C-old STOP 2 silent" "$([ "$co_stop_rc" = 2 ] && isempty "$LOGS/c_old_stop.err" && echo 1 || echo 0)"
check "C-old no heartbeat/marker" "$([ "$co_hb" = no ] && [ "$co_mk" = no ] && echo 1 || echo 0)"
row "C-old adapter (7 runs)" "${co_vs_rc}/${co_ss_rc}/${co_eok_rc}/${co_ebad_rc}/${co_pag_rc}/${co_rf_rc}/${co_stop_rc}" "$co_hb" "$co_mk"

run c_new_vs   "$SC" "$(vs "$SC")"      "${NENV[@]}" validate-state;         cn_vs_rc=$RC
run c_new_ss   "$SC" "$(ss "$SC")"      "${NENV[@]}" session-start;          cn_ss_rc=$RC
run c_new_eok  "$SC" "$(execok "$SC")"  "${NENV[@]}" state-transition-guard; cn_eok_rc=$RC
run c_new_ebad "$SC" "$(execbad "$SC")" "${NENV[@]}" state-transition-guard; cn_ebad_rc=$RC
run c_new_pag  "$SC" "$(editp "$SC")"   "${NENV[@]}" plan-approval-guard;    cn_pag_rc=$RC
run c_new_rf   "$SC" "$(editp "$SC")"   "${NENV[@]}" review-freeze;          cn_rf_rc=$RC
run c_new_stop "$SC" "$(stopp "$SC")"   "${NENV[@]}" continue-workflow;      cn_stop_rc=$RC

cn_hb=no; [ -f "$(hh_dir "$SC")/validate-state.last" ] && [ -f "$(hh_dir "$SC")/continue-workflow.last" ] && cn_hb=yes
cn_mk=no; [ -f "$(marker "$SC")" ] && cn_mk=yes
check "C-new exits identical to B" \
  "$([ "$cn_vs_rc" = 0 ] && [ "$cn_ss_rc" = 0 ] && [ "$cn_eok_rc" = 0 ] && [ "$cn_pag_rc" = 0 ] && [ "$cn_rf_rc" = 0 ] && [ "$cn_stop_rc" = 0 ] && [ "$cn_ebad_rc" = 2 ] && echo 1 || echo 0)"
check "C-new EXEC_BAD real guard msg" "$(contains "$LOGS/c_new_ebad.err" "Stage status cannot be changed" && echo 1 || echo 0)"
check "C-new heartbeats+marker" "$([ "$cn_hb" = yes ] && [ "$cn_mk" = yes ] && echo 1 || echo 0)"
row "C-new adapter (7 runs)" "${cn_vs_rc}/${cn_ss_rc}/${cn_eok_rc}/${cn_ebad_rc}/${cn_pag_rc}/${cn_rf_rc}/${cn_stop_rc}" "$cn_hb" "$cn_mk"

# === Case D — doctor =========================================================
echo "== case D =="

doctor() { # doctor <name> <dir> — never fails; exit code lands in RC
  local rc=0
  (cd "$2" && env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME \
     DEVIN_PROJECT_DIR="$2" "$BIN" doctor --verbose --project-dir "$2") >"$LOGS/$1.txt" 2>&1 || rc=$?
  RC=$rc
}

doctor d1 "$OUT/p-d1"; d1_rc=$RC
row "D1 doctor fresh P" "$d1_rc" "-" "-"

doctor d2 "$PB"; d2_rc=$RC
row "D2 doctor after fixed chain" "$d2_rc" "-" "-"

# D3: fresh source tree; new adapter SS+VS, then old adapter SS/VS/EXEC_OK, then doctor
SD=$OUT/s-d3
cp "$SD/.devin/hooks/aidlc-devin-adapter.ts" "$SD/.devin/hooks/aidlc-devin-adapter-old.ts"
sed -i 's/\[executable, "engine", "hook", hook\]/[executable, "hook", hook]/g' "$SD/.devin/hooks/aidlc-devin-adapter-old.ts"
D3NENV=(env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME "DEVIN_PROJECT_DIR=$SD" \
        AIDLC_COMPILED_EXECUTABLE="$BIN" AIDLC_HARNESS_NAME=devin AIDLC_HARNESS_DIR=.devin \
        bun "$SD/.devin/hooks/aidlc-devin-adapter.ts")
D3OENV=(env -u CLAUDE_PROJECT_DIR -u AIDLC_PROJECT_DIR -u AIDLC_HARNESS_DIR -u AIDLC_HARNESS_NAME "DEVIN_PROJECT_DIR=$SD" \
        AIDLC_COMPILED_EXECUTABLE="$BIN" AIDLC_HARNESS_NAME=devin AIDLC_HARNESS_DIR=.devin \
        bun "$SD/.devin/hooks/aidlc-devin-adapter-old.ts")

run d3_new_ss  "$SD" "$(ss "$SD")"     "${D3NENV[@]}" session-start
run d3_new_vs  "$SD" "$(vs "$SD")"     "${D3NENV[@]}" validate-state
marker_before=$(cat "$(marker "$SD")" 2>/dev/null || echo "ABSENT")

run d3_old_ss  "$SD" "$(ss "$SD")"     "${D3OENV[@]}" session-start;       d3_old_ss_rc=$RC
run d3_old_vs  "$SD" "$(vs "$SD")"     "${D3OENV[@]}" validate-state
run d3_old_eok "$SD" "$(execok "$SD")" "${D3OENV[@]}" state-transition-guard; d3_old_eok_rc=$RC
marker_after=$(cat "$(marker "$SD")" 2>/dev/null || echo "ABSENT")

doctor d3 "$SD"; d3_rc=$RC
d3_evidence_ok=$(grep -c 'ok    Devin hook execution evidence' "$LOGS/d3.txt" || true)

check "D3 marker lastRun unchanged by old SS" \
  "$([ "$marker_before" != "ABSENT" ] && [ "$marker_before" = "$marker_after" ] && echo 1 || echo 0)"
check "D3 doctor evidence row ok" "$(yesno "$([ "$d3_evidence_ok" -ge 1 ] && echo 1 || echo 0)")"
row "D3 doctor stale marker" "$d3_rc" "-" "lastRun unchanged: $([ "$marker_before" = "$marker_after" ] && echo yes || echo no)"

# === report ==================================================================
echo
echo "== results table =="
printf '%-34s | %-16s | %-10s | %s\n' "case" "exit" "heartbeat" "marker"
printf -- '----------------------------------|------------------|------------|---------------------\n'
for r in "${ROWS[@]}"; do
  IFS='|' read -r c e h m <<<"$r"
  printf '%-34s | %-16s | %-10s | %s\n' "$c" "$e" "$h" "$m"
done
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
  echo "RESULT: PASS ($PASS_COUNT checks passed, 0 failed)"
else
  echo "RESULT: FAIL ($PASS_COUNT checks passed, ${#FAILURES[@]} failed)"
  printf '  failed: %s\n' "${FAILURES[@]}"
fi
