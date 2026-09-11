// covers: file:knowledge/aidlc-design-agent/visual-design-foundations.md,
// file:agents/aidlc-design-agent.md,
// file:aidlc-common/stages/inception/refined-mockups.md
//
// Pins the visual-direction contract of the design persona. The wireframing
// and UX guides settle structure (states, flows, WCAG); before this file
// nothing settled the visual layer, so typography, colour, and elevation were
// decided silently at code generation, outside the refined-mockups gate. The
// contract has three surfaces that must agree: the knowledge file that defines
// the design read and the foundation token table, the persona that owns
// stating them, and the stage that asks for their inputs and names them in
// the design-system mapping artifact.
//
// Mechanism = none: pure text invariants over authored files plus the shipped
// dist/claude projection of the persona and the knowledge file.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const core = (...p: string[]) => join(REPO_ROOT, "core", ...p);
const dist = (...p: string[]) => join(REPO_ROOT, "dist", "claude", ".claude", ...p);

const KNOWLEDGE = ["knowledge", "aidlc-design-agent", "visual-design-foundations.md"];
const PERSONA = ["agents", "aidlc-design-agent.md"];
const STAGE = core("aidlc-common", "stages", "inception", "refined-mockups.md");

const TOKEN_GROUPS = ["### Type", "### Colour", "### Space, Shape, and Depth", "### Motion", "### Iconography"];

describe("t340 design visual foundations pins", () => {
  test("knowledge file defines the design read, the token groups, and the defaults list", () => {
    const src = readFileSync(core(...KNOWLEDGE), "utf-8");
    expect(src).toContain("## The Design Read");
    expect(src).toContain("Reading this as:");
    // The read is evidence-derived; an unsettled read is a question, not a guess.
    expect(src).toContain("Existing assets win.");
    expect(src).toContain("Quiet constraints override preference.");
    expect(src).toContain("it is a clarifying question for");
    expect(src).toContain("## Defaults to Reach Past");
    expect(src).toContain("## Foundation Token Table");
    for (const group of TOKEN_GROUPS) expect(src).toContain(group);
    // Contrast is stated per pair, and both themes are defined together.
    expect(src).toContain("4.5:1 for body text");
    expect(src).toContain("Light and dark together");
    expect(src).toContain("## Handoff Checklist");
    expect((src.match(/^- \[ \] /gm) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  test("knowledge file is harness-neutral prose and ships in dist/claude unchanged", () => {
    const src = readFileSync(core(...KNOWLEDGE), "utf-8");
    expect(src).not.toMatch(/\.(claude|kiro|codex|cursor|aidlc)\//);
    expect(readFileSync(dist(...KNOWLEDGE), "utf-8")).toBe(src);
  });

  test("persona owns the visual direction and points at the knowledge file", () => {
    const src = readFileSync(core(...PERSONA), "utf-8");
    expect(src).toContain("### Visual Direction");
    expect(src).toContain("State the design read");
    expect(src).toContain("Define the foundation token table");
    expect(src).toContain(
      "`{{HARNESS_DIR}}/knowledge/aidlc-design-agent/visual-design-foundations.md`",
    );
    expect(src).toContain("7. **Read the audience before choosing a look**");
    // Frontmatter is untouched: still judgment tier, still no nested delegation.
    expect(src).toContain("tier: judgment");
    expect(src).toContain("disallowedTools: Task");
  });

  test("dist/claude persona resolves the token to the Claude harness dir", () => {
    const projected = readFileSync(dist(...PERSONA), "utf-8");
    expect(projected).toContain("### Visual Direction");
    expect(projected).toContain(
      ".claude/knowledge/aidlc-design-agent/visual-design-foundations.md",
    );
    expect(projected).not.toContain("{{HARNESS_DIR}}");
  });

  test("refined-mockups asks for the design-read inputs and names the token table in the mapping artifact", () => {
    const src = readFileSync(STAGE, "utf-8");
    expect(src).toContain(
      "- What brand assets, design system, or aesthetic references already exist, and who is the audience (the inputs to the design read)?",
    );
    expect(src).toContain(
      "design system mapping (opening with the design read and carrying the foundation token table from `{{HARNESS_DIR}}/knowledge/aidlc-design-agent/visual-design-foundations.md`)",
    );
    // The artifact contract itself did not change: same outputs line.
    expect(src).toContain(
      "outputs: mockups.md, interaction-spec.md, design-system-mapping.md, accessibility-checklist.md, refined-mockups-questions.md",
    );
  });
});
