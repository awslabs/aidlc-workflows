#!/bin/bash
# t130 (smoke): Generated scope-runner skills. Structural conformance for the
# first-batch runners (bugfix, feature, mvp, security-patch): each dir exists
# with a SKILL.md whose frontmatter `name` equals the dir name, `description`
# is present, body is within the 500-line Agent-Skills ceiling, the runner
# carries NO `hooks:` block (the spine lives in settings.json post-move), and
# the shell drives `aidlc-orchestrate next --scope <scope>`. Plus the generator
# drift guard (`aidlc-runner-gen.ts scopes --check`) is clean over the shipped
# tree, and a non-batch scope has no runner dir (runners are a curated subset;
# the rest run via `--scope`). Pure bash + bun, no LLM; smoke tier. (24 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

CLAUDE_DIR="$(cd "$SCRIPT_DIR/../../dist/claude/.claude" && pwd)"
SKILLS_DIR="$CLAUDE_DIR/skills"
GEN="$CLAUDE_DIR/tools/aidlc-runner-gen.ts"

# The first batch the generator ships (mirrors aidlc-runner-gen.ts FIRST_BATCH).
BATCH="bugfix feature mvp security-patch"

plan 24

# --- Per-runner structural conformance (5 tests × 4 = 20) -----------------
for scope in $BATCH; do
  dir="$SKILLS_DIR/aidlc-$scope"
  file="$dir/SKILL.md"

  assert_file_exists "$file" "aidlc-$scope: SKILL.md exists"

  # frontmatter name == dir name (aidlc-<scope>)
  got_name=$(bun -e '
    import { readFileSync } from "fs";
    const t = readFileSync(process.argv[1], "utf8");
    const m = t.match(/^---\n([\s\S]*?)\n---/);
    const fm = m ? m[1] : "";
    const nm = fm.match(/^name:\s*(.*)$/m);
    console.log(nm ? nm[1].trim().replace(/^["\x27]|["\x27]$/g, "") : "");
  ' "$file" 2>/dev/null || true)
  assert_eq "$got_name" "aidlc-$scope" "aidlc-$scope: frontmatter name == dir"

  # description present and non-empty
  assert_grep "$file" "^description:" "aidlc-$scope: has description"

  # NO hooks: block (spine moved to settings.json)
  assert_not_grep "$file" "^hooks:" "aidlc-$scope: carries no hooks: block"

  # body <= 500 lines (Agent-Skills ceiling)
  lines=$(wc -l < "$file" | tr -d ' ')
  if [ "$lines" -le 500 ]; then
    ok "aidlc-$scope: SKILL.md body <= 500 lines ($lines)"
  else
    not_ok "aidlc-$scope: SKILL.md body <= 500 lines" "got $lines"
  fi
done

# --- The shell drives the engine with the baked scope (1 test) ------------
# Spot-check bugfix carries the engine forwarding-loop call with its scope.
assert_grep "$SKILLS_DIR/aidlc-bugfix/SKILL.md" \
  "aidlc-orchestrate.ts next --scope bugfix" \
  "aidlc-bugfix: shell drives the engine with --scope bugfix"

# --- Generator drift guard is clean (1 test) ------------------------------
if bun "$GEN" scopes --check >/dev/null 2>&1; then
  ok "runner-gen scopes --check is drift-clean over the shipped tree"
else
  not_ok "runner-gen scopes --check is drift-clean" "drift detected (regenerate)"
fi

# --- Negative: a non-batch scope has no runner dir (1 test) ---------------
# `refactor` is a shipped scope but not in the first batch — it must run via
# `--scope`, not a runner. This pins that runners are a curated subset.
assert_file_not_exists "$SKILLS_DIR/aidlc-refactor/SKILL.md" \
  "non-batch scope (refactor) has no runner — runs via --scope"

# --- Generator emits a runner for a new scope file (1 test) ---------------
# Drop a fixture scope into an isolated tree, point the generator at it with
# --all + --out, and confirm it emits the runner. Proves "add a scope file →
# generator emits its runner" with no code change.
TMP_SCOPES=$(mktemp -d -t t130-scopes-XXXXXX)
TMP_OUT=$(mktemp -d -t t130-out-XXXXXX)
cat > "$TMP_SCOPES/aidlc-hotfix.md" <<'EOF'
---
name: hotfix
depth: Minimal
keywords:
  - hotfix
description: Urgent production patch
---
# hotfix scope
A leaner-than-bugfix urgent patch path.
EOF
AIDLC_SCOPES_DIR="$TMP_SCOPES" bun "$GEN" scopes --all --out "$TMP_OUT" >/dev/null 2>&1 || true
if [ -f "$TMP_OUT/aidlc-hotfix/SKILL.md" ] && \
   grep -q "next --scope hotfix" "$TMP_OUT/aidlc-hotfix/SKILL.md"; then
  ok "generator emits a runner for a newly-dropped scope file (no code change)"
else
  not_ok "generator emits a runner for a new scope file" "no runner emitted"
fi
rm -rf "$TMP_SCOPES" "$TMP_OUT"

finish
