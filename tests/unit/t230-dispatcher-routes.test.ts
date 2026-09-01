// covers: tool:aidlc, function:renderCommandHelp, tool:aidlc-sensor, tool:aidlc-swarm, hook:aidlc-validate-state, hook:aidlc-review-freeze, hook:aidlc-statusline
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  ENGINE_NAMESPACE_HELP,
  PUBLIC_COMMANDS,
  ROUTES,
  SYSTEM_NAMESPACE_HELP,
  TOOLS,
  type Route,
  renderAllHelp,
  renderCommandHelp,
  renderEngineHelp,
  renderHumanHelp,
  renderNamespaceHelp,
  resolveAction,
  routePolicyFor,
} from "../../core/tools/aidlc.ts";
import { validatePublicConfigArgs } from "../../core/tools/aidlc-init.ts";
import { launcherRouteUsesPin } from "../../core/tools/aidlc-command.ts";
import {
  projectPinTargetPath,
  targetTriple,
} from "../../core/tools/aidlc-install-paths.ts";
import {
  discoverProjectHarnesses,
  isCompiledModuleUrl,
  runtimeHarnessDir,
} from "../../core/tools/aidlc-runtime-paths.ts";
import { parseSensorManifest } from "../../core/tools/aidlc-sensor-schema.ts";
import { AIDLC_VERSION } from "../../core/tools/aidlc-version.ts";
import {
  cleanupTestProject,
  createTestProject,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { setupTuiProject } from "../harness/tui-fixtures.ts";

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

type RouteDestination = {
  key: string;
  path: string;
};

function firstPassthroughTarget(route: Route, form: string): string {
  const stripped = form === route.group
    ? ""
    : form.startsWith(`${route.group} `)
    ? form.slice(route.group.length + 1)
    : form;
  return /^[A-Za-z0-9_-]+/.exec(stripped)?.[0] ?? "<root>";
}

function routeDestinations(route: Route): RouteDestination[] {
  const path = (verb: string): string =>
    route.group === "top" ? verb : `${route.group} ${verb}`;
  if (route.kind === "custom") {
    return route.verbs.map((verb) => ({
      key: `custom:${route.id}::${verb}`,
      path: path(verb),
    }));
  }
  if (route.kind === "routing-only") {
    if (route.routeOnly === "tool-passthrough" && route.tool) {
      return (route.all ?? route.verbs).map((form) => {
        const target = firstPassthroughTarget(route, form);
        return {
          key: `${route.tool}::${target}`,
          path: path(target),
        };
      });
    }
    return [{
      key: `${route.routeOnly ?? route.id}::${route.id}`,
      path: route.group,
    }];
  }
  if (route.kind === "top-prefix") {
    return [{
      key: `${route.tool ?? route.id}::${route.prefix?.join(" ") ?? ""}`,
      path: route.verbs[0],
    }];
  }
  if (route.kind === "top-help") {
    return [{ key: `help::${route.namespace}`, path: route.verbs[0] }];
  }
  return route.verbs.map((verb) => ({
    key: `${route.tool ?? route.id}::${
      route.kind === "noun-map"
        ? route.targets?.[verb] ?? verb
        : [...(route.prefix ?? []), verb].join(" ")
    }`,
    path: path(verb),
  }));
}

function duplicateDestinations(routes: readonly Route[]): Array<[string, string[]]> {
  const destinations = new Map<string, string[]>();
  for (const route of routes) {
    for (const destination of routeDestinations(route)) {
      destinations.set(destination.key, [
        ...(destinations.get(destination.key) ?? []),
        destination.path,
      ]);
    }
  }
  return [...destinations.entries()].filter(([, paths]) => paths.length > 1);
}

const tempProjects = new Set<string>();
let compiledRoot: string | null = null;
let compiledDispatcher: string | null = null;

afterAll(() => {
  for (const project of tempProjects) cleanupTestProject(project);
  if (compiledRoot) rmSync(compiledRoot, { recursive: true, force: true });
});

function makeProject(): string {
  const project = createTestProject();
  const dataDir = join(project, ".claude", "tools", "data");
  mkdirSync(dataDir, { recursive: true });
  cpSync(
    join(REPO_ROOT, "dist", "claude", ".claude", "tools", "data", "aidlc-stamp.json"),
    join(dataDir, "aidlc-stamp.json"),
  );
  tempProjects.add(project);
  return project;
}

function registerPinFixture(
  project: string,
  machine: string,
  version: string,
  executable: string,
): void {
  const target = projectPinTargetPath(project);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${executable}\n`);
  mkdirSync(machine, { recursive: true });
  writeFileSync(
    join(machine, "pins.json"),
    `${JSON.stringify({ [realpathSync(project)]: version }, null, 2)}\n`,
  );
}

function makeUnselectedKiroProject(): string {
  const project = setupTuiProject({
    harness: "kiro",
    withState: "state-mid-ideation.md",
  });
  tempProjects.add(project);
  const utility = join(project, ".kiro", "tools", "aidlc-utility.ts");
  const created = run(
    [
      BUN,
      utility,
      "intent-create",
      "--scope",
      "poc",
      "--label",
      "second fixture",
      "--project-dir",
      project,
    ],
    project,
  );
  expect(created.exitCode, created.stderr.toString()).toBe(0);
  rmSync(
    join(
      project,
      "aidlc",
      "spaces",
      "default",
      "intents",
      "active-intent",
    ),
    { force: true },
  );
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
      routerArgs: ["engine", "orchestrate", "next", "compose"],
      tool: "aidlc-orchestrate.ts",
      toolArgs: ["next", "compose"],
    },
    {
      name: "continue passes through to orchestrate",
      routerArgs: ["engine", "orchestrate", "continue", "invalid-token"],
      tool: "aidlc-orchestrate.ts",
      toolArgs: ["continue", "invalid-token"],
    },
    {
      name: "version prints binary and runtime versions",
      routerArgs: ["version"],
      tool: "aidlc.ts",
      toolArgs: ["version"],
    },
    {
      name: "state set-status maps to utility",
      routerArgs: ["engine", "state", "set-status"],
      tool: "aidlc-utility.ts",
      toolArgs: ["set-status"],
    },
    {
      name: "state init maps to utility",
      routerArgs: ["engine", "state", "init"],
      tool: "aidlc-utility.ts",
      toolArgs: ["state-init"],
    },
    {
      name: "audit fork maps to audit-fork",
      routerArgs: ["engine", "audit", "fork"],
      tool: "aidlc-audit.ts",
      toolArgs: ["audit-fork"],
    },
    {
      name: "audit merge maps to audit-merge",
      routerArgs: ["engine", "audit", "merge"],
      tool: "aidlc-audit.ts",
      toolArgs: ["audit-merge"],
    },
    {
      name: "intent list maps through workspace parser",
      routerArgs: ["engine", "intent", "list"],
      tool: "aidlc-utility.ts",
      toolArgs: ["intent"],
      fixture: true,
    },
    {
      name: "intent list json maps through workspace parser",
      routerArgs: ["engine", "intent", "list", "--json"],
      tool: "aidlc-utility.ts",
      toolArgs: ["intent", "--json"],
      fixture: true,
    },
    {
      name: "intent switch maps through workspace parser",
      routerArgs: ["engine", "intent", "switch", "fixture-8000000000000001"],
      tool: "aidlc-utility.ts",
      toolArgs: ["intent", "switch", "fixture-8000000000000001"],
      fixture: true,
    },
    {
      name: "intent create maps through workspace parser",
      routerArgs: ["engine", "intent", "create"],
      tool: "aidlc-utility.ts",
      toolArgs: ["intent-create"],
    },
    {
      name: "space list maps through workspace parser",
      routerArgs: ["engine", "space", "list"],
      tool: "aidlc-utility.ts",
      toolArgs: ["space"],
      fixture: true,
    },
    {
      name: "space switch maps through workspace parser",
      routerArgs: ["engine", "space", "switch", "default"],
      tool: "aidlc-utility.ts",
      toolArgs: ["space", "switch", "default"],
      fixture: true,
    },
    {
      name: "scope change maps to utility",
      routerArgs: ["engine", "scope", "change"],
      tool: "aidlc-utility.ts",
      toolArgs: ["scope-change"],
    },
    {
      name: "scope detect maps to utility",
      routerArgs: ["engine", "scope", "detect"],
      tool: "aidlc-utility.ts",
      toolArgs: ["detect-scope"],
    },
    {
      name: "scope resolve-env maps to utility",
      routerArgs: ["engine", "scope", "resolve-env"],
      tool: "aidlc-utility.ts",
      toolArgs: ["resolve-env-scope"],
    },
    {
      name: "config get maps to config-get",
      routerArgs: ["engine", "config", "get", "depth"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-get", "depth"],
      fixture: true,
    },
    {
      name: "config list maps to config-list",
      routerArgs: ["engine", "config", "list"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-list"],
      fixture: true,
    },
    {
      name: "config depth maps to config-change",
      routerArgs: ["engine", "config", "set", "depth", "minimal"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-change", "--depth", "minimal"],
      fixture: true,
    },
    {
      name: "config test strategy maps to config-change",
      routerArgs: ["engine", "config", "set", "test-strategy", "standard"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-change", "--test-strategy", "standard"],
      fixture: true,
    },
    {
      name: "config review maps to config-change",
      routerArgs: ["engine", "config", "set", "review", "advisory"],
      tool: "aidlc-utility.ts",
      toolArgs: ["config-change", "--review", "advisory"],
      fixture: true,
    },
    {
      name: "plugin select maps to select-plugins",
      routerArgs: ["engine", "plugin", "select"],
      tool: "aidlc-utility.ts",
      toolArgs: ["select-plugins"],
      fixture: true,
    },
    {
      name: "plugin list maps to dedicated plugin state",
      routerArgs: ["engine", "plugin", "list"],
      tool: "aidlc-plugin.ts",
      toolArgs: ["list"],
      fixture: true,
    },
    {
      name: "plugin sync maps to dedicated transactional sync",
      routerArgs: ["engine", "plugin", "sync"],
      tool: "aidlc-plugin.ts",
      toolArgs: ["sync"],
      fixture: true,
    },
    {
      name: "config maps to its project lifecycle delegate",
      routerArgs: ["config"],
      tool: "aidlc-init.ts",
      toolArgs: ["config"],
    },
    {
      name: "plugin validate maps to plugin-validate",
      routerArgs: ["plugin", "validate", ".", "--json"],
      tool: "aidlc-utility.ts",
      toolArgs: ["plugin-validate", ".", "--json"],
      fixture: true,
    },
    {
      name: "plugin build maps to plugin-build",
      routerArgs: ["plugin", "build", "claude", "out", "--plugin-root", "."],
      tool: "aidlc-utility.ts",
      toolArgs: ["plugin-build", "claude", "out", "--plugin-root", "."],
      fixture: true,
    },
    {
      name: "update maps to its machine lifecycle delegate",
      routerArgs: ["update"],
      tool: "aidlc-lifecycle.ts",
      toolArgs: ["update"],
      fixture: true,
    },
    {
      name: "gen runners maps to runner write",
      routerArgs: ["engine", "gen", "runners"],
      tool: "aidlc-runner-gen.ts",
      toolArgs: ["write"],
    },
    {
      name: "gen runners check maps to runner check",
      routerArgs: ["engine", "gen", "runners", "--check"],
      tool: "aidlc-runner-gen.ts",
      toolArgs: ["check"],
    },
    {
      name: "gen runner-list maps to runner list",
      routerArgs: ["engine", "gen", "runner-list"],
      tool: "aidlc-runner-gen.ts",
      toolArgs: ["list"],
    },
    {
      name: "gen runner-scopes maps to runner scopes",
      routerArgs: ["engine", "gen", "runner-scopes", "--check"],
      tool: "aidlc-runner-gen.ts",
      toolArgs: ["scopes", "--check"],
    },
    {
      name: "gen stage-table maps to utility",
      routerArgs: ["engine", "gen", "stage-table", "--check"],
      tool: "aidlc-utility.ts",
      toolArgs: ["stage-table", "--check"],
    },
    {
      name: "gen scope-table maps to utility",
      routerArgs: ["engine", "gen", "scope-table", "--check"],
      tool: "aidlc-utility.ts",
      toolArgs: ["scope-table", "--check"],
    },
    {
      name: "workspace detect maps to utility detect",
      routerArgs: ["engine", "workspace", "detect"],
      tool: "aidlc-utility.ts",
      toolArgs: ["detect"],
      fixture: true,
    },
    {
      name: "workspace codekb maps to utility codekb-path",
      routerArgs: ["engine", "workspace", "codekb"],
      tool: "aidlc-utility.ts",
      toolArgs: ["codekb-path"],
      fixture: true,
    },
    {
      name: "sensor passthrough preserves bytes",
      routerArgs: ["engine", "sensor", "list"],
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
    const routed = viaDispatcher(["engine", "space", "create", "router-space"], routedProject);

    expectSameRun(routed, old, "space create");
    expect(entriesUnder(join(routedProject, "aidlc", "spaces", "router-space"))).toEqual(
      entriesUnder(join(directProject, "aidlc", "spaces", "router-space")),
    );
  });

  test("legacy top-level engine forms are rejected", () => {
    for (const args of [
      ["state", "get", "Current Stage"],
      ["graph", "artifacts"],
      ["space", "list"],
      ["space-create", "legacy-space"],
      ["init"],
      ["upgrade"],
      ["rollback"],
      ["versions", "list"],
      ["harness", "list"],
      ["package", "verify", "/tmp/release"],
      ["plugin", "list"],
      ["completions", "bash"],
    ]) {
      const routed = viaDispatcher(args, REPO_ROOT);
      expect(routed.exitCode, args.join(" ")).toBe(2);
      expect(routed.stderr.toString()).toContain(`error: unknown command '${args[0]}'`);
    }
  });

  test("semantic intent create receives project mutation policy", () => {
    const projectDir = makeProject();
    const result = viaDispatcher(
      ["engine", "intent", "create", "--scope", "poc"],
      projectDir,
      { AIDLC_DISPATCH_TOOLS_DIR: DIST_TOOLS_DIR },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).not.toContain("does not permit filesystem mutation");
    const intentsDir = join(projectDir, "aidlc", "spaces", "default", "intents");
    const activeIntent = readFileSync(join(intentsDir, "active-intent"), "utf-8").trim();
    const state = readFileSync(join(intentsDir, activeIntent, "aidlc-state.md"), "utf-8");
    expect(state).toContain("- **Scope**: poc");
  });

  test("engine project roots cannot overlap machine install or command paths", () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-t230-machine-project-"));
    tempProjects.add(root);
    const install = join(root, "install");
    const bin = join(root, "bin");
    mkdirSync(install, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const candidates = [
      root,
      install,
      join(install, "retained-runtime"),
      bin,
    ];
    for (const project of candidates) {
      mkdirSync(join(project, ".git"), { recursive: true });
    }
    if (process.platform !== "win32") {
      const target = join(install, "aliased-runtime");
      mkdirSync(join(target, ".git"), { recursive: true });
      const alias = join(root, "project-alias");
      symlinkSync(target, alias, "dir");
      candidates.push(alias);

      const ancestorAliasRoot = mkdtempSync(
        join(tmpdir(), "aidlc-t230-machine-project-alias-"),
      );
      tempProjects.add(ancestorAliasRoot);
      const ancestorAlias = join(ancestorAliasRoot, "project");
      symlinkSync(root, ancestorAlias, "dir");
      candidates.push(ancestorAlias);
    }

    for (const project of candidates) {
      const result = viaDispatcher(
        [
          "engine",
          "intent",
          "create",
          "--scope",
          "poc",
          "--project-dir",
          project,
        ],
        REPO_ROOT,
        {
          AIDLC_INSTALL_ROOT: install,
          AIDLC_BIN_DIR: bin,
        },
      );
      expect(result.exitCode, project).toBe(1);
      expect(result.stderr.toString()).toContain(
        "cannot use an AI-DLC machine install or command directory as its project directory",
      );
      expect(existsSync(join(project, "aidlc", "spaces"))).toBe(false);
    }

    const aliasProject = candidates[0];
    for (const args of [
      ["--claim", "machine-unit"],
      ["--release", "machine-unit"],
    ]) {
      const result = viaDispatcher(
        [...args, "--project-dir", aliasProject],
        REPO_ROOT,
        {
          AIDLC_INSTALL_ROOT: install,
          AIDLC_BIN_DIR: bin,
        },
      );
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "cannot use an AI-DLC machine install or command directory as its project directory",
      );
    }

    writeFileSync(join(aliasProject, ".aidlc-version"), "9.9.9\n");
    const pinnedStatus = viaDispatcher(
      ["engine", "status", "--project-dir", aliasProject],
      REPO_ROOT,
      {
        AIDLC_INSTALL_ROOT: install,
        AIDLC_BIN_DIR: bin,
      },
    );
    expect(pinnedStatus.exitCode).toBe(1);
    expect(`${pinnedStatus.stdout}${pinnedStatus.stderr}`).toContain(
      "cannot use an AI-DLC machine install or command directory as its project directory",
    );
    expect(`${pinnedStatus.stdout}${pinnedStatus.stderr}`).not.toContain(
      "pin is not registered",
    );

    const parentProject = mkdtempSync(
      join(tmpdir(), "aidlc-t230-machine-parent-project-"),
    );
    tempProjects.add(parentProject);
    mkdirSync(join(parentProject, ".git"));
    const nestedInstall = join(parentProject, "aidlc");
    const nestedBin = join(root, "parent-project-bin");
    mkdirSync(nestedInstall, { recursive: true });
    const parentResult = viaDispatcher(
      [
        "engine",
        "intent",
        "create",
        "--scope",
        "poc",
        "--project-dir",
        parentProject,
      ],
      REPO_ROOT,
      {
        AIDLC_INSTALL_ROOT: nestedInstall,
        AIDLC_BIN_DIR: nestedBin,
      },
    );
    expect(parentResult.exitCode).toBe(1);
    expect(`${parentResult.stdout}${parentResult.stderr}`).toContain(
      "cannot use an AI-DLC machine install or command directory as its project directory",
    );
    expect(existsSync(join(nestedInstall, "spaces"))).toBe(false);

    if (process.platform !== "win32") {
      const symlinkProject = mkdtempSync(
        join(tmpdir(), "aidlc-t230-machine-symlink-parent-"),
      );
      const externalMachine = mkdtempSync(
        join(tmpdir(), "aidlc-t230-machine-symlink-target-"),
      );
      tempProjects.add(symlinkProject);
      tempProjects.add(externalMachine);
      mkdirSync(join(symlinkProject, ".git"));
      const linkedInstall = join(symlinkProject, "aidlc");
      symlinkSync(externalMachine, linkedInstall, "dir");
      const symlinkResult = viaDispatcher(
        [
          "engine",
          "intent",
          "create",
          "--scope",
          "poc",
          "--project-dir",
          symlinkProject,
        ],
        REPO_ROOT,
        {
          AIDLC_INSTALL_ROOT: linkedInstall,
          AIDLC_BIN_DIR: join(root, "symlink-project-bin"),
        },
      );
      expect(symlinkResult.exitCode).toBe(1);
      expect(`${symlinkResult.stdout}${symlinkResult.stderr}`).toContain(
        "cannot use an AI-DLC machine install or command directory as its project directory",
      );
      expect(existsSync(join(externalMachine, "spaces"))).toBe(false);
    }
  });

  test("--project-dir is global and may be interleaved with workspace tokens", () => {
    const projectDir = makeProject();
    const routed = viaDispatcher(
      ["engine", "space", "--project-dir", projectDir, "create", "interleaved-space"],
      REPO_ROOT,
    );

    expect(routed.exitCode).toBe(0);
    expect(existsSync(join(projectDir, "aidlc", "spaces", "interleaved-space"))).toBe(true);
  });

  test("duplicate --project-dir values fail before either project is mutated", () => {
    const trusted = makeProject();
    const target = makeProject();
    const result = viaDispatcher([
      "--project-dir",
      trusted,
      "engine",
      "space",
      "create",
      "must-not-exist",
      "--project-dir",
      target,
    ], REPO_ROOT);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "--project-dir may be specified only once",
    );
    expect(existsSync(join(trusted, "aidlc", "spaces", "must-not-exist"))).toBe(false);
    expect(existsSync(join(target, "aidlc", "spaces", "must-not-exist"))).toBe(false);
  });

  test("literal --project-dir task text cannot reroute compose policy", () => {
    const projectDir = makeProject();
    const literalDir = mkdtempSync(join(tmpdir(), "aidlc-t230-literal-project-"));
    tempProjects.add(literalDir);
    const result = viaDispatcher(
      ["compose", "--", "--project-dir", literalDir],
      projectDir,
      { AIDLC_DISPATCH_TOOLS_DIR: DIST_TOOLS_DIR },
    );

    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "requires an installed project harness or recognized project directory",
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });
});

describe("t230 version-aware startup", () => {
  test("stable launcher pin classification matches every registered route", () => {
    for (const route of ROUTES) {
      const verb = route.verbs[0]?.split(/\s+/)[0] ?? "";
      const argv = route.namespace === "public"
        ? (route.group === "top" ? [verb] : [route.group, verb])
        : route.group === "top"
        ? [route.namespace, verb]
        : [route.namespace, route.group, verb];
      expect(
        launcherRouteUsesPin(argv),
        `${route.id}: ${argv.join(" ")}`,
      ).toBe(route.pinPolicy === "pinned");
    }
    for (const alias of ["--claim", "--release"]) {
      expect(launcherRouteUsesPin([alias, "unit-a"]), alias).toBe(true);
    }
  });

  test("legacy unit aliases retain pinned policy on normal projects", () => {
    const project = makeProject();
    for (const alias of ["--claim", "--release"]) {
      const result = viaDispatcher([alias, "unit-a"], project);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain("launcher pin policy drift");
      expect(output).not.toContain(
        "cannot use an AI-DLC machine install or command directory",
      );
    }
  });

  test("unpinned engine routes refuse a project from another major", () => {
    const project = makeProject();
    const stampPath = join(project, ".claude", "tools", "data", "aidlc-stamp.json");
    mkdirSync(dirname(stampPath), { recursive: true });
    cpSync(join(DIST_TOOLS_DIR, "data", "aidlc-stamp.json"), stampPath);
    const stamp = JSON.parse(readFileSync(stampPath, "utf-8")) as { frameworkVersion: string };
    stamp.frameworkVersion = "99.0.0";
    writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    const result = viaDispatcher(["engine", "status", "--json"], project);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual(expect.objectContaining({
      schemaVersion: 1,
      ok: false,
      code: 1,
      message: expect.stringContaining("is incompatible with selected engine"),
      remediation: "aidlc use <installed-version> or aidlc config",
    }));
  });

  test("pinned dispatch rejects a path-only incomplete retained release", () => {
    const project = makeProject();
    const machine = mkdtempSync(join(tmpdir(), "aidlc-t230-machine-"));
    const versionRoot = join(machine, "versions", "9.9.9");
    mkdirSync(join(versionRoot, "runtime", "claude"), { recursive: true });
    const executable = join(
      versionRoot,
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(project, ".aidlc-version"), "9.9.9\n");
    registerPinFixture(project, machine, "9.9.9", executable);
    const result = viaDispatcher(["engine", "status"], project, {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("not installed completely");
  });

  test("pinned validation is read-only and invalidates on executable content change", () => {
    const project = makeProject();
    const machine = mkdtempSync(join(tmpdir(), "aidlc-t230-pin-cache-"));
    const root = join(machine, "versions", AIDLC_VERSION);
    const executable = join(root, process.platform === "win32" ? "aidlc.exe" : "aidlc");
    mkdirSync(root, { recursive: true });
    cpSync(join(REPO_ROOT, "dist-release", "claude"), join(root, "runtime", "claude"), {
      recursive: true,
    });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(root, "version.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        version: AIDLC_VERSION,
        distributions: [{ name: "claude" }],
        assets: [{
          name: `aidlc-${targetTriple()}${process.platform === "win32" ? ".exe" : ""}`,
          sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
        }],
      }, null, 2)}\n`,
    );
    writeFileSync(join(project, ".aidlc-version"), `${AIDLC_VERSION}\n`);
    registerPinFixture(project, machine, AIDLC_VERSION, executable);
    const env = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };
    const inputA = JSON.stringify({ session_id: "t230-pin-cache-a" });
    const first = viaDispatcher( ["engine", "hook", "validate-state"], project, env, inputA);
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    expect(existsSync(join(machine, "pin-resolution-cache"))).toBe(false);

    writeFileSync(executable, `${readFileSync(executable, "utf-8")}# changed\n`);
    const changed = viaDispatcher( ["engine", "hook", "validate-state"], project, env, inputA);
    expect(changed.exitCode).toBe(1);
    expect(changed.stderr.toString()).toContain("not installed completely");
  });

  test.skipIf(process.platform === "win32")(
    "pinned dispatch holds a retained-version reservation until the child exits",
    () => {
      const project = makeProject();
      const machine = mkdtempSync(join(tmpdir(), "aidlc-t230-dispatch-reservation-"));
      const version = "9.9.8";
      const root = join(machine, "versions", version);
      const executable = join(root, "aidlc");
      const marker = join(project, "reservation-observed.txt");
      mkdirSync(root, { recursive: true });
      cpSync(join(REPO_ROOT, "dist-release", "claude"), join(root, "runtime", "claude"), {
        recursive: true,
      });
      const runtimeStampPath = join(
        root,
        "runtime",
        "claude",
        ".claude",
        "tools",
        "data",
        "aidlc-stamp.json",
      );
      const runtimeStamp = JSON.parse(readFileSync(runtimeStampPath, "utf-8")) as {
        frameworkVersion: string;
      };
      runtimeStamp.frameworkVersion = version;
      writeFileSync(runtimeStampPath, `${JSON.stringify(runtimeStamp, null, 2)}\n`);
      writeFileSync(
        executable,
        `#!/bin/sh\nif find "$AIDLC_INSTALL_ROOT/reservations" -type f -print -quit 2>/dev/null | grep -q .; then printf 'reserved\\n' > ${JSON.stringify(marker)}; else printf 'missing\\n' > ${JSON.stringify(marker)}; fi\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(root, "version.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          version,
          distributions: [{ name: "claude" }],
          assets: [{
            name: `aidlc-${targetTriple()}`,
            sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
          }],
        }, null, 2)}\n`,
      );
      writeFileSync(join(project, ".aidlc-version"), `${version}\n`);
      registerPinFixture(project, machine, version, executable);

      const result = viaDispatcher(["engine", "status"], project, {
        AIDLC_INSTALL_ROOT: machine,
        AIDLC_BIN_DIR: join(machine, "bin"),
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(marker, "utf-8")).toBe("reserved\n");
      expect(existsSync(join(machine, "reservations"))).toBe(false);
    },
  );

  test("Kiro IDE adapter routing never waits for its open stdin pipe", async () => {
    const project = makeProject();
    cpSync(
      join(REPO_ROOT, "dist", "kiro-ide", ".kiro"),
      join(project, ".kiro"),
      { recursive: true },
    );
    const child = spawn(
      BUN,
      [DISPATCHER, "engine", "adapter", "kiro-ide", "mint", "--project-dir", project],
      {
        cwd: project,
        env: childEnv(project, {
          AIDLC_DISPATCH_TOOLS_DIR: CORE_TOOLS_DIR,
          USER_PROMPT: "{}",
          VSCODE_PID: "23002",
        }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const outcome = await Promise.race([
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
      new Promise<"timeout">((resolveTimeout) =>
        setTimeout(() => resolveTimeout("timeout"), 5_000)
      ),
    ]);
    if (outcome === "timeout") child.kill("SIGKILL");
    child.stdin.destroy();
    expect(outcome, stderr).not.toBe("timeout");
    expect(outcome, stderr).toBe(0);
  }, 10_000);
});

describe("t230 dispatcher global flag translation", () => {
  test("extracts --project-dir before noun/verb parsing and restores it for delegation", () => {
    expect(resolveAction(["engine", "space", "--project-dir", "/tmp/example", "create", "teamB"])).toEqual({
      type: "delegate",
      tool: "aidlc-utility.ts",
      args: ["space-create", "teamB", "--project-dir", "/tmp/example"],
    });
    expect(resolveAction(["--project-dir", "/tmp/example", "space-create", "teamC"]).type)
      .toBe("error");
    expect(resolveAction(["engine", "bolt", "start", "--project-dir", "relative/project"])).toEqual({
      type: "delegate",
      tool: "aidlc-bolt.ts",
      args: ["start", "--project-dir", resolve(process.cwd(), "relative/project")],
    });
    expect(resolveAction(["--json", "system", "versions", "list"])).toEqual({
      type: "delegate",
      tool: TOOLS.lifecycle,
      args: ["versions", "list", "--json"],
    });
  });

  test("places global --project-dir before the literal task delimiter", () => {
    expect(
      resolveAction(["--project-dir", "/tmp/example", "compose", "--", "--scope", "migration"]),
    ).toEqual({
      type: "delegate",
      tool: "aidlc-orchestrate.ts",
      args: [
        "next",
        "compose",
        "--project-dir",
        "/tmp/example",
        "--",
        "--scope",
        "migration",
      ],
    });
    expect(resolveAction(["compose", "--", "--project-dir", "/tmp/literal"])).toEqual({
      type: "delegate",
      tool: "aidlc-orchestrate.ts",
      args: ["next", "compose", "--", "--project-dir", "/tmp/literal"],
    });
    expect(resolveAction([
      "--project-dir",
      "/tmp/example",
      "compose",
      "--",
      "--project-dir",
      "/tmp/literal",
    ])).toEqual({
      type: "delegate",
      tool: "aidlc-orchestrate.ts",
      args: [
        "next",
        "compose",
        "--project-dir",
        "/tmp/example",
        "--",
        "--project-dir",
        "/tmp/literal",
      ],
    });
  });

  test("install-profile receives only the deliberate user-home mutation scope", () => {
    const projectDir = makeProject();
    const home = mkdtempSync(join(tmpdir(), "aidlc-t230-profile-home-"));
    tempProjects.add(home);
    const profile = join(home, ".profile");
    const bin = join(home, ".local", "bin");
    const result = viaDispatcher(
      [
        "system",
        "lifecycle",
        "install-profile",
        "--profile",
        profile,
        "--bin-dir",
        bin,
      ],
      projectDir,
      {
        HOME: home,
        AIDLC_INSTALL_ROOT: join(home, ".local", "share", "aidlc"),
        AIDLC_BIN_DIR: bin,
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(profile, "utf-8")).toContain("# BEGIN AI-DLC:PATH");

    const replacementBin = join(home, "bin-replacement");
    const replaced = viaDispatcher(
      [
        "system",
        "lifecycle",
        "install-profile",
        "--profile",
        profile,
        "--bin-dir",
        replacementBin,
      ],
      projectDir,
      {
        HOME: home,
        AIDLC_INSTALL_ROOT: join(home, ".local", "share", "aidlc"),
        AIDLC_BIN_DIR: bin,
      },
    );
    expect(replaced.exitCode, replaced.stderr.toString()).toBe(0);
    const updated = readFileSync(profile, "utf-8");
    expect(updated.match(/^# BEGIN AI-DLC:PATH$/gm)).toHaveLength(1);
    expect(updated.match(/^# END AI-DLC:PATH$/gm)).toHaveLength(1);
    expect(updated).toContain(`export PATH="${replacementBin}:$PATH"`);
    expect(updated).not.toContain(`export PATH="${bin}:$PATH"`);
  });

  test("install-profile cannot overwrite machine control files", () => {
    const projectDir = makeProject();
    const home = mkdtempSync(join(tmpdir(), "aidlc-t230-profile-machine-"));
    tempProjects.add(home);
    const install = join(home, ".local", "share", "aidlc");
    const bin = join(home, ".local", "bin");
    const profile = join(install, "active-version");
    mkdirSync(install, { recursive: true });
    writeFileSync(profile, `${AIDLC_VERSION}\n`);
    const result = viaDispatcher(
      [
        "system",
        "lifecycle",
        "install-profile",
        "--profile",
        profile,
        "--bin-dir",
        bin,
      ],
      projectDir,
      {
        HOME: home,
        AIDLC_INSTALL_ROOT: install,
        AIDLC_BIN_DIR: bin,
      },
    );

    expect(result.exitCode).toBe(4);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "user-home mutation scope cannot mutate machine path",
    );
    expect(readFileSync(profile, "utf-8")).toBe(`${AIDLC_VERSION}\n`);
  });

  test("install-profile rejects malformed marker layouts without writing", () => {
    const projectDir = makeProject();
    const home = mkdtempSync(join(tmpdir(), "aidlc-t230-profile-markers-"));
    tempProjects.add(home);
    const profile = join(home, ".profile");
    const bin = join(home, ".local", "bin");
    const cases = [
      "# END AI-DLC:PATH\nkeep-this-line\n# BEGIN AI-DLC:PATH\n",
      "# BEGIN AI-DLC:PATH\none\n# END AI-DLC:PATH\n# BEGIN AI-DLC:PATH\ntwo\n# END AI-DLC:PATH\n",
      "# BEGIN AI-DLC:PATH\nmissing-end\n",
      "prefix # BEGIN AI-DLC:PATH suffix\n# END AI-DLC:PATH\n",
    ];
    for (const content of cases) {
      writeFileSync(profile, content);
      const result = viaDispatcher(
        [
          "system",
          "lifecycle",
          "install-profile",
          "--profile",
          profile,
          "--bin-dir",
          bin,
        ],
        projectDir,
        {
          HOME: home,
          AIDLC_INSTALL_ROOT: join(home, ".local", "share", "aidlc"),
          AIDLC_BIN_DIR: bin,
        },
      );
      expect(result.exitCode, content).toBe(4);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "profile AI-DLC PATH markers are missing, duplicated, or malformed",
      );
      expect(readFileSync(profile, "utf-8")).toBe(content);
    }
  });

  test("carries --project-dir into routing-only actions", () => {
    const projectDir = "/tmp/routed-project";
    for (const action of [
      resolveAction( ["engine", "hook", "validate-state", "--project-dir", projectDir]),
      resolveAction( ["engine", "statusline", "--project-dir", projectDir]),
      resolveAction( ["engine", "adapter", "codex", "validate-state", "--project-dir", projectDir]),
    ]) {
      expect("projectDir" in action ? action.projectDir : undefined).toBe(projectDir);
    }
  });

  test("pin policy is route-aware when --project-dir precedes the command", () => {
    const projectDir = makeProject();
    const machine = mkdtempSync(join(tmpdir(), "aidlc-t230-pin-machine-"));
    tempProjects.add(machine);
    const versionRoot = join(machine, "versions", "99.0.0");
    const executable = join(
      versionRoot,
      process.platform === "win32" ? "aidlc.exe" : "aidlc",
    );
    mkdirSync(versionRoot, { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(projectDir, ".aidlc-version"), "99.0.0\n");
    registerPinFixture(projectDir, machine, "99.0.0", executable);
    const machineEnv = {
      AIDLC_INSTALL_ROOT: machine,
      AIDLC_BIN_DIR: join(machine, "bin"),
    };

    const active = viaDispatcher(
      ["--project-dir", projectDir, "version"],
      projectDir,
      machineEnv,
    );
    expect(active.exitCode).toBe(0);
    expect(active.stdout.toString()).toMatch(
      /^aidlc \d+\.\d+\.\d+ \(runtime \d+\.\d+\.\d+\)\n$/,
    );
    expect(active.stderr.toString()).not.toContain("this project requires");

    const pinned = viaDispatcher(
      ["--json", "--project-dir", projectDir, "engine", "status"],
      projectDir,
      machineEnv,
    );
    expect(pinned.exitCode).toBe(1);
    expect(pinned.stderr.toString()).toBe("");
    expect(JSON.parse(pinned.stdout.toString())).toEqual(expect.objectContaining({
      schemaVersion: 1,
      ok: false,
      code: 1,
      message: "this project requires 99.0.0, which is not installed completely",
      remediation: "aidlc config --pin 99.0.0",
    }));

    const bootstrap = viaDispatcher(
      [
        "--project-dir",
        projectDir,
        "system",
        "lifecycle",
        "install-apply",
        "--from",
        join(projectDir, "missing-release"),
      ],
      projectDir,
      machineEnv,
    );
    expect(bootstrap.exitCode).toBe(4);
    expect(bootstrap.stderr.toString()).not.toContain("this project requires");

    const versions = viaDispatcher(
      ["--json", "system", "versions", "list"],
      projectDir,
      { AIDLC_INSTALL_ROOT: join(projectDir, "empty-machine") },
    );
    expect(versions.exitCode).toBe(0);
    expect(versions.stdout.toString()).not.toContain("this project requires");
  });

  test("sensor worker routes by registered id, never by caller-supplied path", () => {
    expect(resolveAction(["engine", "__sensor-script-file", "linter"])).toEqual({
      type: "sensor-script-file",
      id: "linter",
      args: [],
    });
    expect(resolveAction(["engine", "__sensor-script-file", "/tmp/aidlc-sensor-evil.ts"]).type).toBe("error");
  });
});

describe("t230 dispatcher dev and compiled in-process modes", () => {
  test("compiled URL detection recognizes Bun virtual roots on Unix and Windows", () => {
    expect(isCompiledModuleUrl("file:///$bunfs/root/aidlc.ts")).toBe(true);
    expect(isCompiledModuleUrl("file:///B:/%7EBUN/root/aidlc.exe")).toBe(true);
    expect(isCompiledModuleUrl("B:\\~BUN\\root\\aidlc.exe")).toBe(true);
    expect(isCompiledModuleUrl("file:///workspace/core/tools/aidlc.ts")).toBe(false);
  });

  const cases = [
    { name: "version", args: ["version"] },
    { name: "graph artifacts", args: ["engine", "graph", "artifacts", "--help"] },
    { name: "sensor list", args: ["engine", "sensor", "list"] },
    { name: "state get", args: ["engine", "state", "get"] },
  ];

  for (const item of cases) {
    test(`${item.name} imported compiled main matches spawned dev dispatcher`, () => {
      const projectDir = makeProject();
      const dev = viaDispatcher(item.args, projectDir, { AIDLC_DISPATCH_TOOLS_DIR: DIST_TOOLS_DIR });
      const compiled = viaImportedCompiledMain(item.args, projectDir);
      expectSameRun(compiled, dev, item.name);
    });
  }

  test("compiled main discovers an OpenCode project from shipped harness metadata", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aidlc-t230-opencode-"));
    const machine = mkdtempSync(join(tmpdir(), "aidlc-t230-opencode-machine-"));
    tempProjects.add(projectDir);
    tempProjects.add(machine);
    cpSync(join(REPO_ROOT, "dist", "opencode"), projectDir, { recursive: true });
    const result = viaImportedCompiledMain(
      ["doctor", "--project-dir", projectDir, "--json"],
      projectDir,
      {
        AIDLC_BIN_DIR: join(machine, "bin"),
        AIDLC_DISPATCH_TOOLS_DIR: CORE_TOOLS_DIR,
        AIDLC_HARNESS_DIR: "",
        AIDLC_INSTALL_ROOT: machine,
      },
    );
    const report = JSON.parse(result.stdout.toString()) as {
      data: { checks: Array<{ label: string }> };
    };
    const labels = report.data.checks.map((check) => check.label);
    expect(labels.some((label) => label.includes("opencode.json or opencode.jsonc present")))
      .toBe(true);
    expect(labels.some((label) => label.includes(".claude/settings.json"))).toBe(false);
  });

  test("project harness discovery accepts a metadata-declared future harness", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aidlc-t230-future-harness-"));
    tempProjects.add(projectDir);
    const dataDir = join(projectDir, ".future", "tools", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "harness.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        distribution: "future",
        harnessDir: ".future",
      })}\n`,
    );
    expect(runtimeHarnessDir(projectDir)).toBe(".future");
    expect(discoverProjectHarnesses(projectDir)).toEqual([{
      distribution: "future",
      harnessDir: ".future",
      root: join(projectDir, ".future"),
    }]);
  });

  test("project harness discovery tolerates foreign metadata and preserves legacy precedence", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "aidlc-t230-harness-discovery-"));
    tempProjects.add(projectDir);

    const writeHarness = (
      directory: string,
      value: Record<string, unknown> | string,
    ): void => {
      const dataDir = join(projectDir, directory, "tools", "data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, "harness.json"),
        typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
      );
    };
    writeHarness(".foreign", "{");
    writeHarness(".claude.bak", {
      schemaVersion: 1,
      distribution: "claude",
      harnessDir: ".claude",
    });
    writeHarness(".aidlc", {
      schemaVersion: 1,
      distribution: "opencode",
      harnessDir: ".aidlc",
    });
    writeHarness(".codex", {
      schemaVersion: 1,
      distribution: "codex",
      harnessDir: ".codex",
    });
    writeHarness(".claude", { harnessDir: ".claude", rulesSubdir: "rules" });

    expect(discoverProjectHarnesses(projectDir).map((item) => item.distribution))
      .toEqual(["claude", "codex", "opencode"]);
    expect(runtimeHarnessDir(projectDir)).toBe(".claude");
  });

  test("compiled main pins the Kiro harness name before unselected routing", () => {
    const projectDir = makeUnselectedKiroProject();
    const compiled = viaImportedCompiledMain(
      [
        "next",
        "poc",
        "Create a tiny TypeScript command-line program that prints Hello World.",
        "--project-dir",
        projectDir,
      ],
      projectDir,
    );
    expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
    const directive = JSON.parse(compiled.stdout.toString()) as {
      kind?: string;
      ask_type?: string;
      available_intents?: string[];
    };
    expect(directive.kind).toBe("ask");
    expect(directive.ask_type).toBe("new-work-routing");
    expect(directive.available_intents).toHaveLength(2);
  });
});

describe("t230 dispatcher route completeness", () => {
  test("every route declares the complete normative execution policy", () => {
    for (const route of ROUTES) {
      expect(["public", "engine", "system"]).toContain(route.namespace);
      expect(["public", "hidden", "legacy"]).toContain(route.visibility);
      expect(["none", "optional", "required"]).toContain(route.projectRequirement);
      expect(["active", "inspect", "pinned"]).toContain(route.pinPolicy);
      expect(["forbidden", "explicit-only", "interactive-bounded", "required"])
        .toContain(route.networkPolicy);
      expect(["none", "project", "machine", "project-and-machine", "user-home"])
        .toContain(route.mutationScope);
      expect(route.outputModes.length).toBeGreaterThan(0);
    }
    for (const route of ROUTES.filter((candidate) => candidate.namespace === "engine")) {
      expect(route.networkPolicy, route.id).toBe("forbidden");
      expect(["none", "project"], route.id).toContain(route.mutationScope);
    }
    expect(ROUTES.find((route) => route.id === "top-doctor"))
      .toEqual(expect.objectContaining({
        tool: "aidlc-doctor.ts",
        pinPolicy: "active",
        mutationScope: "project-and-machine",
      }));
    expect(ROUTES.find((route) => route.id === "top-use"))
      .toEqual(expect.objectContaining({ pinPolicy: "active", mutationScope: "machine" }));
    const publicPolicy = new Map(
      ROUTES.filter((route) => route.visibility === "public")
        .map((route) => [route.id, {
          networkPolicy: route.networkPolicy,
          mutationScope: route.mutationScope,
        }]),
    );
    expect(Object.fromEntries(publicPolicy)).toEqual(expect.objectContaining({
      "top-config": { networkPolicy: "explicit-only", mutationScope: "project-and-machine" },
      "top-update": { networkPolicy: "explicit-only", mutationScope: "machine" },
      "top-use": { networkPolicy: "explicit-only", mutationScope: "machine" },
      "top-uninstall": { networkPolicy: "forbidden", mutationScope: "machine" },
    }));
    expect(
      ROUTES.filter((route) => route.visibility === "public")
        .some((route) => route.mutationScope === "project-and-machine"),
    ).toBe(true);
    expect(
      ROUTES.filter((route) => route.visibility === "public" && route.id !== "top-help")
        .map((route) => route.id)
        .sort(),
    ).toEqual([
      "top-config",
      "top-doctor",
      "top-uninstall",
      "top-update",
      "top-use",
      "top-version",
    ]);
    for (const noun of ["state", "audit", "graph", "runtime", "sensor", "plugin"]) {
      expect(
        ROUTES.filter((route) => route.namespace === "engine" && route.group === noun)
          .every((route) => route.pinPolicy === "pinned"),
      )
        .toBe(true);
    }
    expect(Object.fromEntries(
      ROUTES.filter((route) => route.namespace === "system")
        .map((route) => [route.id, {
          networkPolicy: route.networkPolicy,
          mutationScope: route.mutationScope,
        }]),
    )).toEqual({
      "config-global": { networkPolicy: "forbidden", mutationScope: "machine" },
      "system-lifecycle": {
        networkPolicy: "explicit-only",
        mutationScope: "machine",
      },
      "top-completions": { networkPolicy: "forbidden", mutationScope: "none" },
      "top-rollback": { networkPolicy: "forbidden", mutationScope: "machine" },
      "versions-install": { networkPolicy: "explicit-only", mutationScope: "machine" },
      "versions-list": { networkPolicy: "forbidden", mutationScope: "none" },
      "versions-prune": { networkPolicy: "forbidden", mutationScope: "machine" },
      "workspace-sync": { networkPolicy: "required", mutationScope: "project" },
    });
  });

  test("aliases and system delegates resolve policy from the route registry", () => {
    expect(routePolicyFor(["--status"])?.id).toBe("top-status");
    expect(routePolicyFor(["--project-dir", "/tmp/example", "engine", "graph", "compile"]))
      .toEqual(expect.objectContaining({ id: "graph", pinPolicy: "pinned" }));
    expect(routePolicyFor(["system", "lifecycle", "install-apply", "--quiet"])?.id)
      .toBe("system-lifecycle");
    expect(routePolicyFor( ["engine", "hook", "validate-state", "--project-dir", "/tmp/example"]))
      .toEqual(expect.objectContaining({ id: "hook", pinPolicy: "pinned" }));
    const semanticRoutes: Array<[string[], string]> = [
      [["engine", "state", "set-status"], "state-utility"],
      [["engine", "state", "init"], "state-utility"],
      [["engine", "scope", "change"], "scope"],
      [["engine", "scope", "detect"], "scope"],
      [["engine", "scope", "resolve-env"], "scope"],
      [["engine", "orchestrate", "help"], "engine-orchestrate-help"],
      [["engine", "workspace", "detect"], "workspace"],
      [["engine", "workspace", "codekb"], "workspace"],
      [["engine", "workspace", "codekb-scope-diff"], "workspace"],
      [["engine", "gen", "stage-table"], "gen"],
      [["engine", "gen", "scope-table"], "gen"],
      [["engine", "gen", "runners"], "gen"],
      [["engine", "gen", "runner-list"], "gen"],
      [["engine", "gen", "runner-scopes"], "gen"],
      [["engine", "plugin", "select"], "plugin"],
      [["engine", "plugin", "list"], "plugin"],
      [["engine", "plugin", "sync"], "plugin"],
      [["engine", "intent", "birth"], "intent"],
      [["engine", "intent", "list"], "intent"],
      [["engine", "space", "create"], "space"],
      [["engine", "space", "list"], "space"],
      [["engine", "config", "get"], "config"],
      [["engine", "config", "list"], "config"],
      [["engine", "config", "set", "depth"], "config"],
      [["engine", "status"], "top-status"],
      [["engine", "recompose"], "top-recompose"],
    ];
    for (const [args, routeId] of semanticRoutes) {
      expect(routePolicyFor(args)?.id, args.join(" ")).toBe(routeId);
    }
    expect(routePolicyFor(["system", "workspace-sync"])?.id).toBe("workspace-sync");
    expect(routePolicyFor(["--claim", "unit-a"])?.id).toBe("unit");
    expect(routePolicyFor(["--release", "unit-a"])?.id).toBe("unit");
    expect(routePolicyFor(["engine", "sensor-claim-sources"])?.id)
      .toBe("engine-sensor-claim-sources");
    expect(routePolicyFor(["engine", "utility", "status"])).toBeNull();
    expect(routePolicyFor(["engine", "runner-gen", "write"])).toBeNull();
  });

  test("system namespace resolves only the moved per-user installation handlers", () => {
    expect(resolveAction(["system", "lifecycle", "install-apply"])).toEqual({
      type: "delegate",
      tool: TOOLS.lifecycle,
      args: ["install-apply"],
    });
    expect(resolveAction(["system", "versions", "list"])).toEqual({
      type: "delegate",
      tool: TOOLS.lifecycle,
      args: ["versions", "list"],
    });
    expect(resolveAction(["system", "rollback", "--list"])).toEqual({
      type: "delegate",
      tool: TOOLS.lifecycle,
      args: ["rollback", "--list"],
    });
    expect(resolveAction(["system", "config", "global", "list"])).toEqual({
      type: "delegate",
      tool: TOOLS.machineConfig,
      args: ["global", "list"],
    });
    expect(resolveAction(["system", "machine-config", "global", "list"]).type)
      .toBe("error");
    expect(resolveAction(["system", "completions", "bash"])).toEqual({
      type: "delegate",
      tool: TOOLS.completions,
      args: ["bash"],
    });
  });

  test("dissolved aliases resolve through their single semantic paths", () => {
    expect(resolveAction(["engine", "orchestrate", "help"])).toEqual({
      type: "delegate",
      tool: TOOLS.utility,
      args: ["help"],
    });
    expect(resolveAction(["engine", "scope", "help"]).type).toBe("error");
    expect(resolveAction(["engine", "workspace", "codekb-scope-diff", "--repo", "api"]))
      .toEqual({
        type: "delegate",
        tool: TOOLS.utility,
        args: ["codekb-scope-diff", "--repo", "api"],
      });
    expect(resolveAction(["engine", "status"])).toEqual({
      type: "delegate",
      tool: TOOLS.utility,
      args: ["status"],
    });
    expect(resolveAction(["engine", "recompose", "--skip", "market-research"]))
      .toEqual({
        type: "delegate",
        tool: TOOLS.utility,
        args: ["recompose", "--skip", "market-research"],
      });
    expect(resolveAction(["engine", "gen", "runners", "--check"])).toEqual({
      type: "delegate",
      tool: TOOLS.runnerGen,
      args: ["check"],
    });
  });

  test("projected tool subcommands are represented in the route table", () => {
    expect(resolveAction(["engine", "graph", "ars", "--iae", "0.5"])).toEqual({
      type: "delegate",
      tool: TOOLS.graph,
      args: ["ars", "--iae", "0.5"],
    });
    expect(resolveAction(["engine", "log", "review", "--stage", "user-stories"]))
      .toEqual({
        type: "delegate",
        tool: TOOLS.log,
        args: ["review", "--stage", "user-stories"],
      });
  });

  test("public, engine, and system namespaces have no duplicate destinations", () => {
    for (const namespace of ["public", "engine", "system"] as const) {
      expect(
        duplicateDestinations(ROUTES.filter((route) => route.namespace === namespace)),
        namespace,
      ).toEqual([]);
    }
  });

  test("destination metric resolves tool passthrough forms", () => {
    const configRoute = ROUTES.find((route) => route.id === "config-global");
    expect(configRoute).toBeDefined();
    const retiredTwin: Route = {
      ...configRoute!,
      id: "retired-system-machine-config",
      group: "machine-config",
      kind: "routing-only",
      classification: "routing-only",
      verbs: ["<command>"],
      routeOnly: "tool-passthrough",
      all: ["global <get|set|clear|list> [args]"],
    };
    expect(duplicateDestinations([configRoute!, retiredTwin])).toEqual([
      [
        `${TOOLS.machineConfig}::global`,
        ["config global", "machine-config global"],
      ],
    ]);
  });

  test("trusted engine namespace refuses every machine or network lifecycle path", () => {
    for (const args of [
      ["engine", "update"],
      ["engine", "use", "1.2.3"],
      ["engine", "uninstall", "--yes"],
      ["engine", "rollback", "--list"],
      ["engine", "versions", "list"],
      ["engine", "harness", "list"],
      ["engine", "config", "global", "list"],
      ["engine", "config", "set", "offline", "on", "--global"],
      ["engine", "lifecycle", "install-apply"],
      ["engine", "machine-config", "global", "list"],
      ["engine", "workspace-sync"],
      ["engine", "completions", "bash"],
    ]) {
      expect(resolveAction(args).type, args.join(" ")).toBe("error");
      expect(routePolicyFor(args), args.join(" ")).toBeNull();
    }
  });

  test("unsupported output modes are refused before delegate execution", () => {
    const projectDir = makeProject();
    const result = viaDispatcher(["version", "--quiet"], projectDir);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString("utf-8")).toBe("top-version does not support --quiet\n");
    expect(result.stderr.toString("utf-8")).toBe("");
  });

  test("version --json reports binary and runtime versions", () => {
    const result = viaDispatcher(["version", "--json"], REPO_ROOT);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      schemaVersion: 1,
      binaryVersion: AIDLC_VERSION,
      runtimeVersion: AIDLC_VERSION,
    });
  });

  test("unknown commands render one JSON failure before delegation", () => {
    const projectDir = makeProject();
    const result = viaDispatcher(["unknown-command", "--json"], projectDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      schemaVersion: 1,
      ok: false,
      code: 2,
      status: "usage",
      message: "unknown command or noun 'unknown-command'; try 'aidlc --help'",
    });
  });

  test("missing global flag values are usage errors", () => {
    const result = viaDispatcher(["status", "--project-dir"], REPO_ROOT);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("aidlc: --project-dir requires a path value\n");
  });

  test("engine help is generated from the route table", async () => {
    const text = await renderEngineHelp();
    expect(text).toContain("Engine machinery");
    const actualGroups = new Set(
      text.split("\n")
        .filter((line) => /^ {2}\S/.test(line))
        .map((line) => /^ {2}([^:]+?)(?::|$)/.exec(line)?.[1])
        .filter((group): group is string => Boolean(group)),
    );
    const expectedGroups = new Set(
      ROUTES.filter((route) => route.namespace === "engine")
        .map((route) => route.group === "top" ? route.id.replace(/^top-/, "") : route.group),
    );
    expect(actualGroups).toEqual(expectedGroups);
    expect(actualGroups.has("utility")).toBe(false);
    expect(actualGroups.has("runner-gen")).toBe(false);
    expect(text).toContain("  state:\n    records:");
    expect(text).toContain("    lifecycle:");
    expect(text).toContain("    gates:");
    expect(text).toContain("    fork/merge:");
    expect(text).toContain("    parking:");
    expect(text).toContain("  status: [args]");
    expect(text).toContain("  recompose: [args]");
    expect(text).toContain("  statusline\n");
    expect(text).toContain("  adapter: <harness> <target> [args]");
    expect(text).not.toContain("statusline: statusline");
    expect(text).not.toContain("adapter: adapter ");

    for (const file of [
      "aidlc-claim-sources.md",
      "aidlc-linter.md",
      "aidlc-required-sections.md",
      "aidlc-traceability.md",
      "aidlc-type-check.md",
      "aidlc-upstream-coverage.md",
    ]) {
      const manifest = parseSensorManifest(
        readFileSync(join(REPO_ROOT, "core", "sensors", file), "utf-8"),
      );
      expect(text).toContain(`  sensor-${manifest.id}: ${manifest.description}`);
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
      "aidlc-knowledge.ts",
      "aidlc-learnings.ts",
      "aidlc-log.ts",
      "aidlc-orchestrate.ts",
      "aidlc-runner-gen.ts",
      "aidlc-runtime.ts",
      "aidlc-sensor-claim-sources.ts",
      "aidlc-sensor-linter.ts",
      "aidlc-sensor-type-check.ts",
      "aidlc-state.ts",
      "aidlc-utility.ts",
      "aidlc-worktree.ts",
      "aidlc-workspace-sync.ts",
      "aidlc-sensor.ts",
      "aidlc-swarm.ts",
      "aidlc-validate.ts",
      "aidlc-sensor-required-sections.ts",
      "aidlc-sensor-upstream-coverage.ts",
    ].sort();
    const routeTargets = new Set(ROUTES.flatMap((route) => (route.tool ? [route.tool] : [])));
    if (ROUTES.some((route) => route.group === "sensor" && route.verbs.includes("fire"))) {
      routeTargets.add("aidlc-sensor-claim-sources.ts");
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
  test("bare aidlc, -h, and --help are identical successful help", () => {
    const expected = renderHumanHelp();
    for (const args of [[], ["-h"], ["--help"]]) {
      const result = viaDispatcher(args, REPO_ROOT);
      expect(result.exitCode, args.join(" ") || "bare").toBe(0);
      expect(result.stdout.toString("utf-8")).toBe(expected);
      expect(result.stderr.toString("utf-8")).toBe("");
    }
  });

  test("all six public commands have side-effect-free registry-derived help", () => {
    const projectDir = makeProject();
    const machineRoot = join(projectDir, "machine-help-probe");
    const env = {
      AIDLC_INSTALL_ROOT: machineRoot,
      AIDLC_BIN_DIR: join(machineRoot, "bin"),
      AIDLC_RELEASE_BASE_URL: "http://127.0.0.1:9",
      AIDLC_OFFLINE: "0",
      AIDLC_DISPATCH_TOOLS_DIR: join(projectDir, "missing-tools"),
    };
    const usage: Record<(typeof PUBLIC_COMMANDS)[number], string> = {
      config: "config <section> [flags]",
      doctor: "doctor [options]",
      version: "version [--json]",
      update: "update [options]",
      use: "use <version> [options]",
      uninstall: "uninstall [options]",
    };
    for (const command of PUBLIC_COMMANDS) {
      const rendered = renderCommandHelp(command);
      expect(rendered).toContain(usage[command]);
      const route = ROUTES.find((candidate) =>
        candidate.namespace === "public" &&
        candidate.group === "top" &&
        candidate.verbs.includes(command)
      );
      expect(route).toBeDefined();
      expect(rendered).toContain("USAGE");
      expect(rendered).toContain(usage[command]);
      expect(rendered).toContain("--help");

      for (const args of [[command, "--help"], [command, "-h"]]) {
        const dev = viaDispatcher(args, projectDir, env);
        expect(dev.exitCode, args.join(" ")).toBe(0);
        expect(dev.stdout.toString("utf-8")).toBe(rendered);
        expect(dev.stderr.toString("utf-8")).toBe("");
      }

      const compiled = viaImportedCompiledMain(
        [command, "--help"],
        projectDir,
        env,
      );
      expect(compiled.exitCode, `compiled ${command}`).toBe(0);
      expect(compiled.stdout.toString("utf-8")).toBe(
        rendered.replaceAll("bun .claude/tools/aidlc.ts", "aidlc"),
      );
      expect(compiled.stderr.toString("utf-8")).toBe("");
    }
    expect(entriesUnder(machineRoot)).toEqual([]);
  }, 60_000);

  test("top-level config help consumes every root value flag without doing work", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "aidlc-t230-config-help-"));
    tempProjects.add(sandbox);
    const projectDir = join(sandbox, "project");
    const machineRoot = join(sandbox, "machine");
    mkdirSync(projectDir);
    const env = {
      AIDLC_INSTALL_ROOT: machineRoot,
      AIDLC_BIN_DIR: join(machineRoot, "bin"),
      AIDLC_DISPATCH_TOOLS_DIR: join(sandbox, "missing-tools"),
      AIDLC_OFFLINE: "0",
    };
    const cases: Array<[string, string]> = [
      ["--from", join(sandbox, "missing-release")],
      ["--harness", "claude"],
      ["--mcp", "none"],
      ["--pin", "9.9.9"],
      ["--release-base-url", "http://127.0.0.1:9"],
      ["--ca-bundle", join(sandbox, "missing-ca.pem")],
      ["--plan-token", "not-a-real-plan-token"],
      ["--project-dir", projectDir],
    ];
    const expected = renderCommandHelp("config");
    for (const [flag, value] of cases) {
      const args = [
        "config",
        flag,
        value,
        ...(flag === "--project-dir" ? [] : ["--project-dir", projectDir]),
        "--help",
      ];
      const result = viaDispatcher(args, projectDir, env);
      expect(result.exitCode, flag).toBe(0);
      expect(result.stdout.toString("utf-8"), flag).toBe(expected);
      expect(result.stderr.toString("utf-8"), flag).toBe("");
      expect(entriesUnder(projectDir), flag).toEqual([]);
      expect(entriesUnder(machineRoot), flag).toEqual([]);
    }
  });

  test("all public commands reject malformed grammar before delegation or writes", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "aidlc-t230-public-grammar-"));
    tempProjects.add(sandbox);
    const projectDir = join(sandbox, "project");
    const machineRoot = join(sandbox, "machine");
    mkdirSync(projectDir);
    const env = {
      AIDLC_INSTALL_ROOT: machineRoot,
      AIDLC_BIN_DIR: join(machineRoot, "bin"),
      AIDLC_DISPATCH_TOOLS_DIR: join(sandbox, "missing-tools"),
      AIDLC_RELEASE_BASE_URL: "http://127.0.0.1:9",
      AIDLC_OFFLINE: "0",
    };
    const cases: Array<{
      command: (typeof PUBLIC_COMMANDS)[number];
      category: string;
      args: string[];
      message: string;
    }> = [
      { command: "config", category: "unknown", args: ["config", "--wat"], message: "unknown config option --wat" },
      { command: "config", category: "stray", args: ["config", "extra"], message: "unknown config section" },
      { command: "config", category: "missing", args: ["config", "--from"], message: "--from requires a value" },
      { command: "config", category: "duplicate", args: ["config", "--force", "--force"], message: "--force may be specified only once" },
      { command: "config", category: "incompatible", args: ["config", "--json", "--quiet"], message: "mutually exclusive" },
      { command: "doctor", category: "unknown", args: ["doctor", "--wat"], message: "unknown doctor option --wat" },
      { command: "doctor", category: "stray", args: ["doctor", "extra"], message: "unexpected doctor positional" },
      { command: "doctor", category: "missing", args: ["doctor", "--output"], message: "--output requires a value" },
      { command: "doctor", category: "duplicate", args: ["doctor", "--verbose", "--verbose"], message: "--verbose may be specified only once" },
      { command: "doctor", category: "incompatible", args: ["doctor", "--json", "--quiet"], message: "mutually exclusive" },
      { command: "doctor", category: "structured-export", args: ["doctor", "--json", "--export"], message: "--export cannot be combined" },
      { command: "version", category: "unknown", args: ["version", "--wat"], message: "unknown version option --wat" },
      { command: "version", category: "stray", args: ["version", "extra"], message: "unexpected version positional" },
      { command: "version", category: "missing", args: ["version", "--project-dir"], message: "--project-dir requires a path value" },
      { command: "version", category: "duplicate", args: ["version", "--json", "--json"], message: "--json may be specified only once" },
      { command: "version", category: "incompatible", args: ["version", "--quiet"], message: "does not support --quiet" },
      { command: "update", category: "unknown", args: ["update", "--wat"], message: "unknown update option --wat" },
      { command: "update", category: "stray", args: ["update", "extra"], message: "unexpected update positional" },
      { command: "update", category: "missing", args: ["update", "--version"], message: "--version requires a value" },
      { command: "update", category: "duplicate", args: ["update", "--check", "--check"], message: "--check may be specified only once" },
      { command: "update", category: "incompatible", args: ["update", "--check", "--dry-run"], message: "--check cannot be combined" },
      { command: "use", category: "unknown", args: ["use", "1.2.3", "--wat"], message: "unknown use option --wat" },
      { command: "use", category: "stray", args: ["use", "1.2.3", "extra"], message: "unexpected use positional" },
      { command: "use", category: "missing", args: ["use", "1.2.3", "--from"], message: "--from requires a value" },
      { command: "use", category: "duplicate", args: ["use", "1.2.3", "--offline", "--offline"], message: "--offline may be specified only once" },
      { command: "use", category: "incompatible", args: ["use", "1.2.3", "--json", "--quiet"], message: "mutually exclusive" },
      { command: "use", category: "ordering", args: ["use", "--from", "./release", "1.2.3"], message: "version before options" },
      { command: "uninstall", category: "unknown", args: ["uninstall", "--wat"], message: "unknown uninstall option --wat" },
      { command: "uninstall", category: "stray", args: ["uninstall", "extra"], message: "unexpected uninstall positional" },
      { command: "uninstall", category: "missing", args: ["uninstall", "--project-dir"], message: "--project-dir requires a path value" },
      { command: "uninstall", category: "duplicate", args: ["uninstall", "--purge", "--purge"], message: "--purge may be specified only once" },
      { command: "uninstall", category: "incompatible", args: ["uninstall", "--json", "--quiet"], message: "mutually exclusive" },
    ];
    for (const item of cases) {
      const result = viaDispatcher(item.args, projectDir, env);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.exitCode, `${item.command} ${item.category}: ${output}`).toBe(2);
      expect(output, `${item.command} ${item.category}`).toContain(item.message);
      expect(entriesUnder(projectDir), `${item.command} ${item.category}`).toEqual([]);
      expect(entriesUnder(machineRoot), `${item.command} ${item.category}`).toEqual([]);
    }

    const typo = viaDispatcher(
      ["uninstall", "--pruge", "--dry-run", "--yes", "--json"],
      projectDir,
      env,
    );
    expect(typo.exitCode).toBe(2);
    expect(JSON.parse(typo.stdout.toString("utf-8")).message).toBe(
      "unknown uninstall option --pruge",
    );
    expect(entriesUnder(projectDir)).toEqual([]);
    expect(entriesUnder(machineRoot)).toEqual([]);

    for (const [alias, command] of [
      ["--doctor", "doctor"],
      ["--version", "version"],
    ] as const) {
      const malformed = viaDispatcher([alias, "--wat"], projectDir, env);
      expect(malformed.exitCode, alias).toBe(2);
      expect(`${malformed.stdout}${malformed.stderr}`, alias).toContain(
        `unknown ${command} option --wat`,
      );
      const help = viaDispatcher([alias, "--help"], projectDir, env);
      expect(help.exitCode, `${alias} help`).toBe(0);
      expect(help.stdout.toString("utf-8"), `${alias} help`).toBe(
        renderCommandHelp(command),
      );
      expect(entriesUnder(projectDir), alias).toEqual([]);
      expect(entriesUnder(machineRoot), alias).toEqual([]);
    }
  }, 60_000);

  test("root config grammar isolates scaffold, pin, and unpin options", () => {
    const cases: Array<{
      flag: string;
      tokens: string[];
      allowed: Array<"scaffold" | "pin" | "unpin">;
    }> = [
      { flag: "--mcp", tokens: ["--mcp", "none"], allowed: ["scaffold"] },
      { flag: "--harness", tokens: ["--harness", "claude"], allowed: ["scaffold"] },
      { flag: "--force", tokens: ["--force"], allowed: ["scaffold"] },
      { flag: "--plan-token", tokens: ["--plan-token", "token"], allowed: ["scaffold"] },
      { flag: "--from", tokens: ["--from", "/tmp/release"], allowed: ["scaffold", "pin"] },
      { flag: "--release-base-url", tokens: ["--release-base-url", "https://example.invalid"], allowed: ["pin"] },
      { flag: "--ca-bundle", tokens: ["--ca-bundle", "/tmp/ca.pem"], allowed: ["pin"] },
      { flag: "--offline", tokens: ["--offline"], allowed: ["pin"] },
    ];
    const modes = {
      scaffold: ["config"],
      pin: ["config", "--pin", "1.2.3"],
      unpin: ["config", "--unpin"],
    } as const;
    for (const item of cases) {
      for (const [mode, prefix] of Object.entries(modes) as Array<
        [keyof typeof modes, readonly string[]]
      >) {
        const error = validatePublicConfigArgs([...prefix, ...item.tokens]);
        if (item.allowed.includes(mode)) {
          expect(error, `${mode} ${item.flag}`).toBeNull();
        } else {
          expect(error, `${mode} ${item.flag}`).toContain(
            `${item.flag} is not valid with config`,
          );
        }
      }
    }
    expect(
      validatePublicConfigArgs(["config", "--pin", "1.2.3", "--unpin"]),
    ).toBe("--pin and --unpin are mutually exclusive");
  });

  test("config help names top-level flags and section help still passes through", () => {
    const projectDir = makeProject();
    const config = viaDispatcher(["config", "--help"], projectDir);
    expect(config.exitCode).toBe(0);
    const text = config.stdout.toString("utf-8");
    for (const section of ["models", "runtime", "providers", "trust", "flags", "project"]) {
      expect(text).toMatch(new RegExp(`^  ${section}\\s+`, "m"));
      const sectionHelp = viaDispatcher(
        ["config", section, "--help"],
        projectDir,
      );
      expect(sectionHelp.exitCode, section).toBe(0);
      const sectionText = sectionHelp.stdout.toString("utf-8");
      const copyInvocation = "bun .claude/tools/aidlc.ts";
      expect(sectionText, section).toContain(
        `${copyInvocation} config ${section} [flags]`,
      );
      expect(sectionText, section).toContain(
        `${copyInvocation} config ${section} --show`,
      );
      expect(sectionText, section).toContain(
        `Run '${copyInvocation} config ${section}`,
      );
      const compiledSection = viaImportedCompiledMain(
        ["config", section, "--help"],
        projectDir,
      );
      expect(compiledSection.exitCode, `compiled ${section}`).toBe(0);
      expect(compiledSection.stdout.toString("utf-8")).toBe(
        sectionText.replaceAll(copyInvocation, "aidlc"),
      );
      expect(compiledSection.stderr.toString("utf-8")).toBe("");
    }
    for (const flag of [
      "--pin",
      "--show",
      "--dry-run",
      "--yes",
    ]) {
      expect(text).toContain(flag);
    }
  }, 60_000);

  test("human help stays short and hides plumbing nouns", () => {
    const text = renderHumanHelp();
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(30);
    expect(text).toContain("SET UP A PROJECT");
    expect(text).toContain("MANAGE THE MACHINE INSTALL");
    expect(text).toContain("EXAMPLES");
    expect(text).toContain("LEARN MORE");
    expect(text).not.toContain("  $ ");
    for (const command of ["config", "doctor", "update", "use", "version", "uninstall"]) {
      expect(text).toContain(`  ${command}`);
    }
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
      "system",
    ]) {
      expect(text).not.toContain(`  ${noun}:`);
      expect(text).not.toContain(`${noun} <`);
    }
  });

  test("engine help labels the namespace as machinery", () => {
    const text = renderNamespaceHelp(ENGINE_NAMESPACE_HELP);
    expect(text).toContain("Engine machinery - generated harness surfaces only; not for human scripts:");
    expect(text).toContain("  state:");
    expect(text).not.toContain("Commands:");
  });

  test("system help is hidden and defines system as this user's installation", () => {
    const text = renderNamespaceHelp(SYSTEM_NAMESPACE_HELP);
    expect(resolveAction(["system", "--help"])).toEqual({
      type: "help",
      scope: "system",
    });
    expect(text).toContain("aidlc system <noun> <verb> [args]");
    expect(text).toContain(
      "Operations on this user's aidlc installation; never a system-wide or root install:",
    );
    expect(text).toContain("  rollback: [--version <version>|--list]");
    expect(text).toContain("  completions: <bash|zsh|fish|powershell>");
    expect(text).toContain("  lifecycle: install-apply");
    expect(text).toContain("install-profile --profile <path>");
    expect(text).not.toContain("machine-config");
    expect(text).toContain("  workspace-sync: [--force] [--project-dir <path>]");
    expect(text).not.toContain("--harness");
    expect(text).not.toContain("lifecycle: \n");
    expect(renderHumanHelp()).not.toContain("system");
  });

  test("help --all reveals both hidden namespaces without changing default help", () => {
    const defaultHelp = renderHumanHelp();
    const expanded = renderAllHelp();
    expect(resolveAction(["help", "--all"])).toEqual({
      type: "help",
      scope: "all",
    });
    expect(expanded).toStartWith(defaultHelp.trimEnd());
    expect(expanded).toContain("Hidden namespaces:");
    expect(expanded).toContain(
      "engine  Generated harness surfaces only; not for human scripts. Run: aidlc engine --help",
    );
    expect(expanded).toContain(
      "system  This user's installation; unsupported interface. Run: aidlc system --help",
    );
    expect(defaultHelp).not.toContain("Hidden namespaces:");
    expect(defaultHelp).not.toContain("aidlc engine --help");
    expect(defaultHelp).not.toContain("aidlc system --help");
  });

  test("removed alias nouns are routing errors", () => {
    for (const args of [
      ["engine", "utility", "status"],
      ["engine", "runner-gen", "write"],
      ["system", "machine-config", "global", "list"],
    ]) {
      expect(resolveAction(args).type, args.join(" ")).toBe("error");
    }
  });

  test("unknown top-level command points to the nearest help node", () => {
    const res = viaDispatcher(["bogus"], REPO_ROOT);
    expect(res.exitCode).toBe(2);
    expect(res.stdout.toString("utf-8")).toBe("");
    expect(res.stderr.toString("utf-8")).toBe(
      "error: unknown command 'bogus'\n\nusage: bun .claude/tools/aidlc.ts <command> [flags]\n" +
        "For the full list, run 'bun .claude/tools/aidlc.ts --help'.\n",
    );
    const suggestion = viaDispatcher(["confg"], REPO_ROOT);
    expect(suggestion.exitCode).toBe(2);
    expect(suggestion.stderr.toString("utf-8")).toBe(
      "error: unknown command 'confg'\n\n  tip: did you mean 'config'?\n\n" +
        "usage: bun .claude/tools/aidlc.ts <command> [flags]\n" +
        "For the full list, run 'bun .claude/tools/aidlc.ts --help'.\n",
    );
  });

  test("unknown config sections use the contextual suggestion", () => {
    const result = viaDispatcher(["config", "modles"], makeProject(), {
      AIDLC_TEST_CONFIG_TTY: "1",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString("utf-8")).toBe("");
    expect(result.stderr.toString("utf-8")).toBe(
        "error: unknown config section 'modles'\n\n" +
        "  tip: did you mean 'models'?\n\n" +
        "usage: bun .claude/tools/aidlc.ts config <section> [flags]\n" +
        "For the full list, run 'bun .claude/tools/aidlc.ts config --help'.\n",
    );
  });

  test("unknown engine noun verb points to engine help", () => {
    const res = viaDispatcher(["engine", "state", "bogus"], REPO_ROOT);
    expect(res.exitCode).toBe(2);
    expect(res.stdout.toString("utf-8")).toBe("");
    expect(res.stderr.toString("utf-8")).toBe(
      "aidlc: unknown verb 'bogus' for engine noun 'state'; try 'aidlc engine --help'\n",
    );
  });

  test("plugin help and invalid plugin verbs use the shared noun grammar", () => {
    const help = viaDispatcher(["engine", "plugin", "help"], REPO_ROOT);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString("utf-8")).toContain("plugin: select [names]");

    const invalid = viaDispatcher(["engine", "plugin", "remove"], REPO_ROOT);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString("utf-8")).toBe(
      "aidlc: unknown verb 'remove' for noun 'plugin'; try 'aidlc help --all'\n",
    );
  });

  test("formerly stubbed routes now reach utility handlers", () => {
    const projectDir = makeProject();
    writeMinimalState(projectDir);
    const cases = [
      ["engine", "config", "get", "depth"],
      ["engine", "config", "list"],
      ["engine", "plugin", "sync"],
      ["engine", "plugin", "list"],
      ["config"],
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
      ["engine", "plugin", "select", "aidlc", "--project-dir", projectDir],
      REPO_ROOT,
    );
    expect(plugin.exitCode).not.toBe(0);
    expect(plugin.stderr.toString("utf-8")).toContain("requires an installed project harness");

    const graph = viaDispatcher(
      ["engine", "graph", "compile", "--project-dir", projectDir],
      REPO_ROOT,
    );
    expect(graph.exitCode).not.toBe(0);
    expect(graph.stderr.toString("utf-8")).toContain("requires an installed project harness");
    expect(existsSync(join(projectDir, ".claude"))).toBe(false);
  });
});

describe("t230 dispatcher hook routing", () => {
  test("adapter routing separates harness, target, and extra arguments", () => {
    const codex = resolveAction( ["engine", "adapter", "codex", "session-start"]);
    expect(codex.type).toBe("adapter");
    if (codex.type === "adapter") {
      expect(codex.harness).toBe("codex");
      expect(codex.target).toBe("session-start");
      expect(codex.extraArgs).toEqual([]);
      expect(codex.path.endsWith("aidlc-codex-adapter.ts")).toBe(true);
    }

    const cursor = resolveAction(["engine", "adapter", "cursor", "validate-state"]);
    expect(cursor.type).toBe("adapter");
    if (cursor.type === "adapter") {
      expect(cursor.harness).toBe("cursor");
      expect(cursor.target).toBe("validate-state");
      expect(cursor.extraArgs).toEqual([]);
      expect(cursor.path.endsWith("aidlc-cursor-adapter.ts")).toBe(true);
    }

    const kiro = resolveAction([
      "engine",
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
    const res = viaDispatcher( ["engine", "hook", "validate-state"], projectDir, {}, "{}");

    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString("utf-8")).toBe("");
    const heartbeat = "validate-state.last";
    expect(
      existsSync(join(seededRecordDir(projectDir), ".aidlc-hooks-health", heartbeat)) ||
        existsSync(join(dirname(seededRecordDir(projectDir)), ".aidlc-hooks-health", heartbeat)),
    ).toBe(true);
  });

  test("hook review-freeze dispatches to run(input) and writes heartbeat", () => {
    const projectDir = makeProject();
    const res = viaDispatcher( ["engine", "hook", "review-freeze"], projectDir, {}, "{}");

    expect(res.exitCode).toBe(0);
    expect(res.stderr.toString("utf-8")).toBe("");
    const heartbeat = "review-freeze.last";
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
    const res = viaDispatcher(["engine", "statusline"], projectDir, {}, input);

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
       ["engine", "adapter", "codex", "validate-state"],
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
    writeMinimalState(targetProject, "domain-design");

    const hook = viaDispatcher(
       ["engine", "hook", "validate-state", "--project-dir", targetProject],
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
       ["engine", "statusline", "--project-dir", targetProject],
      cwdProject,
      {},
      JSON.stringify({
        workspace: { project_dir: cwdProject },
        model: { id: "claude-test" },
        context_window: { used_percentage: 12 },
      }),
    );
    expect(statusline.exitCode).toBe(0);
    expect(statusline.stdout.toString("utf-8")).toContain("Domain Design");
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
       ["engine", "adapter", "codex", "validate-state", "--project-dir", targetProject],
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
