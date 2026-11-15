// The orchestrator skill's own name for itself reached the person: on Codex
// the agent opened chat-entry turns with "I'll use the AI-DLC orchestrator for
// this" and "I'll pass your wording straight into the workflow engine" (6 of 46
// words-misses in the 2026-10-10 live baseline), and on Kiro CLI with "Let me
// read the full orchestrator skill" (39 of 65). Both words come from the
// skill's frontmatter description and its title line, which every harness
// shares. The skill keeps its name (aidlc) and what it does; the role word goes.
//
// covers: file:skills/aidlc/SKILL.md
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conductorSkillFileNames } from "../harness/conductor-skill.ts";

const REPO = join(import.meta.dir, "..", "..");
const DIST = join(REPO, "dist");
const ROLE_WORDS = ["workflow orchestrator", "# AI-DLC Orchestrator"];

// Every shipped orchestrator skill file and command file: dist/<harness>/<dot dir>/skills/aidlc/SKILL.md
// (and the files a skill goes on in),
// plus opencode's command file, which carries the same description.
function shippedSkillFiles(): string[] {
  const files: string[] = [];
  for (const harness of readdirSync(DIST, { withFileTypes: true })) {
    if (!harness.isDirectory() || harness.name === "plugins") continue;
    const tree = join(DIST, harness.name);
    for (const dot of readdirSync(tree, { withFileTypes: true })) {
      if (!dot.isDirectory() || !dot.name.startsWith(".")) continue;
      const [skill, ...continuations] = conductorSkillFileNames(harness.name);
      for (const rel of [`skills/aidlc/${skill}`, "command/aidlc.md"]) {
        const file = join(tree, dot.name, rel);
        if (existsSync(file)) files.push(file);
      }
      // The files the skill goes on in ship with it; a missing one fails its read.
      if (existsSync(join(tree, dot.name, "skills", "aidlc", skill))) {
        for (const file of continuations) files.push(join(tree, dot.name, "skills", "aidlc", file));
      }
    }
  }
  return files;
}

describe("the skill names itself AI-DLC, not a role", () => {
  const files = shippedSkillFiles();
  test("every harness ships the orchestrator skill", () => {
    expect(files.filter((f) => f.endsWith("SKILL.md")).length).toBe(7);
  });
  for (const file of files) {
    test(`${file.slice(DIST.length + 1)} carries no role word`, () => {
      const text = readFileSync(file, "utf-8");
      for (const word of ROLE_WORDS) {
        expect(text.includes(word), `${file} carries ${JSON.stringify(word)}`).toBe(false);
      }
    });
  }
});
