// covers: file:harness/kiro/manifest.ts, file:harness/kiro-ide/manifest.ts, file:scripts/package.ts
//
// Kiro CLI's 3.0 engine loads each persona's prompt .md beside its agent JSON
// as an agent of the same name, and a dispatch runs that one (#1394): with no
// tools line the reviewer had only disclose_context, report_progress,
// subagent_response and user_input, and wrote no review. The `kiro` row's
// persona .md carries the `kiro-ide` row's tools and MCP lines and not its
// permissions: on v2 the JSON still decides, and the .md is only its prompt.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "..", "dist");
const KIRO = join(DIST, "kiro", ".kiro", "agents");
const KIRO_IDE = join(DIST, "kiro-ide", ".kiro", "agents");

const frontmatter = (path: string): string =>
  /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(path, "utf-8"))?.[1] ?? "";
const toolsOf = (path: string): string | undefined => /^tools:\s*(.+)$/m.exec(frontmatter(path))?.[1];

describe("Kiro CLI's persona agents carry their tools on the 3.0 engine", () => {
  const personas = readdirSync(KIRO)
    .filter((file) => /^aidlc-.+-agent\.json$/.test(file))
    .map((file) => file.replace(/\.json$/, ".md"))
    .sort();

  test("every persona with an agent JSON declares the Kiro IDE row's tools in its .md", () => {
    expect(personas.length).toBe(14);
    for (const file of personas) {
      expect(toolsOf(join(KIRO_IDE, file)), `kiro-ide ${file}`).toBe(`["read", "write", "shell"]`);
      expect(toolsOf(join(KIRO, file)), `kiro ${file}`).toBe(toolsOf(join(KIRO_IDE, file)));
    }
  });

  // Kiro CLI's 3.0 engine and Kiro IDE give an agent whose frontmatter sets
  // includeMcpJson every server in the person's mcp.json files; without it a
  // dispatched persona had none of them.
  test("every persona .md on both rows opts into the person's MCP servers", () => {
    for (const file of personas) {
      expect(frontmatter(join(KIRO_IDE, file)), `kiro-ide ${file}`).toMatch(/^includeMcpJson: true$/m);
      expect(frontmatter(join(KIRO, file)), `kiro ${file}`).toMatch(/^includeMcpJson: true$/m);
    }
  });

  // The Kiro IDE row's own lead (Kiro IDE, and Kiro CLI on the v3 engine it
  // pins) opts in the same way, so the chat the person types into has them too.
  test("the kiro-ide row's lead opts into the person's MCP servers", () => {
    expect(frontmatter(join(KIRO_IDE, "aidlc-aidlc.md"))).toMatch(/^includeMcpJson: true$/m);
  });

  test("the kiro row's persona .md takes the tools line without the Kiro IDE row's permissions", () => {
    for (const file of personas) {
      expect(frontmatter(join(KIRO_IDE, file)), `kiro-ide ${file}`).toMatch(/^permissions:/m);
      expect(frontmatter(join(KIRO, file)), `kiro ${file}`).not.toMatch(/^permissions:/m);
    }
  });
});
