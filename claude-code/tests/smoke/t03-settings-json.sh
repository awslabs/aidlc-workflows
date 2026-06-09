#!/bin/bash
# t03: settings.json schema validation
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

SETTINGS="$(cd "$SCRIPT_DIR/../../dist/claude/.claude" && pwd)/settings.json"

plan 16

# Valid JSON
if jq empty "$SETTINGS" 2>/dev/null; then
  ok "settings.json is valid JSON"
else
  not_ok "settings.json is valid JSON" "jq parse failed"
fi

# permissions.allow contains all 8 tools
for tool in Read Edit Write Bash Glob Grep Task WebSearch; do
  FOUND=$(jq -r ".permissions.allow[]" "$SETTINGS" 2>/dev/null | grep -c "^${tool}$" || true)
  if [ "$FOUND" -ge 1 ]; then
    ok "permissions.allow contains $tool"
  else
    not_ok "permissions.allow contains $tool" "tool not found in allow list"
  fi
done

# statusLine references aidlc-statusline.ts
SL_CMD=$(jq -r '.statusLine.command // empty' "$SETTINGS" 2>/dev/null)
if echo "$SL_CMD" | grep -q "aidlc-statusline.ts"; then
  ok "statusLine.command references aidlc-statusline.ts"
else
  not_ok "statusLine.command references aidlc-statusline.ts" "got: $SL_CMD"
fi

# Orchestrator model is pinned to opus[1m]
MODEL=$(jq -r '.model // empty' "$SETTINGS" 2>/dev/null)
if [ "$MODEL" = "opus[1m]" ]; then
  ok "model is opus[1m]"
else
  not_ok "model is opus[1m]" "got: $MODEL"
fi

# Bedrock is enabled
USE_BEDROCK=$(jq -r '.env.CLAUDE_CODE_USE_BEDROCK // empty' "$SETTINGS" 2>/dev/null)
if [ "$USE_BEDROCK" = "1" ]; then
  ok "env.CLAUDE_CODE_USE_BEDROCK is 1"
else
  not_ok "env.CLAUDE_CODE_USE_BEDROCK is 1" "got: $USE_BEDROCK"
fi

# AWS_REGION is set (required for Bedrock — Claude Code does not read it from ~/.aws)
AWS_REGION_VAL=$(jq -r '.env.AWS_REGION // empty' "$SETTINGS" 2>/dev/null)
if [ -n "$AWS_REGION_VAL" ]; then
  ok "env.AWS_REGION is set ($AWS_REGION_VAL)"
else
  not_ok "env.AWS_REGION is set" "AWS_REGION missing — Bedrock requires it"
fi

# Bedrock model IDs are pinned to the expected versions
OPUS_MODEL=$(jq -r '.env.ANTHROPIC_DEFAULT_OPUS_MODEL // empty' "$SETTINGS" 2>/dev/null)
if [ "$OPUS_MODEL" = "us.anthropic.claude-opus-4-8" ]; then
  ok "env.ANTHROPIC_DEFAULT_OPUS_MODEL is us.anthropic.claude-opus-4-8"
else
  not_ok "env.ANTHROPIC_DEFAULT_OPUS_MODEL is us.anthropic.claude-opus-4-8" "got: $OPUS_MODEL"
fi

SONNET_MODEL=$(jq -r '.env.ANTHROPIC_DEFAULT_SONNET_MODEL // empty' "$SETTINGS" 2>/dev/null)
if [ "$SONNET_MODEL" = "us.anthropic.claude-sonnet-4-6" ]; then
  ok "env.ANTHROPIC_DEFAULT_SONNET_MODEL is us.anthropic.claude-sonnet-4-6"
else
  not_ok "env.ANTHROPIC_DEFAULT_SONNET_MODEL is us.anthropic.claude-sonnet-4-6" "got: $SONNET_MODEL"
fi

HAIKU_MODEL=$(jq -r '.env.ANTHROPIC_DEFAULT_HAIKU_MODEL // empty' "$SETTINGS" 2>/dev/null)
if [ "$HAIKU_MODEL" = "us.anthropic.claude-haiku-4-5-20251001-v1:0" ]; then
  ok "env.ANTHROPIC_DEFAULT_HAIKU_MODEL is us.anthropic.claude-haiku-4-5-20251001-v1:0"
else
  not_ok "env.ANTHROPIC_DEFAULT_HAIKU_MODEL is us.anthropic.claude-haiku-4-5-20251001-v1:0" "got: $HAIKU_MODEL"
fi

finish
