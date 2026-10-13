// covers: file:scripts/agent-knowledge.ts, file:core/tools/aidlc-plugin-emit.ts, file:core/tools/aidlc-inline-context.ts, file:scripts/package.ts
//
// A dispatched agent reads the shared methodology, not the format docs the
// engine writes (SHIPPED_FORMAT_DOCS). The conductor's own roster already
// leaves them out; a dispatched Code Generation agent still read all of
// aidlc-shared, about 129 KB of format references it never used, carried on
// every call it made after. Each place that needs one names it by path.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { SHIPPED_FORMAT_DOCS } from "../../core/tools/aidlc-inline-context.ts";

const REPO = join(import.meta.dir, "..", "..");
const DIST = join(REPO, "dist");
const MARKER = "<!-- aidlc-delegated-knowledge-preflight -->";
const HARNESSES = ["claude", "codex", "copilot", "cursor", "kiro", "kiro-ide", "opencode"] as const;

// Every packaged agent file (personas and plugin agents) under an agents folder.
function agentFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "tools" || entry === "hooks" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) agentFiles(path, out);
    else if (basename(dirname(path)) === "agents" && /\.(md|toml)$/.test(entry)) out.push(path);
  }
  return out;
}

function preflightLine(text: string): string | null {
  const at = text.indexOf(`${MARKER}\n`);
  if (at < 0) return null;
  const start = at + MARKER.length + 1;
  const end = text.indexOf("\n", start);
  return text.slice(start, end < 0 ? undefined : end);
}

describe("a dispatched agent's knowledge preflight leaves out the format docs", () => {
  const lines = agentFiles(DIST)
    .map((file) => ({ file, line: preflightLine(readFileSync(file, "utf-8").replace(/\r\n/g, "\n")) }))
    .filter((entry): entry is { file: string; line: string } => entry.line !== null);

  test("every harness ships agents with the preflight, plugin agents included", () => {
    for (const harness of HARNESSES) {
      expect(
        lines.some(({ file }) => file.startsWith(join(DIST, harness) + sep)),
        `${harness}: no packaged agent carries the preflight`,
      ).toBe(true);
    }
    expect(lines.some(({ file }) => file.startsWith(join(DIST, "plugins") + sep))).toBe(true);
  });

  test("the shared folder it names comes without the five format docs", () => {
    for (const { file, line } of lines) {
      for (const doc of SHIPPED_FORMAT_DOCS) {
        expect(line, `${file.slice(DIST.length + 1)} still reads ${doc}`).toContain(`all but its format references`);
        expect(line, `${file.slice(DIST.length + 1)} does not name ${doc} as left out`).toContain(`\`${doc}\``);
      }
    }
  });
});

describe("a dispatched Kiro CLI agent preloads only the shared methodology files", () => {
  const agentsDir = join(DIST, "kiro", ".kiro", "agents");
  const sharedDir = join(DIST, "kiro", ".kiro", "knowledge", "aidlc-shared");
  const methodology = readdirSync(sharedDir)
    .filter((file) => file.endsWith(".md") && !SHIPPED_FORMAT_DOCS.has(file))
    .sort()
    .map((file) => `file://.kiro/knowledge/aidlc-shared/${file}`);

  test("the shared folder still has methodology files to preload", () => {
    expect(methodology.length).toBeGreaterThan(0);
  });

  test("each agent JSON lists exactly the shared folder minus the format docs", () => {
    const jsons = readdirSync(agentsDir).filter((file) => file.endsWith("-agent.json"));
    expect(jsons.length).toBe(14);
    for (const file of jsons) {
      const resources = (JSON.parse(readFileSync(join(agentsDir, file), "utf-8")).resources ?? []) as string[];
      const shared = resources.filter((entry) => entry.includes("/knowledge/aidlc-shared/"));
      expect(shared, `${file} preloads ${shared.join(", ")}`).toEqual(methodology);
    }
  });
});
