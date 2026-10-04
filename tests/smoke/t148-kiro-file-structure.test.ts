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
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_MATRIX,
  manifestGrantsIdeAgentTools,
} from "../harness/harness-matrix.ts";
import { delegatedLifecycleCommand } from "../../core/hooks/aidlc-state-transition-guard.ts";

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
    // Steering now carries onboarding, not copies of the workspace method.
    expect(readdirSync(join(K, "steering"))).toEqual(["aidlc-onboarding.md"]);
  });

  test("authored shell files present", () => {
    for (const f of [
      "skills/aidlc/SKILL.md",
      "skills/aidlc/question-rendering.md",
      "steering/aidlc-onboarding.md",
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
    expect(frontmatter(join(KI, "steering", "aidlc-onboarding.md"))).toBe("inclusion: always");
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
      expect(fm, agent).toContain(`        - "aidlc/spaces/**"`);
      // Exactly the read-only version check; `bun test` and the rest still ask.
      expect(fm, agent).toContain(`        - "bun --version"`);
      expect(fm, agent).not.toContain(`        - "bun *"`);
      expect(fm, agent).not.toContain("disallowedTools:");
    }
  });

  test("the Kiro CLI composer may write only its grid proposal file", () => {
    // The composer writes its grid to the proposalPath detect prints before
    // each validate-grid run. It writes no scope and not the scope grid:
    // saving a scope is the engine's `scope save`.
    const config = readJson(join(K, "agents", "aidlc-composer-agent.json"));
    const settings = config.toolsSettings as Record<string, { allowedPaths?: string[] }>;
    expect(settings.fs_write?.allowedPaths).toEqual([
      "aidlc/spaces/*/intents/.aidlc-engine/composer-proposal.json",
    ]);
  });

  test("Kiro IDE agents directory is Markdown-only and pins Kiro CLI to the v3 engine", () => {
    const names = readdirSync(join(KI, "agents")).sort();
    expect(names.filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(names.filter((name) => name.endsWith(".md")).length).toBe(15);
    expect(names).toContain("aidlc.md");
    expect(names.filter((name) => name.endsWith("-agent.md")).length).toBe(14);
    // Kiro CLI's default v2 engine runs no .kiro/hooks at all, and no hook can
    // detect that from inside, so the project settings file is the only guard.
    expect(readJson(join(KI, "settings", "cli.json"))).toEqual({
      "chat.agentEngine": "v3",
      "chat.defaultAgent": "aidlc",
    });
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
    // Kiro resolves a delegated subagent's tools from the agent .md
    // frontmatter, not from the agent-v1 JSON the CLI row reads (field-proven:
    // a dispatched composer without the grant ran toolless). tools binds on
    // every dispatch path; the persona's own permissions bind only on the
    // invoke_sub_agent / orchestrate_subagent path the conductor selects. The
    // kiro-ide manifest injects both during projection; they must land on
    // every delegation target there and must NOT leak into any other
    // harness's agents (on Claude a `tools:` frontmatter field would RESTRICT
    // the agent to non-Claude tool names, breaking it).
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
      expect(fm).toContain("    - capability: fs_read");
      // Engine-owned trees are denied to every persona, the composer too: it
      // writes only its grid proposal, never a scope or the scope grid.
      const deny = fm.slice(fm.indexOf("    - capability: fs_write\n      effect: deny"));
      expect(deny, file).toContain(`        - ".kiro/**"`);
      expect(deny, file).toContain(`        - "aidlc/.aidlc-sessions/**"`);
      expect(deny, file).toContain(`        - "aidlc/spaces/*/intents/*/.aidlc-engine/gate-words/**"`);
      expect(deny, file).not.toContain("exclude:");
      if (file === "aidlc-composer-agent.md") {
        // The grid file it writes before each validate-grid run (the
        // proposalPath detect prints) is its only write.
        expect(fm.slice(fm.indexOf("    - capability: filesystem"), fm.indexOf("    - capability: fs_write"))).toBe(
          `    - capability: filesystem\n      effect: allow\n      match:\n        - "aidlc/spaces/*/intents/.aidlc-engine/composer-proposal.json"\n`,
        );
      }
      expect(fm).not.toContain("disallowedTools:");
    }
    // The conductor names the two dispatch tools that run a delegate under
    // its own permissions (Kiro IDE accepts only invoke_sub_agent, Kiro CLI
    // only orchestrate_subagent), not the `subagent` category, whose
    // subagent_<name> dispatch ignores them.
    expect(fmToolsOf(join(IDE_AGENTS, "aidlc.md"))).toBe(
      `["read", "write", "shell", "invoke_sub_agent", "orchestrate_subagent"]`,
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

  test("every delegation target denies the conductor's command allow except what the guard lets a delegate run", () => {
    // A delegate's calls carry no agent identity, so the state-transition
    // guard's delegated branch cannot fire on Kiro, and a delegated persona's
    // shell allow is not applied: the delegate runs what the conductor's allow
    // covers (Kiro CLI 2.27.1, IDE 1.2.4). The persona's deny is enforced, so it
    // denies that whole allow and excludes the canonical commands the guard
    // lets a delegate run. Kiro's matching, as measured on Kiro CLI 2.27.1: it
    // judges each part of a command joined by &&, ||, ;, |, &, a newline, $( )
    // or backticks on its own,
    // as written, quotes and spaces kept; a deny "P *" matches P alone or P
    // followed by arguments, never P as a word prefix; any other trailing "*"
    // is a prefix; an exclude "X *" lifts X followed by arguments, not bare X.
    // A part runs unprompted only when the conductor's allow covers it and the
    // persona's deny does not; any other part asks.
    const denyMatches = (pattern: string, command: string): boolean =>
      pattern.endsWith(" *")
        ? command === pattern.slice(0, -2) || command.startsWith(pattern.slice(0, -1))
        : pattern.endsWith("*")
        ? command.startsWith(pattern.slice(0, -1))
        : command === pattern;
    const excludeMatches = (pattern: string, command: string): boolean =>
      pattern.endsWith("*") ? command.startsWith(pattern.slice(0, -1)) : command === pattern;
    const ruleOf = (file: string): { match: string[]; exclude: string[] } => {
      const fm = frontmatter(file);
      const at = fm.indexOf("    - capability: shell\n      effect: deny\n      match:\n");
      expect(at, `${file} has a shell deny rule`).toBeGreaterThanOrEqual(0);
      const lines = fm.slice(at).split("\n").slice(3);
      const list = (from: string[]): string[] =>
        from.slice(0, from.findIndex((line) => !line.startsWith("        - "))).map((line) =>
          line.slice('        - "'.length, -1)
        );
      const match = list(lines);
      const rest = lines.slice(match.length);
      return { match, exclude: rest[0] === "      exclude:" ? list(rest.slice(1)) : [] };
    };
    const partsOf = (command: string): string[] => {
      const substitution = /[$<]\(([^()]*)\)|`([^`]*)`/g;
      const inner = [...command.matchAll(substitution)].map((match) => match[1] ?? match[2]);
      return [command.replace(substitution, ""), ...inner]
        .flatMap((part) => part.split(/&&|\|\||;|\||&|\n/))
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    };
    const deniesPart = (rule: { match: string[]; exclude: string[] }, part: string): boolean =>
      rule.match.some((pattern) => denyMatches(pattern, part)) &&
      !rule.exclude.some((pattern) => excludeMatches(pattern, part));
    const denies = (rule: { match: string[]; exclude: string[] }, command: string): boolean =>
      partsOf(command).some((part) => deniesPart(rule, part));
    const runsUnprompted = (rule: { match: string[]; exclude: string[] }, allow: string, command: string): boolean =>
      partsOf(command).every((part) => denyMatches(allow, part) && !deniesPart(rule, part));
    // Each refused command is one the guard refuses a delegate, spelled as
    // written, re-quoted, re-spaced, or with a flag before the verb; each
    // allowed one is a command personas run.
    const channels = [
      {
        tree: "dist",
        allow: "bun .kiro/tools/aidlc-*",
        refused: [
          "bun .kiro/tools/aidlc-orchestrate.ts next",
          "bun .kiro/tools/aidlc-orchestrate.ts --project-dir . next",
          'bun .kiro/tools/aidlc-"orchestrate.ts" next',
          "bun .kiro/tools/aidlc-jump.ts execute --to x",
          "bun .kiro/tools/aidlc-state.ts set-unit-ownership u1 developer",
          "bun .kiro/tools/aidlc-utility.ts recompose --skip x",
          'bun .kiro/tools/aidlc-utility.ts "scope-change" --scope mvp',
          "bun .kiro/tools/aidlc-utility.ts  scope-change --scope mvp",
          "bun .kiro/tools/aidlc-utility.ts --project-dir . scope-change --scope mvp",
          "bun .kiro/tools/aidlc-utility.ts intent other-intent",
          "bun .kiro/tools/aidlc-utility.ts space switch other",
          "bun .kiro/tools/aidlc-log.ts answers --stage x && bun .kiro/tools/aidlc-orchestrate.ts next",
          "bun .kiro/tools/aidlc-log.ts answers --stage x; bun .kiro/tools/aidlc-utility.ts recompose --skip x",
          "bun .kiro/tools/aidlc-log.ts answers --stage $(bun .kiro/tools/aidlc-orchestrate.ts next)",
          "bun .kiro/tools/aidlc-log.ts answers --stage `bun .kiro/tools/aidlc-orchestrate.ts next`",
          "bun .kiro/tools/aidlc-log.ts answers --stage x & bun .kiro/tools/aidlc-orchestrate.ts next",
          "bun .kiro/tools/aidlc-log.ts answers --stage x\nbun .kiro/tools/aidlc-orchestrate.ts next",
          "bun .kiro/tools/aidlc-state.ts set-construction-execution swarm",
          "bun .kiro/tools/aidlc-state.ts unit complete --stage code-generation --unit u1",
          "bun .kiro/tools/aidlc-utility.ts reclassify --type existing",
          "bun .kiro/tools/aidlc-utility.ts select-plugins test-pro",
          "bun .kiro/tools/aidlc-unit.ts gate u1 --decision approve",
          "bun .kiro/tools/aidlc-unit.ts land u1",
          "bun .kiro/tools/aidlc-bolt.ts set-autonomy --mode gated",
          "bun .kiro/tools/aidlc-log.ts answer --question q1 --answer yes",
          "bun .kiro/tools/aidlc-testing-posture.ts fingerprint --unit u1",
          "bun .kiro/tools/aidlc-utility.ts intent --json true other-intent",
          "bun .kiro/tools/aidlc-utility.ts intent --all true archive other-intent",
          "bun .kiro/tools/aidlc-utility.ts space --json true other",
          "bun .kiro/tools/aidlc-log.ts answers --stage x <(bun .kiro/tools/aidlc-orchestrate.ts next)",
          "bun .kiro/tools/aidlc-worktree.ts purge --slug u1 --older-than 0",
          "bun .kiro/tools/aidlc-audit.ts audit-merge --slug u1",
          "bun .kiro/tools/aidlc-audit.ts audit-fork --slug u1",
          "bun .kiro/tools/aidlc-utility.ts select-plugins test-pro --no-color",
        ],
        foreign: "bun .kiro/tools/aidlc-log.ts answers --stage x && rm -rf docs",
        hostOnly: ["bun .kiro/tools/aidlc-sensor-linter.ts --stage code-generation"],
        allowed: [
          "bun .kiro/tools/aidlc-utility.ts project-description",
          "bun .kiro/tools/aidlc-utility.ts codekb-snapshot --unit u1",
          "bun .kiro/tools/aidlc-utility.ts version",
          "bun .kiro/tools/aidlc-log.ts answers --stage x",
          "bun .kiro/tools/aidlc-testing-posture.ts brief --unit u1",
          "bun .kiro/tools/aidlc-worktree.ts merge u1",
          "bun .kiro/tools/aidlc-state.ts get Status",
          "bun .kiro/tools/aidlc-state.ts lookup phase-of code-generation",
          "bun .kiro/tools/aidlc-jump.ts resolve --to code-generation",
          "bun .kiro/tools/aidlc-utility.ts intent list --json",
          "bun .kiro/tools/aidlc-utility.ts intent",
          "bun .kiro/tools/aidlc-utility.ts intent --json",
          "bun .kiro/tools/aidlc-utility.ts space help",
          "bun .kiro/tools/aidlc-utility.ts select-plugins",
          "bun .kiro/tools/aidlc-utility.ts select-plugins --json",
          "bun .kiro/tools/aidlc-utility.ts intent --all --json",
          "bun .kiro/tools/aidlc-unit.ts merge-status u1",
          "bun .kiro/tools/aidlc-worktree.ts create --slug u1 --base main",
          "bun .kiro/tools/aidlc-worktree.ts info --slug u1",
          "bun .kiro/tools/aidlc-worktree.ts discard --slug u1",
          "bun .kiro/tools/aidlc-worktree.ts restore --slug u1",
          "bun .kiro/tools/aidlc-audit.ts history",
          "bun .kiro/tools/aidlc-audit.ts append --type PRACTICES_SECTION_EMPTY",
          "bun .kiro/tools/aidlc-utility.ts select-plugins --no-color",
          "bun .kiro/tools/aidlc-utility.ts intent --quiet",
        ],
      },
      {
        tree: "dist-release",
        allow: "aidlc engine *",
        refused: [
          "aidlc engine orchestrate next",
          'aidlc engine "orchestrate" next',
          "aidlc engine --project-dir . orchestrate next",
          'aidlc engine "--resume"',
          "aidlc engine recompose --skip x",
          "aidlc engine state unpark",
          "aidlc engine config set depth minimal",
          "aidlc engine config --project-dir . set depth minimal",
          'aidlc engine config "set" depth minimal',
          "aidlc engine intent other-intent",
          "aidlc engine space switch other",
          "aidlc engine log answers --stage x && aidlc engine orchestrate next",
          "aidlc engine log answers --stage $(aidlc engine state unpark)",
          "aidlc engine log answers --stage `aidlc engine state unpark`",
          "aidlc engine log answers --stage x & aidlc engine state unpark",
          "aidlc engine state init --scope feature",
          "aidlc engine workspace reclassify --type existing",
          "aidlc engine plugin select test-pro",
          "aidlc engine bolt hold-merge u1",
          "aidlc engine swarm finalize",
          "aidlc engine learnings persist",
          "aidlc engine state set-construction-checkpoints disabled",
          "aidlc engine state unit pause --stage code-generation --unit u1",
          "aidlc engine intent --json other-intent",
          "aidlc engine space --json create other",
          "aidlc engine plugin select --json test-pro",
          "aidlc engine --claim u1",
          "aidlc engine --release u1",
          "aidlc engine worktree purge --slug u1 --older-than 0",
          "aidlc engine audit merge --slug u1",
          "aidlc engine audit fork --slug u1",
          "aidlc engine plugin select --no-color test-pro",
        ],
        foreign: "aidlc engine log answers --stage x && rm -rf docs",
        hostOnly: [
          "aidlc engine hook record-human-turn",
          "aidlc engine adapter kiro-ide record-human-turn",
          "aidlc engine statusline",
          "aidlc engine sensor-linter --stage code-generation",
        ],
        allowed: [
          "aidlc engine workspace project-description",
          "aidlc engine config get depth",
          "aidlc engine worktree merge u1",
          "aidlc engine state lookup phase-of code-generation",
          "aidlc engine intent list",
          "aidlc engine intent",
          "aidlc engine intent --json",
          "aidlc engine space -h",
          "aidlc engine plugin select",
          "aidlc engine plugin select --json",
          "aidlc engine testing-posture brief --unit u1",
          "aidlc engine worktree create --slug u1 --base main",
          "aidlc engine worktree info --slug u1",
          "aidlc engine worktree discard --slug u1",
          "aidlc engine worktree restore --slug u1",
          "aidlc engine audit history",
          "aidlc engine audit append --type PRACTICES_SECTION_EMPTY",
          "aidlc engine plugin select --no-color",
        ],
      },
    ];
    for (const { tree, allow, refused, foreign, hostOnly, allowed } of channels) {
      for (const command of refused) expect(delegatedLifecycleCommand(command), command).not.toBeNull();
      for (const command of allowed) expect(delegatedLifecycleCommand(command), command).toBeNull();
      const agents = join(REPO_ROOT, tree, "kiro-ide", ".kiro", "agents");
      expect(frontmatter(join(agents, "aidlc.md")), `${tree} conductor`).toContain(`        - "${allow}"`);
      for (const file of readdirSync(agents).filter((name) => name.endsWith("-agent.md"))) {
        const rule = ruleOf(join(agents, file));
        expect(rule.match, `${tree} ${file}`).toEqual([allow]);
        for (const command of refused) expect(denies(rule, command), `${tree} ${file}: ${command}`).toBe(true);
        // Host-only routing surfaces (hooks, the adapter, sensors) stay denied
        // though no lifecycle rule names them.
        for (const command of hostOnly) expect(denies(rule, command), `${tree} ${file}: ${command}`).toBe(true);
        // An allowed command with a foreign command appended still asks.
        expect(runsUnprompted(rule, allow, foreign), `${tree} ${file}: ${foreign}`).toBe(false);
        for (const command of allowed) {
          expect(runsUnprompted(rule, allow, command), `${tree} ${file}: ${command}`).toBe(true);
        }
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
    expect(fm).toContain(`tools: ["read", "write", "shell", "invoke_sub_agent", "orchestrate_subagent"]`);
    expect(fm).toContain("    - capability: shell");
    expect(fm).toContain("      effect: deny");
    // Settings changes and the per-harness hook entry ask the person even
    // though the tool grant allows the rest (ask outranks allow in Kiro IDE).
    expect(fm).toContain(
      `      effect: ask\n      match:\n        - "bun .kiro/tools/aidlc.ts engine config set *"\n        - "bun .kiro/tools/aidlc.ts engine adapter *"\n`,
    );
    // Every delegation target is pre-approved by name, so a routine dispatch
    // does not stop for an approval prompt; toolsSettings.subagent.trustedAgents
    // is inert in a Markdown agent.
    const subagentRule = fm.slice(fm.indexOf("    - capability: subagent"));
    for (const agent of readdirSync(join(KI, "agents")).filter((n) => n.endsWith("-agent.md"))) {
      expect(subagentRule).toContain(`        - "${agent.replace(/\.md$/, "")}"`);
    }
    expect(fm).not.toContain("toolsSettings");
    expect(fm).toContain(`        - "aidlc/.aidlc-compose-pending"`);
  });

  test("Kiro IDE first-run guidance sends the user to the aidlc agent in the agent picker", () => {
    // Kiro IDE opens new chats on its Default agent, and chat.defaultAgent in
    // cli.json only reaches Kiro CLI, so the config next step and the
    // always-included onboarding both name the picker.
    for (const tree of ["dist", "dist-release"]) {
      const data = readJson(join(REPO_ROOT, tree, "kiro-ide", ".kiro", "tools", "data", "harness.json"));
      expect(data.configNextStep as string).toContain("choose the aidlc agent in the chat panel's agent picker");
    }
    const onboarding = readFileSync(join(KI, "steering", "aidlc-onboarding.md"), "utf-8");
    expect(onboarding).toContain("choose **aidlc** in the chat panel's agent picker first");
  });

  test("Kiro IDE docs name the agent picker wherever they start AI-DLC", () => {
    // The README and the guides are the first-run path for a manual-copy install,
    // so they must not send a Kiro IDE user to /aidlc while the chat is still on
    // Default.
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf-8");
    expect(readme.split("\n").find((line) => line.startsWith("| Kiro IDE 1.x / Kiro CLI v3 |"))).toContain(
      "| Open the project in Kiro IDE and choose **aidlc** in the chat panel's agent picker, or run `kiro-cli` |",
    );
    expect(readme).toContain("In Kiro IDE, first choose **aidlc**\nin the chat panel's agent picker.");
    const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, "docs", "guide", ...parts), "utf-8");
    const next = readJson(join(KI, "tools", "data", "harness.json")).configNextStep as string;
    const lifecycleRow = read("18-install-and-lifecycle.md")
      .split("Successful config prints the host-specific next step:")[1]
      ?.split("\n")
      .find((line) => line.startsWith("| Kiro IDE |"));
    expect(lifecycleRow).toBe(`| Kiro IDE | ${next[0].toUpperCase()}${next.slice(1)} |`);
    const gettingStarted = read("01-getting-started.md");
    expect(gettingStarted).toContain("| Kiro IDE | `kiro-ide` | Open the project, then choose **aidlc** in the chat panel's agent picker | `/aidlc` |");
    expect(gettingStarted).toContain("| Kiro IDE | Open the configured project, then choose **aidlc** in the chat panel's agent picker |");
    const doctorSteps = read("harnesses", "kiro-ide.md").split(/\n\s*\n/).filter((paragraph) => /\brun\s+`\/aidlc --doctor`/.test(paragraph));
    expect(doctorSteps.length).toBeGreaterThanOrEqual(2);
    for (const paragraph of doctorSteps) expect(paragraph).toContain("agent picker");
    const conductor = readFileSync(join(KI, "agents", "aidlc.md"), "utf-8");
    expect(conductor).toContain("description: AI-DLC. Choose this agent in the agent picker");
  });

  test("doctor accepts IDE shape and keeps CLI settings validation", () => {
    // This shape check must not validate the developer's global installed runtime.
    const installRoot = mkdtempSync(join(tmpdir(), "t148-doctor-install-"));
    try {
      const run = (projectDir: string): string => {
        const tool = join(projectDir, ".kiro", "tools", "aidlc-utility.ts");
        const result = spawnSync(process.execPath, [tool, "doctor", "--project-dir", projectDir, "--verbose"], {
          encoding: "utf-8",
          env: { ...process.env, AIDLC_HARNESS_DIR: ".kiro", AIDLC_INSTALL_ROOT: installRoot },
        });
        return `${result.stdout ?? ""}${result.stderr ?? ""}`;
      };
      const ide = run(KIRO_IDE);
      expect(ide).toContain("ok    agents/aidlc.{json,md} present (conductor wiring)");
      expect(ide).not.toContain("settings/cli.json present");
      const pin = 'settings/cli.json pins "chat.agentEngine": "v3" and "chat.defaultAgent": "aidlc"';
      expect(ide).toContain(`ok    ${pin}`);
      // A missing, malformed, or changed pin leaves Kiro CLI on an engine that
      // runs no project hooks, so each must fail rather than report clean.
      for (const [label, content] of [
        ["missing", null],
        ["malformed", "{\n"],
        ["v2 engine", `${JSON.stringify({ "chat.agentEngine": "v2", "chat.defaultAgent": "aidlc" }, null, 2)}\n`],
        ["other agent", `${JSON.stringify({ "chat.agentEngine": "v3", "chat.defaultAgent": "kiro_default" }, null, 2)}\n`],
      ] as const) {
        const project = mkdtempSync(join(tmpdir(), "t148-cli-pin-"));
        try {
          cpSync(KIRO_IDE, project, { recursive: true });
          const settings = join(project, ".kiro", "settings", "cli.json");
          if (content === null) rmSync(settings);
          else writeFileSync(settings, content);
          const report = run(project);
          expect(report, label).toContain(`fail  ${pin}`);
          // The repair keeps the project's own keys; --force is the fallback.
          expect(report, label).toContain("in .kiro/settings/cli.json and keep its other keys");
        } finally {
          rmSync(project, { recursive: true, force: true });
        }
      }

      const cli = run(KIRO);
      expect(cli).toContain("ok    agents/aidlc.{json,md} present (conductor wiring)");
      expect(cli).toContain(
        "ok    settings/cli.json present (workspace default-agent activation)",
      );
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
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
      expect(h.command).toContain("aidlc.ts engine adapter kiro");
    }
    const preMatchers = (hooks.preToolUse ?? []).map((h) => h.matcher).sort();
    expect(preMatchers).toEqual([
      "execute_bash",
      "execute_bash",
      "execute_bash",
      "execute_bash",
      "fs_write",
      "fs_write",
      "subagent",
      "subagent",
    ]);
    expect(
      (hooks.preToolUse ?? []).find((h) => h.matcher === "fs_write")?.command,
    ).toContain("aidlc.ts engine adapter kiro review-freeze");
    expect(
      (hooks.preToolUse ?? []).filter((h) => h.matcher === "execute_bash")
        .some((h) => h.command.includes("aidlc.ts engine adapter kiro review-freeze")),
    ).toBe(true);
    const subagentCommands = (hooks.preToolUse ?? [])
      .filter((h) => h.matcher === "subagent")
      .map((h) => h.command)
      .sort();
    expect(subagentCommands).toEqual([
      "bun .kiro/tools/aidlc.ts engine adapter kiro deliver-stage-rules",
      "bun .kiro/tools/aidlc.ts engine adapter kiro plan-approval-guard",
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
      const plan = registrationMatchers(config, "preToolUse", "plan-approval-guard");
      const audit = registrationMatchers(config, "postToolUse", "audit-and-sensors");
      for (const tool of REGISTRATION_TOOL_NAMES.writes) {
        expect(
          freeze.filter((matcher) => matchesKiroMatcher(matcher, tool)),
          `${name}: freeze selection for ${tool}`,
        ).toHaveLength(1);
        expect(
          plan.filter((matcher) => matchesKiroMatcher(matcher, tool)),
          `${name}: plan approval selection for ${tool}`,
        ).toHaveLength(1);
        expect(
          audit.filter((matcher) => matchesKiroMatcher(matcher, tool)),
          `${name}: audit selection for ${tool}`,
        ).toHaveLength(1);
      }
      expect(
        plan.filter((matcher) => matchesKiroMatcher(matcher, "execute_bash")),
        `${name}: plan approval shell selection`,
      ).toHaveLength(1);
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

  test("Kiro CLI standalone v3 hooks enforce human turns and plan approval", () => {
    const hooks = join(K, "hooks");
    const human = JSON.parse(
      readFileSync(join(hooks, "aidlc-record-human-turn.kiro.hook"), "utf-8"),
    ) as { when: { type: string }; then: { command: string } };
    const plan = JSON.parse(
      readFileSync(join(hooks, "aidlc-plan-approval-guard.kiro.hook"), "utf-8"),
    ) as { when: { type: string; toolTypes: string[] }; then: { command: string } };
    expect(human.when.type).toBe("promptSubmit");
    expect(human.then.command).toContain("tools/aidlc.ts engine hook record-human-turn");
    expect(plan.when.type).toBe("preToolUse");
    expect(plan.when.toolTypes).toEqual([
      "write",
      "shell",
      "subagent",
      ".*invoke_sub_agent.*",
    ]);
    expect(plan.then.command).toContain("plan-approval-guard");
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
