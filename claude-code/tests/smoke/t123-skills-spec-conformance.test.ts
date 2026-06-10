// covers: file:skills, contract:agent-skills-spec-conformance
//
// t123 (smoke) — Agent-Skills-spec structural conformance over EVERY shipped
// skill dir under dist/claude/.claude/skills/. Migrated from
// tests/smoke/t123-skills-spec-conformance.sh (TAP plan: 1 dir-count guard +
// 5 structural assertions per skill = 1 + 5×38 = 191 assertions).
//
// Mechanism: none. There is no tool / process / argv seam under test — the
// subject IS the on-disk shape of the shipped skill set and the bytes of each
// SKILL.md. The .sh sourced lib/tap.sh and shelled to `bun -e` only to PARSE
// (read the graph, extract the frontmatter `name`); it never invoked an aidlc
// tool as a process-boundary contract. So the twin reads the same static files
// in-process (resolved from the harness's AIDLC_SRC, the same
// dist/claude/.claude root the .sh reached via $CLAUDE_DIR) and asserts. Zero
// LLM, zero tokens, zero subprocess. The ONE in-repo import — FIRST_BATCH from
// aidlc-runner-gen.ts — is a pure exported constant, not a spawn (the .sh
// hardcoded the same four scope-runner names in SCOPE_RUNNER_SKILLS; importing
// the constant is STRONGER: it tracks the generator's source of truth so a
// FIRST_BATCH edit flows into this guard automatically).
//
// Subject under test (the shipped skill set + each SKILL.md):
//   dist/claude/.claude/skills/<skill>/SKILL.md — for the DERIVED expected set:
//     - 4 base skills (orchestrator + 3 read-only session skills)
//     - the generator's FIRST_BATCH scope-runners (aidlc-runner-gen.ts:307,
//       imported here, not hardcoded)
//     - one aidlc-<slug> per RUNNABLE compiled stage (every stage whose
//       phase !== "initialization", read from tools/data/stage-graph.json
//       exactly as the .sh's `bun -e` did — the array of stage records)
//     - the single /aidlc-init phase wrapper
//   Each conformant SKILL.md must: exist; carry frontmatter `name:` equal to
//   the dir name; carry a `description:` line; carry NO `hooks:` block (Fork
//   2→B moved the deterministic spine project-wide into settings.json); and
//   keep its body within the Agent-Skills 500-line ceiling.
//
// DERIVED, never hardcoded (the .sh's central design promise): the expected
// set is computed from the same two sources the .sh used — stage-graph.json
// (filtered to non-initialization phases) + FIRST_BATCH — so a stage added to
// the graph flows into this guard automatically and cannot silently ship a
// non-conformant runner. The dir-count guard (test 1) then proves the on-disk
// shipped set EQUALS that derived set.
//
// Old TAP -> new test parity (1:1, no guarantee dropped; several STRONGER):
//   .sh test 1 (dir-count: shipped set == base 4 + 4 scope-runners +
//       29 stage-runners + aidlc-init, sorted assert_eq)
//         -> "shipped skill set == derived expected set (sorted, exact)"
//            STRONGER: asserts the two sorted arrays equal element-by-element
//            (toEqual), not just the joined string the .sh compared.
//   .sh per-skill test A (assert_file_exists SKILL.md)
//         -> per-skill "SKILL.md exists"
//   .sh per-skill test B (frontmatter name == dir, via bun -e parse)
//         -> per-skill "frontmatter name == dir" (same `^name:` extraction,
//            quote-stripped, block-scoped to the --- front-matter)
//   .sh per-skill test C (assert_grep "^description:")
//         -> per-skill "has a description: line" (same `^description:` anchor)
//   .sh per-skill test D (assert_not_grep "^hooks:")
//         -> per-skill "carries no hooks: block" (same `^hooks:` anchor — the
//            failure event MUST be reachable: a SKILL.md that grows a hooks:
//            block fails this row, mirroring assert_not_grep)
//   .sh per-skill test E (wc -l <= 500, ok/not_ok)
//         -> per-skill "SKILL.md body <= 500 lines"
//
// 1 + 5×38 = 191 .sh assertions -> 1 set-equality test() + 5 expect()s ×
// 38 skills (190) = 191 expect()-bearing assertions, same observables, the
// dir-count + name-derivation STRONGER.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { FIRST_BATCH } from "../../dist/claude/.claude/tools/aidlc-runner-gen.ts";

const SKILLS_DIR = join(AIDLC_SRC, "skills");
const STAGE_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

// --- The four base skills (orchestrator + the three read-only session skills).
const BASE_SKILLS = [
  "aidlc",
  "aidlc-outcomes-pack",
  "aidlc-replay",
  "aidlc-session-cost",
];

// --- The first-batch generated scope-runner dirs. IMPORTED from the generator
// (aidlc-runner-gen.ts FIRST_BATCH), not hardcoded — the .sh hardcoded the same
// four in SCOPE_RUNNER_SKILLS; tracking the constant is the stronger contract.
const SCOPE_RUNNER_SKILLS = FIRST_BATCH.map((s) => `aidlc-${s}`);

// --- One aidlc-<slug> per RUNNABLE compiled stage, derived from the graph the
// same way the .sh's `bun -e` did: read tools/data/stage-graph.json (the array
// of stage records), keep every stage whose phase !== "initialization".
interface StageRecord {
  slug: string;
  phase: string;
}
const graph: StageRecord[] = JSON.parse(readFileSync(STAGE_GRAPH, "utf-8"));
const RUNNER_SKILLS = graph
  .filter((s) => s.phase !== "initialization")
  .map((s) => `aidlc-${s.slug}`);

// --- The init-phase runner: a single /aidlc-init wrapper over `/aidlc --init`.
const INIT_RUNNER_SKILL = "aidlc-init";

const EXPECTED_SKILLS = [
  ...BASE_SKILLS,
  ...SCOPE_RUNNER_SKILLS,
  ...RUNNER_SKILLS,
  INIT_RUNNER_SKILL,
].sort();

/**
 * Discover the shipped skill set: every directory under the skills dir that
 * contains a SKILL.md (mirrors the .sh for-loop over the skills dir that keeps
 * directories carrying a SKILL.md file).
 */
function discoveredSkills(): string[] {
  return readdirSync(SKILLS_DIR)
    .filter((name) => {
      const dir = join(SKILLS_DIR, name);
      return (
        statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"))
      );
    })
    .sort();
}

/** Extract the frontmatter name: value (quote-stripped), block-scoped to the
 *  leading ---\n…\n--- fence — exactly the .sh's inline bun -e parser. */
function frontmatterName(text: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = m ? m[1] : "";
  const nm = fm.match(/^name:\s*(.*)$/m);
  return nm ? nm[1].trim().replace(/^["']|["']$/g, "") : "";
}

describe("t123 (smoke) skills-spec conformance — shipped skill set (migrated from t123-skills-spec-conformance.sh, plan 191)", () => {
  // --- Test 1: the shipped skill set is exactly the DERIVED expected set ---
  test("shipped skill set == derived expected set (sorted, exact) [.sh test 1]", () => {
    // STRONGER than the .sh's joined-string assert_eq: element-by-element.
    // Asserts both that the count matches (191's dir-count guard) and that the
    // membership is exact — every base + scope-runner + stage-runner + init.
    expect(discoveredSkills()).toEqual(EXPECTED_SKILLS);
  });
});

// --- Per-skill structural conformance (5 expect()s each). One describe block
// per skill keeps the failure report skill-scoped, mirroring the .sh's
// per-skill TAP lines. The set iterated is the DERIVED expected set (sorted),
// exactly the .sh's `for skill in $(echo "$EXPECTED_SKILLS" | ... | sort)`.
describe("t123 (smoke) skills-spec conformance — per-skill SKILL.md invariants", () => {
  for (const skill of EXPECTED_SKILLS) {
    const file = join(SKILLS_DIR, skill, "SKILL.md");

    test(`${skill}: SKILL.md exists [.sh per-skill A]`, () => {
      expect(existsSync(file)).toBe(true);
    });

    test(`${skill}: frontmatter name == dir [.sh per-skill B]`, () => {
      const text = readFileSync(file, "utf-8");
      expect(frontmatterName(text)).toBe(skill);
    });

    test(`${skill}: has a description: line [.sh per-skill C]`, () => {
      const text = readFileSync(file, "utf-8");
      // Same anchor as assert_grep "^description:": a line that starts the
      // `description:` key (multiline mode).
      expect(/^description:/m.test(text)).toBe(true);
    });

    test(`${skill}: carries no hooks: block [.sh per-skill D]`, () => {
      const text = readFileSync(file, "utf-8");
      // Same anchor as assert_not_grep "^hooks:" — Fork 2→B moved the spine to
      // settings.json. The failure row IS reachable: any SKILL.md that grows a
      // `hooks:` key at line-start fails here.
      expect(/^hooks:/m.test(text)).toBe(false);
    });

    test(`${skill}: SKILL.md body <= 500 lines [.sh per-skill E]`, () => {
      const text = readFileSync(file, "utf-8");
      // The .sh used `wc -l < file`, which counts newline characters. Mirror
      // that exactly (number of "\n"), not the split-array length.
      const lines = (text.match(/\n/g) ?? []).length;
      expect(lines).toBeLessThanOrEqual(500);
    });
  }
});
