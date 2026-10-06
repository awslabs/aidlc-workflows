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
import { CONFIG_SECTIONS } from "../../core/tools/aidlc-command.ts";
import { copyChannelDispatcherCommands, ROUTES } from "../../core/tools/aidlc.ts";

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
    const runsUnprompted = (rule: { match: string[]; exclude: string[] }, allows: string[], command: string): boolean =>
      partsOf(command).every((part) => allows.some((allow) => denyMatches(allow, part)) && !deniesPart(rule, part));
    // Each refused command is one the guard refuses a delegate, spelled as
    // written, re-quoted, re-spaced, or with a flag before the verb; each
    // allowed one is a command personas run.
    const channels = [
      {
        tree: "dist",
        // The copy channel's conductor also runs AI-DLC's read-only dispatcher
        // commands, each exactly as written, as the other copy channels do.
        allows: [
          "bun .kiro/tools/aidlc-*",
          "bun .kiro/tools/aidlc.ts engine *",
          ...copyChannelDispatcherCommands().map((command) => `bun .kiro/tools/aidlc.ts ${command}`),
        ],
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
          "bun .kiro/tools/aidlc-machine-config.ts global get offline",
          "bun .kiro/tools/aidlc-machine-config.ts global set offline on",
        ],
        // The guard does not refuse these, but no persona is admitted them: a
        // verb the tool may gain later, writers no persona is given, and audit
        // appends, diagnostics included.
        unadmitted: [
          "bun .kiro/tools/aidlc-graph.ts future-authority x",
          "bun .kiro/tools/aidlc-knowledge.ts summarize x",
          "bun .kiro/tools/aidlc-runtime.ts compile",
          "bun .kiro/tools/aidlc-utility.ts plugin-build test-pro",
          "bun .kiro/tools/aidlc-utility.ts doctor",
          "bun .kiro/tools/aidlc-init.ts --yes",
          "bun .kiro/tools/aidlc-audit.ts append ERROR_LOGGED --field Details=x",
          "bun .kiro/tools/aidlc-audit.ts append PRACTICES_SECTION_EMPTY --field Details=x",
          "bun .kiro/tools/aidlc-audit.ts append-raw Note body",
          // The conductor reads settings and runs doctor with no card; no
          // persona is admitted either.
          "bun .kiro/tools/aidlc.ts config models --show --json",
          "bun .kiro/tools/aidlc.ts config flags --help",
          "bun .kiro/tools/aidlc.ts doctor",
          "bun .kiro/tools/aidlc.ts --doctor",
        ],
        // The guard does not refuse these, and only pipeline-deploy is admitted them.
        roleOnly: [
          "bun .kiro/tools/aidlc-worktree.ts create --slug u1 --base main",
          "bun .kiro/tools/aidlc-worktree.ts merge --slug u1 --target main --strategy squash",
          "bun .kiro/tools/aidlc-worktree.ts discard --slug u1",
          "bun .kiro/tools/aidlc-worktree.ts restore --slug u1 --parked 20261004T000000Z",
        ],
        foreign: "bun .kiro/tools/aidlc-log.ts answers --stage x && rm -rf docs",
        hostOnly: ["bun .kiro/tools/aidlc-sensor-linter.ts --stage code-generation"],
        allowed: [
          "bun .kiro/tools/aidlc-utility.ts project-description",
          "bun .kiro/tools/aidlc-utility.ts codekb-snapshot --unit u1",
          "bun .kiro/tools/aidlc-utility.ts version",
          "bun .kiro/tools/aidlc-log.ts answers --stage x",
          "bun .kiro/tools/aidlc-testing-posture.ts brief --unit u1",
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
          "bun .kiro/tools/aidlc-utility.ts document-input --onboard --include-ignored",
          "bun .kiro/tools/aidlc-worktree.ts info --slug u1",
          "bun .kiro/tools/aidlc-audit.ts history",
          "bun .kiro/tools/aidlc-utility.ts select-plugins --no-color",
          "bun .kiro/tools/aidlc-utility.ts intent --quiet",
        ],
      },
      {
        tree: "dist-release",
        // The native conductor also runs the same read-only and turn-back-on
        // commands, each exactly as written, through the installed aidlc.
        allows: ["aidlc engine *", ...copyChannelDispatcherCommands().map((command) => `aidlc ${command}`)],
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
        unadmitted: [
          "aidlc engine graph future-authority x",
          "aidlc engine knowledge summarize x",
          "aidlc engine runtime compile",
          "aidlc engine plugin build test-pro",
          "aidlc engine gen runners",
          "aidlc engine scope detect",
          "aidlc engine audit append ERROR_LOGGED --field Details=x",
          "aidlc engine audit append PRACTICES_SECTION_EMPTY --field Details=x",
          // The conductor reads settings, runs doctor and turns a check back
          // on with no card; no persona is admitted any of them.
          "aidlc config models --show",
          "aidlc config models --show --json",
          "aidlc config flags --help",
          "aidlc config --help",
          "aidlc doctor",
          "aidlc --doctor",
          "aidlc --status",
          "aidlc --version",
          "aidlc config flags --clear-bypass AIDLC_DISABLE_SENSORS --yes",
        ],
        roleOnly: [
          "aidlc engine worktree create --slug u1 --base main",
          "aidlc engine worktree merge --slug u1 --target main --strategy squash",
          "aidlc engine worktree discard --slug u1",
          "aidlc engine worktree restore --slug u1 --parked 20261004T000000Z",
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
          "aidlc engine state lookup phase-of code-generation",
          "aidlc engine intent list",
          "aidlc engine intent",
          "aidlc engine intent --json",
          "aidlc engine space -h",
          "aidlc engine plugin select",
          "aidlc engine plugin select --json",
          "aidlc engine testing-posture brief --unit u1",
          "aidlc engine workspace document-input --onboard",
          "aidlc engine worktree info --slug u1",
          "aidlc engine audit history",
          "aidlc engine plugin select --no-color",
          "aidlc engine gen stage-table",
        ],
      },
    ];
    // The copy channel's conductor also allows the dispatcher's engine
    // namespace, so its persona deny covers the native channel's routes
    // spelled through the copy dispatcher.
    const [copy, native] = channels;
    const viaDispatcher = (commands: string[]): string[] =>
      commands.filter((command) => command.startsWith("aidlc engine"))
        .map((command) => command.replaceAll("aidlc engine", "bun .kiro/tools/aidlc.ts engine"));
    copy.refused.push(...viaDispatcher(native.refused));
    copy.unadmitted.push(...viaDispatcher(native.unadmitted));
    copy.roleOnly.push(...viaDispatcher(native.roleOnly));
    copy.hostOnly.push(...viaDispatcher(native.hostOnly));
    copy.allowed.push(...viaDispatcher(native.allowed));
    for (const { tree, allows, refused, unadmitted, roleOnly, foreign, hostOnly, allowed } of channels) {
      for (const command of refused) expect(delegatedLifecycleCommand(command), command).not.toBeNull();
      for (const command of [...unadmitted, ...roleOnly]) expect(delegatedLifecycleCommand(command), command).toBeNull();
      for (const command of allowed) expect(delegatedLifecycleCommand(command), command).toBeNull();
      const agents = join(REPO_ROOT, tree, "kiro-ide", ".kiro", "agents");
      for (const allow of allows) {
        expect(frontmatter(join(agents, "aidlc.md")), `${tree} conductor`).toContain(`        - "${allow}"`);
      }
      expect(readdirSync(agents), `${tree} agents`).toContain("aidlc-pipeline-deploy-agent.md");
      for (const file of readdirSync(agents).filter((name) => name.endsWith("-agent.md"))) {
        const rule = ruleOf(join(agents, file));
        expect(rule.match, `${tree} ${file}`).toEqual(allows);
        for (const command of refused) expect(denies(rule, command), `${tree} ${file}: ${command}`).toBe(true);
        // Host-only routing surfaces (hooks, the adapter, sensors) stay denied
        // though no lifecycle rule names them.
        for (const command of hostOnly) expect(denies(rule, command), `${tree} ${file}: ${command}`).toBe(true);
        // A command the guard lets through stays denied unless it is admitted.
        for (const command of unadmitted) expect(denies(rule, command), `${tree} ${file}: ${command}`).toBe(true);
        // An allowed command with a foreign command appended still asks.
        expect(runsUnprompted(rule, allows, foreign), `${tree} ${file}: ${foreign}`).toBe(false);
        for (const command of allowed) {
          expect(runsUnprompted(rule, allows, command), `${tree} ${file}: ${command}`).toBe(true);
        }
        const ownRole = file === "aidlc-pipeline-deploy-agent.md";
        for (const command of roleOnly) {
          expect(runsUnprompted(rule, allows, command), `${tree} ${file}: ${command}`).toBe(ownRole);
          expect(denies(rule, command), `${tree} ${file}: ${command}`).toBe(!ownRole);
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
    // Kiro's / menu turns a bare /aidlc + Enter into a specialist's name; the
    // conductor reads that whole message as /aidlc.
    expect(body).toContain(
      "when their whole message is one of those, treat it as `/aidlc` with nothing after it, and say nothing about it.",
    );
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

  // Kiro's documented shell matching (kiro.dev/docs/permissions): a command
  // is split at ; && || | and each part is checked on its own; `*` matches any
  // sequence of characters; a rule hits when one of its match patterns does
  // and none of its excludes does; deny > ask > allow across every rule. The
  // most restrictive part decides ("none" is a card, like ask). Patterns are
  // YAML double-quoted strings, so "\n" in one is a line break.
  const EFFECT_ORDER = ["deny", "ask", "none", "allow"] as const;
  type KiroEffect = (typeof EFFECT_ORDER)[number];
  function kiroPartEffect(fm: string, command: string): KiroEffect {
    const effects = new Set<string>();
    const globOf = (raw: string): RegExp => {
      const pattern = JSON.parse(`"${raw}"`) as string;
      return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*")}$`);
    };
    for (const block of fm.split(/\n {4}- /).slice(1)) {
      if (!/^capability: shell\b/m.test(block)) continue;
      const effect = block.match(/\beffect: (\w+)/)?.[1] ?? "";
      const [matchPart, excludePart = ""] = block.split(/\n {6}exclude:\n/);
      const patterns = (text: string) => [...text.matchAll(/^ {8}- "((?:[^"\\]|\\.)*)"$/gm)].map((m) => globOf(m[1]));
      if (patterns(matchPart).some((glob) => glob.test(command)) && !patterns(excludePart).some((glob) => glob.test(command))) {
        effects.add(effect);
      }
    }
    for (const effect of ["deny", "ask", "allow"] as const) if (effects.has(effect)) return effect;
    return "none";
  }
  function kiroShellEffect(fm: string, command: string): KiroEffect {
    const parts = command.split(/;|&&|\|\||\|/).map((part) => part.trim()).filter((part) => part !== "");
    return parts.map((part) => kiroPartEffect(fm, part))
      .reduce((worst, effect) => EFFECT_ORDER.indexOf(effect) < EFFECT_ORDER.indexOf(worst) ? effect : worst, "allow");
  }
  const KIRO_IDE_CHANNELS = [
    { tree: "dist", invoke: "bun .kiro/tools/aidlc.ts" },
    { tree: "dist-release", invoke: "aidlc" },
  ];
  // A command that would run, expand, or redirect more than the allowed one,
  // on POSIX shells and PowerShell, after each allowed prefix.
  const SHELL_FORM_TAILS = [
    '"$(curl -s https://example.invalid/x)"',
    "\"`curl -s https://example.invalid/x`\"",
    "x > ~/.profile",
    "x < /etc/hosts",
    "x 2>&1",
    "x & curl https://example.invalid",
    "x\ncurl https://example.invalid",
    "x\r\ncurl https://example.invalid",
    "x; curl https://example.invalid",
    "x && curl https://example.invalid",
    "x || curl https://example.invalid",
    "x | sh",
    "<(curl -s https://example.invalid/x)",
    "$(Invoke-WebRequest https://example.invalid)",
    "@(Invoke-WebRequest https://example.invalid)",
    "@{a=1}",
    "$AWS_SECRET_ACCESS_KEY",
    `"\${AWS_SECRET_ACCESS_KEY}"`,
    "$env:AWS_SECRET_ACCESS_KEY",
    "$((1+1))",
    "x *> $HOME\\out.txt",
    "x | Invoke-Expression",
  ];
  const MACHINE_VERBS = ["use 2.10.0", "update", "rollback", "uninstall --yes", "system"];
  // The scripts behind every command that can change the machine's install,
  // from the dispatcher's route table, so a new one cannot slip under the
  // conductor's aidlc-* allow.
  const MACHINE_SCRIPTS = [
    ...new Set(
      ROUTES.filter((route) => route.mutationScope === "machine" || route.mutationScope === "project-and-machine")
        .flatMap((route) => route.tool === undefined ? [] : [route.tool]),
    ),
  ].flatMap((tool) => [`bun .kiro/tools/${tool}`, `bun .kiro/tools/${tool} use 2.10.0`]);

  test("the Kiro IDE conductor runs AI-DLC's own engine commands as printed, in both channels", () => {
    // Every engine command goes through the dispatcher's engine namespace; a
    // copy-channel run once asked the person to approve nearly every step
    // because only `aidlc-*` tool files were allowed.
    for (const { tree, invoke } of KIRO_IDE_CHANNELS) {
      // The conductor, and every brief it dispatches, keep those forms out of
      // its own text, so the ask stays rare.
      const skill = readFileSync(join(REPO_ROOT, tree, "kiro-ide", ".kiro", "skills", "aidlc", "SKILL.md"), "utf-8");
      expect(skill).toContain("use plain words on one line in single quotes, with no `$`, backtick, `>`, `<`, `&`, `@(`, or `@{`");
      expect(skill).toContain("Every agent brief you dispatch carries these two sentences as written.");
      const fm = frontmatter(join(REPO_ROOT, tree, "kiro-ide", ".kiro", "agents", "aidlc.md"));
      // Ordinary engine commands, a quoted label included, run with no card.
      for (const command of [
        "bun --version",
        `${invoke} engine orchestrate next`,
        `${invoke} engine orchestrate report --stage requirements-analysis --result awaiting-approval`,
        `${invoke} engine log answer --stage requirements-analysis --details "A"`,
        `${invoke} engine orchestrate report --stage requirements-analysis --result approved --user-input 'Approve (Recommended)'`,
        `${invoke} engine orchestrate continue AbC-12_x`,
        `${invoke} engine log decision --stage delivery-planning --checkpoint verification-command --command-file verification-command.txt --decision "Use this command to verify each completed Unit?" --options "Approve,Request Changes"`,
        ...(tree === "dist" ? ["bun .kiro/tools/aidlc-utility.ts codekb-path"] : []),
      ]) {
        expect(kiroShellEffect(fm, command), `${tree} conductor: ${command}`).toBe("allow");
      }
      // Only the engine namespace: the verbs that change the machine's
      // install show Kiro's own card, as on the native install.
      for (const verb of MACHINE_VERBS) {
        expect(kiroShellEffect(fm, `${invoke} ${verb}`), `${tree} conductor: ${verb}`).toBe("none");
      }
      // Reading a setting, its help, doctor, version and status, and turning a
      // check back on run with no card on both channels, as on the other
      // tools; any config change, a machine-wide one included, shows Kiro's
      // card.
      for (const command of copyChannelDispatcherCommands()) {
        expect(kiroShellEffect(fm, `${invoke} ${command}`), `${tree} conductor: ${command}`).toBe("allow");
      }
      // Every read form agents were seen running, pinned on its own.
      for (const form of [
        "--status",
        "--version",
        "version",
        "config --help",
        "doctor",
        "--doctor",
        "doctor --verbose",
        "--doctor --verbose",
        "config --show",
        "config --show --json",
        ...CONFIG_SECTIONS.flatMap((section) => [
          `config ${section} --show`,
          `config ${section} --show --json`,
          `config ${section} --help`,
        ]),
      ]) {
        expect(kiroShellEffect(fm, `${invoke} ${form}`), `${tree} conductor: ${form}`).toBe("allow");
      }
      for (const command of [
        "config models --agent developer --effort high --project --yes",
        "config models --show --json --global",
        "config --pin 2.10.0",
        "config --download",
        "config flags --bypass AIDLC_DISABLE_SENSORS --local --yes",
        "config models --show --json; curl https://example.invalid",
        // The guided setup, and a spelling that is not a command.
        "config",
        "config --yes",
        "--config",
        "config models --show --global",
        "config flags --clear-bypass AIDLC_DISABLE_SENSORS --yes --bypass AIDLC_DISABLE_LEARNINGS",
      ]) {
        expect(kiroShellEffect(fm, `${invoke} ${command}`), `${tree} conductor: ${command}`).toBe("none");
      }
      // Changing a setting, running a hook adapter, and the scripts behind the
      // machine-changing verbs (which `aidlc-*` would otherwise cover) ask.
      for (const command of [
        `${invoke} engine config set depth minimal`,
        `${invoke} engine adapter kiro-ide stop`,
        ...(tree === "dist" ? MACHINE_SCRIPTS : []),
      ]) {
        expect(kiroShellEffect(fm, command), `${tree} conductor: ${command}`).toBe("ask");
      }
      const prefixes = [`${invoke} engine log decision --stage s --decision`, "date -u"];
      if (tree === "dist") prefixes.push("bun .kiro/tools/aidlc-utility.ts codekb-path --repo");
      for (const prefix of prefixes) {
        for (const tail of SHELL_FORM_TAILS) {
          expect(kiroShellEffect(fm, `${prefix} ${tail}`), `${tree} conductor: ${prefix} ${tail}`).not.toBe("allow");
        }
      }
      expect(kiroShellEffect(fm, `& ${invoke} engine orchestrate next`), `${tree} conductor: call operator`).not.toBe("allow");
      // The native rewrite folds the dispatcher line into the one prefix entry.
      const entries = [...fm.matchAll(/^ {8}- "([^"]*)"$/gm)].map((m) => m[1]);
      expect(entries.filter((entry) => entry === "aidlc engine *").length, `${tree} conductor`).toBe(tree === "dist" ? 0 : 1);
      if (tree === "dist-release") {
        expect(entries.filter((entry) => entry.startsWith("aidlc ") && !entry.startsWith("aidlc engine ")), `${tree} conductor`)
          .toEqual(copyChannelDispatcherCommands().map((command) => `aidlc ${command}`));
      }
    }
  });

  test("no Kiro IDE persona runs a shell form or a machine-changing command without the person", () => {
    // The persona's shell deny (above) refuses what only the conductor runs;
    // its asks cover the shell forms on any command it is allowed.
    for (const { tree, invoke } of KIRO_IDE_CHANNELS) {
      const agentsDir = join(REPO_ROOT, tree, "kiro-ide", ".kiro", "agents");
      const personas = readdirSync(agentsDir).filter((name) => name.endsWith("-agent.md"));
      expect(personas.length).toBe(14);
      for (const persona of personas) {
        const fm = frontmatter(join(agentsDir, persona));
        const prefixes = ["date -u", `${invoke} engine log answers --stage x --details`];
        if (tree === "dist") prefixes.push("bun .kiro/tools/aidlc-log.ts answers --stage x --details");
        for (const prefix of prefixes) {
          for (const tail of SHELL_FORM_TAILS) {
            expect(kiroShellEffect(fm, `${prefix} ${tail}`), `${tree} ${persona}: ${prefix} ${tail}`).not.toBe("allow");
          }
        }
        for (const command of [
          ...MACHINE_VERBS.map((verb) => `${invoke} ${verb}`),
          `${invoke} engine config set depth minimal`,
          `${invoke} engine adapter kiro-ide stop`,
          ...(tree === "dist" ? MACHINE_SCRIPTS : []),
        ]) {
          expect(kiroShellEffect(fm, command), `${tree} ${persona}: ${command}`).not.toBe("allow");
        }
        // A delegate runs under the conductor's allow and its own deny, so a
        // risky form on an AI-DLC command it is admitted (or on `date -u`) is
        // refused outright, whatever ask Kiro applies to the call; the plain
        // command still runs.
        const admitted = [`${invoke} engine log answers --stage x`, "date -u"];
        if (tree === "dist") admitted.push("bun .kiro/tools/aidlc-log.ts answers --stage x");
        for (const command of admitted) {
          expect(kiroShellEffect(fm, command), `${tree} ${persona}: ${command}`).not.toBe("deny");
          for (const tail of ["$HOME", "`id`", "x > out.txt", "x < in.txt", "x & y", "@(1)", "@{a=1}", "x\ny", "x\r\ny"]) {
            expect(kiroShellEffect(fm, `${command} ${tail}`), `${tree} ${persona}: ${command} ${tail}`).toBe("deny");
          }
        }
      }
    }
  });

  // Kiro (IDE 1.1 and 1.2, and the v3 engine Kiro CLI shares with it) compiles
  // an agent's permissions.rules into ONE Cedar policy set: each pattern becomes
  // `resource.path like "<pattern>"`, with `**` folded to `*`, every `\` doubled
  // and `"` escaped, plus `resource.path == "<prefix>"` for a pattern ending in
  // " *" whose prefix has no `*` or `?`. When Cedar rejects one policy, Kiro
  // drops the whole set and asks before every command, an allowed one included.
  // Measured against the Cedar Kiro bundles (cedar-wasm 4.9.1): of every control
  // character and the punctuation the rules use, only a carriage return is
  // rejected ("not a valid escape"). Kiro CLI's own agents are JSON with
  // allowedCommands regular expressions, which its v2 engine matches without
  // Cedar and its v3 engine does not read, so they carry no permissions.rules;
  // any built Kiro agent that does is checked here.
  test("every rule a built Kiro agent carries compiles in Kiro's policy engine", () => {
    const cedarLiteral = (pattern: string) => pattern.replace(/\*\*/g, "*").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const cedarRejects = (literal: string): string | null => {
      for (let index = 0; index < literal.length; index++) {
        const char = literal[index];
        if (char === "\r") return `carriage return at ${index}`;
        if (char !== "\\") continue;
        const rest = literal.slice(index + 1);
        if (/^u\{[0-9a-fA-F]{1,6}\}/.test(rest)) continue;
        if (!/^[\\"'nrt0*]/.test(rest)) return `escape \\${rest[0] ?? ""} at ${index}`;
        index++;
      }
      return null;
    };
    const agentDirs: string[] = [];
    for (const tree of ["dist", "dist-release"]) {
      const root = join(REPO_ROOT, tree);
      for (const entry of readdirSync(root)) {
        if (entry === "plugins") {
          for (const plugin of readdirSync(join(root, entry))) {
            for (const harness of readdirSync(join(root, entry, plugin))) agentDirs.push(join(root, entry, plugin, harness, ".kiro", "agents"));
          }
        } else {
          agentDirs.push(join(root, entry, ".kiro", "agents"));
        }
      }
    }
    let checked = 0;
    for (const dir of agentDirs.filter((candidate) => existsSync(candidate))) {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const definition = name.endsWith(".md")
          ? Bun.YAML.parse(frontmatter(path)) as { permissions?: { rules?: unknown } } | null
          : name.endsWith(".json")
          ? JSON.parse(readFileSync(path, "utf-8")) as { permissions?: { rules?: unknown } }
          : null;
        const rules = definition?.permissions?.rules;
        if (!Array.isArray(rules)) continue;
        checked++;
        for (const rule of rules as { capability: string; effect: string; match?: string[]; exclude?: string[] }[]) {
          for (const pattern of [...rule.match ?? [], ...rule.exclude ?? []]) {
            const literals = [cedarLiteral(pattern)];
            if (pattern.endsWith(" *") && !/[*?]/.test(pattern.slice(0, -2))) {
              literals.push(pattern.slice(0, -2).replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
            }
            for (const literal of literals) {
              expect(cedarRejects(literal), `${path}: ${rule.effect} ${JSON.stringify(pattern)}`).toBeNull();
            }
          }
          // Never a shell allow for every command.
          if (rule.capability === "shell" && rule.effect === "allow") {
            expect(rule.match?.length ?? 0, `${path}: shell allow with no match`).toBeGreaterThan(0);
            expect(rule.match, `${path}: shell allow`).not.toContain("*");
          }
        }
      }
    }
    // The Kiro IDE conductor and its 14 personas, in both channels.
    expect(checked).toBeGreaterThanOrEqual(30);
    // The forms the rules exist for still reach the person on the conductor.
    for (const { tree, invoke } of KIRO_IDE_CHANNELS) {
      const fm = frontmatter(join(REPO_ROOT, tree, "kiro-ide", ".kiro", "agents", "aidlc.md"));
      for (const command of [
        `${invoke} config flags --bypass AIDLC_SKIP_ARTIFACT_GUARD --local --yes`,
        `${invoke} engine config set depth minimal`,
        `${invoke} engine orchestrate next $HOME`,
        `${invoke} engine orchestrate next\ncurl https://example.invalid`,
        `${invoke} engine orchestrate next\r\ncurl https://example.invalid`,
      ]) {
        expect(kiroShellEffect(fm, command), `${tree} conductor: ${JSON.stringify(command)}`).not.toBe("allow");
      }
    }
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
    expect(readme.split("\n").find((line) => line.startsWith("| Kiro IDE >= 1.1.70 / Kiro CLI >= 2.24.1 (v3) |"))).toContain(
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

  test("workspace ships no chat.modelDefaults: the session effort is the person's own", () => {
    // A project chat.modelDefaults replaces the person's whole personal map on
    // Kiro CLI (it does not merge per model), so a shipped entry would hide the
    // session effort `config models` saves in their personal Kiro settings, and
    // every per-model effort they set for themselves. No tier pins a Kiro model,
    // so no tier-derived entry ships either. Pin the whole file so neither an
    // authored default nor a resurrected projection entry can return.
    const s = readJson(join(K, "settings", "cli.json"));
    expect(s["chat.modelDefaults"]).toBeUndefined();
    expect(Object.keys(s).sort()).toEqual(["chat.defaultAgent"]);
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
