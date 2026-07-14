// covers: file:skills, contract:agent-skills-spec-conformance
//
// t123 (unit) — Agent-Skills-spec conformance over every shipped harness's
// declared skill root, asserted with the complete frontmatter
// parser (the unit-tier sibling of the smoke-tier structural sweep). Migrated
// from tests/unit/t123-skills-spec-conformance.sh (TAP plan: 1 dir-count guard
// + 3 conformance assertions per skill = 1 + 3×38 = 115 assertions).
//
// Mechanism: none. There is no tool / process / argv / exit-code seam under
// test — the subject IS the on-disk shape of each shipped skill set and the
// YAML frontmatter bytes of each SKILL.md. The .sh sourced lib/tap.sh and
// shelled to `bun -e` ONLY to PARSE (read the stage graph; run the frontmatter
// extractor); it never invoked an aidlc tool as a process-boundary contract.
// So the twin reads the same static files in-process, with skill roots resolved
// by the shared harness matrix. Zero LLM, zero tokens, zero subprocess. The ONE
// in-repo import - defaultScopeBatch from aidlc-runner-gen.ts - is a pure
// function import, not a spawn (the .sh hardcoded the same four scope-runner
// names in SCOPE_RUNNER_SKILLS; calling the function is STRONGER: it tracks the
// generator's source of truth so a default-batch edit flows into this guard).
//
// DISTINCT FROM the smoke twin (tests/smoke/t123-skills-spec-conformance.test.ts):
// the smoke tier owns the fast 5-assertion structural sweep (exists, name==dir,
// description PRESENT, no hooks: block, <=500 lines). THIS unit tier owns the
// .sh's narrower 3-assertion-per-skill conformance, whose load-bearing
// difference is the description NON-EMPTY check driven by the FULL frontmatter
// parser: every shipped SKILL.md uses the folded block-scalar `description: >`
// form, so "present" is not enough — the parser must follow the block scalar to
// the first non-empty continuation line before the next top-level key. That
// block-scalar-aware non-empty contract is what this twin preserves verbatim
// from the .sh's inline `bun -e` parser (t123-skills-spec-conformance.sh:94-124).
//
// Subject under test (each shipped skill set + each SKILL.md's frontmatter):
//   dist/<harness>/<skill-root>/<skill>/SKILL.md, for the DERIVED expected set:
//     - 4 base skills (orchestrator + 3 read-only session skills)
//     - the generator's default-batch scope-runners (imported here, not
//       hardcoded)
//     - one aidlc-<slug> per RUNNABLE compiled stage (every stage whose
//       phase !== "initialization", read from tools/data/stage-graph.json
//       exactly as the .sh's `bun -e` did — the array of stage records)
//     - the single /aidlc-init phase wrapper
//   Each conformant SKILL.md must: carry frontmatter `name:` equal to the dir
//   name; carry a `description:` that is BOTH present AND non-empty (inline or
//   folded `>`/`|` block-scalar form); keep its body within the Agent-Skills
//   500-line ceiling.
//
// DERIVED, never hardcoded (the .sh's central design promise): the expected set
// is computed from the same two sources the .sh used — stage-graph.json
// (filtered to non-initialization phases) + defaultScopeBatch() - so a stage
// added to the graph flows into this guard automatically and cannot silently
// ship a non-conformant runner. The dir-count guard (test 1) then proves the on-disk
// shipped set EQUALS that derived set.
//
// Old TAP -> new test parity (1:1, no guarantee dropped; several STRONGER):
//   .sh test 1 (dir-count: discovered shipped dirs == base 4 + 4 scope-runners
//       + 29 stage-runners + aidlc-init, sorted assert_eq)
//         -> "shipped skill set == derived expected set (sorted, exact)"
//            STRONGER: element-by-element toEqual on the sorted arrays, not just
//            the joined string the .sh compared — proves count AND membership.
//   .sh per-skill assertion 1 (assert_eq got_name == skill; the .sh's
//       not_ok-on-missing-file branch is folded in: a missing SKILL.md yields
//       an empty parsed name, so name!==dir fails loudly)
//         -> per-skill "frontmatter name == dir" (same `^name:` extraction,
//            quote-stripped, BLOCK-SCOPED to the ---\n…\n--- fence)
//   .sh per-skill assertion 2 (descPresent==1 AND descNonEmpty==1, the
//       block-scalar-aware parser)
//         -> per-skill "description present AND non-empty (block-scalar aware)"
//            — the SAME parser logic ported verbatim; the failure event IS
//            reachable (an empty `description: >` with no continuation, or a
//            blank inline value, fails this row, mirroring the .sh's not_ok).
//   .sh per-skill assertion 3 (wc -l <= 500, ok/not_ok)
//         -> per-skill "SKILL.md body <= 500 lines" (wc -l counts newlines —
//            mirrored as the count of "\n", not the split-array length).
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
 * contains a SKILL.md (mirrors the .sh's for-loop over the skills dir that
 * keeps directories carrying a SKILL.md file).
 */
function discoveredSkills(skillsDir: string): string[] {
  return readdirSync(skillsDir)
    .filter((name) => {
      const dir = join(skillsDir, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"));
    })
    .sort();
}

interface FrontmatterParse {
  name: string;
  descPresent: boolean;
  descNonEmpty: boolean;
}

/**
 * Parse the leading YAML frontmatter block and return the spec fields the .sh's
 * inline `bun -e` parser emitted (t123-skills-spec-conformance.sh:94-124),
 * PORTED VERBATIM so the non-empty contract is byte-identical:
 *   - name: the `^name:` scalar, trimmed + quote-stripped.
 *   - descPresent: a `^description:` line exists.
 *   - descNonEmpty: the description value carries visible text — for an inline
 *     value, the trimmed quote-stripped value is non-empty; for a folded/literal
 *     block scalar (`>` `|` `>-` `|-`), at least one indented continuation line
 *     before the next top-level key has visible text.
 * A SKILL.md with no frontmatter fence yields ("", false, false) — same as the
 * .sh's `if (!m) { ... ["", "0", "0"] }` early-out, so a malformed file fails
 * both the name and description rows loudly.
 */
function parseFrontmatter(text: string): FrontmatterParse {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { name: "", descPresent: false, descNonEmpty: false };
  const lines = m[1].split("\n");
  let name = "";
  let descPresent = false;
  let descNonEmpty = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      descPresent = true;
      const inline = descMatch[1].trim();
      if (inline === ">" || inline === "|" || inline === ">-" || inline === "|-") {
        // Block scalar: non-empty iff at least one indented continuation line
        // has visible text before the next top-level key.
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\S/.test(lines[j])) break; // next top-level key
          if (lines[j].trim().length > 0) {
            descNonEmpty = true;
            break;
          }
        }
      } else {
        const v = inline.replace(/^["']|["']$/g, "").trim();
        descNonEmpty = v.length > 0;
      }
    }
  }
  return { name, descPresent, descNonEmpty };
}

describe("t123 (unit) skills-spec conformance — every shipped skill set", () => {
  for (const harness of HARNESS_MATRIX) {
    test(`${harness.name}: shipped skill set == derived expected set (sorted, exact)`, () => {
      expect(discoveredSkills(harness.skillsRoot)).toEqual(EXPECTED_SKILLS);
    });
  }
});

// --- Per-skill spec conformance (3 expect()s each). One describe block per
// skill keeps the failure report skill-scoped, mirroring the .sh's per-skill
// TAP lines. The set iterated is the DERIVED expected set (sorted), exactly the
// .sh's `for skill in $(echo "$EXPECTED_SKILLS" | tr ' ' '\n' | sort)`.
describe("t123 (unit) skills-spec conformance — per-skill SKILL.md invariants", () => {
  for (const harness of HARNESS_MATRIX) {
    for (const skill of EXPECTED_SKILLS) {
      const file = join(harness.skillsRoot, skill, "SKILL.md");

      test(`${harness.name}/${skill}: frontmatter name == dir`, () => {
        const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
        expect(parseFrontmatter(text).name).toBe(skill);
      });

      test(`${harness.name}/${skill}: description present and non-empty`, () => {
        const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
        const fm = parseFrontmatter(text);
        expect(fm.descPresent).toBe(true);
        expect(fm.descNonEmpty).toBe(true);
      });

      test(`${harness.name}/${skill}: SKILL.md body <= 500 lines`, () => {
        const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
        const lines = (text.match(/\n/g) ?? []).length;
        expect(lines).toBeLessThanOrEqual(500);
      });
    }
  }
});
