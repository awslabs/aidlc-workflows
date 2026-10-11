// Kiro's agent cuts any tool result over 30,000 characters (CHAR_THRESHOLD in
// the kiro-agent bundle): a file read shows the first 30,000. Both Kiro skills
// are about three times that, and when the conductor had to read its own skill
// with its file tool in parts, Kiro IDE 1.2.37 stopped after four of ten parts
// in five of six measured chats, so 230 of 390 lines never reached it. The
// conductor now carries the skill and its two annexes as the agent's own
// `file://` resources, which Kiro puts whole into that agent's context at chat
// start (measured on Kiro IDE 1.2.37: all 102 KB, no read), and the prompt says
// so; nothing in the skill asks to be read any more.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
// Each part a read returns, with room for the read tool's own wrapper.
const PART_MAX_CHARS = 28_000;
const SKILL_FILES = ["SKILL.md", "question-rendering.md", "composer.md"] as const;
const RESOURCES = SKILL_FILES.map((file) => `file://.kiro/skills/aidlc/${file}`);
const PROMPT_ITEM =
  "the aidlc skill (.kiro/skills/aidlc/SKILL.md) and the two files beside it (question-rendering.md and composer.md) are in your context from the start of this chat: follow them, and never read them with your file tool; read every other AI-DLC file they send you to (a protocol module, a stage file) with your file tool in parts of at most 200 lines, to its last line;";
// The read step the skill and the prompts carried while the agent read the skill itself.
const OLD_READ_STEP = "with your file tool in parts of at most 40 lines";

// What Kiro loads as the skill: the text after the front matter.
function skillBody(text: string): string {
  const match = text.match(/^---\n[\s\S]*?\n---\n/);
  return match ? text.slice(match[0].length) : text;
}

function frontmatter(text: string): string {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  return match ? match[1] : "";
}

const TREES = [
  ["Kiro IDE", "dist/kiro-ide"],
  ["Kiro IDE release", "dist-release/kiro-ide"],
  ["Kiro CLI", "dist/kiro"],
  ["Kiro CLI release", "dist-release/kiro"],
] as const;

function conductorPrompt(treeRoot: string): string {
  const ide = join(REPO, treeRoot, ".kiro", "agents", "aidlc-aidlc.md");
  if (existsSync(ide)) return skillBody(readFileSync(ide, "utf-8"));
  return (JSON.parse(readFileSync(join(REPO, treeRoot, ".kiro", "agents", "aidlc.json"), "utf-8")) as { prompt: string }).prompt;
}

function conductorResources(treeRoot: string): string[] {
  const ide = join(REPO, treeRoot, ".kiro", "agents", "aidlc-aidlc.md");
  if (existsSync(ide)) {
    return [...frontmatter(readFileSync(ide, "utf-8")).matchAll(/^\s+- "(file:\/\/[^"]+)"$/gm)].map((m) => m[1]);
  }
  return (JSON.parse(readFileSync(join(REPO, treeRoot, ".kiro", "agents", "aidlc.json"), "utf-8")) as { resources: string[] }).resources;
}

describe("t-kiro-skill-read-in-parts: the conductor carries the skill as its own resources", () => {
  for (const [tool, root] of TREES) {
    test(`${tool}: the conductor lists the skill and its two annexes as file resources, and each one is shipped`, () => {
      const resources = conductorResources(root);
      for (const resource of RESOURCES) {
        expect(resources, `${tool} resources`).toContain(resource);
        expect(existsSync(join(REPO, root, resource.slice("file://".length))), resource).toBe(true);
      }
    });

    test(`${tool}: the skill asks nothing about reading itself`, () => {
      const body = skillBody(readFileSync(join(REPO, root, ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8"));
      expect(body).not.toContain(OLD_READ_STEP);
      expect(body).not.toContain("Read all of this file before any AI-DLC command");
      expect(body).not.toContain("## Read all of this skill");
      expect(body).not.toContain("loading this skill shows only its start and its end");
    });

    test(`${tool}: the conductor prompt says the skill is in its context from the start, never read`, () => {
      const prompt = conductorPrompt(root);
      expect(prompt).toContain(PROMPT_ITEM);
      expect(prompt).not.toContain(OLD_READ_STEP);
      expect(prompt).not.toContain("unless the aidlc skill is already in this chat");
    });
  }
});

// The protocol modules, stage files and agent files the skill sends the agent
// to are 33 to 104 KB (#2196), so one read shows their first 30,000 characters
// and the agent acted on that: the Construction module's Unit receipt rule and
// each module's Kiro binding section sit past the cut. The Routing section and
// both prompts say to read each such file in parts of at most 200 lines, and
// this keeps every such part under the cut, so a file that grows past it fails
// here before a Kiro agent runs without its tail.
const MODULE_PART_LINES = 200;
const MODULE_READ_STEP = "read every module named in `directive.protocol_modules`, and the stage file, with your file tool in parts of at most 200 lines (offset and limit), from the first line to the last";
const MODULE_CUT_SHORT = "never act on a module or stage file until its last part has come back";
const PROMPT_MODULE_STEP = "read every other AI-DLC file they send you to (a protocol module, a stage file) with your file tool in parts of at most 200 lines, to its last line";

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe("t-kiro-skill-read-in-parts: every file the skill sends the agent to fits its parts", () => {
  for (const [tool, root] of TREES) {
    const kiroDir = join(REPO, root, ".kiro");

    test(`${tool}: the skill says to read modules and stage files in ${MODULE_PART_LINES}-line parts, to the last line`, () => {
      const body = skillBody(readFileSync(join(kiroDir, "skills", "aidlc", "SKILL.md"), "utf-8"));
      expect(body).toContain(MODULE_READ_STEP);
      expect(body).toContain(MODULE_CUT_SHORT);
    });

    test(`${tool}: every ${MODULE_PART_LINES}-line part of every protocol module, stage file and agent file fits in one Kiro result`, () => {
      const files = [
        ...markdownFiles(join(kiroDir, "aidlc-common", "protocols")),
        ...markdownFiles(join(kiroDir, "aidlc-common", "stages")),
        ...markdownFiles(join(kiroDir, "agents")),
      ];
      expect(files.length).toBeGreaterThan(40);
      for (const file of files) {
        const lines = readFileSync(file, "utf-8").split("\n");
        let largest = 0;
        for (let start = 0; start < lines.length; start++) {
          largest = Math.max(largest, lines.slice(start, start + MODULE_PART_LINES).join("\n").length + 1);
        }
        expect(largest, relative(REPO, file)).toBeLessThan(PART_MAX_CHARS);
      }
    });

    test(`${tool}: the conductor prompt says to read every other AI-DLC file in parts`, () => {
      expect(conductorPrompt(root)).toContain(PROMPT_MODULE_STEP);
    });
  }
});

// The generated knowledge preflight in every delegated agent file tells a
// helper to load its knowledge files; on Kiro those reads are cut at 30,000
// characters too, so the Kiro trees' preflight carries the same read-in-parts
// clause (the reporter's helpers in #2196 read theirs once).
const PREFLIGHT_MARKER = "<!-- aidlc-delegated-knowledge-preflight -->";
const PREFLIGHT_KIRO_CLAUSE = "Kiro shows only part of a long file: read each one with your file tool in parts of at most 200 lines (offset and limit), from the first line to the last; a read that comes back cut short is not all of it.";

describe("t-kiro-skill-read-in-parts: the generated preflight tells a Kiro helper to read its knowledge in parts", () => {
  for (const [tool, root] of TREES) {
    const agents = join(REPO, root, ".kiro", "agents");
    test(`${tool}: every delegated agent file carries the clause after the preflight marker`, () => {
      const files = readdirSync(agents).filter((name) => /^aidlc-.*-agent\.md$/.test(name));
      expect(files.length).toBe(14);
      for (const name of files) {
        const file = join(agents, name);
        const text = readFileSync(file, "utf-8");
        expect(text, relative(REPO, file)).toContain(PREFLIGHT_MARKER);
        expect(text, relative(REPO, file)).toContain(PREFLIGHT_KIRO_CLAUSE);
      }
    });
  }

  test("a Claude agent file keeps the plain preflight: Claude shows the whole file", () => {
    const text = readFileSync(join(REPO, "dist", "claude", ".claude", "agents", "aidlc-developer-agent.md"), "utf-8");
    expect(text).toContain(PREFLIGHT_MARKER);
    expect(text).not.toContain("parts of at most 200 lines");
  });
});
