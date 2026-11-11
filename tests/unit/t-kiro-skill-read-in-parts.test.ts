// Kiro's agent cuts any tool result over 30,000 characters (CHAR_THRESHOLD in
// the kiro-agent bundle): a file read shows the first 30,000. Both Kiro skills
// are about three times that, and when the conductor had to read its own skill
// with its file tool in parts, Kiro IDE 1.2.37 stopped after four of ten parts
// in five of six measured chats, so 230 of 390 lines never reached it. The
// conductor now carries the skill and its annexes as the agent's own `file://`
// resources, which Kiro puts into that agent's context at chat start (measured
// on Kiro IDE 1.2.37: all 102 KB, no read), and the prompt says so.
//
// Kiro CLI 3.1.0 and Kiro IDE 1.4.86 cap those resources (Kiro's agent
// configuration reference, "resources" field): at most 32 files and 100,000
// characters for one agent, and at most 50,000 characters from one file, the
// rest cut with a note. Measured on Kiro CLI 3.1.0 and Kiro IDE 1.4.121, the
// conductor's resources held a 67,000-character SKILL.md only up to that cut.
// So the Kiro row's skill goes on in workflow.md, and the last block keeps
// every agent file in the Kiro row's trees inside the caps.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONDUCTOR_SKILL_FILES, conductorSkillText } from "../harness/conductor-skill.ts";

const REPO = join(import.meta.dir, "..", "..");
// Each part a read returns, with room for the read tool's own wrapper.
const PART_MAX_CHARS = 28_000;
// The conductor's resources: its skill's files, then the two annexes.
const RESOURCE_FILES = {
  "kiro-ide": [...CONDUCTOR_SKILL_FILES["kiro-ide"], "question-rendering.md", "composer.md"],
  kiro: [...CONDUCTOR_SKILL_FILES.kiro, "question-rendering.md", "composer.md"],
} as const;
const PROMPT_ITEM = {
  "kiro-ide":
    "the aidlc skill (.kiro/skills/aidlc/SKILL.md) and the three files beside it (workflow.md, question-rendering.md and composer.md) are in your context from the start of this chat: follow them, and never read them with your file tool; read every other AI-DLC file they send you to (a protocol module, a stage file) with your file tool in parts of at most 200 lines, to its last line;",
  kiro:
    "the aidlc skill (.kiro/skills/aidlc/SKILL.md) and the two files beside it (question-rendering.md and composer.md) are in your context from the start of this chat: follow them, and never read them with your file tool; read every other AI-DLC file they send you to (a protocol module, a stage file) with your file tool in parts of at most 200 lines, to its last line;",
} as const;
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
  ["Kiro IDE", "dist/kiro-ide", "kiro-ide"],
  ["Kiro IDE release", "dist-release/kiro-ide", "kiro-ide"],
  ["Kiro CLI", "dist/kiro", "kiro"],
  ["Kiro CLI release", "dist-release/kiro", "kiro"],
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

// The whole skill the conductor follows, without SKILL.md's front matter.
function conductorSkill(treeRoot: string, harness: keyof typeof RESOURCE_FILES): string {
  return skillBody(conductorSkillText(harness, join(REPO, treeRoot, ".kiro", "skills", "aidlc")));
}

describe("t-kiro-skill-read-in-parts: the conductor carries the skill as its own resources", () => {
  for (const [tool, root, harness] of TREES) {
    test(`${tool}: the conductor lists the skill and its annexes as file resources, and each one is shipped`, () => {
      const resources = conductorResources(root);
      for (const file of RESOURCE_FILES[harness]) {
        const resource = `file://.kiro/skills/aidlc/${file}`;
        expect(resources, `${tool} resources`).toContain(resource);
        expect(existsSync(join(REPO, root, resource.slice("file://".length))), resource).toBe(true);
      }
    });

    test(`${tool}: the skill asks nothing about reading itself`, () => {
      const body = conductorSkill(root, harness);
      expect(body).not.toContain(OLD_READ_STEP);
      expect(body).not.toContain("Read all of this file before any AI-DLC command");
      expect(body).not.toContain("## Read all of this skill");
      expect(body).not.toContain("loading this skill shows only its start and its end");
    });

    test(`${tool}: the conductor prompt says the skill is in its context from the start, never read`, () => {
      const prompt = conductorPrompt(root);
      expect(prompt).toContain(PROMPT_ITEM[harness]);
      expect(prompt).not.toContain(OLD_READ_STEP);
      expect(prompt).not.toContain("unless the aidlc skill is already in this chat");
    });
  }

  // A chat that loads the skill without the aidlc agent's resources (Kiro's
  // Default agent running /aidlc) gets SKILL.md alone, and workflow.md is past
  // one read's cut, so SKILL.md says where the rest is and how to read it.
  const WORKFLOW_PART_LINES = 50;
  const WORKFLOW_READ_STEP = `read it with your file tool before your first AI-DLC command, in parts of at most ${WORKFLOW_PART_LINES} lines, to its last line`;
  for (const [tool, root] of TREES.filter(([, , harness]) => harness === "kiro-ide")) {
    test(`${tool}: SKILL.md names workflow.md near its top, and every ${WORKFLOW_PART_LINES}-line part of it fits in one Kiro result`, () => {
      const skillDir = join(REPO, root, ".kiro", "skills", "aidlc");
      const head = skillBody(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).split("\n## ")[0];
      expect(head).toContain("This skill continues in `.kiro/skills/aidlc/workflow.md`");
      expect(head).toContain(WORKFLOW_READ_STEP);
      const lines = readFileSync(join(skillDir, "workflow.md"), "utf-8").split("\n");
      let largest = 0;
      for (let start = 0; start < lines.length; start++) {
        largest = Math.max(largest, lines.slice(start, start + WORKFLOW_PART_LINES).join("\n").length + 1);
      }
      expect(largest).toBeLessThan(PART_MAX_CHARS);
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
  for (const [tool, root, harness] of TREES) {
    const kiroDir = join(REPO, root, ".kiro");

    test(`${tool}: the skill says to read modules and stage files in ${MODULE_PART_LINES}-line parts, to the last line`, () => {
      const body = conductorSkill(root, harness);
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
// clause (the reporter's helpers in #2196 read theirs once). It names folders,
// and Kiro helpers listed them with one shell `ls` (each an approval card on
// Kiro CLI 3.1.0 and Kiro IDE), so it also says how to list them. Checked in
// the paragraph after the marker: some personas' own file-tools rule further
// down names listing too.
const PREFLIGHT_MARKER = "<!-- aidlc-delegated-knowledge-preflight -->";
const PREFLIGHT_KIRO_CLAUSE = "Kiro shows only part of a long file: read each one with your file tool in parts of at most 200 lines (offset and limit), from the first line to the last; a read that comes back cut short is not all of it.";
const PREFLIGHT_KIRO_LIST = "To find them, list each of these folders with your file tool, one folder per call, and any folder inside one the same way; a folder that is not there has nothing to load, and a shell line that lists, searches or reads them can stop and ask the person to approve it.";

function preflightParagraph(text: string): string {
  const match = text.replace(/\r\n/g, "\n").match(/^<!-- aidlc-delegated-knowledge-preflight -->\n([^\n]*)\n/m);
  return match ? match[1] : "";
}

// Every agent file (Markdown, or Codex's TOML) under a dist tree that carries
// the preflight (a plugin's contribution fragments carry none), found by
// walking rather than by folder name.
function preflightFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/-agent\.(md|toml)$/.test(entry.name) && readFileSync(path, "utf-8").includes(PREFLIGHT_MARKER)) files.push(path);
    }
  };
  walk(root);
  return files;
}

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
        expect(preflightParagraph(text), relative(REPO, file)).toContain(PREFLIGHT_KIRO_CLAUSE);
        expect(preflightParagraph(text), relative(REPO, file)).toContain(PREFLIGHT_KIRO_LIST);
      }
    });
  }

  for (const harness of ["kiro-ide", "kiro"]) {
    test(`a plugin's ${harness} agent files carry the same Kiro clauses in their preflight`, () => {
      const plugins = join(REPO, "dist", "plugins");
      const files = readdirSync(plugins)
        .map((plugin) => join(plugins, plugin, harness))
        .filter((root) => existsSync(root))
        .flatMap(preflightFiles);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const paragraph = preflightParagraph(readFileSync(file, "utf-8"));
        expect(paragraph, relative(REPO, file)).toContain(PREFLIGHT_KIRO_LIST);
        expect(paragraph, relative(REPO, file)).toContain(PREFLIGHT_KIRO_CLAUSE);
      }
    });
  }

  test("a Claude agent file keeps the plain preflight: Claude shows the whole file", () => {
    const text = readFileSync(join(REPO, "dist", "claude", ".claude", "agents", "aidlc-developer-agent.md"), "utf-8");
    expect(text).toContain(PREFLIGHT_MARKER);
    expect(text).not.toContain("parts of at most 200 lines");
  });

  for (const harness of ["claude", "codex", "cursor", "opencode", "copilot"]) {
    test(`${harness}: no agent file, core or plugin, carries the Kiro clauses in its preflight`, () => {
      const roots = [join(REPO, "dist", harness)];
      const plugins = join(REPO, "dist", "plugins");
      for (const plugin of readdirSync(plugins)) roots.push(join(plugins, plugin, harness));
      const files = roots.filter((root) => existsSync(root)).flatMap(preflightFiles);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const paragraph = preflightParagraph(readFileSync(file, "utf-8"));
        expect(paragraph, relative(REPO, file)).toStartWith("**Delegated knowledge preflight (mandatory):**");
        expect(paragraph, relative(REPO, file)).not.toContain(PREFLIGHT_KIRO_LIST);
        expect(paragraph, relative(REPO, file)).not.toContain(PREFLIGHT_KIRO_CLAUSE);
      }
    });
  }
});

// Kiro's caps on an agent's `file://` resources (see the header): a helper that
// declares none of its own gets the conductor's, so checking every agent that
// declares some covers them all. Lengths count UTF-16 code units, never fewer
// than Kiro's characters, and the whole file, front matter included.
const RESOURCE_MAX_FILES = 32;
const RESOURCE_MAX_FILE_CHARS = 50_000;
const RESOURCE_MAX_TOTAL_CHARS = 100_000;
const RESOURCE_MAX_FILE_BYTES = 1024 * 1024;

type ResourceBudget = { files: number; total: number; problems: string[] };

function resourceBudget(treeRoot: string, agentFile: string): ResourceBudget {
  const fm = Bun.YAML.parse(frontmatter(readFileSync(agentFile, "utf-8"))) as { resources?: unknown } | null;
  const resources = Array.isArray(fm?.resources) ? (fm.resources as unknown[]) : [];
  const budget: ResourceBudget = { files: 0, total: 0, problems: [] };
  for (const resource of resources) {
    if (typeof resource !== "string" || !resource.startsWith("file://")) continue;
    const path = resource.slice("file://".length);
    if (/[*?[{]/.test(path)) {
      budget.problems.push(`${resource}: a glob's files cannot be counted here; list each file`);
      continue;
    }
    const file = join(REPO, treeRoot, path);
    if (!existsSync(file)) {
      budget.problems.push(`${resource}: not shipped`);
      continue;
    }
    const text = readFileSync(file, "utf-8");
    budget.files += 1;
    budget.total += text.length;
    if (text.length > RESOURCE_MAX_FILE_CHARS) {
      budget.problems.push(`${resource}: ${text.length} characters, over Kiro's ${RESOURCE_MAX_FILE_CHARS} for one file (Kiro cuts the rest)`);
    }
    if (Buffer.byteLength(text) > RESOURCE_MAX_FILE_BYTES) budget.problems.push(`${resource}: over 1 MiB (Kiro skips it)`);
  }
  if (budget.files > RESOURCE_MAX_FILES) {
    budget.problems.push(`${budget.files} files, over Kiro's ${RESOURCE_MAX_FILES} (Kiro drops the later ones)`);
  }
  if (budget.total > RESOURCE_MAX_TOTAL_CHARS) {
    budget.problems.push(`${budget.total} characters in all, over Kiro's ${RESOURCE_MAX_TOTAL_CHARS} (Kiro drops the later files)`);
  }
  return budget;
}

describe("t-kiro-skill-read-in-parts: every Kiro-row agent's resources fit Kiro's caps", () => {
  for (const [tool, root] of TREES.filter(([, , harness]) => harness === "kiro-ide")) {
    test(`${tool}: no agent's file resources pass ${RESOURCE_MAX_FILES} files, ${RESOURCE_MAX_FILE_CHARS} characters in one file or ${RESOURCE_MAX_TOTAL_CHARS} in all`, () => {
      const agents = join(REPO, root, ".kiro", "agents");
      const files = readdirSync(agents).filter((name) => name.endsWith(".md"));
      expect(files).toContain("aidlc-aidlc.md");
      const problems: string[] = [];
      for (const name of files) {
        const budget = resourceBudget(root, join(agents, name));
        for (const problem of budget.problems) problems.push(`${name}: ${problem}`);
      }
      // Too long: move a whole section into another file the agent lists, or
      // out of the files it carries from the start.
      expect(problems).toEqual([]);
      expect(resourceBudget(root, join(agents, "aidlc-aidlc.md")).files).toBe(RESOURCE_FILES["kiro-ide"].length);
      expect(conductorResources(root)).toEqual(RESOURCE_FILES["kiro-ide"].map((file) => `file://.kiro/skills/aidlc/${file}`));
    });
  }
});
