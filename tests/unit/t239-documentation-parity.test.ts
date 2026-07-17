import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import codexOnboardingFills from "../../harness/codex/onboarding.fills.ts";
import { renderOnboarding } from "../../scripts/onboarding.ts";

const ROOT = join(import.meta.dir, "..", "..");
const at = (...parts: string[]): string => join(ROOT, ...parts);
const read = (...parts: string[]): string => readFileSync(at(...parts), "utf8");
const normalized = (text: string): string => text.replace(/\s+/g, " ").trim();

function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`missing start marker: ${start}`);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`missing end marker after ${start}: ${end}`);
  return text.slice(from, to);
}

function quotedTokens(block: string, pattern = /"([A-Z][A-Z0-9_]*)"/g): string[] {
  return [...new Set([...block.matchAll(pattern)].map((match) => match[1]))].sort();
}

function filesBelow(root: string, suffix: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...filesBelow(path, suffix));
    else if (entry.endsWith(suffix)) files.push(path);
  }
  return files.sort();
}

function numberWord(value: number): string {
  const words = ["zero", "one", "two", "three", "four", "five"];
  return words[value] ?? String(value);
}

function codeList(values: string[]): string {
  const quoted = values.map((value) => `\`${value}\``);
  if (quoted.length < 2) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

function agentTokens(text: string): string[] {
  return [...new Set([...text.matchAll(/aidlc-[a-z-]+-agent/g)].map((match) => match[0]))]
    .sort();
}

function documentedDistNames(text: string): string[] {
  return [...new Set([...text.matchAll(/dist\/([a-z][a-z-]+)\//g)].map((match) => match[1]))]
    .sort();
}

function eventCountClaimPattern(value: number): RegExp {
  return new RegExp(
    String.raw`(?:\b${value}(?=-event\b|\s+events?\b|\s+event\s+(?:types?|taxonomy|audit(?:\s+trail)?))|\b(?:audit\s+)?event\s+types?\s*\|\s*${value}\b)`,
    "i",
  );
}

function eventCountClaims(line: string): number[] {
  const claims = [
    ...line.matchAll(
      /\b(\d+)(?=-event\b|\s+events?\b|\s+event\s+(?:types?|taxonomy|audit(?:\s+trail)?))/gi,
    ),
    ...line.matchAll(/\b(?:audit\s+)?event\s+types?\s*\|\s*(\d+)\b/gi),
  ];
  return claims.map((match) => Number(match[1]));
}

const auditSource = read("core", "tools", "aidlc-audit.ts");
const auditSetBlock = sliceBetween(
  auditSource,
  "const VALID_EVENT_TYPES = new Set([",
  "]);",
);
const eventTypes = quotedTokens(auditSetBlock);

const harnessRoot = at("harness");
const harnessNames = readdirSync(harnessRoot)
  .filter((name) => existsSync(join(harnessRoot, name, "manifest.ts")))
  .map((dir) => {
    const manifest = read("harness", dir, "manifest.ts");
    const match = manifest.match(/\bname:\s*"([^"]+)"/);
    if (!match) throw new Error(`manifest has no name: harness/${dir}/manifest.ts`);
    expect(match[1]).toBe(dir);
    return match[1];
  })
  .sort();

const harnessLabels: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro IDE",
};

const agentNames = readdirSync(at("core", "agents"))
  .filter((name) => /^aidlc-.+-agent\.md$/.test(name))
  .map((name) => basename(name, ".md"))
  .sort();
const reviewerNames = [
  ...new Set(
    filesBelow(at("core", "aidlc-common", "stages"), ".md").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/^reviewer:\s*(aidlc-[a-z-]+-agent)\s*$/gm)].map(
        (match) => match[1],
      ),
    ),
  ),
].sort();
const composerNames: string[] = agentNames.filter((name) => name === "aidlc-composer-agent");
const domainNames = agentNames.filter(
  (name) => !reviewerNames.includes(name) && !composerNames.includes(name),
);

const engineSource = read("core", "tools", "aidlc-orchestrate.ts");
const engineMain = sliceBetween(engineSource, "function main(): void {", "if (import.meta.main)");
const engineCommands = [...engineMain.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);

describe("documentation parity derives current behavior from authored implementation", () => {
  test("event count and user-guide taxonomy match VALID_EVENT_TYPES", () => {
    expect(eventTypes.length).toBe(72);

    const guide = read("docs", "guide", "10-state-and-audit.md");
    const guideTaxonomy = sliceBetween(
      guide,
      `### ${eventTypes.length}-event taxonomy`,
      "### What gets logged and when",
    );
    const guideEvents = [
      ...new Set([...guideTaxonomy.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((match) => match[1])),
    ].sort();
    expect(guideEvents).toEqual(eventTypes);

    for (const path of [
      ["README.md"],
      ["docs", "guide", "00-introduction.md"],
      ["docs", "guide", "glossary.md"],
      ["docs", "guide", "08-knowledge.md"],
      ["docs", "reference", "00-overview.md"],
      ["docs", "reference", "01-architecture.md"],
      ["docs", "reference", "10-knowledge-system.md"],
      ["docs", "reference", "13-runtime-graph.md"],
      ["docs", "reference", "17-skill-system.md"],
    ]) {
      expect(
        read(...path),
        `${path.join("/")} must carry a numeric event-count claim matching the registry`,
      ).toMatch(eventCountClaimPattern(eventTypes.length));
    }

    const staleClaims = [at("README.md"), ...filesBelow(at("docs"), ".md")].flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          eventCountClaims(line)
            .filter((claim) => claim !== eventTypes.length)
            .map((claim) => ({ file, line, index: index + 1, claim })),
        ),
    );
    expect(staleClaims).toEqual([]);
  });

  test("documented harness roster matches every implementation manifest", () => {
    expect(harnessNames).toEqual(["claude", "codex", "kiro", "kiro-ide"]);
    expect(Object.keys(harnessLabels).sort()).toEqual(harnessNames);

    const readmeRoster = sliceBetween(
      read("README.md"),
      "## Pick your harness",
      "## Recommended Model",
    );
    expect(documentedDistNames(readmeRoster)).toEqual(harnessNames);

    const harnessIndex = sliceBetween(
      read("docs", "guide", "harnesses", "README.md"),
      "Pick your harness:",
      "This set is open:",
    );
    const indexLabels = [...harnessIndex.matchAll(/\| \*\*([^*]+)\*\*/g)]
      .map((match) => match[1])
      .sort();
    expect(indexLabels).toEqual(Object.values(harnessLabels).sort());

    const glossaryDistribution = read("docs", "guide", "glossary.md")
      .split("\n")
      .find((line) => line.startsWith("| **Distribution** |"));
    expect(glossaryDistribution).toBeDefined();
    expect(documentedDistNames(glossaryDistribution ?? "")).toEqual(harnessNames);

    const buildModel = sliceBetween(
      read("docs", "harness-engineering", "00-overview.md"),
      "## The build model:",
      "## When you cross into the Developer Reference",
    );
    expect(documentedDistNames(buildModel)).toEqual(harnessNames);

    for (const doc of [
      read("docs", "guide", "glossary.md"),
      read("docs", "reference", "01-architecture.md"),
      read("docs", "reference", "14-claude-features.md"),
    ]) {
      for (const name of harnessNames) expect(doc).toContain(harnessLabels[name]);
    }
  });

  test("Kiro IDE documentation names only IDE-native enforcement and configuration surfaces", () => {
    const skill = read("harness", "kiro-ide", "skills", "aidlc", "SKILL.md");
    const questionRendering = read(
      "harness",
      "kiro-ide",
      "skills",
      "aidlc",
      "question-rendering.md",
    );
    const ideHooks = at("harness", "kiro-ide", "hooks");

    expect(existsSync(join(ideHooks, "aidlc-reviewer-scope.kiro.hook"))).toBe(false);
    expect(skill).toContain("read-scope bound is prose-only on this harness");
    expect(skill).not.toContain(".aidlc-reviewer-dispatch.json");
    expect(skill).not.toContain("kiro-cli");
    expect(questionRendering).toContain("Kiro IDE has no structured-question tool");
    expect(questionRendering).not.toContain("Kiro CLI");

    const primitiveMap = sliceBetween(
      read("docs", "reference", "14-claude-features.md"),
      "| AI-DLC Concept |",
      "\n\nThe deterministic engine",
    );
    const rows = primitiveMap
      .split("\n")
      .filter((line) => line.startsWith("| **"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
    const ideCell = (label: string): string => {
      const row = rows.find((candidate) => candidate[0].startsWith(`**${label}**`));
      if (!row) throw new Error(`missing primitive-map row: ${label}`);
      return row[3];
    };

    expect(ideCell("Agent personas")).toContain("`tools:` grants");
    expect(ideCell("Agent personas")).not.toContain("agent configs");
    expect(ideCell("Standing rules")).toContain("resources glob");
    expect(ideCell("Standing rules")).not.toContain("`rules_in_context`");
    expect(ideCell("Permissions / config")).toContain("`tools:` frontmatter");
    expect(ideCell("Permissions / config")).not.toContain("settings/cli.json");

    const ideAgent = JSON.parse(
      read("harness", "kiro-ide", "agents", "aidlc.json"),
    ) as { resources?: string[] };
    expect(ideAgent.resources).toContain("file://aidlc/spaces/default/memory/**/*.md");
    const includesSource = read("core", "tools", "aidlc-includes.ts");
    expect(includesSource).toContain('if (harness === ".kiro")');
    expect(includesSource).toContain("repointKiroAgentResources");
  });

  test("documented agent roster matches agent files and reviewer frontmatter", () => {
    expect(agentNames.length).toBe(14);
    expect(domainNames.length).toBe(11);
    expect(reviewerNames.length).toBe(2);
    expect(composerNames.length).toBe(1);

    const index = read("docs", "reference", "agents", "README.md");
    const roster = sliceBetween(index, "## The 14 Agents", "## Shared Configuration");
    expect(agentTokens(roster)).toEqual(agentNames);

    for (const doc of [
      read("README.md"),
      read("core", "templates", "onboarding.md"),
      read("docs", "guide", "06-agents.md"),
    ]) {
      expect(doc).toContain(String(agentNames.length));
      expect(doc).toContain(String(domainNames.length));
      expect(doc).toContain(String(reviewerNames.length));
      expect(doc.toLowerCase()).toContain("composer");
    }

    const canonicalSurfaces = [
      ["docs", "guide", "agents", "README.md"],
      ["docs", "reference", "04-stage-protocol.md"],
      ["docs", "reference", "diagrams.md"],
    ];
    const composition =
      `The full ${agentNames.length}-agent roster comprises ` +
      `${domainNames.length} domain agents, ${reviewerNames.length} review-only agents, ` +
      "and the adaptive-workflows composer.";
    for (const path of canonicalSurfaces) {
      expect(
        normalized(read(...path)),
        `${path.join("/")} must distinguish the full roster from its domain-agent view`,
      ).toContain(composition);
    }

    const deepDiveTable = sliceBetween(
      read("docs", "guide", "agents", "README.md"),
      "| # | Agent | Domain |",
      "\n---",
    );
    expect(agentTokens(deepDiveTable)).toEqual(domainNames);

    const protocolDomainRoster = sliceBetween(
      read("docs", "reference", "04-stage-protocol.md"),
      `### The ${domainNames.length} Domain Agents`,
      "\n---",
    );
    expect(agentTokens(protocolDomainRoster)).toEqual(domainNames);

    const diagramSection = sliceBetween(
      read("docs", "reference", "diagrams.md"),
      "## 6. Agent Collaboration Map",
      "## 7. Execution Model",
    );
    const diagram = sliceBetween(diagramSection, "```mermaid", "```");
    expect(agentTokens(diagram)).toEqual(domainNames);
  });

  test("agent tool matrices describe expected use rather than access grants", () => {
    for (const name of agentNames) {
      const source = read("core", "agents", `${name}.md`);
      const frontmatter = sliceBetween(source, "---\n", "\n---");
      expect(frontmatter, `${name} must inherit the session toolset`).not.toMatch(/^tools:/m);
    }

    const index = read("docs", "reference", "agents", "README.md");
    const expectedTools = sliceBetween(
      index,
      "### Tools each persona is expected to exercise",
      "### Agent Tiers",
    );
    const comparison = sliceBetween(
      index,
      "## Agent Comparison Matrix",
      "## Phase Participation",
    );
    const agentSystem = sliceBetween(
      read("docs", "reference", "05-agent-system.md"),
      "## Agent Comparison Matrix",
      "## Phase Participation",
    );
    const hookTools = sliceBetween(
      read("docs", "reference", "06-hooks-and-tools.md"),
      "### Agent Tool Restrictions",
      "## Deterministic Utility Tool",
    );

    expect(index).toContain("every agent inherits the **full session toolset**");
    expect(expectedTools).toContain("not a per-agent grant");
    expect(comparison).toContain("Bash Expected Use");
    expect(comparison).toContain("WebSearch Expected Use");
    expect(comparison).toContain("does not grant or withhold access");
    expect(agentSystem).toContain("Bash Expected Use");
    expect(agentSystem).toContain("WebSearch Expected Use");
    expect(hookTools).toContain("Agents Expected to Exercise It");
    expect(`${expectedTools}\n${comparison}\n${agentSystem}\n${hookTools}`).not.toMatch(
      /\b(?:Bash|WebSearch) access\b/i,
    );
  });

  test("engine docs match the subcommands in aidlc-orchestrate main", () => {
    expect(engineCommands).toEqual(["next", "report", "park"]);
    const expected =
      `exactly ${numberWord(engineCommands.length)} subcommands: ${codeList(engineCommands)}`;

    for (const path of [
      ["core", "templates", "onboarding.md"],
      ["docs", "guide", "glossary.md"],
      ["docs", "harness-engineering", "00-overview.md"],
      ["docs", "reference", "03-orchestrator.md"],
      ["docs", "reference", "11-contributing.md"],
      ["docs", "reference", "17-skill-system.md"],
    ]) {
      expect(
        normalized(read(...path)),
        `${path.join("/")} must list the complete engine command surface`,
      ).toContain(expected);
    }
  });

  test("workspace CLI docs follow the implemented router and keep utility-only verbs direct-only", () => {
    const lib = read("core", "tools", "aidlc-lib.ts");
    const workspaceBlock = sliceBetween(
      lib,
      "export const WORKSPACE_VERBS: ReadonlySet<string> = new Set([",
      "]);",
    );
    const workspaceVerbs = quotedTokens(workspaceBlock, /"([a-z][a-z-]+)"/g);
    expect(workspaceVerbs).toEqual(["intent", "space", "space-create"]);

    const cliGuide = read("docs", "guide", "12-cli-commands.md");
    for (const verb of workspaceVerbs) expect(cliGuide).toContain(`/aidlc ${verb}`);
    const directOnlyVerbs = ["codekb-path", "select-plugins"];
    for (const verb of directOnlyVerbs) {
      expect(workspaceVerbs).not.toContain(verb);
      expect(cliGuide).toContain("direct utility invocation");
      expect(cliGuide).toContain(`not an \`/aidlc ${verb}\` command`);
    }

    const helpTail = sliceBetween(
      read("core", "tools", "aidlc-utility.ts"),
      "const HELP_TEXT_TAIL = `",
      "`;",
    );
    for (const verb of directOnlyVerbs) expect(helpTail).not.toContain(verb);
  });

  test("Codex onboarding fills and rendered output name the emitted agent TOML directory", () => {
    const rendered = renderOnboarding(
      read("core", "templates", "onboarding.md"),
      codexOnboardingFills,
    );
    for (const body of [rendered, read("dist", "codex", "AGENTS.md")]) {
      expect(body).toContain("`.codex/agents/` TOMLs");
      expect(body).not.toContain("transposed into `.agents/` TOMLs");
    }
  });

  test("private package metadata names the multi-harness repository", () => {
    const pkg = JSON.parse(read("package.json")) as {
      name: string;
      description: string;
      repository: { url: string; directory?: string };
    };
    expect(pkg.name).toBe("aidlc-workflows-dev");
    expect(pkg.description).toContain("multi-harness");
    expect(pkg.repository.url).toBe("https://github.com/awslabs/aidlc-workflows");
    expect(pkg.repository.directory).toBeUndefined();
    expect(read("bun.lock")).toContain(`"name": "${pkg.name}"`);
  });
});
