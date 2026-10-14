// covers: file:scripts/package.ts
// covers: file:scripts/harness-bindings.ts
// covers: file:aidlc-common/protocols/stage-protocol-construction.md
// covers: file:aidlc-common/protocols/stage-protocol-ensemble.md
// covers: file:aidlc-common/protocols/stage-protocol-reviewer.md
// covers: file:aidlc-common/protocols/stage-protocol-swarm.md
//
// The construction, topology, reviewer and swarm modules each carry one
// binding subsection per tool. A tool reads only its own, so each shipped tree
// carries only its own: the agent no longer reads six other tools' text every
// time it loads a module. The authored source keeps all seven, and nothing
// outside the bindings changes.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const TREES: ReadonlyArray<readonly [string, string, string]> = [
  ["claude", ".claude", "Claude Code"],
  ["kiro", ".kiro", "Kiro CLI"],
  ["kiro-ide", ".kiro", "Kiro IDE"],
  ["codex", ".codex", "Codex CLI"],
  ["cursor", ".cursor", "Cursor"],
  ["opencode", ".aidlc", "opencode"],
  ["copilot", ".aidlc", "GitHub Copilot"],
  ["devin", ".devin", "Devin CLI"],
];
const TOOLS = TREES.map(([, , heading]) => heading);
const MODULES = [
  "stage-protocol-construction.md",
  "stage-protocol-ensemble.md",
  "stage-protocol-reviewer.md",
  "stage-protocol-swarm.md",
] as const;

function headings(text: string): string[] {
  const found: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (match) found.push(match[1]);
  }
  return found;
}

function shippedRoots(): string[] {
  return ["dist", "dist-release"].filter((root) => existsSync(join(REPO_ROOT, root, "claude")));
}

describe("t-own-harness-bindings", () => {
  test("the authored modules keep every tool's binding subsection", () => {
    for (const module of MODULES) {
      const core = headings(readFileSync(join(REPO_ROOT, "core", "aidlc-common", "protocols", module), "utf-8"));
      for (const tool of TOOLS) {
        expect(core.filter((h) => h === tool), `${module}: ${tool}`).toHaveLength(1);
      }
    }
  });

  test("each shipped tree carries only its own tool's binding subsection, and every other heading", () => {
    expect(shippedRoots()).toContain("dist");
    const wrong: string[] = [];
    for (const root of shippedRoots()) {
      for (const [tree, dir, own] of TREES) {
        for (const module of MODULES) {
          const corePath = join(REPO_ROOT, "core", "aidlc-common", "protocols", module);
          const shippedPath = join(REPO_ROOT, root, tree, dir, "aidlc-common", "protocols", module);
          const shipped = headings(readFileSync(shippedPath, "utf-8"));
          const tools = shipped.filter((h) => TOOLS.includes(h));
          if (tools.length !== 1 || tools[0] !== own) {
            wrong.push(`${root}/${tree} ${module}: binding headings ${JSON.stringify(tools)}`);
          }
          const others = (list: string[]) => list.filter((h) => !TOOLS.includes(h));
          const coreOthers = others(headings(readFileSync(corePath, "utf-8")));
          if (JSON.stringify(others(shipped)) !== JSON.stringify(coreOthers)) {
            wrong.push(`${root}/${tree} ${module}: a heading outside the bindings changed`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("a tree's own subsection ships whole", () => {
    // Every line of a tool's authored subsection ships; only token lines differ.
    const section = (text: string, own: string) => {
      const from = text.indexOf(`### ${own}\n`);
      const rest = text.slice(from + 1).search(/\n#{2,3} /);
      // Trailing blank lines differ only by where the section ends (a heading or the file end).
      return text.slice(from, rest === -1 ? undefined : from + 1 + rest).trimEnd().split("\n");
    };
    const differ: string[] = [];
    for (const [tree, dir, own] of TREES) {
      for (const module of MODULES) {
        const core = section(readFileSync(join(REPO_ROOT, "core", "aidlc-common", "protocols", module), "utf-8"), own);
        const shipped = section(
          readFileSync(join(REPO_ROOT, "dist", tree, dir, "aidlc-common", "protocols", module), "utf-8"),
          own,
        );
        if (shipped.length !== core.length) {
          differ.push(`${tree} ${module}: ${shipped.length} lines shipped, ${core.length} authored`);
          continue;
        }
        core.forEach((line, i) => {
          if (!line.includes("{{") && line !== shipped[i]) differ.push(`${tree} ${module} line ${i + 1}`);
        });
      }
    }
    expect(differ).toEqual([]);
  });

  test("the filter keeps fenced text, nested headings and the text after the run", async () => {
    const { keepOwnHarnessBindings } = await import("../../scripts/harness-bindings.ts");
    const run = TOOLS.map((tool) => `### ${tool}\n\n${tool} body.\n\n#### ${tool} detail\n\nmore ${tool}.\n`).join("\n");
    const source = [
      "# Module",
      "",
      "```bash",
      "### Cursor",
      "```",
      "",
      "## Bindings",
      "",
      run,
      "### After the run",
      "",
      "Shared text.",
      "",
    ].join("\n");
    const kiro = keepOwnHarnessBindings(source, "kiro", "fixture.md");
    expect(kiro).toContain("```bash\n### Cursor\n```");
    expect(kiro).toContain("### Kiro CLI\n\nKiro CLI body.\n\n#### Kiro CLI detail\n\nmore Kiro CLI.\n");
    expect(kiro).not.toContain("Claude Code body.");
    expect(kiro).not.toContain("#### Kiro IDE detail");
    expect(kiro).toContain("### After the run\n\nShared text.\n");
    expect(keepOwnHarnessBindings("# No bindings\n\ntext\n", "codex", "plain.md")).toBe("# No bindings\n\ntext\n");
  });

  test("a CRLF checkout cuts the same subsections and keeps its line endings", async () => {
    const { keepOwnHarnessBindings } = await import("../../scripts/harness-bindings.ts");
    const run = TOOLS.map((tool) => `### ${tool}\n\n${tool} body.\n`).join("\n");
    const lf = `# Module\n\n\`\`\`bash\n### Cursor\n\`\`\`\n\n## Bindings\n\n${run}\n### After\n\nShared.\n`;
    const crlf = lf.replaceAll("\n", "\r\n");
    for (const harness of ["claude", "kiro-ide", "copilot"]) {
      const cut = keepOwnHarnessBindings(crlf, harness, "crlf.md");
      expect(cut).toBe(keepOwnHarnessBindings(lf, harness, "lf.md").replaceAll("\n", "\r\n"));
      expect(cut).not.toMatch(/(^|[^\r])\n/);
    }
    // A Windows clone of an authored module cuts exactly as the LF source does.
    const module = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "protocols", "stage-protocol-swarm.md"), "utf-8");
    expect(keepOwnHarnessBindings(module.replaceAll("\n", "\r\n"), "codex", "swarm.md"))
      .toBe(keepOwnHarnessBindings(module, "codex", "swarm.md").replaceAll("\n", "\r\n"));
  });

  test("a binding run that is missing a tool fails the build", async () => {
    const { keepOwnHarnessBindings } = await import("../../scripts/harness-bindings.ts");
    const partial = TOOLS.slice(0, 6).map((tool) => `### ${tool}\n\n${tool} body.\n`).join("\n");
    expect(() => keepOwnHarnessBindings(`## Bindings\n\n${partial}`, "claude", "partial.md"))
      .toThrow("missing GitHub Copilot");
    expect(() => keepOwnHarnessBindings("### Cursor\n\nalone\n\n### Next\n", "cursor", "lone.md"))
      .toThrow("a binding run must name each tool once");
    // A harness being ported, with no heading registered yet, keeps every subsection.
    const full = `## Bindings\n\n${TOOLS.map((tool) => `### ${tool}\n\n${tool} body.\n`).join("\n")}`;
    expect(keepOwnHarnessBindings(full, "foo", "port.md")).toBe(full);
  });
});
