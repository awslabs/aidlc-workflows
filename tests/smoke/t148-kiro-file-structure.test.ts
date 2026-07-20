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

  test("every dispatched graph writer has a space-scoped write grant on Kiro CLI and IDE", () => {
    for (const harness of ["kiro", "kiro-ide"] as const) {
      const agentsDir = join(REPO_ROOT, "dist", harness, ".kiro", "agents");
      const writers = dispatchedSpaceWriters(harness);
      expect(writers.length).toBeGreaterThan(0);
      for (const agent of writers) {
        const config = readJson(join(agentsDir, `${agent}.json`));
        expect(config.tools as string[]).toContain("fs_write");
        const settings = config.toolsSettings as Record<string, { allowedPaths?: string[] }>;
        expect(settings.fs_write?.allowedPaths).toContain("aidlc/spaces/**");
      }
    }
  });

  test("shared Kiro CLI and IDE agent JSON sources remain byte-identical", () => {
    const cliDir = join(REPO_ROOT, "harness", "kiro", "agents");
    const ideDir = join(REPO_ROOT, "harness", "kiro-ide", "agents");
    const intentionalReviewerDifferences = new Set([
      "aidlc-architecture-reviewer-agent.json",
      "aidlc-product-lead-agent.json",
    ]);
    const shared = readdirSync(cliDir)
      .filter((name) => name.endsWith("-agent.json"))
      .filter((name) => !intentionalReviewerDifferences.has(name))
      .sort();
    expect(
      readdirSync(ideDir)
        .filter((name) => name.endsWith("-agent.json"))
        .filter((name) => !intentionalReviewerDifferences.has(name))
        .sort(),
    ).toEqual(shared);
    for (const name of shared) {
      expect(readFileSync(join(ideDir, name), "utf-8")).toBe(
        readFileSync(join(cliDir, name), "utf-8"),
      );
    }
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
    const fmToolsOf = (p: string): string | undefined =>
      /^tools:\s*(.+)$/m.exec(
        /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(p, "utf-8"))?.[1] ?? "",
      )?.[1];
    // The delegation-target roster IS the set of hand-authored agent JSONs
    // (minus the conductor aidlc.json) - derive it from disk so a future
    // delegate added without a grant reds here instead of shipping toolless
    // (the original field bug). Every delegate carries fs_write in its CLI
    // JSON (builders author artifacts; reviewers append `## Review` per 12a;
    // ensemble collaborators (2.5.0) write their own contribution files per
    // stage-protocol §11 - everyone writes, the lead owns the produces[]
    // artifacts), so every delegate's IDE grant is read+write+shell. The
    // grant is still DERIVED from the CLI JSON rather than hardcoded, so a
    // future read-only delegate stays expressible. Every NON-delegate
    // kiro-ide agent must have NO grant (catches the injection landing on
    // the wrong file).
    const delegates = readdirSync(IDE_AGENTS)
      .filter((n) => n.endsWith("-agent.json"))
      .map((n) => n.replace(/\.json$/, ".md"));
    expect(delegates.length).toBeGreaterThanOrEqual(14);
    for (const f of readdirSync(IDE_AGENTS).filter((n) => n.endsWith(".md"))) {
      if (delegates.includes(f)) {
        const cliJson = readJson(join(IDE_AGENTS, f.replace(/\.md$/, ".json")));
        const writes = ((cliJson.tools as string[]) ?? []).includes("fs_write");
        expect(fmToolsOf(join(IDE_AGENTS, f))).toBe(
          writes ? `["read", "write", "shell"]` : `["read", "shell"]`,
        );
      } else {
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

  test("workspace pins per-model efforts via chat.modelDefaults (orchestrator + tier models)", () => {
    // The shipped cli.json carries one entry per model AIDLC pins: the
    // authored orchestrator entry (claude-opus-4.8 -> xhigh, exactly as
    // agents/aidlc.json pins it) plus one tier-projected entry per distinct
    // model the tier table names (claude-sonnet-4.5 -> high — balanced's
    // effort wins the balanced/templated collapse; judgment pins no model so
    // it has no entry). Kiro's per-model default sub-path is
    // output_config.effort (per kiro.dev/docs/cli/chat/effort). Pin the whole
    // map so neither the authored default nor the projection can regress.
    const s = readJson(join(K, "settings", "cli.json"));
    const defaults = s["chat.modelDefaults"] as Record<
      string,
      { output_config?: { effort?: string } }
    >;
    expect(defaults?.["claude-opus-4.8"]?.output_config?.effort).toBe("xhigh");
    expect(defaults?.["claude-sonnet-4.5"]?.output_config?.effort).toBe("high");
    expect(Object.keys(defaults ?? {}).sort()).toEqual([
      "claude-opus-4.8",
      "claude-sonnet-4.5",
    ]);
  });

  test("kiro skills carry the kiro tool prefix, never the claude one", () => {
    const skill = readFileSync(join(K, "skills", "aidlc", "SKILL.md"), "utf-8");
    expect(skill).toContain("bun .kiro/tools/");
    expect(skill).not.toContain("bun .claude/tools/");
    expect(skill).not.toContain("AskUserQuestion");
  });
});
