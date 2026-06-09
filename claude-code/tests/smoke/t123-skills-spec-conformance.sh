#!/bin/bash
# t123 (smoke): Agent-Skills-spec structural conformance over EVERY shipped skill
# dir. The unit-tier t123 owns the same invariants with the full frontmatter
# parser; this smoke-tier guard is the fast structural sweep the MR 11 spec
# promised ("smoke + unit") — it runs over the complete shipped set, not a
# subset. For each skill dir it asserts: a SKILL.md exists, frontmatter `name`
# equals the dir name, `description:` is present, the body is within the
# 500-line Agent-Skills ceiling, and (post Fork 2→B) the skill carries NO
# `hooks:` block — the deterministic spine lives project-wide in settings.json.
#
# The expected set is DERIVED, never hardcoded: the 4 base skills + the
# generator's FIRST_BATCH scope-runners + one `aidlc-<slug>` per RUNNABLE
# compiled stage (initialization excluded — no standalone --single meaning) +
# the single /aidlc-init phase wrapper. Deriving the stage-runners from the
# compiled graph means a stage added to the graph flows into this guard
# automatically and cannot silently ship a non-conformant runner. Pure bash +
# bun, no LLM; smoke tier. (1 dir-count guard + 5 structural assertions per
# skill = 1 + 5×38 = 191 tests.)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"

CLAUDE_DIR="$(cd "$SCRIPT_DIR/../../dist/claude/.claude" && pwd)"
SKILLS_DIR="$CLAUDE_DIR/skills"

# The four base skills (the orchestrator + the three read-only session skills).
BASE_SKILLS="aidlc aidlc-outcomes-pack aidlc-replay aidlc-session-cost"

# The first-batch generated scope-runner dirs (mirrors aidlc-runner-gen.ts
# FIRST_BATCH); the rest run via `--scope`.
SCOPE_RUNNER_SKILLS="aidlc-bugfix aidlc-feature aidlc-mvp aidlc-security-patch"

# One `aidlc-<slug>` per RUNNABLE compiled stage, derived from the graph (the
# initialization phase is excluded — it ships as the single /aidlc-init wrapper).
RUNNER_SKILLS=$(bun -e '
  const fs = require("fs");
  const g = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  console.log(g.filter(s => s.phase !== "initialization").map(s => "aidlc-" + s.slug).join(" "));
' "$CLAUDE_DIR/tools/data/stage-graph.json")

# The init-phase runner: a single /aidlc-init wrapper over `/aidlc --init`.
INIT_RUNNER_SKILL="aidlc-init"

EXPECTED_SKILLS="$BASE_SKILLS $SCOPE_RUNNER_SKILLS $RUNNER_SKILLS $INIT_RUNNER_SKILL"

# Plan = 1 dir-count guard + 5 structural assertions per skill.
NUM_SKILLS=$(echo "$EXPECTED_SKILLS" | tr ' ' '\n' | grep -c .)
plan $((1 + 5 * NUM_SKILLS))

# --- Test 1: the shipped skill set is exactly the expected set ---
DISCOVERED=$(for d in "$SKILLS_DIR"/*/; do
  [ -f "$d/SKILL.md" ] && basename "$d"
done | sort | tr '\n' ' ' | sed 's/ $//')
EXPECTED_SORTED=$(echo "$EXPECTED_SKILLS" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')
assert_eq "$DISCOVERED" "$EXPECTED_SORTED" \
  "shipped skill dirs == base four + 4 scope-runners + 29 stage-runners + aidlc-init"

# --- Per-skill structural conformance (4 tests each) ---
for skill in $(echo "$EXPECTED_SKILLS" | tr ' ' '\n' | sort); do
  file="$SKILLS_DIR/$skill/SKILL.md"

  assert_file_exists "$file" "$skill: SKILL.md exists"

  # frontmatter name == dir name
  got_name=$(bun -e '
    import { readFileSync } from "fs";
    const t = readFileSync(process.argv[1], "utf8");
    const m = t.match(/^---\n([\s\S]*?)\n---/);
    const fm = m ? m[1] : "";
    const nm = fm.match(/^name:\s*(.*)$/m);
    console.log(nm ? nm[1].trim().replace(/^["\x27]|["\x27]$/g, "") : "");
  ' "$file" 2>/dev/null || true)
  assert_eq "$got_name" "$skill" "$skill: frontmatter name == dir"

  # description present
  assert_grep "$file" "^description:" "$skill: has description"

  # NO hooks: block (spine moved to settings.json, Fork 2→B)
  assert_not_grep "$file" "^hooks:" "$skill: carries no hooks: block"

  # body <= 500 lines (Agent-Skills ceiling)
  lines=$(wc -l < "$file" | tr -d ' ')
  if [ "$lines" -le 500 ]; then
    ok "$skill: SKILL.md body <= 500 lines ($lines)"
  else
    not_ok "$skill: SKILL.md body <= 500 lines" "got $lines"
  fi
done

finish
