// t148-kiro-file-structure: structural smoke for the dist/kiro harness tree.
//
// covers: file:settings.json
//
// Mirrors t01's pattern for the Kiro shell: the SHIPPED dist/kiro tree has
// the right shape — core dirs present and populated, authored shell files
// present, agent configs are valid JSON with the load-bearing fields the
// design pinned (allowedCommands-only shell grant per findings 0.9b; no
// subagent tool on delegation targets; chat.defaultAgent activation; hooks
// registered through the adapter). Pure fs reads — no spawn, no LLM.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_MATRIX,
  manifestGrantsIdeAgentTools,
} from "../harness/harness-matrix.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KIRO = join(REPO_ROOT, "dist", "kiro");
const K = join(KIRO, ".kiro");

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

interface StageNode {
  mode?: string;
  lead_agent?: string;
  support_agents?: string[];
  reviewer?: string;
}

function dispatchedSpaceWriters(harness: "kiro" | "kiro-ide"): string[] {
  const graph = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "dist", harness, ".kiro", "tools", "data", "stage-graph.json"),
      "utf-8",
    ),
  ) as StageNode[];
  return [...new Set(
    graph
      .flatMap((stage) => [
        ...(stage.mode !== "inline"
          ? [stage.lead_agent, ...(stage.support_agents ?? [])]
          : []),
        stage.reviewer,
      ])
      .filter((agent): agent is string => typeof agent === "string"),
  )].sort();
}

describe("t148 dist/kiro file structure", () => {
  test("core dirs exist and are populated", () => {
    for (const [dir, min] of [
      ["tools", 20],
      ["aidlc-common/stages", 5],
      ["knowledge", 5],
      ["sensors", 4],
      ["scopes", 9],
      ["agents", 11],
      ["hooks", 10],
    ] as Array<[string, number]>) {
      const p = join(K, dir);
      expect(existsSync(p)).toBe(true);
      expect(readdirSync(p).length).toBeGreaterThanOrEqual(min);
    }
  });

  test("ships the method ('memory') tree at the workspace root aidlc/spaces/default/memory/", () => {
    // The AIDLC method relocated OUT of the harness dir (the old .kiro/steering/
    // rule layers) to the workspace root under aidlc/spaces/default/memory/ — one
    // hand-editable source of truth, identical on every harness, read by Kiro via
    // the agent JSON `resources` globs (file://aidlc/spaces/default/memory/**/*.md).
    // It sits beside .kiro/, so resolve from KIRO, not K.
    const mem = (...parts: string[]) =>
      join(KIRO, "aidlc", "spaces", "default", "memory", ...parts);
    for (const f of ["org.md", "team.md", "project.md"]) {
      expect(existsSync(mem(f))).toBe(true);
    }
    for (const p of ["ideation", "inception", "construction", "operation"]) {
      expect(existsSync(mem("phases", `${p}.md`))).toBe(true);
    }
    // The old in-harness rules dir must NOT ship (the relocation is complete).
    expect(existsSync(join(K, "steering"))).toBe(false);
  });

  test("authored shell files present", () => {
    for (const f of [
      "skills/aidlc/SKILL.md",
      "skills/aidlc/question-rendering.md",
      "hooks/aidlc-kiro-adapter.ts",
      "agents/aidlc.json",
      "agents/aidlc-developer-agent.json",
      "agents/aidlc-architect-agent.json",
      "settings/cli.json",
    ]) {
      expect(existsSync(join(K, f))).toBe(true);
    }
    expect(existsSync(join(KIRO, "AGENTS.md"))).toBe(true);
  });

  test("conductor agent: allowedCommands-only shell grant (findings 0.9b)", () => {
    const a = readJson(join(K, "agents", "aidlc.json"));
    const allowed = (a.allowedTools as string[]) ?? [];
    expect(allowed).not.toContain("execute_bash"); // never blanket shell trust
    const ts = a.toolsSettings as Record<string, { allowedCommands?: string[] }>;
    const cmds = ts.execute_bash?.allowedCommands ?? [];
    expect(cmds.some((c) => c.includes(".kiro/tools/"))).toBe(true);
  });

  test("delegation targets cannot nest (no subagent tool)", () => {
    for (const f of ["aidlc-developer-agent.json", "aidlc-architect-agent.json"]) {
      const a = readJson(join(K, "agents", f));
      expect((a.tools as string[]) ?? []).not.toContain("subagent");
    }
  });

  test("IDE-agent capability ignores unrelated frontmatter additions", () => {
    expect(
      manifestGrantsIdeAgentTools({
        frontmatterAdditions: [
          { file: "agents/aidlc-example-agent.md", lines: ["badge: example"] },
          { file: "skills/aidlc/SKILL.md", lines: [`tools: ["read"]`] },
        ],
      }),
    ).toBe(false);
    expect(
      manifestGrantsIdeAgentTools({
        frontmatterAdditions: [
          { file: "agents/aidlc-example-agent.md", lines: [`tools: ["read"]`] },
        ],
      }),
    ).toBe(true);
  });

  test("every dispatched graph writer has a space-scoped write grant on Kiro CLI (JSON) and IDE (md permissions)", () => {
    // Kiro CLI expresses the write grant in the agent-v1 JSON (tools +
    // toolsSettings.allowedPaths); Kiro IDE expresses it in the agent .md
    // frontmatter (tools: + permissions.rules), since the IDE ships no agent
    // JSON. Both must scope every dispatched writer to aidlc/spaces/**.
    const cliDir = join(REPO_ROOT, "dist", "kiro", ".kiro", "agents");
    const cliWriters = dispatchedSpaceWriters("kiro");
    expect(cliWriters.length).toBeGreaterThan(0);
    for (const agent of cliWriters) {
      const config = readJson(join(cliDir, `${agent}.json`));
      expect(config.tools as string[]).toContain("fs_write");
      const settings = config.toolsSettings as Record<string, { allowedPaths?: string[] }>;
      expect(settings.fs_write?.allowedPaths).toContain("aidlc/spaces/**");
    }
    const ideDir = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents");
    const ideWriters = dispatchedSpaceWriters("kiro-ide");
    expect(ideWriters.length).toBeGreaterThan(0);
    for (const agent of ideWriters) {
      const md = readFileSync(join(ideDir, `${agent}.md`), "utf-8");
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "";
      // tools: grants write; permissions.rules scopes filesystem to the space
      // (the composer additionally reaches the scope grid, so match the shared
      // space path every writer carries).
      expect(fm).toContain(`"write"`);
      expect(fm).toContain(`"aidlc/spaces/**"`);
    }
  });

  test("Kiro IDE ships NO agent JSON — agents resolve from Markdown only (#555 §1)", () => {
    // The IDE reads agents from .md frontmatter, not the CLI's agent-v1 JSON.
    // The kiro-ide tree therefore ships zero agent .json (persona or conductor);
    // the CLI tree keeps its full JSON roster. This is the §1 shape.
    const ideDir = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents");
    expect(readdirSync(ideDir).filter((n) => n.endsWith(".json"))).toEqual([]);
    // The conductor ships as an authored aidlc.md (IDE selector entry).
    expect(existsSync(join(ideDir, "aidlc.md"))).toBe(true);
    // The CLI tree is unaffected — its JSON roster still ships.
    const cliDir = join(REPO_ROOT, "dist", "kiro", ".kiro", "agents");
    expect(readdirSync(cliDir).filter((n) => n.endsWith(".json")).length).toBeGreaterThanOrEqual(14);
  });

  test("IDE-native tools: frontmatter grant on delegation targets - kiro-ide ONLY", () => {
    // The Kiro IDE resolves a delegated subagent's tools from the agent .md
    // frontmatter, not from the agent-v1 JSON the CLI reads (field-proven:
    // a dispatched composer without the grant ran toolless). The kiro-ide
    // manifest injects the grant during projection; it must land on every
    // delegation target there and must NOT leak into any other harness's
    // agents (on Claude a `tools:` frontmatter field would RESTRICT the
    // agent to non-Claude tool names, breaking it).
    const IDE_AGENTS = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "agents");
    // The IDE tree ships no agent JSON, so derive the delegation-target roster
    // from the CLI (kiro) JSONs — the same hand-authored set (minus the
    // conductor aidlc.json). A future delegate added without an IDE grant reds
    // here instead of shipping toolless (the original field bug).
    const CLI_AGENTS = join(REPO_ROOT, "dist", "kiro", ".kiro", "agents");
    const fmBlockOf = (p: string): string =>
      /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(p, "utf-8"))?.[1] ?? "";
    const fmToolsOf = (p: string): string | undefined =>
      /^tools:\s*(.+)$/m.exec(fmBlockOf(p))?.[1];
    const delegates = readdirSync(CLI_AGENTS)
      .filter((n) => n.endsWith("-agent.json"))
      .map((n) => n.replace(/\.json$/, ".md"));
    expect(delegates.length).toBeGreaterThanOrEqual(14);
    for (const f of readdirSync(IDE_AGENTS).filter((n) => n.endsWith(".md"))) {
      if (delegates.includes(f)) {
        // Every delegate carries fs_write in its CLI JSON (builders author
        // artifacts; reviewers append `## Review` per 12a; ensemble
        // collaborators write their own contribution files per §11), so every
        // delegate's IDE grant is read+write+shell PLUS a permissions.rules
        // block scoping filesystem to the space it writes.
        const cliJson = readJson(join(CLI_AGENTS, f.replace(/\.md$/, ".json")));
        const writes = ((cliJson.tools as string[]) ?? []).includes("fs_write");
        expect(writes, `${f}: expected a writing delegate`).toBe(true);
        expect(fmToolsOf(join(IDE_AGENTS, f))).toBe(`["read", "write", "shell"]`);
        expect(fmBlockOf(join(IDE_AGENTS, f))).toContain("permissions:");
      } else {
        // The conductor aidlc.md carries its own authored grant; every OTHER
        // non-delegate kiro-ide agent must have NO injected grant (catches the
        // injection landing on the wrong file).
        if (f === "aidlc.md") continue;
        expect(fmToolsOf(join(IDE_AGENTS, f))).toBeUndefined();
      }
    }
    // Leak guard: the grant is IDE-native and must not ship anywhere else.
    const nonIdeAgentTrees = HARNESS_MATRIX.filter(
      (harness) => !harness.capabilities.ideAgentTools,
    ).map((harness) => join(harness.engineRoot, "agents"));
    expect(nonIdeAgentTrees.length).toBeGreaterThan(0);
    for (const tree of nonIdeAgentTrees) {
      for (const f of readdirSync(tree).filter((n) => n.endsWith(".md"))) {
        expect(fmToolsOf(join(tree, f))).toBeUndefined();
      }
    }
  });

  test("conductor hooks all route through the adapter", () => {
    const a = readJson(join(K, "agents", "aidlc.json"));
    const hooks = a.hooks as Record<string, Array<{ command: string; matcher?: string }>>;
    expect(Object.keys(hooks).sort()).toEqual([
      "agentSpawn",
      "postToolUse",
      "preToolUse",
      "stop",
      "userPromptSubmit",
    ]);
    const all = Object.values(hooks).flat();
    for (const h of all) {
      expect(h.command).toContain("aidlc-kiro-adapter.ts");
    }
    const matchers = (hooks.postToolUse ?? []).map((h) => h.matcher).sort();
    expect(matchers).toEqual(["execute_bash", "fs_write", "subagent", "todo_list"]);
  });

  test("workspace activation ships chat.defaultAgent=aidlc (D-5)", () => {
    const s = readJson(join(K, "settings", "cli.json"));
    expect(s["chat.defaultAgent"]).toBe("aidlc");
  });

  test("workspace pins per-model efforts via chat.modelDefaults (authored conditional entries only)", () => {
    // The shipped cli.json carries ONLY the authored orchestrator entry
    // (claude-opus-4.8 -> xhigh): a CONDITIONAL per-model effort default that
    // applies only when the session actually runs that model — inert for
    // spawns and harmless when the model isn't enabled. No agent surface
    // pins a model anymore (#601: shipped IDs resolve only when enabled on
    // the user's install), and no tier pins a Kiro model, so no tier-derived
    // entry ships. Kiro's per-model default sub-path is output_config.effort
    // (per kiro.dev/docs/cli/chat/effort). Pin the whole map so neither the
    // authored default nor a resurrected projection pin can regress.
    const s = readJson(join(K, "settings", "cli.json"));
    const defaults = s["chat.modelDefaults"] as Record<
      string,
      { output_config?: { effort?: string } }
    >;
    expect(defaults?.["claude-opus-4.8"]?.output_config?.effort).toBe("xhigh");
    expect(Object.keys(defaults ?? {}).sort()).toEqual(["claude-opus-4.8"]);
  });

  test("no shipped Kiro agent surface pins a model (#601: agents inherit the session model)", () => {
    const a = readJson(join(K, "agents", "aidlc.json"));
    expect("model" in a).toBe(false);
  });

  test("kiro skills carry the kiro tool prefix, never the claude one", () => {
    const skill = readFileSync(join(K, "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain("bun .kiro/tools/");
    expect(skill).not.toContain("bun .claude/tools/");
    expect(skill).not.toContain("AskUserQuestion");
  });
});
