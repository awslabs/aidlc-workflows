// covers: file:skills, contract:agent-skills-spec-conformance
//
// t123 (smoke) — Agent-Skills-spec structural conformance over EVERY shipped
// harness's declared skill root. Migrated from
// tests/smoke/t123-skills-spec-conformance.sh (TAP plan: 1 dir-count guard +
// 5 structural assertions per skill = 1 + 5×38 = 191 assertions).
//
// Mechanism: none. There is no tool / process / argv seam under test — the
// subject IS the on-disk shape of each shipped skill set and the bytes of each
// SKILL.md. The .sh sourced lib/tap.sh and shelled to `bun -e` only to PARSE
// (read the graph, extract the frontmatter `name`); it never invoked an aidlc
// tool as a process-boundary contract. So the twin reads the same static files
// in-process, with skill roots resolved by the shared harness matrix. Zero
// LLM, zero tokens, zero subprocess. The ONE in-repo import - defaultScopeBatch
// from aidlc-runner-gen.ts - is a pure function import, not a spawn (the .sh
// hardcoded the same four scope-runner names in SCOPE_RUNNER_SKILLS; calling
// the function is STRONGER: it tracks the generator's source of truth so a
// default-batch edit flows into this guard automatically).
//
// Subject under test (each shipped skill set + each SKILL.md):
//   dist/<harness>/<skill-root>/<skill>/SKILL.md, for the DERIVED expected set:
//     - 4 base skills (orchestrator + 3 read-only session skills)
//     - the generator's default-batch scope-runners (imported here, not
//       hardcoded)
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
// (filtered to non-initialization phases) + defaultScopeBatch() - so a stage
// added to the graph flows into this guard automatically and cannot silently
// ship a non-conformant runner. The dir-count guard (test 1) then proves the on-disk
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
// The original assertion set is preserved independently for every discovered
// distribution, including Codex's emitted .agents/skills layout.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import { defaultScopeBatch } from "../../dist/claude/.claude/tools/aidlc-runner-gen.ts";

const STAGE_GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

// --- The four base skills (orchestrator + the three read-only session skills).
const BASE_SKILLS = [
  "aidlc",
  "aidlc-outcomes-pack",
  "aidlc-replay",
  "aidlc-session-cost",
];

// --- The default-batch generated scope-runner dirs. IMPORTED from the generator
// by calling defaultScopeBatch(), not hardcoded - the .sh hardcoded the same
// four in SCOPE_RUNNER_SKILLS; tracking the function is the stronger contract.
const SCOPE_RUNNER_SKILLS = defaultScopeBatch().map((s) => `aidlc-${s}`);

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

// --- The composer shortcut: a single /aidlc-compose wrapper over
// `/aidlc compose ...` (the adaptive composer's typeable entry).
const COMPOSE_RUNNER_SKILL = "aidlc-compose";

const EXPECTED_SKILLS = [
  ...BASE_SKILLS,
  ...SCOPE_RUNNER_SKILLS,
  ...RUNNER_SKILLS,
  INIT_RUNNER_SKILL,
  COMPOSE_RUNNER_SKILL,
].sort();

/**
 * Discover the shipped skill set: every directory under the skills dir that
 * contains a SKILL.md (mirrors the .sh for-loop over the skills dir that keeps
 * directories carrying a SKILL.md file).
 */
function discoveredSkills(skillsDir: string): string[] {
  return readdirSync(skillsDir)
    .filter((name) => {
      const dir = join(skillsDir, name);
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

describe("t123 (smoke) skills-spec conformance — every shipped skill set", () => {
  for (const harness of HARNESS_MATRIX) {
    test(`${harness.name}: shipped skill set == derived expected set (sorted, exact)`, () => {
      expect(discoveredSkills(harness.skillsRoot)).toEqual(EXPECTED_SKILLS);
    });

    test(`${harness.name}: generated runners invoke the manifest harness dir`, () => {
      const runner = readFileSync(
        join(harness.skillsRoot, "aidlc-code-generation", "SKILL.md"),
        "utf-8",
      );
      expect(runner).toContain(`bun ${harness.manifest.harnessDir}/tools/`);
      expect(runner).not.toContain("{{HARNESS_DIR}}");
      if (harness.manifest.skipRunnerGen) {
        expect(existsSync(join(harness.engineRoot, "skills"))).toBe(false);
      }
    });
  }
});

// --- Per-skill structural conformance (5 expect()s each). One describe block
// per skill keeps the failure report skill-scoped, mirroring the .sh's
// per-skill TAP lines. The set iterated is the DERIVED expected set (sorted),
// exactly the .sh's `for skill in $(echo "$EXPECTED_SKILLS" | ... | sort)`.
describe("t123 (smoke) skills-spec conformance — per-skill SKILL.md invariants", () => {
  for (const harness of HARNESS_MATRIX) {
    for (const skill of EXPECTED_SKILLS) {
      const file = join(harness.skillsRoot, skill, "SKILL.md");

      test(`${harness.name}/${skill}: SKILL.md exists`, () => {
        expect(existsSync(file)).toBe(true);
      });

      test(`${harness.name}/${skill}: frontmatter name == dir`, () => {
        const text = readFileSync(file, "utf-8");
        expect(frontmatterName(text)).toBe(skill);
      });

      test(`${harness.name}/${skill}: has a description: line`, () => {
        const text = readFileSync(file, "utf-8");
        expect(/^description:/m.test(text)).toBe(true);
      });

      test(`${harness.name}/${skill}: carries no hooks: block`, () => {
        const text = readFileSync(file, "utf-8");
        expect(/^hooks:/m.test(text)).toBe(false);
      });

      test(`${harness.name}/${skill}: SKILL.md body <= 500 lines`, () => {
        const text = readFileSync(file, "utf-8");
        const lines = (text.match(/\n/g) ?? []).length;
        expect(lines).toBeLessThanOrEqual(500);
      });
    }
  }
});
