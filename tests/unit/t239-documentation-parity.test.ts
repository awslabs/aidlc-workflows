import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import codexOnboardingFills from "../../harness/codex/onboarding.fills.ts";
import { renderOnboarding } from "../../scripts/onboarding.ts";
import { type Tier, TIER_PROJECTIONS, TIERS } from "../../core/tools/aidlc-tiers.ts";

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

function markdownCells(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function frontmatterScalar(text: string, field: string): string | null {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (frontmatter === undefined) return null;
  const match = new RegExp(`^${field}:\\s*(\\S.*?)\\s*$`, "m").exec(frontmatter);
  return match?.[1] ?? null;
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
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro IDE",
  opencode: "opencode",
};

const agentNames = readdirSync(at("core", "agents"))
  .filter((name) => /^aidlc-.+-agent\.md$/.test(name))
  .map((name) => basename(name, ".md"))
  .sort();
const scopeNames = readdirSync(at("core", "scopes"))
  .filter((name) => /^aidlc-.+\.md$/.test(name))
  .map((name) => name.replace(/^aidlc-/, "").replace(/\.md$/, ""))
  .sort();
const scopeGrid = JSON.parse(
  read("dist", "claude", ".claude", "tools", "data", "scope-grid.json"),
) as Record<string, { stages: Record<string, string> }>;
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
const engineMain = sliceBetween(
  engineSource,
  "export function main(argv: string[]): void {",
  "if (import.meta.main)",
);
const engineCommands = [...engineMain.matchAll(/case "([^"]+)":/g)].map((match) => match[1]);

describe("documentation parity derives current behavior from authored implementation", () => {
  test("event count and user-guide taxonomy match VALID_EVENT_TYPES", () => {
    expect(eventTypes.length).toBe(92);

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

    // The taxonomy's CATEGORY count is a second claim in the same prose, and the
    // event-count regex above does not match a "N categories" phrasing — so it
    // could drift while every other pin stayed green. Derive it three ways and
    // require agreement: the prose number, the number of table rows, and the sum
    // of the per-row counts (which must total the event count).
    const guideCategoryRows = [
      ...guideTaxonomy.matchAll(/^\| \*\*[^*]+\*\* \| +(\d+) \|/gm),
    ].map((match) => Number(match[1]));
    const guideCategoryClaim = guideTaxonomy.match(/organized into (\d+) categories/);
    expect(guideCategoryClaim, "the taxonomy must state its category count").not.toBeNull();
    expect(Number(guideCategoryClaim?.[1])).toBe(guideCategoryRows.length);
    expect(guideCategoryRows.reduce((sum, n) => sum + n, 0)).toBe(eventTypes.length);

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
    expect(harnessNames).toEqual([
      "claude",
      "codex",
      "copilot",
      "cursor",
      "kiro",
      "kiro-ide",
      "opencode",
    ]);
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
    const reviewerProtocol = read(
      "core",
      "aidlc-common",
      "protocols",
      "stage-protocol-reviewer.md",
    );
    const questionRendering = read(
      "harness",
      "kiro-ide",
      "skills",
      "aidlc",
      "question-rendering.md",
    );
    const ideHooks = at("harness", "kiro-ide", "hooks");

    expect(existsSync(join(ideHooks, "aidlc-reviewer-scope.kiro.hook"))).toBe(false);
    expect(existsSync(join(ideHooks, "aidlc-reviewer-scope.json"))).toBe(false);
    expect(skill).toContain("stage-protocol-reviewer.md");
    expect(reviewerProtocol).toContain(
      "On a harness without reviewer-scope enforcement (Kiro IDE today)",
    );
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

    expect(ideCell("Agent personas")).toContain("`tools:`/`permissions.rules`");
    expect(ideCell("Agent personas")).not.toContain("agent configs");
    expect(ideCell("Standing rules")).toContain("always-included steering");
    expect(ideCell("Standing rules")).not.toContain("`rules_in_context`");
    expect(ideCell("Permissions / config")).toContain("`permissions.rules`");
    expect(ideCell("Permissions / config")).not.toContain("settings/cli.json");

    const steering = read(
      "harness",
      "kiro-ide",
      "steering",
      "aidlc-active-memory.md",
    );
    expect(steering).toMatch(/^---\ninclusion: always\n---/);
    expect(steering).toContain(
      "#[[file:aidlc/spaces/default/memory/org.md]]",
    );
    const includesSource = read("core", "tools", "aidlc-includes.ts");
    expect(includesSource).toContain('if (harness === ".kiro")');
    expect(includesSource).toContain("repointKiroSteeringReferences");
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
    expect(engineCommands).toEqual([
      "next",
      "continue",
      "report",
      "park",
      "team-board",
    ]);
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

  test("workflow profiles enumerate every shipped core scope", () => {
    const profiles = read("docs", "guide", "workflow-profiles.md");
    const documented = [...profiles.matchAll(/^## `([a-z][a-z-]+)`$/gm)]
      .map((match) => match[1])
      .sort();
    expect(documented).toEqual(scopeNames);

    const cliGuide = read("docs", "guide", "12-cli-commands.md");
    for (const scope of scopeNames) {
      expect(profiles).toContain(`/aidlc ${scope}`);
      expect(cliGuide).toContain(`/aidlc ${scope}`);
    }

    const quickChooser = sliceBetween(
      profiles,
      "## Quick chooser",
      "Stage counts describe the static route.",
    );
    const rows = quickChooser
      .split("\n")
      .filter((line) => /^\| \*\*/.test(line))
      .map((line) => {
        const cells = markdownCells(line);
        expect(cells.length, line).toBe(6);
        const command = cells[5].match(/^`\/aidlc ([a-z][a-z-]+)`$/);
        expect(command, `invalid quick-chooser command: ${cells[5]}`).not.toBeNull();
        return {
          scope: command![1],
          stages: cells[2],
          depth: cells[3],
          testStrategy: cells[4],
        };
      });
    expect(rows).toHaveLength(scopeNames.length);
    expect([...new Set(rows.map((row) => row.scope))].sort()).toEqual(scopeNames);

    for (const row of rows) {
      const stages = scopeGrid[row.scope]?.stages;
      expect(stages, `missing compiled grid entry for ${row.scope}`).toBeDefined();
      const total = Object.keys(stages).length;
      const executed = Object.values(stages).filter((value) => value === "EXECUTE").length;
      expect(row.stages, `${row.scope} stage count`).toBe(`${executed} / ${total}`);

      const scopeFile = read("core", "scopes", `aidlc-${row.scope}.md`);
      const depth = frontmatterScalar(scopeFile, "depth");
      if (depth === null) {
        throw new Error(`missing depth in core/scopes/aidlc-${row.scope}.md`);
      }
      expect(row.depth, `${row.scope} depth`).toBe(depth);
      expect(row.testStrategy, `${row.scope} test strategy`).toBe(
        frontmatterScalar(scopeFile, "testStrategy") ?? depth,
      );
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
    const directOnlyVerbs = [
      "codekb-path",
      "codekb-snapshot",
      "codekb-publish",
      "codekb-scope-diff",
      "select-plugins",
    ];
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

  test("documented model-pinning tier projections match TIER_PROJECTIONS", () => {
    // The authored table is the single source of truth; every prose copy of it
    // is derived here rather than trusted. The cell convention is shared by
    // both surfaces: `model: <m>` then either a pinned effort or the explicit
    // statement that the key is absent.
    const claudeCell = (tier: Tier): string => {
      const { model, effort } = TIER_PROJECTIONS[tier].claude;
      return effort === null
        ? `\`model: ${model}\`, no \`effort:\` line`
        : `\`model: ${model}\`, \`effort: ${effort}\``;
    };
    const codexCell = (tier: Tier): string => {
      const { model, effort } = TIER_PROJECTIONS[tier].codex;
      return model === null && effort === null
        ? "no `model`/`model_reasoning_effort` keys"
        : `\`model = "${model}"\`, \`model_reasoning_effort = "${effort}"\``;
    };
    const opencodeCell = (tier: Tier): string => {
      const { model, variant } = TIER_PROJECTIONS[tier].opencode;
      return model === null && variant === null
        ? "no `model:`/`variant:` keys"
        : `\`model: ${model}\`, \`variant: ${variant}\``;
    };

    const agentSystemTable = sliceBetween(
      read("docs", "reference", "05-agent-system.md"),
      "| Tier | Claude Code (.md frontmatter) |",
      "Key facts behind the table:",
    );
    const claudeSurfaces: [string, string][] = [
      [
        "docs/reference/05-agent-system.md",
        agentSystemTable,
      ],
      [
        "docs/reference/14-claude-features.md",
        sliceBetween(
          read("docs", "reference", "14-claude-features.md"),
          "| Tier | Agents | Claude Code projection | Rationale |",
          "An omitted `effort:` key",
        ),
      ],
    ];

    for (const tier of TIERS) {
      for (const [label, table] of claudeSurfaces) {
        const row = table.split("\n").find((line) => line.startsWith(`| \`${tier}\``));
        expect(row, `${label} must carry a row for the ${tier} tier`).toBeDefined();
        expect(
          normalized(row as string),
          `${label} must state the shipped Claude projection for ${tier}`,
        ).toContain(normalized(claudeCell(tier)));
      }

      const agentSystemRow = agentSystemTable
        .split("\n")
        .find((line) => line.startsWith(`| \`${tier}\``));
      expect(agentSystemRow, `agent-system must carry a row for the ${tier} tier`).toBeDefined();
      const cells = markdownCells(agentSystemRow as string);
      expect(
        normalized(cells[2]),
        `agent-system must state the shipped Codex projection for ${tier}`,
      ).toContain(normalized(codexCell(tier)));
      expect(
        normalized(cells[5]),
        `agent-system must state the shipped opencode projection for ${tier}`,
      ).toContain(normalized(opencodeCell(tier)));
    }

    // Effort-stepping claims. `judgment` is the only tier that inherits the
    // session effort; any doc calling a single tier the only downgrade is wrong
    // the moment a second tier pins one.
    const pinned = TIERS.filter((tier) => TIER_PROJECTIONS[tier].claude.effort !== null);
    expect(pinned.length, "expected at least one tier to pin a Claude effort").toBeGreaterThan(0);
    if (pinned.length > 1) {
      const narrativePaths = [
        ["core", "tools", "aidlc-tiers.ts"],
        ["docs", "guide", "13-customization.md"],
        ["docs", "harness-engineering", "03-adding-an-agent.md"],
        ["docs", "reference", "05-agent-system.md"],
        ["docs", "reference", "14-claude-features.md"],
        ["docs", "reference", "agents", "README.md"],
        ["harness", "codex", "emit.ts"],
        ["scripts", "package.ts"],
        ["tests", "unit", "t216-agent-tier-projection.test.ts"],
      ];
      for (const path of narrativePaths) {
        const text = normalized(read(...path));
        for (const claim of [
          "a mid-size model, session effort",
          "only for templated work",
          "the one deliberate downgrade",
          "the one tier that steps effort down",
          "absence is the contract for judgment and balanced",
          "absence is deliberate for the first two tiers",
          "templated agents additionally reduce effort",
          "balanced -> `model: sonnet` with no effort pin",
          "mid-size model at session effort suffices",
          "balanced pins a model but inherits effort",
          "inherit contract for judgment/balanced agents",
          "effort: is pinned for templated agents and ABSENT everywhere else",
        ]) {
          expect(
            text,
            `${path.join("/")} must not claim a single stepped-down tier while ${codeList([...pinned])} all pin an effort`,
          ).not.toContain(claim);
        }
      }
    }

    // Two tier names that project identically must say so, or a reader infers
    // two rungs where the shipped projection has one.
    const sortDeep = (value: unknown): unknown =>
      value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as object)
              .sort()
              .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
          )
        : value;
    const identical =
      JSON.stringify(sortDeep(TIER_PROJECTIONS.balanced)) ===
      JSON.stringify(sortDeep(TIER_PROJECTIONS.templated));
    const agentSystem = normalized(read("docs", "reference", "05-agent-system.md"));
    const equivalenceNote = "`balanced` and `templated` currently project IDENTICALLY in every harness";
    if (identical) {
      expect(
        agentSystem,
        "balanced and templated project identically, so the reference must say so",
      ).toContain(normalized(equivalenceNote));
    } else {
      expect(
        agentSystem,
        "balanced and templated no longer project identically, so the equivalence note must go",
      ).not.toContain(normalized(equivalenceNote));
    }
  });

  test("documented agent stage-involvement matrix matches stage frontmatter", () => {
    const lead = new Map<string, number>();
    const support = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string): void => {
      map.set(key, (map.get(key) ?? 0) + 1);
    };

    for (const path of filesBelow(at("core", "aidlc-common", "stages"), ".md")) {
      const frontmatter = sliceBetween(readFileSync(path, "utf8"), "---", "\n---");
      const leadAgent = frontmatter.match(/^lead_agent:\s*(\S+)$/m)?.[1];
      if (leadAgent?.startsWith("aidlc-")) bump(lead, leadAgent);
      const block = frontmatter.match(/^support_agents:\s*\n((?:[ \t]*-[ \t]*\S+[ \t]*\n?)+)/m)?.[1];
      for (const entry of block?.split("\n") ?? []) {
        const agent = entry.replace(/^[ \t]*-[ \t]*/, "").trim();
        if (agent.startsWith("aidlc-")) bump(support, agent);
      }
    }
    expect(lead.size, "expected lead_agent frontmatter on the stage set").toBeGreaterThan(0);

    const matrixPaths = [
      ["docs", "reference", "05-agent-system.md"],
      ["docs", "reference", "agents", "README.md"],
    ];
    const matrices = matrixPaths.map((path) => {
      const matrix = sliceBetween(
        read(...path),
        "| Agent | Bash Expected Use | WebSearch Expected Use | Tier | Lead Stages | Support Stages |",
        "**Observations:**",
      );
      const rows = matrix
        .split("\n")
        .map((line) => line.split("|").map((cell) => cell.trim()))
        .filter((cells) => cells[1]?.startsWith("aidlc-"));
      expect(rows.length, `${path.join("/")} must have one row per domain-expert agent`).toBe(11);
      return { path, rows };
    });

    for (const { path, rows } of matrices) {
      for (const cells of rows) {
        const agent = cells[1];
        const expectedLead = lead.get(agent) ?? 0;
        const expectedSupport = support.get(agent) ?? 0;
        expect(
          [Number(cells[5]), Number(cells[6]), Number(cells[7])],
          `${path.join("/")} ${agent} matrix row`,
        ).toEqual([expectedLead, expectedSupport, expectedLead + expectedSupport]);
      }
    }

    // The "broadest involvement" observation is a claim about the same numbers,
    // and it drifted independently of the table it summarises.
    const totals = matrices[0].rows.map((cells) => ({
      agent: cells[1],
      total: Number(cells[7]),
    }));
    const broadestTotal = Math.max(...totals.map((row) => row.total));
    const broadest = totals.filter((row) => row.total === broadestTotal);
    for (const path of matrixPaths) {
      const observations = sliceBetween(read(...path), "**Observations:**", "\n---");
      expect(
        broadest.some((row) =>
          normalized(observations).includes(
            `${row.agent} has the broadest stage involvement (${row.total} stages`,
          ),
        ),
        `${path.join("/")} must name a broadest agent with ${broadestTotal} stages`,
      ).toBe(true);
    }
    const agentGuide = normalized(read("docs", "guide", "06-agents.md"));
    expect(
      broadest.some(
        (row) =>
          agentGuide.includes(row.agent) &&
          agentGuide.includes(`(${row.total} stages across 3 phases)`),
      ),
      `the guide must name a broadest agent with ${broadestTotal} stages`,
    ).toBe(true);
  });
});
