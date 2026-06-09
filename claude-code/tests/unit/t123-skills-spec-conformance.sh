#!/bin/bash
# t123: Agent-Skills-spec conformance guard. For every shipped skill dir under
# dist/claude/.claude/skills/, assert the spec invariants: frontmatter `name`
# equals the directory name, `description` is present and non-empty, and the
# SKILL.md body is <= 500 lines. This is the in-repo conformance check (the
# published skills-ref validator is not installed; the v0.6.0 plan sanctions a
# vendored equivalent — MR 11). The check tolerates Claude-Code-native
# frontmatter extensions (`user-invocable`, `argument-hint`, and the `aidlc`
# skill's `hooks:` block) — these are documented portable-core-plus-extensions,
# not violations (vision §9). A dir-count guard asserts the shipped skill set is
# exactly the four base skills PLUS the first-batch generated scope-runners
# (v0.6.0 Wave 3 MR 13 — `skills/aidlc-<scope>/`, one per first-batch scope file)
# PLUS the 29 generated stage-runners (MR 14 — `skills/aidlc-<stage>/`, one per
# RUNNABLE compiled stage slug; the 3 bootstrap initialization stages are excluded)
# PLUS the single `/aidlc-init` phase wrapper that packages `/aidlc --init`, so a
# future skill addition fails loudly until this plan is updated. Both runner
# families are GENERATED: the scope-runners over `.claude/scopes/*.md` and the
# stage-runners over the compiled stage graph; their set-equality with their
# sources is owned by t130 (scope-runner drift) and t129-stage-runner-drift
# respectively, while THIS test owns spec conformance for the whole shipped skill set.
# (115 tests: 1 dir-count guard + 3 per skill x 38 skills)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
SKILLS_DIR="$AIDLC_SRC/skills"

# The four base skills (the orchestrator + the three read-only session skills).
BASE_SKILLS="aidlc aidlc-outcomes-pack aidlc-replay aidlc-session-cost"

# The first-batch generated scope-runner dirs: `aidlc-<scope>` for each scope in
# the generator's FIRST_BATCH (bugfix, feature, mvp, security-patch). Runners are
# a curated subset (the rest run via `--scope`); t130 owns the scope-runner drift
# guard, this test owns their spec conformance.
SCOPE_RUNNER_SKILLS="aidlc-bugfix aidlc-feature aidlc-mvp aidlc-security-patch"

# The 29 generated stage-runner dirs: `aidlc-<slug>` for every RUNNABLE compiled
# stage slug. DERIVED from the compiled graph so this guard cannot drift from the
# generator — a stage added to the graph adds its runner to the expected set
# automatically (and t129 enforces the runner actually exists). The bootstrap
# INITIALIZATION stages are EXCLUDED (no standalone --single meaning); the init
# phase ships as the single /aidlc-init wrapper instead (added below). Pure node read.
RUNNER_SKILLS=$(bun -e '
  const fs = require("fs");
  const g = JSON.parse(fs.readFileSync(process.argv[1], "utf-8"));
  console.log(g.filter(s => s.phase !== "initialization").map(s => "aidlc-" + s.slug).join(" "));
' "$AIDLC_SRC/tools/data/stage-graph.json")

# The init-phase runner: a single /aidlc-init wrapper over `/aidlc --init` (the
# whole init phase in one call), standing in for the 3 excluded per-init-stage
# runners. It drives `--init`, not `--stage … --single`, so t129 (the stage-runner
# drift guard) does not count it — but it ships and must conform to the spec.
INIT_RUNNER_SKILL="aidlc-init"

EXPECTED_SKILLS="$BASE_SKILLS $SCOPE_RUNNER_SKILLS $RUNNER_SKILLS $INIT_RUNNER_SKILL"

# Plan = 1 dir-count guard + 3 conformance assertions per skill.
NUM_SKILLS=$(echo "$EXPECTED_SKILLS" | tr ' ' '\n' | grep -c .)
plan $((1 + 3 * NUM_SKILLS))

# --- Discover the live skill set (dirs containing a SKILL.md) ---
DISCOVERED=$(for d in "$SKILLS_DIR"/*/; do
  [ -f "$d/SKILL.md" ] && basename "$d"
done | sort | tr '\n' ' ' | sed 's/ $//')
EXPECTED_SORTED=$(echo "$EXPECTED_SKILLS" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//')

# Test 1: the shipped skill set is exactly the base four + first-batch
# scope-runners + the 29 stage-runners + the /aidlc-init phase wrapper.
assert_eq "$DISCOVERED" "$EXPECTED_SORTED" \
  "shipped skill dirs == base four + 4 scope-runners + 29 stage-runners + aidlc-init"

# --- Per-skill spec conformance ---
# skill_check <dir-name>
skill_check() {
  local skill="$1"
  local file="$SKILLS_DIR/$skill/SKILL.md"

  if [ ! -f "$file" ]; then
    not_ok "$skill: SKILL.md exists" "file not found: $file"
    not_ok "$skill: description present and non-empty" "no SKILL.md"
    not_ok "$skill: SKILL.md body <= 500 lines" "no SKILL.md"
    return
  fi

  # Parse the YAML frontmatter block; extract `name` (simple scalar) and decide
  # whether `description` is present and non-empty (inline OR folded `>`/`|`
  # block-scalar form). Pure node/bun, zero-dep — the deterministic half of the
  # three-concerns split.
  # Emits three tab-separated fields: name, descPresent(1/0), descNonEmpty(1/0).
  local result
  result=$(bun -e '
    import { readFileSync } from "fs";
    const text = readFileSync(process.argv[1], "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) { console.log(["", "0", "0"].join("\t")); process.exit(0); }
    const lines = m[1].split("\n");
    let name = "";
    let descPresent = false, descNonEmpty = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nameMatch = line.match(/^name:\s*(.*)$/);
      if (nameMatch) name = nameMatch[1].trim().replace(/^["\x27]|["\x27]$/g, "");
      const descMatch = line.match(/^description:\s*(.*)$/);
      if (descMatch) {
        descPresent = true;
        const inline = descMatch[1].trim();
        if (inline === ">" || inline === "|" || inline === ">-" || inline === "|-") {
          // Block scalar: non-empty iff at least one indented continuation line
          // has visible text before the next top-level key.
          for (let j = i + 1; j < lines.length; j++) {
            if (/^\S/.test(lines[j])) break; // next top-level key
            if (lines[j].trim().length > 0) { descNonEmpty = true; break; }
          }
        } else {
          const v = inline.replace(/^["\x27]|["\x27]$/g, "").trim();
          descNonEmpty = v.length > 0;
        }
      }
    }
    console.log([name, descPresent ? "1" : "0", descNonEmpty ? "1" : "0"].join("\t"));
  ' "$file" 2>/dev/null)

  local got_name desc_present desc_nonempty
  IFS=$'\t' read -r got_name desc_present desc_nonempty <<< "$result"

  # Test: name == dir
  assert_eq "$got_name" "$skill" "$skill: frontmatter name == dir"

  # Test: description present and non-empty
  if [ "$desc_present" = "1" ] && [ "$desc_nonempty" = "1" ]; then
    ok "$skill: description present and non-empty"
  else
    not_ok "$skill: description present and non-empty" \
      "present=$desc_present nonEmpty=$desc_nonempty"
  fi

  # Test: SKILL.md body <= 500 lines
  local body_lines
  body_lines=$(wc -l < "$file" | tr -d ' ')
  if [ "$body_lines" -le 500 ]; then
    ok "$skill: SKILL.md body <= 500 lines ($body_lines)"
  else
    not_ok "$skill: SKILL.md body <= 500 lines" "got $body_lines lines"
  fi
}

# Conformance-check every expected skill (base four + 4 scope-runners + 32
# stage-runners), in sorted order for stable TAP output.
for skill in $(echo "$EXPECTED_SKILLS" | tr ' ' '\n' | sort); do
  skill_check "$skill"
done

finish
