// covers: function:shippedInlineContextEntries, function:personaTwinRels, file:scripts/package.ts
//
// On Kiro IDE a persona's agent file opens with about 32 KB of tool permissions
// (the manifest's frontmatterAdditions): Kiro needs them to dispatch the agent,
// the lead reading the persona in its own chat does not. A measured Kiro run
// read all 700 permission lines of the product persona in four parts before the
// first question. The persona without them ships beside the agents, the inline
// roster names that copy, and a plugin's persona fragment reaches it as a twin.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphStage } from "../../core/tools/aidlc-graph.ts";
import { inlineAgentsFor, shippedInlineContextEntries } from "../../core/tools/aidlc-inline-context.ts";
import { personaTwinRels } from "../../core/tools/aidlc-plugin.ts";

const REPO = join(import.meta.dir, "..", "..");
const DIST = join(REPO, "dist");
const KIRO_IDE = join(DIST, "kiro-ide", ".kiro");
const BODIES = join(KIRO_IDE, "aidlc-common", "personas");

function split(raw: string): { frontmatter: string; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const match = text.match(/^---\n[\s\S]*?\n---\n/);
  return match ? { frontmatter: match[0], body: text.slice(match[0].length) } : { frontmatter: "", body: text };
}

function graph(): GraphStage[] {
  return JSON.parse(readFileSync(join(KIRO_IDE, "tools", "data", "stage-graph.json"), "utf-8")) as GraphStage[];
}

function stage(slug: string): GraphStage {
  const node = graph().find((entry) => entry.slug === slug);
  if (!node) throw new Error(`no ${slug} in the Kiro IDE graph`);
  return node;
}

describe("the Kiro IDE lead reads the persona without its tool permissions", () => {
  const personas = readdirSync(join(KIRO_IDE, "agents")).filter((file) =>
    file.endsWith("-agent.md") && /^permissions:/m.test(split(readFileSync(join(KIRO_IDE, "agents", file), "utf-8")).frontmatter)
  );

  test("exactly the personas a stage reads inline ship their body beside the agents", () => {
    // The composer and the two reviewers are only ever dispatched: no copy.
    const inline = new Set(graph().flatMap((node) => inlineAgentsFor(node)));
    expect(personas.length).toBeGreaterThan(10);
    expect(readdirSync(BODIES).sort()).toEqual(personas.filter((file) => inline.has(file.replace(/\.md$/, ""))).sort());
    for (const file of readdirSync(BODIES)) {
      const copy = join(BODIES, file);
      expect(existsSync(copy), `${file}: no persona copy`).toBe(true);
      const agent = split(readFileSync(join(KIRO_IDE, "agents", file), "utf-8"));
      const body = split(readFileSync(copy, "utf-8"));
      expect(body.body, `${file}: the copy's persona differs from the agent's`).toBe(agent.body);
      expect(body.frontmatter, `${file}: the copy still carries the permissions`).not.toMatch(/^permissions:/m);
    }
  });

  test("no other harness ships a persona copy", () => {
    for (const harness of ["claude", "codex", "copilot", "cursor", "kiro", "opencode"]) {
      for (const leaf of [".claude", ".codex", ".aidlc", ".cursor", ".kiro"]) {
        expect(existsSync(join(DIST, harness, leaf, "aidlc-common", "personas")), `${harness}/${leaf}`).toBe(false);
      }
    }
  });

  test("the Kiro IDE inline roster names the copy; other trees keep the agent file", () => {
    const node = stage("requirements-analysis");
    const lead = node.lead_agent;
    const ide = shippedInlineContextEntries(node, KIRO_IDE, ".kiro").map((entry) => entry.rel);
    expect(ide).toContain(`.kiro/aidlc-common/personas/${lead}.md`);
    expect(ide).not.toContain(`.kiro/agents/${lead}.md`);
    const cli = shippedInlineContextEntries(node, join(DIST, "kiro", ".kiro"), ".kiro").map((entry) => entry.rel);
    expect(cli).toContain(`.kiro/agents/${lead}.md`);
    const claude = shippedInlineContextEntries(node, join(DIST, "claude", ".claude"), ".claude").map((entry) => entry.rel);
    expect(claude).toContain(`.claude/agents/${lead}.md`);
  });

  test("the copy is a persona twin on Kiro IDE only", () => {
    expect(personaTwinRels("kiro-ide", ".kiro", "aidlc-quality-agent")).toEqual([
      ".kiro/aidlc-common/personas/aidlc-quality-agent.md",
    ]);
    expect(personaTwinRels("kiro", ".kiro", "aidlc-quality-agent")).toEqual([]);
  });

  // A lead told the inline persona loads from the agent file reads the 32 KB
  // file as well, and the saving goes: the Kiro IDE tree says to read the file
  // the roster names.
  test("the Kiro IDE skill never sends the lead to the agent file, and the ensemble binding sends it to the roster's persona file", () => {
    const skill = readFileSync(join(KIRO_IDE, "skills", "aidlc", "SKILL.md"), "utf-8");
    const ensemble = readFileSync(join(KIRO_IDE, "aidlc-common", "protocols", "stage-protocol-ensemble.md"), "utf-8");
    expect(skill).not.toContain("personas load inline from `.kiro/agents/");
    expect(ensemble).not.toContain("persona framing loaded from its `.md` file under `.kiro/agents/`");
    // The skill leaves the persona to the step, which carries it.
    expect(ensemble).toContain("with the lead agent's persona the step carries in `directive.lead_persona`");
  });
});
