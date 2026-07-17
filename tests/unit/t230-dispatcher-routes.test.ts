// covers: tool:aidlc, tool:aidlc-sensor, tool:aidlc-swarm, hook:aidlc-validate-state, hook:aidlc-statusline
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  ROUTES,
  SLASH_FLAG_ALIASES,
  TOOLS,
  renderAllHelp,
  renderHumanHelp,
  resolveAction,
} from "../../core/tools/aidlc.ts";
import {
  cleanupTestProject,
  createTestProject,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUN = process.execPath;
const CORE_TOOLS_DIR = join(REPO_ROOT, "core", "tools");
const DIST_TOOLS_DIR = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const DISPATCHER = join(CORE_TOOLS_DIR, "aidlc.ts");

type RunResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
};

const tempProjects = new Set<string>();
let compiledRoot: string | null = null;
let compiledDispatcher: string | null = null;

afterAll(() => {
  for (const project of tempProjects) cleanupTestProject(project);
  if (compiledRoot) rmSync(compiledRoot, { recursive: true, force: true });
});

function makeProject(): string {
  const project = createTestProject();
  tempProjects.add(project);
  return project;
}

function childEnv(projectDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    CLAUDE_PROJECT_DIR: projectDir,
  };
  delete env.AIDLC_SENSORS_DIR;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

function run(
  cmd: string[],
  projectDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
  stdin?: string,
): RunResult {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: projectDir,
    env: childEnv(projectDir, extraEnv),
    input: stdin,
    timeout: 15000,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status,
    stdout: Buffer.from(result.stdout ?? new Uint8Array()),
    stderr: Buffer.from(result.stderr ?? new Uint8Array()),
  };
}

function direct(tool: string, args: string[], projectDir: string): RunResult {
  return run([BUN, join(CORE_TOOLS_DIR, tool), ...args], projectDir);
}

function viaDispatcher(args: string[], projectDir: string, extraEnv: NodeJS.ProcessEnv = {}, stdin?: string): RunResult {
  return run(
    [BUN, DISPATCHER, ...args],
    projectDir,
    { AIDLC_DISPATCH_TOOLS_DIR: CORE_TOOLS_DIR, ...extraEnv },
    stdin,
  );
}

function expectSameRun(actual: RunResult, expected: RunResult, label: string): void {
  expect(actual.exitCode, `${label} exit`).toBe(expected.exitCode);
  expect(actual.stdout.equals(expected.stdout), `${label} stdout\nactual:\n${actual.stdout}\nexpected:\n${expected.stdout}`).toBe(true);
  expect(actual.stderr.equals(expected.stderr), `${label} stderr\nactual:\n${actual.stderr}\nexpected:\n${expected.stderr}`).toBe(true);
}

function entriesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const rel = relative(root, abs).replace(/\\/g, "/");
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(`${rel}/`);
      for (const child of entriesUnder(abs)) out.push(`${rel}/${child}`);
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function materializedCompiledDispatcher(): string {
  if (compiledDispatcher) return compiledDispatcher;
  compiledRoot = mkdtempSync(join(tmpdir(), "aidlc-t230-"));
  const targetRoot = join(compiledRoot, "$bunfs");
  const targetTools = join(targetRoot, "tools");
  cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), targetRoot, { recursive: true });
  cpSync(CORE_TOOLS_DIR, targetTools, { recursive: true });
  compiledDispatcher = join(targetTools, "aidlc.ts");
  return compiledDispatcher;
}

function viaImportedCompiledMain(
  args: string[],
  projectDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): RunResult {
  const dispatcherUrl = pathToFileURL(materializedCompiledDispatcher()).href;
  const code = [
    `const mod = await import(${JSON.stringify(dispatcherUrl)});`,
    `await mod.main(${JSON.stringify(args)});`,
    "process.exit(process.exitCode ?? 0);",
  ].join("\n");
  return run(
    [BUN, "--eval", code],
    projectDir,
    { AIDLC_DISPATCH_TOOLS_DIR: DIST_TOOLS_DIR, ...extraEnv },
  );
}

function routeForms(route: (typeof ROUTES)[number]): string[] {
  return [...(route.all ?? route.verbs)];
}

function parseAllHelp(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const lines = renderAllHelp().trimEnd().split("\n");
  const topStart = lines.indexOf("Top level:");
  const plumbingStart = lines.indexOf("Plumbing:");
  const aliasStart = lines.indexOf("Slash-flag aliases:");

  groups.set(
    "top",
    lines.slice(topStart + 1, plumbingStart - 2).map((line) => line.trim()),
  );
  for (const line of lines.slice(plumbingStart + 1, aliasStart - 1)) {
    const m = /^ {2}([a-z-]+): (.*)$/.exec(line);
    if (!m) continue;
    groups.set(m[1], m[2].split(", "));
  }
  return groups;
}

function writeMinimalState(projectDir: string, stage = "intent-capture"): void {
  writeFileSync(
    seededStateFile(projectDir),
    [
      "# AI-DLC State Tracking",
      "## Current Status",
      "- **Lifecycle Phase**: IDEATION",
      `- **Current Stage**: ${stage}`,
      "- **Status**: Running",
      "- **Active Agent**: aidlc-product-agent",
      "- **Depth**: Standard",
      "- **Test Strategy**: Standard",
      "## Stage Progress",
      "- [ ] Intent Capture [intent-capture]",
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("t230 dispatcher route parity", () => {
  const cases: Array<{
    name: string;
    routerArgs: string[];
    tool: string;
    toolArgs: string[];
    fixture?: boolean;
  }> = [
    {
      name: "compose translates to orchestrate next compose",
      routerArgs: ["compose"],
      tool: "aidlc-orchestrate.ts",
      toolArgs: ["next", "compose"],
    },
    {
      name: "version is static and byte-compatible with utility",
      routerArgs: ["version"],
      tool: "aidlc-utility.ts",
      toolArgs: ["version"],
    },
    {
      name: "state set-status maps to utility",
      routerArgs: ["state", "set-status"],
      tool: "aidlc-utility.ts",
      toolArgs: ["set-status"],
    },
    {
      name: "state init maps to utility",
      routerArgs: ["state", "init"],
      tool: "aidlc-utility.ts",
      toolArgs: ["state-init"],
    },
    {
      name: "audit fork maps to audit-fork",
      routerArgs: ["audit", "fork"],
      tool: "aidlc-audit.ts",
      toolArgs: ["audit-fork"],
    },
    {
      name: "audit merge maps to audit-merge",
      routerArgs: ["audit", "merge"],
      tool: "aidlc-audit.ts",
      toolArgs: ["audit-merge"],
    },
    {
      name: "intent list maps through workspace parser",
      routerArgs: ["intent", "list"],
      tool: "aidlc-utility.ts",
      toolArgs: ["intent"],
      fixture: true,
    },
    {
      name: "intent list json maps through workspace parser",
      routerArgs: ["intent", "list", "--json"],
      tool: "aidlc-utility.ts",
      toolArgs: ["intent", "--json"],
      fixture: true,
    },
    {
      name: "intent switch maps through workspace parser",
      routerArgs: ["intent", "switch", "fixture-8000000000000001"],
      tool: "aidlc-utility.ts",
      toolArgs: ["intent", "switch", "fixture-8000000000000001"],
      fixture: true,
    },
    {
      name: "intent birth maps through workspace parser",
      routerArgs: ["intent", "birth"],
      tool: "aidlc-utility.ts",
      toolArgs: ["intent-birth"],
    },
    {
      name: "space list maps through workspace parser",
      routerArgs: ["space", "list"],
      tool: "aidlc-utility.ts",
      toolArgs: ["space"],
      fixture: true,
    },
    {
      name: "space switch maps through workspace parser",
      routerArgs: ["space", "switch", "default"],
      tool: "aidlc-utility.ts",
      toolArgs: ["space", "switch", "default"],
      fixture: true,
    },
    {
      name: "scope change maps to utility",
      routerArgs: ["scope", "change"],
      tool: "aidlc-utility.ts",
      toolArgs: ["scope-change"],
    },
    {
      name: "scope detect maps to utility",
      routerArgs: ["scope", "detect"],
      tool: "aidlc-utility.ts",
      toolArgs: ["detect-scope"],
    },
    {
      name: "scope resolve-env maps to utility",
      routerArgs: ["scope", "resolve-env"],
      tool: "aidlc-utility.ts",
      toolArgs: ["resolve-env-scope"],
    },
    {
      name: "config get maps to config-get",
      routerArgs: ["config", "get", "depth"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-get", "depth"],
      fixture: true,
    },
    {
      name: "config list maps to config-list",
      routerArgs: ["config", "list"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-list"],
      fixture: true,
    },
    {
      name: "config depth maps to config-change",
      routerArgs: ["config", "set", "depth", "minimal"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-change", "--depth", "minimal"],
      fixture: true,
    },
    {
      name: "config test strategy maps to config-change",
      routerArgs: ["config", "set", "test-strategy", "standard"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-change", "--test-strategy", "standard"],
      fixture: true,
    },
    {
      name: "plugin select maps to select-plugins",
      routerArgs: ["plugin", "select"],
      tool: "aidlc-utility.ts",
      toolArgs: ["select-plugins"],
      fixture: true,
    },
    {
      name: "plugin list maps to plugin-list",
      routerArgs: ["plugin", "list"],
      tool: "aidlc-utility.ts",
      toolArgs: ["plugin-list"],
      fixture: true,
    },
    {
      name: "plugin sync maps to plugin-sync",
      routerArgs: ["plugin", "sync"],
      tool: "aidlc-utility.ts",
      toolArgs: ["plugin-sync"],
      fixture: true,
    },
    {
      name: "init maps to utility transition handler",
      routerArgs: ["init"],
      tool: "aidlc-utility.ts",
      toolArgs: ["init"],
      fixture: true,
    },
    {
      name: "upgrade maps to utility transition handler",
      routerArgs: ["upgrade"],
      tool: "aidlc-utility.ts",
      toolArgs: ["upgrade"],
      fixture: true,
    },
    {
      name: "gen runners maps to runner write",
      routerArgs: ["gen", "runners"],
      tool: "aidlc-runner-gen.ts",
      toolArgs: ["write"],
    },
    {
      name: "gen runners check maps to runner check",
      routerArgs: ["gen", "runners", "--check"],
      tool: "aidlc-runner-gen.ts",
      toolArgs: ["check"],
    },
    {
      name: "gen runner-list maps to runner list",
      routerArgs: ["gen", "runner-list"],
      tool: "aidlc-runner-gen.ts",
      toolArgs: ["list"],
    },
    {
      name: "gen runner-scopes maps to runner scopes",
      routerArgs: ["gen", "runner-scopes", "--check"],
      tool: "aidlc-runner-gen.ts",
      toolArgs: ["scopes", "--check"],
    },
    {
      name: "gen stage-table maps to utility",
      routerArgs: ["gen", "stage-table", "--check"],
      tool: "aidlc-utility.ts",
      toolArgs: ["stage-table", "--check"],
    },
    {
      name: "gen scope-table maps to utility",
      routerArgs: ["gen", "scope-table", "--check"],
      tool: "aidlc-utility.ts",
      toolArgs: ["scope-table", "--check"],
    },
    {
      name: "workspace detect maps to utility detect",
      routerArgs: ["workspace", "detect"],
      tool: "aidlc-utility.ts",
      toolArgs: ["detect"],
      fixture: true,
    },
    {
      name: "workspace codekb maps to utility codekb-path",
      routerArgs: ["workspace", "codekb"],
      tool: "aidlc-utility.ts",
      toolArgs: ["codekb-path"],
      fixture: true,
    },
    {
      name: "sensor passthrough preserves bytes",
      routerArgs: ["sensor", "list"],
      tool: "aidlc-sensor.ts",
      toolArgs: ["list"],
    },
  ];

  for (const item of cases) {
    test(`${item.name}`, () => {
      const projectDir = item.fixture ? makeProject() : REPO_ROOT;
      const routed = viaDispatcher(item.routerArgs, projectDir);
      const old = direct(item.tool, item.toolArgs, projectDir);
      expectSameRun(routed, old, item.name);
    });
  }

  test("space create mutates the same observable tree as space-create", () => {
    const directProject = makeProject();
    const routedProject = makeProject();
    const old = direct("aidlc-utility.ts", ["space-create", "router-space"], directProject);
    const routed = viaDispatcher(["space", "create", "router-space"], routedProject);

    expectSameRun(routed, old, "space create");
    expect(entriesUnder(join(routedProject, "aidlc", "spaces", "router-space"))).toEqual(
      entriesUnder(join(directProject, "aidlc", "spaces", "router-space")),
    );
  });

  test("legacy top-level space-create remains routed", () => {
    const directProject = makeProject();
    const routedProject = makeProject();
    const old = direct("aidlc-utility.ts", ["space-create", "legacy-space"], directProject);
    const routed = viaDispatcher(["space-create", "legacy-space"], routedProject);

    expectSameRun(routed, old, "space-create");
    expect(existsSync(join(routedProject, "aidlc", "spaces", "legacy-space"))).toBe(true);
  });

  test("--project-dir is global and may be interleaved with workspace tokens", () => {
    const projectDir = makeProject();
    const routed = viaDispatcher(
      ["space", "--project-dir", projectDir, "create", "interleaved-space"],
      REPO_ROOT,
    );

    expect(routed.exitCode).toBe(0);
    expect(existsSync(join(projectDir, "aidlc", "spaces", "interleaved-space"))).toBe(true);
  });
});

describe("t230 dispatcher global flag translation", () => {
  test("extracts --project-dir before noun/verb parsing and restores it for delegation", () => {
    expect(resolveAction(["space", "--project-dir", "/tmp/example", "create", "teamB"])).toEqual({
      type: "delegate",
      tool: "aidlc-utility.ts",
      args: ["space-create", "teamB", "--project-dir", "/tmp/example"],
    });
    expect(resolveAction(["--project-dir", "/tmp/example", "space-create", "teamC"])).toEqual({
      type: "delegate",
      tool: "aidlc-utility.ts",
      args: ["space-create", "teamC", "--project-dir", "/tmp/example"],
    });
    expect(resolveAction(["bolt", "start", "--project-dir", "relative/project"])).toEqual({
      type: "delegate",
      tool: "aidlc-bolt.ts",
      args: ["start", "--project-dir", resolve(process.cwd(), "relative/project")],
    });
  });

  test("carries --project-dir into routing-only actions", () => {
    const projectDir = "/tmp/routed-project";
    for (const action of [
      resolveAction(["hook", "validate-state", "--project-dir", projectDir]),
      resolveAction(["statusline", "--project-dir", projectDir]),
      resolveAction(["adapter", "codex", "validate-state", "--project-dir", projectDir]),
    ]) {
      expect("projectDir" in action ? action.projectDir : undefined).toBe(projectDir);
    }
  });

  test("sensor worker routes by registered id, never by caller-supplied path", () => {
    expect(resolveAction(["__sensor-script-file", "linter"])).toEqual({
      type: "sensor-script-file",
      id: "linter",
      args: [],
    });
    expect(resolveAction(["__sensor-script-file", "/tmp/aidlc-sensor-evil.ts"]).type).toBe("error");
  });
});

describe("t230 dispatcher dev and compiled in-process modes", () => {
  const cases = [
    { name: "version", args: ["version"] },
    { name: "graph artifacts", args: ["graph", "artifacts", "--help"] },
    { name: "sensor list", args: ["sensor", "list"] },
    { name: "state get", args: ["state", "get"] },
  ];

  for (const item of cases) {
    test(`${item.name} imported compiled main matches spawned dev dispatcher`, () => {
      const projectDir = makeProject();
      const dev = viaDispatcher(item.args, projectDir, { AIDLC_DISPATCH_TOOLS_DIR: DIST_TOOLS_DIR });
      const compiled = viaImportedCompiledMain(item.args, projectDir);
      expectSameRun(compiled, dev, item.name);
    });
  }
});

describe("t230 dispatcher route completeness", () => {
  test("help --all is generated from the route table", () => {
    const groups = parseAllHelp();
    for (const route of ROUTES) {
      const displayed = groups.get(route.group);
      expect(displayed, `missing help group ${route.group}`).toBeDefined();
      for (const form of routeForms(route)) {
        expect(displayed!.filter((item) => item === form).length, `${route.group} ${form}`).toBe(1);
      }
    }
  });

  test("every dispatcher tool target exists beside the dispatcher", () => {
    for (const tool of Object.values(TOOLS)) {
      expect(existsSync(join(CORE_TOOLS_DIR, tool)), tool).toBe(true);
    }
  });

  test("every main-exported tool is reachable from a route", () => {
    const mainExportedTools = [
      "aidlc-audit.ts",
      "aidlc-bolt.ts",
      "aidlc-graph.ts",
      "aidlc-jump.ts",
      "aidlc-learnings.ts",
      "aidlc-log.ts",
      "aidlc-orchestrate.ts",
      "aidlc-runner-gen.ts",
      "aidlc-runtime.ts",
      "aidlc-sensor-linter.ts",
      "aidlc-sensor-type-check.ts",
      "aidlc-state.ts",
      "aidlc-utility.ts",
      "aidlc-worktree.ts",
      "aidlc-sensor.ts",
      "aidlc-swarm.ts",
      "aidlc-validate.ts",
      "aidlc-sensor-required-sections.ts",
      "aidlc-sensor-upstream-coverage.ts",
    ].sort();
    const routeTargets = new Set(ROUTES.flatMap((route) => (route.tool ? [route.tool] : [])));
    if (ROUTES.some((route) => route.group === "sensor" && route.verbs.includes("fire"))) {
      routeTargets.add("aidlc-sensor-linter.ts");
      routeTargets.add("aidlc-sensor-required-sections.ts");
      routeTargets.add("aidlc-sensor-type-check.ts");
      routeTargets.add("aidlc-sensor-upstream-coverage.ts");
    }
    const missing = mainExportedTools.filter((tool) => !routeTargets.has(tool));
    expect(missing).toEqual([]);
  });
});

describe("t230 dispatcher help and errors", () => {
  test("human help stays short and hides plumbing nouns", () => {
    const text = renderHumanHelp();
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(20);
    for (const noun of [
      "state",
      "audit",
      "graph",
      "runtime",
      "sensor",
      "swarm",
      "bolt",
      "worktree",
      "jump",
      "log",
      "learnings",
      "validate",
      "hook",
      "statusline",
      "adapter",
    ]) {
      expect(text).not.toContain(`  ${noun}:`);
      expect(text).not.toContain(`${noun} <`);
    }
  });

  test("help --all contains plumbing groups, banner, and alias rows", () => {
    const text = renderAllHelp();
    expect(text).toContain("conductor protocol - not a stable scripting interface");
    for (const group of ROUTES.filter((route) => route.group !== "top").map((route) => route.group)) {
      expect(text).toContain(`  ${group}:`);
    }
    expect(text).toContain("Slash-flag aliases:");
    for (const alias of SLASH_FLAG_ALIASES) {
      expect(text).toContain(`  ${alias.from} -> ${alias.to}`);
    }
  });

  test("unknown top-level command points to the nearest help node", () => {
    const res = viaDispatcher(["bogus"], REPO_ROOT);
    expect(res.exitCode).toBe(1);
    expect(res.stdout.toString("utf-8")).toBe("");
    expect(res.stderr.toString("utf-8")).toBe("aidlc: unknown command or noun 'bogus'; try 'aidlc --help'\n");
  });

  test("unknown noun verb points to help --all", () => {
    const res = viaDispatcher(["state", "bogus"], REPO_ROOT);
    expect(res.exitCode).toBe(1);
    expect(res.stdout.toString("utf-8")).toBe("");
    expect(res.stderr.toString("utf-8")).toBe("aidlc: unknown verb 'bogus' for noun 'state'; try 'aidlc help --all'\n");
  });

  test("formerly stubbed routes now reach utility handlers", () => {
    const projectDir = makeProject();
    writeMinimalState(projectDir);
    const cases = [
      ["config", "get", "depth"],
      ["config", "list"],
      ["plugin", "sync"],
      ["plugin", "list"],
      ["init"],
      ["upgrade"],
    ];
    for (const args of cases) {
      const res = viaDispatcher(args, projectDir);
      expect(res.exitCode, args.join(" ")).not.toBe(3);
    }
  });

  test("mutable commands reject a project with no installed harness", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aidlc-t230-no-harness-"));
    tempProjects.add(projectDir);

    const plugin = viaDispatcher(
      ["plugin", "select", "aidlc", "--project-dir", projectDir],
      REPO_ROOT,
    );
    expect(plugin.exitCode).not.toBe(0);
    expect(plugin.stderr.toString("utf-8")).toContain("requires an installed project harness");

    const graph = viaDispatcher(
      ["graph", "compile", "--project-dir", projectDir],
      REPO_ROOT,
    );
    expect(graph.exitCode).not.toBe(0);
    expect(graph.stderr.toString("utf-8")).toContain("requires an installed project harness");
    expect(existsSync(join(projectDir, ".claude"))).toBe(false);
  });
});

describe("t230 dispatcher hook routing", () => {
  test("adapter routing separates harness, target, and extra arguments", () => {
    const codex = resolveAction(["adapter", "codex", "session-start"]);
    expect(codex.type).toBe("adapter");
    if (codex.type === "adapter") {
      expect(codex.harness).toBe("codex");
      expect(codex.target).toBe("session-start");
      expect(codex.extraArgs).toEqual([]);
      expect(codex.path.endsWith("aidlc-codex-adapter.ts")).toBe(true);
    }

    const kiro = resolveAction([
      "adapter",
      "kiro",
      "reviewer-scope",
      "aidlc-product-lead-agent",
    ]);
    expect(kiro.type).toBe("adapter");
    if (kiro.type === "adapter") {
      expect(kiro.harness).toBe("kiro");
      expect(kiro.target).toBe("reviewer-scope");
      expect(kiro.extraArgs).toEqual(["aidlc-product-lead-agent"]);
      expect(kiro.path.endsWith("aidlc-kiro-adapter.ts")).toBe(true);
    }
  });

  test("hook validate-state dispatches to run(input) and writes heartbeat", () => {
    const projectDir = makeProject();
    const res = viaDispatcher(["hook", "validate-state"], projectDir, {}, "{}");

    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString("utf-8")).toBe("");
    const heartbeat = "validate-state.last";
    expect(
      existsSync(join(seededRecordDir(projectDir), ".aidlc-hooks-health", heartbeat)) ||
        existsSync(join(dirname(seededRecordDir(projectDir)), ".aidlc-hooks-health", heartbeat)),
    ).toBe(true);
  });

  test("statusline dispatches to run(input) and renders a line", () => {
    const projectDir = makeProject();
    writeMinimalState(projectDir);
    const input = JSON.stringify({
      workspace: { project_dir: projectDir },
      model: { id: "claude-3-5-sonnet-20241022" },
      context_window: { used_percentage: 12 },
    });
    const res = viaDispatcher(["statusline"], projectDir, {}, input);

    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString("utf-8")).toBe("");
    expect(res.stdout.byteLength).toBeGreaterThan(0);
    expect(res.stdout.toString("utf-8")).toContain("Intent Capture");
  });

  test("Codex adapter target dispatches through the installed harness adapter", () => {
    const projectDir = makeProject();
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(projectDir, ".codex"), {
      recursive: true,
    });
    const input = JSON.stringify({
      hook_event_name: "PreCompact",
      cwd: projectDir,
      session_id: "t230-adapter",
    });
    const res = viaDispatcher(
      ["adapter", "codex", "validate-state"],
      projectDir,
      {},
      input,
    );

    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString("utf-8")).toBe("");
    expect(
      existsSync(join(seededRecordDir(projectDir), ".aidlc-hooks-health", "validate-state.last")) ||
        existsSync(join(dirname(seededRecordDir(projectDir)), ".aidlc-hooks-health", "validate-state.last")),
    ).toBe(true);
  });

  test("--project-dir overrides cwd and payload project for hook, statusline, and adapter", () => {
    const cwdProject = makeProject();
    const targetProject = makeProject();
    writeMinimalState(cwdProject, "intent-capture");
    writeMinimalState(targetProject, "application-design");

    const hook = viaDispatcher(
      ["hook", "validate-state", "--project-dir", targetProject],
      cwdProject,
      {},
      "{}",
    );
    expect(hook.exitCode).toBe(0);
    expect(
      existsSync(join(seededRecordDir(targetProject), ".aidlc-hooks-health", "validate-state.last")) ||
        existsSync(join(dirname(seededRecordDir(targetProject)), ".aidlc-hooks-health", "validate-state.last")),
    ).toBe(true);
    expect(
      existsSync(join(seededRecordDir(cwdProject), ".aidlc-hooks-health", "validate-state.last")) ||
        existsSync(join(dirname(seededRecordDir(cwdProject)), ".aidlc-hooks-health", "validate-state.last")),
    ).toBe(false);

    const statusline = viaDispatcher(
      ["statusline", "--project-dir", targetProject],
      cwdProject,
      {},
      JSON.stringify({
        workspace: { project_dir: cwdProject },
        model: { id: "claude-test" },
        context_window: { used_percentage: 12 },
      }),
    );
    expect(statusline.exitCode).toBe(0);
    expect(statusline.stdout.toString("utf-8")).toContain("Application Design");
    expect(statusline.stdout.toString("utf-8")).not.toContain("Intent Capture");

    rmSync(
      join(seededRecordDir(targetProject), ".aidlc-hooks-health", "validate-state.last"),
      { force: true },
    );
    rmSync(
      join(dirname(seededRecordDir(targetProject)), ".aidlc-hooks-health", "validate-state.last"),
      { force: true },
    );
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(targetProject, ".codex"), {
      recursive: true,
    });
    const adapter = viaDispatcher(
      ["adapter", "codex", "validate-state", "--project-dir", targetProject],
      cwdProject,
      {},
      JSON.stringify({
        hook_event_name: "PreCompact",
        cwd: cwdProject,
        session_id: "t230-project-dir",
      }),
    );
    expect(adapter.exitCode).toBe(0);
    expect(
      existsSync(join(seededRecordDir(targetProject), ".aidlc-hooks-health", "validate-state.last")) ||
        existsSync(join(dirname(seededRecordDir(targetProject)), ".aidlc-hooks-health", "validate-state.last")),
    ).toBe(true);
  });
});
