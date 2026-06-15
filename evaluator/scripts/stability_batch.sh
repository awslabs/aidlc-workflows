#!/usr/bin/env bash
# Stability batch runner for claude-code AIDLC evaluation.
#
# Runs 21 evaluations as 3 sequential waves of 7 concurrent runs each.
# Each run is fully isolated (PID-stamped run folder, per-run rules clone,
# per-workspace .claude/), so concurrency is safe. The only shared resource
# is Bedrock — we grep each session log for throttling so harness-induced
# correlated failures can be told apart from genuine AIDLC variance.
set -u

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.bun/bin:$PATH"

WAVES=${WAVES:-3}
PER_WAVE=${PER_WAVE:-7}
LOGDIR="/tmp/aidlc-stability-$(date -u +%Y%m%dT%H%M%S)"
mkdir -p "$LOGDIR"
echo "Batch runner: $WAVES waves x $PER_WAVE concurrent = $((WAVES*PER_WAVE)) runs"
echo "Per-run logs: $LOGDIR"

run_one() {
  local tag="$1"
  uv run python run.py cli --cli claude-code \
    --claude-scope mvp \
    --vision test_cases/sci-calc-v2/vision.md \
    --tech-env test_cases/sci-calc-v2/tech-env.md \
    --golden test_cases/sci-calc-v2/golden-aidlc-docs \
    --openapi test_cases/sci-calc-v2/openapi.yaml \
    --scorer-model global.anthropic.claude-opus-4-6-v1 \
    --region us-west-2 \
    > "$LOGDIR/$tag.log" 2>&1
  echo "  [$tag] finished (exit=$?)"
}

for w in $(seq 1 "$WAVES"); do
  echo ""
  echo "=== WAVE $w/$WAVES starting at $(date -u +%H:%M:%S) ==="
  for i in $(seq 1 "$PER_WAVE"); do
    run_one "w${w}-r${i}" &
  done
  wait
  echo "=== WAVE $w/$WAVES complete at $(date -u +%H:%M:%S) ==="
done

echo ""
echo "=== throttle / Bedrock error scan ==="
grep -rilE "throttl|ThrottlingException|TooManyRequests|429|ServiceUnavailable|internalServerException" "$LOGDIR" \
  | sed "s#$LOGDIR/##" || echo "  none detected"

echo ""
echo "=== ALL WAVES DONE — log dir: $LOGDIR ==="
echo "$LOGDIR" > /tmp/aidlc-stability-last-logdir.txt
