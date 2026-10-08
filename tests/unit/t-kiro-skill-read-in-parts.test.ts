// Kiro's agent cuts any tool result over 30,000 characters (CHAR_THRESHOLD in
// the kiro-agent bundle): a skill load shows only the first and last 500
// characters, and a file read the first 30,000. Both Kiro skills are about
// three times that, so the part Kiro always shows tells the agent to read the
// whole file in parts that each fit, and the agent prompts say the same (#2167).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const KIRO_RESULT_CUT = 30_000;
const PREVIEW = 500;
// Each part a read returns, with room for the read tool's own wrapper.
const PART_LINES = 40;
const PART_MAX_CHARS = 28_000;
const READ_STEP = "read `.kiro/skills/aidlc/SKILL.md` with your file tool in parts of at most 40 lines (offset and limit), from the first line to the last";
const PROMPT_STEP = "read all of .kiro/skills/aidlc/SKILL.md with your file tool in parts of at most 40 lines, from the first line to the last (Kiro shows a long skill or file only in part), unless you already read all of it in this chat";

// What Kiro loads as the skill: the text after the front matter.
function skillBody(text: string): string {
  const match = text.match(/^---\n[\s\S]*?\n---\n/);
  return match ? text.slice(match[0].length) : text;
}

const SKILLS = [
  ["Kiro IDE", "dist/kiro-ide/.kiro/skills/aidlc/SKILL.md"],
  ["Kiro IDE release", "dist-release/kiro-ide/.kiro/skills/aidlc/SKILL.md"],
  ["Kiro CLI", "dist/kiro/.kiro/skills/aidlc/SKILL.md"],
  ["Kiro CLI release", "dist-release/kiro/.kiro/skills/aidlc/SKILL.md"],
] as const;

describe("t-kiro-skill-read-in-parts: the skill reaches the agent past Kiro's cut", () => {
  for (const [tool, rel] of SKILLS) {
    const text = readFileSync(join(REPO, rel), "utf-8");
    const body = skillBody(text);

    test(`${tool}: the skill is longer than Kiro shows, so the step is needed`, () => {
      expect(body.length).toBeGreaterThan(KIRO_RESULT_CUT);
    });

    test(`${tool}: the first and the last ${PREVIEW} characters Kiro shows carry the step`, () => {
      expect(body.slice(0, PREVIEW)).toContain(READ_STEP);
      expect(body.slice(-PREVIEW)).toContain(READ_STEP);
    });

    test(`${tool}: every ${PART_LINES}-line part fits in one Kiro result`, () => {
      const lines = text.split("\n");
      let largest = 0;
      for (let start = 0; start < lines.length; start++) {
        largest = Math.max(largest, lines.slice(start, start + PART_LINES).join("\n").length + 1);
      }
      expect(largest).toBeLessThan(PART_MAX_CHARS);
    });
  }

  test("both Kiro agent prompts say to read all of it, in parts", () => {
    const ide = readFileSync(join(REPO, "dist", "kiro-ide", ".kiro", "agents", "aidlc.md"), "utf-8");
    const cli = (JSON.parse(readFileSync(join(REPO, "dist", "kiro", ".kiro", "agents", "aidlc.json"), "utf-8")) as { prompt: string }).prompt;
    for (const prompt of [ide, cli]) {
      expect(prompt).toContain(PROMPT_STEP);
      // A skill load's preview is not the skill: the old wording let it count as read.
      expect(prompt).not.toContain("unless the aidlc skill is already in this chat");
    }
  });
});
