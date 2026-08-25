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
import { spawnSync } from "node:child_process";
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
const KIRO_IDE = join(REPO_ROOT, "dist", "kiro-ide");
const KI = join(KIRO_IDE, ".kiro");

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

interface HookRegistration {
  matcher?: string;
  command: string;
}

interface RegistrationToolNames {
  writes: string[];
  reads: string[];
  dispatches: string[];
  responses: string[];
}

const REGISTRATION_TOOL_NAMES = (
  readJson(
    join(REPO_ROOT, "tests", "fixtures", "kiro-hook-payloads", "payloads.json"),
  )._registration_tool_names as RegistrationToolNames
);

const KIRO_ALIAS_GROUPS = [
  ["fs_write", "write"],
  ["fs_read", "read"],
] as const;

function matchesKiroMatcher(pattern: string, reportedTool: string): boolean {
  const aliases = KIRO_ALIAS_GROUPS.find((group) =>
    group.some((name) => name === reportedTool)
  ) ?? [reportedTool];
  const glob = new Bun.Glob(pattern);
  return aliases.some((name) => glob.match(name));
}

function registrationMatchers(
  config: Record<string, unknown>,
  event: "preToolUse" | "postToolUse",
  target: string,
): string[] {
  const hooks = config.hooks as Record<string, HookRegistration[]>;
  const matchers = (hooks[event] ?? [])
    .filter((hook) => hook.command.includes(target))
    .map((hook) => hook.matcher)
    .filter((matcher): matcher is string => typeof matcher === "string");
  if (matchers.length === 0) throw new Error(`missing ${event} matcher for ${target}`);
  return matchers;
}

function frontmatter(p: string): string {
  return readFileSync(p, "utf-8").match(
    /^---\r?\n([\s\S]*?)\r?\n---/,
  )?.[1] ?? "";
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
      "settings/mcp.json",
    ]) {
      expect(existsSync(join(K, f))).toBe(true);
    }
    expect(existsSync(join(KIRO, "AGENTS.md"))).toBe(true);
  });

  test("Kiro IDE ships always-included active-memory steering for delegates", () => {
    const path = join(
      REPO_ROOT,
      "dist",
      "kiro-ide",
      ".kiro",
      "steering",
      "aidlc-active-memory.md",
    );
    expect(existsSync(path)).toBe(true);
    const steering = readFileSync(path, "utf-8");
    expect(steering).toMatch(/^---\ninclusion: always\n---/);
    for (const file of [
      "org.md",
      "team.md",
      "project.md",
      "phases/ideation.md",
      "phases/inception.md",
      "phases/construction.md",
      "phases/operation.md",
    ]) {
      expect(steering).toContain(
        `#[[file:aidlc/spaces/default/memory/${file}]]`,
      );
    }
  });

  test("conductor agent: allowedCommands-only shell grant (findings 0.9b)", () => {
    const a = readJson(join(K, "agents", "aidlc.json"));
    const allowed = (a.allowedTools as string[]) ?? [];
    expect(allowed).not.toContain("execute_bash"); // never blanket shell trust
    const ts = a.toolsSettings as Record<string, { allowedCommands?: string[] }>;
    const cmds = ts.execute_bash?.allowedCommands ?? [];
    expect(cmds.some((c) => c.includes(".kiro/tools/"))).toBe(true);
    // No `.kiro/tools/` grant may end in an open wildcard: Kiro matches the
    // whole command string, so a trailing `.*` after the directory swallows
    // path traversal (`bun .kiro/tools/../../anything.ts` ran unprompted before
    // 2.5.16). t252 asserts the resulting accept/reject behaviour in full.
    for (const c of cmds) {
      if (!c.includes(".kiro/tools/")) continue;
      expect(c, `open wildcard after .kiro/tools/: ${c}`)
        .not.toMatch(/\.kiro\/tools\/\.\*/);
    }
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
    const cliAgents = join(K, "agents");
    for (const agent of dispatchedSpaceWriters("kiro")) {
      const config = readJson(join(cliAgents, `${agent}.json`));
      expect(config.tools as string[]).toContain("fs_write");
      const settings = config.toolsSettings as Record<string, { allowedPaths?: string[] }>;
      expect(settings.fs_write?.allowedPaths).toContain("aidlc/spaces/**");
    }

    const ideAgents = join(KI, "agents");
    for (const agent of dispatchedSpaceWriters("kiro-ide")) {
      const fm = frontmatter(join(ideAgents, `${agent}.md`));
      expect(fm, agent).toContain(`tools: ["read", "write", "shell"]`);
      expect(fm, agent).toContain("permissions:");
      expect(fm, agent).toContain("  rules:");
      expect(fm, agent).not.toContain("disallowedTools:");
    }
  });

  test("Kiro IDE agents directory is Markdown-only and omits CLI settings", () => {
    const names = readdirSync(join(KI, "agents")).sort();
    expect(names.filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(names.filter((name) => name.endsWith(".md")).length).toBe(15);
    expect(names).toContain("aidlc.md");
    expect(names.filter((name) => name.endsWith("-agent.md")).length).toBe(14);
    expect(existsSync(join(KI, "settings", "cli.json"))).toBe(false);
  });

  test("Kiro agent Markdown omits the Claude-only disallowedTools key", () => {
    for (const harness of ["kiro", "kiro-ide"] as const) {
      const agentsDir = join(REPO_ROOT, "dist", harness, ".kiro", "agents");
      const files = readdirSync(agentsDir)
        .filter((name) => name.endsWith("-agent.md"))
        .sort();
      expect(files.length).toBe(14);
      for (const file of files) {
        const projected = readFileSync(join(agentsDir, file), "utf-8");
        const projectedFm =
          projected.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
        expect(projectedFm, `dist/${harness} ${file}`).not.toMatch(
          /^disallowedTools:/m,
        );

        const core = readFileSync(
          join(REPO_ROOT, "core", "agents", file),
          "utf-8",
        );
        const coreFm = core.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
        expect(coreFm, `core/agents/${file}`).toMatch(
          /^disallowedTools:\s*Task\s*$/mi,
        );
      }
    }
  });

  test("IDE-native tools and multi-line permissions land on all delegation targets only", () => {
    // The Kiro IDE resolves a delegated subagent's tools from the agent .md
    // frontmatter, not from the agent-v1 JSON the CLI reads (field-proven:
    // a dispatched composer without the grant ran toolless). The kiro-ide
    // manifest injects the grant during projection; it must land on every
    // delegation target there and must NOT leak into any other harness's
    // agents (on Claude a `tools:` frontmatter field would RESTRICT the
    // agent to non-Claude tool names, breaking it).
    const IDE_AGENTS = join(KI, "agents");
    const fmToolsOf = (p: string): string | undefined =>
      /^tools:\s*(.+)$/m.exec(
        /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(p, "utf-8"))?.[1] ?? "",
      )?.[1];
    const delegates = readdirSync(join(REPO_ROOT, "core", "agents"))
      .filter((name) => name.endsWith("-agent.md"))
      .sort();
    expect(delegates.length).toBe(14);
    for (const file of delegates) {
      const fm = frontmatter(join(IDE_AGENTS, file));
      expect(fmToolsOf(join(IDE_AGENTS, file))).toBe(
        `["read", "write", "shell"]`,
      );
      expect(fm).toContain("permissions:");
      expect(fm).toContain("  rules:");
      expect(fm).toContain("    - capability: shell");
      expect(fm).toContain("      effect: allow");
      expect(fm).toContain(`        - "bun .kiro/tools/aidlc-*"`);
      expect(fm).not.toContain("disallowedTools:");
    }
    expect(fmToolsOf(join(IDE_AGENTS, "aidlc.md"))).toBe(
      `["read", "write", "shell", "subagent"]`,
    );
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

  test("Kiro IDE conductor keeps the current CLI prompt in IDE-native Markdown", () => {
    const cliConductor = readJson(
      join(REPO_ROOT, "harness", "kiro", "agents", "aidlc.json"),
    );
    const markdown = readFileSync(join(KI, "agents", "aidlc.md"), "utf-8");
    const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "").trim();
    expect(typeof cliConductor.prompt).toBe("string");
    expect(body).toBe(cliConductor.prompt as string);
    const fm = frontmatter(join(KI, "agents", "aidlc.md"));
    expect(fm).toContain(`tools: ["read", "write", "shell", "subagent"]`);
    expect(fm).toContain("    - capability: shell");
    expect(fm).toContain("      effect: deny");
    expect(fm).toContain(`        - "aidlc/.aidlc-compose-pending"`);
  });

  test("doctor accepts IDE shape and keeps CLI settings validation", () => {
    const run = (projectDir: string): string => {
      const tool = join(projectDir, ".kiro", "tools", "aidlc-utility.ts");
      const result = spawnSync(process.execPath, [tool, "doctor", "--project-dir", projectDir], {
        encoding: "utf-8",
        env: { ...process.env, AIDLC_HARNESS_DIR: ".kiro" },
      });
      return `${result.stdout ?? ""}${result.stderr ?? ""}`;
    };
    const ide = run(KIRO_IDE);
    expect(ide).toContain("✓  agents/aidlc.{json,md} present (conductor wiring)");
    expect(ide).not.toContain("settings/cli.json present");

    const cli = run(KIRO);
    expect(cli).toContain("✓  agents/aidlc.{json,md} present (conductor wiring)");
    expect(cli).toContain(
      "✓  settings/cli.json present (workspace default-agent activation)",
    );
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
    const preMatchers = (hooks.preToolUse ?? []).map((h) => h.matcher).sort();
    expect(preMatchers).toEqual([
      "execute_bash",
      "execute_bash",
      "execute_bash",
      "fs_write",
      "subagent",
      "subagent",
    ]);
    expect(
      (hooks.preToolUse ?? []).find((h) => h.matcher === "fs_write")?.command,
    ).toContain("aidlc-kiro-adapter.ts review-freeze");
    expect(
      (hooks.preToolUse ?? []).filter((h) => h.matcher === "execute_bash")
        .some((h) => h.command.includes("aidlc-kiro-adapter.ts review-freeze")),
    ).toBe(true);
    const subagentCommands = (hooks.preToolUse ?? [])
      .filter((h) => h.matcher === "subagent")
      .map((h) => h.command)
      .sort();
    expect(subagentCommands).toEqual([
      "bun .kiro/hooks/aidlc-kiro-adapter.ts deliver-stage-rules",
      "bun .kiro/hooks/aidlc-kiro-adapter.ts plan-approval-guard",
    ]);
    const matchers = (hooks.postToolUse ?? []).map((h) => h.matcher).sort();
    expect(matchers).toEqual(["execute_bash", "fs_write", "subagent", "todo_list"]);
  });

  test("Kiro agent-v1 registrations select the live-captured alias families", () => {
    const agentDir = join(K, "agents");
    const configs = readdirSync(agentDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [name, readJson(join(agentDir, name))] as const);

    for (const [name, config] of configs) {
      if (!((config.tools as string[]) ?? []).includes("fs_write")) continue;
      const freeze = registrationMatchers(config, "preToolUse", "review-freeze");
      const audit = registrationMatchers(config, "postToolUse", "audit-and-sensors");
      for (const tool of REGISTRATION_TOOL_NAMES.writes) {
        expect(
          freeze.filter((matcher) => matchesKiroMatcher(matcher, tool)),
          `${name}: freeze selection for ${tool}`,
        ).toHaveLength(1);
        expect(
          audit.filter((matcher) => matchesKiroMatcher(matcher, tool)),
          `${name}: audit selection for ${tool}`,
        ).toHaveLength(1);
      }
    }

    for (const name of [
      "aidlc-architecture-reviewer-agent.json",
      "aidlc-product-lead-agent.json",
    ]) {
      const config = readJson(join(agentDir, name));
      const scope = registrationMatchers(config, "preToolUse", "reviewer-scope");
      for (const tool of [
        ...REGISTRATION_TOOL_NAMES.reads,
        ...REGISTRATION_TOOL_NAMES.writes,
      ]) {
        expect(
          scope.filter((matcher) => matchesKiroMatcher(matcher, tool)),
          `${name}: reviewer scope selection for ${tool}`,
        ).toHaveLength(1);
      }
    }

    const conductor = readJson(join(agentDir, "aidlc.json"));
    for (const target of [
      "deliver-stage-rules",
      "plan-approval-guard",
      "log-subagent",
    ]) {
      const event = target === "log-subagent" ? "postToolUse" : "preToolUse";
      const dispatch = registrationMatchers(conductor, event, target);
      for (const tool of REGISTRATION_TOOL_NAMES.dispatches) {
        expect(
          dispatch.filter((matcher) => matchesKiroMatcher(matcher, tool)),
          `${target}: dispatch selection for ${tool}`,
        ).toHaveLength(1);
      }
      for (const tool of REGISTRATION_TOOL_NAMES.responses) {
        expect(
          dispatch.filter((matcher) => matchesKiroMatcher(matcher, tool)),
          `${target}: response selection for ${tool}`,
        ).toHaveLength(0);
      }
    }

    expect(matchesKiroMatcher("write|fs_write", "write")).toBe(false);
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
