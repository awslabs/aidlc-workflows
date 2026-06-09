#!/bin/bash
# t110: MCP registry integrity + the inheritance access model.
#
# The MCP access model: servers are declared once in
# dist/claude/.mcp.json and provisioned to the Claude Code session.
# Subagents INHERIT all session MCP tools by default (per Claude Code's
# sub-agents spec), so no per-agent grant is required — or possible by
# addition. An agent only needs a `tools:` allowlist entry to RESTRICT
# itself, and such entries must be fully-qualified `mcp__<server>__<tool>`
# (a bare `mcp__<server>` is not honored by Claude Code).
#
# This test pins:
#   1. Registry shape — .mcp.json is valid JSON and declares each expected
#      public server.
#   2. threat-composer-ai is intentionally absent (lands with the devsecops
#      threat-model stage in a later MR).
#   3. The inheritance invariant — no agent carries a bare `mcp__<server>`
#      token in `tools`. Those are no-ops (the access model is
#      inheritance, not per-agent grants), and a bare server token is not a
#      valid Claude Code grant form regardless. A future restriction MR that
#      adds real `tools:` allowlists would use fully-qualified
#      `mcp__<server>__<tool>` ids — this guard explicitly permits that form
#      and rejects only the bare-server form.
#
# L1 — pure bash + bun (for JSON parse, always on PATH). No jq dependency.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

SRC="$(cd "$SCRIPT_DIR/../../dist/claude" && pwd)"
MCP_JSON="$SRC/.mcp.json"
AGENTS_DIR="$SRC/.claude/agents"
AGENTS="product design delivery architect aws-platform compliance devsecops developer quality pipeline-deploy operations"

plan 32

# --- Registry is present and valid JSON --------------------------------------
assert_file_exists "$MCP_JSON" ".mcp.json registry exists"

if bun -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$MCP_JSON" >/dev/null 2>&1; then
  ok ".mcp.json is valid JSON"
else
  not_ok ".mcp.json is valid JSON" "JSON.parse failed"
fi

# Declared server names, one per line.
DECLARED=$(bun -e "
  const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  console.log(Object.keys(m.mcpServers || {}).join('\n'));
" "$MCP_JSON" 2>/dev/null)

declared_has() {
  printf '%s\n' "$DECLARED" | grep -qxF "$1"
}

# --- Expected public servers are declared ------------------------------------
for srv in context7 aws-mcp aws-pricing aws-iac aws-serverless; do
  if declared_has "$srv"; then
    ok "registry declares $srv"
  else
    not_ok "registry declares $srv" "missing from .mcp.json mcpServers"
  fi
done

# --- threat-composer is intentionally NOT here (lands with MR-D) -------------
if declared_has "threat-composer-ai"; then
  not_ok "threat-composer-ai is deferred (not declared yet)" "found it — should land with the threat-model stage"
else
  ok "threat-composer-ai is deferred (not declared yet)"
fi

# --- Inheritance invariant: no bare mcp__<server> grant tokens ---------------
# Access is by inheritance from .mcp.json, not per-agent grants. A bare
# `mcp__<server>` token (no __<tool> segment) in tools is a no-op and
# an invalid grant form. Fully-qualified `mcp__<server>__<tool>` entries in a
# real `tools:` allowlist are permitted (that's how a future restriction MR
# would narrow an agent) and are NOT flagged here.
BARE_TOKENS=""
for agent in $AGENTS; do
  FILE="$AGENTS_DIR/aidlc-${agent}-agent.md"
  [ -f "$FILE" ] || continue
  # Pull every mcp__ token from any tool field line, then keep only the bare
  # ones (mcp__<server> with no following __<tool>).
  for tok in $(grep -hoE 'mcp__[A-Za-z0-9-]+(__[A-Za-z0-9_-]+)?' "$FILE" 2>/dev/null || true); do
    if ! echo "$tok" | grep -qE '^mcp__[A-Za-z0-9-]+__'; then
      BARE_TOKENS+="  aidlc-${agent}-agent carries bare token '$tok' (no-op; access is by inheritance)"$'\n'
    fi
  done
done

if [ -z "$BARE_TOKENS" ]; then
  ok "no agent carries a bare mcp__<server> grant token (access is by inheritance)"
else
  not_ok "no agent carries a bare mcp__<server> grant token (access is by inheritance)" \
    "$(echo -e "\n$BARE_TOKENS")"
fi

# --- Per-server config shape validity ----------------------------------------
# The checks above assert only that the five server NAMES are keys under
# mcpServers; they never read inside a server object. These assertions parse
# each server body via `bun -e` (no jq) and pin its usable shape field by
# field, so a gutted, retyped, or renamed-package server still passes
# name-presence but fails here. The inline JS is a FIXED single-quoted program
# — the server name and a mode keyword travel as process.argv data (no shell
# value is interpolated into JS source), which keeps the program's internal
# double-quoted string literals safe.
mcp_check() {
  # mcp_check <server> <mode>
  #   mode: type | command | args0 | url_nonempty | has_ctx7_key
  #         | args_nonempty | args_has_region
  bun -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).mcpServers || {};
    const s = m[process.argv[2]] || {};
    const mode = process.argv[3];
    let out = "";
    if (mode === "type") out = s.type ?? "";
    else if (mode === "command") out = s.command ?? "";
    else if (mode === "args0") out = (Array.isArray(s.args) && s.args.length > 0) ? String(s.args[0]) : "";
    else if (mode === "url_nonempty") out = (typeof s.url === "string" && s.url.length > 0) ? "1" : "0";
    else if (mode === "has_ctx7_key") out = (s.headers && Object.prototype.hasOwnProperty.call(s.headers, "CONTEXT7_API_KEY")) ? "1" : "0";
    else if (mode === "args_nonempty") out = (Array.isArray(s.args) && s.args.length > 0) ? "1" : "0";
    else if (mode === "args_has_region") out = (Array.isArray(s.args) && s.args.includes("AWS_REGION=us-east-1")) ? "1" : "0";
    console.log(out);
  ' "$MCP_JSON" "$1" "$2" 2>/dev/null
}

# context7 — HTTP server with a URL and the API-key header placeholder.
assert_eq "$(mcp_check context7 type)" "http" "context7 type is 'http'"
assert_eq "$(mcp_check context7 url_nonempty)" "1" "context7 url is a non-empty string"
assert_eq "$(mcp_check context7 has_ctx7_key)" "1" "context7 declares headers.CONTEXT7_API_KEY"

# aws-* servers — uvx launchers whose first arg is the expected '<pkg>@latest' pin.
for pair in \
  "aws-mcp:mcp-proxy-for-aws@latest" \
  "aws-pricing:awslabs.aws-pricing-mcp-server@latest" \
  "aws-iac:awslabs.aws-iac-mcp-server@latest" \
  "aws-serverless:awslabs.aws-serverless-mcp-server@latest"; do
  srv="${pair%%:*}"
  pkg="${pair#*:}"
  assert_eq "$(mcp_check "$srv" command)" "uvx" "$srv command is 'uvx'"
  assert_eq "$(mcp_check "$srv" args_nonempty)" "1" "$srv args is a non-empty array"
  assert_eq "$(mcp_check "$srv" args0)" "$pkg" "$srv args[0] is '$pkg'"
done

# aws-mcp additionally carries its region metadata in args.
assert_eq "$(mcp_check aws-mcp args_has_region)" "1" "aws-mcp args include 'AWS_REGION=us-east-1'"

# --- No committed secrets: credential-position values are env-var placeholders ---
# The assertions above only enumerate KEYS — none inspect a value, so a real
# credential inlined where a placeholder belongs would pass today. These guards
# catch a debugging-session leak (someone swaps ${CONTEXT7_API_KEY} for a
# literal key) and any future header-bearing server added with an inlined token.

# (1) The one credential-position header on disk today (context7) is a ${VAR}
#     placeholder of the form ${UPPER_SNAKE}. Fails if a literal token replaces it.
CTX7_KEY="$(bun -e "const m=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(((m.mcpServers||{})['context7']||{}).headers?.CONTEXT7_API_KEY ?? '');" "$MCP_JSON")"
assert_match "$CTX7_KEY" '^\$\{[A-Z0-9_]+\}$' \
  "context7 CONTEXT7_API_KEY header is an env-var placeholder, not a literal token"

# (2) EVERY header value on EVERY server is a ${VAR} placeholder (generalises the
#     invariant to any future header-bearing server).
BAD_HEADERS="$(bun -e "
const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const re = /^\\\$\\{[A-Z0-9_]+\\}\$/;
const bad = [];
for (const [name, cfg] of Object.entries(m.mcpServers || {})) {
  for (const [hk, hv] of Object.entries((cfg && cfg.headers) || {})) {
    if (typeof hv !== 'string' || !re.test(hv)) bad.push(name + '.' + hk + ' = ' + JSON.stringify(hv));
  }
}
process.stdout.write(bad.join('\n'));
" "$MCP_JSON")"
if [ -z "$BAD_HEADERS" ]; then
  ok "every server header value is an env-var placeholder (no inlined credentials)"
else
  not_ok "every server header value is an env-var placeholder (no inlined credentials)" \
    "$(printf 'non-placeholder header value(s):\n%s' "$BAD_HEADERS")"
fi

# (3) No quoted string value anywhere in .mcp.json matches a high-entropy /
#     literal-key shape (provider prefixes, AKIA ids, base64 blobs, long alnum runs).
SECRET_SHAPE='"[^"]*((sk|pk|rk|ghp|gho|ghs|xox[bap])[_-][A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{12,}|[A-Za-z0-9+/]{40,}={0,2}|[A-Za-z0-9]{32,})[^"]*"'
if grep -qE "$SECRET_SHAPE" "$MCP_JSON"; then
  not_ok "no literal/high-entropy credential shape in .mcp.json (placeholders only)" \
    "$(printf 'literal-key shape found:\n%s' "$(grep -nE "$SECRET_SHAPE" "$MCP_JSON")")"
else
  ok "no literal/high-entropy credential shape in .mcp.json (placeholders only)"
fi

# --- Exact cardinality + clean top-level shape -------------------------------
# The presence checks above set no upper bound and never pin the document shape:
# a 6th unexpected server, a stray sibling top-level key, or mcpServers authored
# as an array/null would all pass them. These three close that gap.
SERVER_COUNT=$(bun -e "
  const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  console.log(Object.keys(m.mcpServers || {}).length);
" "$MCP_JSON" 2>/dev/null)
assert_eq "$SERVER_COUNT" "5" "mcpServers declares exactly 5 servers (no 6th unexpected entry)"

TOP_KEYS=$(bun -e "
  const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  console.log(Object.keys(m).join(','));
" "$MCP_JSON" 2>/dev/null)
assert_eq "$TOP_KEYS" "mcpServers" "mcpServers is the sole top-level key"

SERVERS_SHAPE=$(bun -e "
  const m = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  const v = m.mcpServers;
  console.log(v !== null && typeof v === 'object' && !Array.isArray(v) ? 'object' : 'not-object');
" "$MCP_JSON" 2>/dev/null)
assert_eq "$SERVERS_SHAPE" "object" "mcpServers value is a non-null object (not an array, not null)"

# --- Dangling fully-qualified grant guard ------------------------------------
# Complement of the bare-token guard: that guard keeps only bare mcp__<server>
# tokens; this keeps the fully-qualified mcp__<server>__<tool> tokens and checks
# each one's <server> segment against the live registry ($DECLARED). A
# fully-qualified entry naming a server NOT in .mcp.json is a dangling grant
# (renamed / deferred / mis-typed) that slips past the bare-token guard. Today
# no agent carries any mcp__ token, so this passes; it FAILS the moment an
# allowlist references e.g. mcp__threat-composer-ai__create or a typo'd server.
DANGLING_GRANTS=""
for agent in $AGENTS; do
  FILE="$AGENTS_DIR/aidlc-${agent}-agent.md"
  [ -f "$FILE" ] || continue
  for tok in $(grep -hoE 'mcp__[A-Za-z0-9-]+(__[A-Za-z0-9_-]+)?' "$FILE" 2>/dev/null || true); do
    # Keep only fully-qualified tokens (those with a __<tool> segment).
    echo "$tok" | grep -qE '^mcp__[A-Za-z0-9-]+__' || continue
    rest="${tok#mcp__}"
    srv="${rest%%__*}"
    if ! declared_has "$srv"; then
      DANGLING_GRANTS+="  aidlc-${agent}-agent token '$tok' names undeclared server '$srv' (not in .mcp.json mcpServers)"$'\n'
    fi
  done
done

if [ -z "$DANGLING_GRANTS" ]; then
  ok "every fully-qualified mcp__<server>__<tool> grant names a server declared in .mcp.json"
else
  not_ok "every fully-qualified mcp__<server>__<tool> grant names a server declared in .mcp.json" \
    "$(echo -e "\n$DANGLING_GRANTS")"
fi

finish
