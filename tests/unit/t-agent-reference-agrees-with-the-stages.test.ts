// covers: file:agents/aidlc-delivery-agent.md, file:agents/aidlc-pipeline-deploy-agent.md, file:knowledge/aidlc-delivery-agent/workflow-planning-guide.md, file:knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md, file:knowledge/aidlc-shared/brownfield.md
//
// What an agent reads beside its stage (its persona and its knowledge) agrees
// with the stage it works and with what the engine does:
//   - no persona or knowledge file points at a numbered step or a section of
//     the /aidlc skill (no harness skill has either), at a target-line hint the
//     engine never sends, or at a worktree check no step runs;
//   - the delivery persona hands Ideation over to Inception, where Approval &
//     Handoff leads, and checks no architecture or Units there (they come later);
//   - the Delivery Planning guide decides no stages: that stage says it does not;
//   - the shared brownfield safeguards ask for no diff preview before a change
//     and no stop on the impact summary, which Code Generation does not have.
// Requirement-ID templates are owned by t-traced-id-examples. Every shipped
// tree is read, so a later file that says the same fails here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";

const read = (path: string): string => readFileSync(path, "utf-8").replace(/\r\n/g, "\n");

// Persona and knowledge text: markdown everywhere, and Codex's TOML agents.
function referenceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...referenceFiles(path));
    else if (/\.(?:mdc?|toml)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const NOWHERE: Array<[string, RegExp]> = [
  ["a numbered step of the /aidlc skill", /SKILL\.md Step\b|\*\*SKILL\.md Step/],
  ["a section of the /aidlc skill", /Halt-and-ask failure handling/],
  ["a target-line hint", /target_line/],
  ["a worktree check no step runs", /then (?:runs|call) `aidlc-worktree verify`/],
];

describe("t-agent-reference-agrees-with-the-stages", () => {
  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: no persona or knowledge file points at a step the engine does not have",
    (_name, harness) => {
      const found: string[] = [];
      for (const file of referenceFiles(harness.distRoot)) {
        const text = read(file);
        for (const [what, pattern] of NOWHERE) {
          if (pattern.test(text)) found.push(`${relative(harness.distRoot, file)}: ${what}`);
        }
      }
      expect(found).toEqual([]);
    },
  );

  test.each(HARNESS_MATRIX.map((harness) => [harness.name, harness] as const))(
    "%s: the delivery agent, its planning guide and the brownfield safeguards match their stages",
    (_name, harness) => {
      // Every copy of the persona a tree ships (native agent files and the conductor's own copy).
      const personas = referenceFiles(harness.distRoot).filter((file) => /aidlc-delivery-agent\.(?:md|toml)$/.test(file));
      expect(personas.length).toBeGreaterThan(0);
      for (const file of personas) {
        const persona = read(file);
        expect(persona, relative(harness.distRoot, file)).not.toContain("Ideation to Construction");
        expect(persona, relative(harness.distRoot, file)).not.toContain("ideation into construction");
        expect(persona, relative(harness.distRoot, file)).not.toContain("architecture, and units");
      }
      const knowledge = join(harness.engineRoot, "knowledge");
      const guide = read(join(knowledge, "aidlc-delivery-agent", "workflow-planning-guide.md"));
      expect(guide).not.toContain("EXECUTE when");
      expect(guide).not.toContain("Stage Configuration");
      expect(guide).not.toContain("product-guide.md");
      const brownfield = read(join(knowledge, "aidlc-shared", "brownfield.md"));
      expect(brownfield).not.toContain("Diff Preview");
      expect(brownfield).not.toContain("impact summary to user before proceeding");
    },
  );
});
