#!/usr/bin/env bash
# AIDLC distribution probe — shared by the Claude and Codex plugin probes.
# Answers Gap 1: can a plugin SessionStart hook (a) fire unattended,
# (b) write the PROJECT tree, (c) write its own PLUGIN DATA dir, and
# (d) reach its own PLUGIN ROOT to compose from. Plus a bun-reachability check.
#
# Throwaway. Writes a timestamped log to the project tree, plugin data, and /tmp
# so you can confirm afterward regardless of which writes the host allows.
set -u

# --- resolve host-provided env (Claude uses CLAUDE_*, Codex uses PLUGIN_* + aliases)
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-${PLUGIN_DATA:-}}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"   # Codex may not set a project-dir var; PWD is the fallback
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo NO_DATE)"

line() { printf '%s\n' "$*"; }
report=""
add() { report="${report}$1"$'\n'; line "$1"; }

add "==== AIDLC dist-probe @ ${STAMP} ===="
add "host env seen:"
add "  CLAUDE_PLUGIN_ROOT = ${CLAUDE_PLUGIN_ROOT:-<unset>}"
add "  CLAUDE_PLUGIN_DATA = ${CLAUDE_PLUGIN_DATA:-<unset>}"
add "  CLAUDE_PROJECT_DIR = ${CLAUDE_PROJECT_DIR:-<unset>}"
add "  PLUGIN_ROOT        = ${PLUGIN_ROOT:-<unset>}"
add "  PLUGIN_DATA        = ${PLUGIN_DATA:-<unset>}"
add "  PWD                = ${PWD}"

# --- (b) WRITE PROJECT TREE -------------------------------------------------
proj_ok="FAIL"
if mkdir -p "${PROJECT_DIR}/.aidlc-probe" 2>/dev/null \
   && printf 'project-write ok @ %s\n' "$STAMP" > "${PROJECT_DIR}/.aidlc-probe/sentinel.txt" 2>/dev/null; then
  proj_ok="OK -> ${PROJECT_DIR}/.aidlc-probe/sentinel.txt"
fi
add "(b) PROJECT-TREE write: ${proj_ok}"

# --- (c) WRITE PLUGIN DATA --------------------------------------------------
data_ok="FAIL (no PLUGIN_DATA var)"
if [ -n "${PLUGIN_DATA}" ]; then
  if mkdir -p "${PLUGIN_DATA}" 2>/dev/null \
     && printf 'plugin-data-write ok @ %s\n' "$STAMP" > "${PLUGIN_DATA}/probe-data.txt" 2>/dev/null; then
    data_ok="OK -> ${PLUGIN_DATA}/probe-data.txt"
  else
    data_ok="FAIL (var set, write denied)"
  fi
fi
add "(c) PLUGIN-DATA write: ${data_ok}"

# --- (d) READ PLUGIN ROOT (can we reach bundled files to compose from?) -----
root_ok="FAIL (no PLUGIN_ROOT var)"
if [ -n "${PLUGIN_ROOT}" ]; then
  if [ -r "${PLUGIN_ROOT}/.aidlc-bundle/bundle.json" ] || [ -d "${PLUGIN_ROOT}" ]; then
    root_ok="OK -> ${PLUGIN_ROOT} ($(ls -1 "${PLUGIN_ROOT}" 2>/dev/null | tr '\n' ' '))"
  else
    root_ok="FAIL (var set, unreadable)"
  fi
fi
add "(d) PLUGIN-ROOT read:  ${root_ok}"

# --- (stretch) is the AIDLC toolchain reachable from the hook context? ------
# Hooks often run with a minimal PATH that misses ~/.bun/bin (the default bun
# install dir). Check PATH first, then the standard home-relative location.
# This is the real Gap-1 stretch question: AIDLC's composer runs on bun, so the
# hook must be able to FIND it — note whether it needed the fallback path.
bun_ok="FAIL (bun not found on PATH or in ~/.bun/bin)"
BUN_FALLBACK="${HOME}/.bun/bin/bun"
if command -v bun >/dev/null 2>&1; then
  bun_ok="OK (on PATH) -> $(command -v bun) ($(bun --version 2>/dev/null))"
elif [ -x "$BUN_FALLBACK" ]; then
  bun_ok="OK (NOT on PATH; found at fallback) -> ${BUN_FALLBACK} ($("$BUN_FALLBACK" --version 2>/dev/null)) — a real hook must invoke bun by absolute path or fix PATH"
fi
add "(stretch) bun reachable: ${bun_ok}"
node_ok="n/a"
command -v node >/dev/null 2>&1 && node_ok="OK -> $(command -v node)"
add "(stretch) node reachable: ${node_ok}"

add "==== verdict: PROJECT=${proj_ok%% *} DATA=${data_ok%% *} ROOT=${root_ok%% *} BUN=${bun_ok%% *} ===="

# --- persist the report everywhere we can, so you can read it after the session
printf '%s' "$report" > "/tmp/aidlc-dist-probe.log" 2>/dev/null || true
[ "$proj_ok" != "FAIL" ] && printf '%s' "$report" > "${PROJECT_DIR}/.aidlc-probe/report.log" 2>/dev/null || true
[ -n "${PLUGIN_DATA}" ] && printf '%s' "$report" > "${PLUGIN_DATA}/report.log" 2>/dev/null || true

# Always exit 0 — a probe must never block the session it's measuring.
exit 0
