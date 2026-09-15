#!/usr/bin/env bash
# AIDLC v2 standalone evaluation suite — all three standard tasks:
#   1. greenfield (sci-calc API, graded vs the v2 golden + 88-case contract)
#   2. brownfield bugfix (httpbin /base64, 3 HTTP assertions)
#   3. brownfield feature (RealWorld follow/unfollow, project Hurl suite)
# then a combined report (graded + deterministic sections).
#
# Detached (survives SSH loss):
#   setsid nohup bash scripts/run_v2_suite.sh >/dev/null 2>&1 < /dev/null &
# Foreground:
#   bash scripts/run_v2_suite.sh
#
# Prereqs (see README):
#   * `claude` CLI + bun on PATH; Bedrock access (or Anthropic API) configured
#   * the v2 .claude dist path set in config/versions.yaml (claude_dist)
#   * docker + the sandbox image (docker/sandbox/build.sh) for contract scoring
#   * hurl >= 8.0 on PATH for the RealWorld feature oracle
#
# Env knobs:
#   RUNS=N               runs per task (default: versions.yaml, 5)
#   SKIP_GREENFIELD=1    brownfield-only
#   CAPTURE_TOKENS=1     use the external OTEL collector -> CloudWatch for cost
#                        capture instead of the built-in local OTLP receiver
#                        (tokens/cost are captured locally by default)
# Logs: runs/v2-suite.log. Markers: runs/V2_SUITE_DONE / _ABORTED.
set -u
export PATH="/usr/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
cd "$(dirname "$0")/.."   # evaluator root

mkdir -p runs
LOG=runs/v2-suite.log
exec >> "$LOG" 2>&1
# log() writes to STDERR so it never contaminates a run_batch() command
# substitution (which captures stdout to get the batch dir).
log() { echo "[v2-suite $(date -u +%FT%TZ)] $*" >&2; }

runs_flag=()
[ -n "${RUNS:-}" ] && runs_flag=(--runs "$RUNS")
otel_flag=()
[ "${CAPTURE_TOKENS:-0}" = "1" ] && otel_flag=(--capture-tokens-otel)

if ! command -v hurl >/dev/null 2>&1; then
  log "ABORT: hurl not on PATH — the feature task cannot be scored"
  touch runs/V2_SUITE_ABORTED
  exit 1
fi
log "hurl: $(hurl --version | head -1)"

run_batch() {  # <scenario-or-empty> <label>
  local scenario="$1" label="$2"
  local scen_flag=()
  [ -n "$scenario" ] && scen_flag=(--scenario "$scenario")
  log "launching $label batch ${scenario:+scenario=$scenario}"
  uv run python scripts/run_version_batch.py \
      "${scen_flag[@]}" "${runs_flag[@]}" "${otel_flag[@]}" \
      --versions v2 \
      --max-parallel 3 \
      --no-report >&2
  local bdir
  bdir=$(ls -td runs/*-version-batch | head -1)
  log "$label batch → $bdir"
  echo "$bdir"
}

log "v2 suite started"

GF="" ; BUG="" ; FEAT=""
if [ "${SKIP_GREENFIELD:-0}" != "1" ]; then
  GF=$(run_batch "" greenfield)
else
  log "SKIP_GREENFIELD=1 — greenfield batch skipped"
fi
BUG=$(run_batch  brownfield/httpbin   bugfix)
FEAT=$(run_batch brownfield/realworld feature)

report_args=()
[ -n "$GF" ]   && report_args+=(--greenfield "$GF")
[ -n "$BUG" ]  && report_args+=(--brownfield-bug "$BUG")
[ -n "$FEAT" ] && report_args+=(--brownfield-feature "$FEAT")
STAMP=$(date -u +%Y%m%d)
OUT="runs/V2-EVALUATION-${STAMP}.md"
log "generating combined report → $OUT (+ .html)"
uv run python scripts/run_combined_report.py "${report_args[@]}" \
    --out "$OUT" --also-html "runs/V2-EVALUATION-${STAMP}.html" \
    --generated "$(date -u +%FT%TZ)" || log "WARN: combined report failed"

touch runs/V2_SUITE_DONE
log "done — greenfield=$GF bug=$BUG feature=$FEAT report=$OUT"
